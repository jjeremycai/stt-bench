import 'server-only'

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type BenchMethod, STT_BENCH_CATALOG } from './catalog'
import type {
  BenchRunRequestItem,
  BenchRunResponse,
  BenchRunResult,
  BenchStatusResponse,
} from './types'

const SHERPA_REPOS: Record<string, string> = {
  'parakeet-v2': 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
  'parakeet-v3': 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
}

interface CommandResult {
  code: number | null
  stderr: string
  stdout: string
}

interface BenchEnvironment {
  ffmpegPath?: string
  ffprobePath?: string
  fluidPath?: string
  fluidModelCacheRoot: string
  goPath?: string
  projectRoot: string
  sherpaGoBinaryPath: string
  sherpaGoRepoPath?: string
  sherpaModelCacheRoot: string
  sherpaPythonPath?: string
  sherpaScriptPath: string
}

export interface PreparedAudio {
  audioDurationSeconds: number
  canonicalPath: string
  canonicalName: string
  originalName: string
  sizeBytes: number
  tempDir: string
  type: string
}

async function pathExists(target: string | undefined): Promise<boolean> {
  if (!target) return false
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function ensureDir(target: string) {
  await fs.mkdir(target, { recursive: true })
}

function truncate(text: string, maxLength = 4000) {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`
}

function lastJsonLine(text: string): Record<string, unknown> {
  const line = text
    .trim()
    .split('\n')
    .map((part) => part.trim())
    .reverse()
    .find((part) => part.startsWith('{') && part.endsWith('}'))

  if (!line) {
    throw new Error('No JSON payload found in command output')
  }

  return JSON.parse(line) as Record<string, unknown>
}

async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    rejectOnError?: boolean
  } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', reject)
    child.on('close', (code) => {
      if (options.rejectOnError !== false && code !== 0) {
        reject(new Error(`${command} exited with code ${code}\n${stderr || stdout}`))
        return
      }

      resolve({ code, stderr, stdout })
    })
  })
}

async function resolveCommand(name: string): Promise<string | undefined> {
  const result = await runCommand('which', [name], { rejectOnError: false })
  if (result.code !== 0) return undefined
  return result.stdout.trim().split('\n').filter(Boolean).at(0)
}

async function resolveFirstExisting(
  candidates: Array<string | undefined>,
): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (!candidate) continue
    if (await pathExists(candidate)) return candidate
  }
  return undefined
}

async function resolveBenchEnvironment(): Promise<BenchEnvironment> {
  const projectRoot = process.cwd()
  const tempRoot = path.join(projectRoot, '.tmp', 'stt-bench')
  await ensureDir(tempRoot)

  return {
    projectRoot,
    ffmpegPath: await resolveCommand('ffmpeg'),
    ffprobePath: await resolveCommand('ffprobe'),
    fluidPath: await resolveFirstExisting([
      process.env.STT_BENCH_FLUIDAUDIO_CLI_PATH,
      '/tmp/FluidAudio/.build/release/fluidaudiocli',
    ]),
    fluidModelCacheRoot: path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'FluidAudio',
      'Models',
    ),
    goPath: await resolveCommand('go'),
    sherpaGoBinaryPath: path.join(tempRoot, 'sherpa-go-bench'),
    sherpaGoRepoPath: await resolveFirstExisting([
      process.env.STT_BENCH_SHERPA_GO_REPO_PATH,
      '/tmp/sherpa-onnx-go-macos',
    ]),
    sherpaModelCacheRoot: path.join(tempRoot, 'models'),
    sherpaPythonPath: await resolveFirstExisting([
      process.env.STT_BENCH_SHERPA_PYTHON_PATH,
      '/tmp/sherpa-py/bin/python',
      '/tmp/sherpa-py/bin/python3',
    ]),
    sherpaScriptPath: path.join(projectRoot, 'scripts', 'sherpa_mainline_bench.py'),
  }
}

function methodStatus(
  env: BenchEnvironment,
  method: BenchMethod,
): BenchStatusResponse['runners'][number] {
  switch (method) {
    case 'fluid':
      return env.fluidPath
        ? {
            method,
            available: true,
            details: 'CLI detected and ready for local runs.',
            detectedPath: env.fluidPath,
            modelCacheRoot: env.fluidModelCacheRoot,
          }
        : {
            method,
            available: false,
            details:
              'FluidAudio CLI not found. Set STT_BENCH_FLUIDAUDIO_CLI_PATH or build /tmp/FluidAudio.',
            modelCacheRoot: env.fluidModelCacheRoot,
          }
    case 'sherpa-python':
      return env.sherpaPythonPath
        ? {
            method,
            available: true,
            details: 'Python sherpa-onnx runtime detected. Models will be cached locally on demand.',
            detectedPath: env.sherpaPythonPath,
            modelCacheRoot: env.sherpaModelCacheRoot,
          }
        : {
            method,
            available: false,
            details:
              'sherpa Python runtime not found. Set STT_BENCH_SHERPA_PYTHON_PATH or create /tmp/sherpa-py.',
            modelCacheRoot: env.sherpaModelCacheRoot,
          }
    case 'sherpa-go':
      if (!env.goPath) {
        return {
          method,
          available: false,
          details: 'Go toolchain not found in PATH.',
          modelCacheRoot: env.sherpaModelCacheRoot,
        }
      }
      if (!env.sherpaGoRepoPath) {
        return {
          method,
          available: false,
          details:
            'sherpa-onnx-go-macos repo not found. Set STT_BENCH_SHERPA_GO_REPO_PATH or clone /tmp/sherpa-onnx-go-macos.',
          modelCacheRoot: env.sherpaModelCacheRoot,
        }
      }
      if (!env.sherpaPythonPath) {
        return {
          method,
          available: false,
          details:
            'Go adapter is present, but sherpa Python is also needed to materialize model files.',
          detectedPath: env.sherpaGoRepoPath,
          modelCacheRoot: env.sherpaModelCacheRoot,
        }
      }
      return {
        method,
        available: true,
        details:
          'Go adapter detected. Helper binary will be built on first use and reuse the sherpa model cache.',
        detectedPath: env.sherpaGoRepoPath,
        modelCacheRoot: env.sherpaModelCacheRoot,
      }
  }
}

export async function getBenchStatus(): Promise<BenchStatusResponse> {
  const env = await resolveBenchEnvironment()
  const runners = (Object.keys(STT_BENCH_CATALOG) as BenchMethod[]).map((method) =>
    methodStatus(env, method),
  )
  const audioReady = Boolean(env.ffmpegPath && env.ffprobePath)

  return {
    catalogVersion: 1,
    audioTools: {
      ready: audioReady,
      details: audioReady
        ? 'ffmpeg and ffprobe detected. Uploaded audio will be normalized to a shared WAV before benchmarking.'
        : 'ffmpeg/ffprobe are required to normalize uploaded audio before routing it to the runners.',
      ffmpegPath: env.ffmpegPath,
      ffprobePath: env.ffprobePath,
    },
    runners,
  }
}

export async function prepareUploadedAudio(file: File): Promise<PreparedAudio> {
  const env = await resolveBenchEnvironment()
  if (!env.ffmpegPath || !env.ffprobePath) {
    throw new Error('ffmpeg and ffprobe must be installed to run the STT bench')
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stt-bench-audio-'))
  const originalExt = path.extname(file.name || '') || '.bin'
  const originalPath = path.join(tempDir, `upload${originalExt}`)
  const canonicalPath = path.join(tempDir, 'input.wav')

  await fs.writeFile(originalPath, Buffer.from(await file.arrayBuffer()))

  await runCommand(env.ffmpegPath, [
    '-y',
    '-i',
    originalPath,
    '-ar',
    '16000',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    canonicalPath,
  ])

  const ffprobe = await runCommand(env.ffprobePath, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=nk=1:nw=1',
    canonicalPath,
  ])

  const duration = Number(ffprobe.stdout.trim())
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Failed to determine canonical audio duration')
  }

  return {
    tempDir,
    canonicalPath,
    canonicalName: 'input.wav',
    audioDurationSeconds: duration,
    originalName: file.name,
    sizeBytes: file.size,
    type: file.type || 'application/octet-stream',
  }
}

export async function cleanupPreparedAudio(tempDir: string) {
  await fs.rm(tempDir, { recursive: true, force: true })
}

async function ensureSherpaModelDir(env: BenchEnvironment, model: string) {
  if (!env.sherpaPythonPath) {
    throw new Error('sherpa Python runtime is required to prepare model files')
  }

  const repoId = SHERPA_REPOS[model]
  if (!repoId) {
    throw new Error(`Unsupported sherpa model: ${model}`)
  }

  const modelDir = path.join(env.sherpaModelCacheRoot, model)
  await ensureDir(env.sherpaModelCacheRoot)
  await runCommand(env.sherpaPythonPath, [
    env.sherpaScriptPath,
    '--prepare-only',
    '--repo-id',
    repoId,
    '--model-dir',
    modelDir,
  ])
  return modelDir
}

function goBenchSource() {
  return `package main

import (
  "encoding/json"
  "flag"
  "fmt"
  "log"
  "path/filepath"
  "time"

  sherpa "github.com/k2-fsa/sherpa-onnx-go-macos"
)

func main() {
  wavPath := flag.String("wav", "", "Path to canonical wav input")
  modelDir := flag.String("model-dir", "", "Path to sherpa model directory")
  provider := flag.String("provider", "coreml", "Execution provider")
  numThreads := flag.Int("num-threads", 4, "Inference threads")
  modelType := flag.String("model-type", "nemo_transducer", "Model type")
  flag.Parse()

  if *wavPath == "" || *modelDir == "" {
    log.Fatal("both --wav and --model-dir are required")
  }

  w := sherpa.ReadWave(*wavPath)
  if w == nil {
    log.Fatalf("failed to read wave: %s", *wavPath)
  }

  t0 := time.Now()
  recognizer := sherpa.NewOfflineRecognizer(&sherpa.OfflineRecognizerConfig{
    FeatConfig: sherpa.FeatureConfig{
      SampleRate: 16000,
      FeatureDim: 80,
    },
    ModelConfig: sherpa.OfflineModelConfig{
      Transducer: sherpa.OfflineTransducerModelConfig{
        Encoder: filepath.Join(*modelDir, "encoder.int8.onnx"),
        Decoder: filepath.Join(*modelDir, "decoder.int8.onnx"),
        Joiner:  filepath.Join(*modelDir, "joiner.int8.onnx"),
      },
      Tokens:     filepath.Join(*modelDir, "tokens.txt"),
      NumThreads: *numThreads,
      Provider:   *provider,
      ModelType:  *modelType,
    },
    DecodingMethod: "greedy_search",
    MaxActivePaths: 4,
  })
  if recognizer == nil {
    log.Fatal("failed to create recognizer")
  }
  defer sherpa.DeleteOfflineRecognizer(recognizer)

  t1 := time.Now()
  stream := sherpa.NewOfflineStream(recognizer)
  if stream == nil {
    log.Fatal("failed to create offline stream")
  }
  defer sherpa.DeleteOfflineStream(stream)

  stream.AcceptWaveform(w.SampleRate, w.Samples)
  recognizer.Decode(stream)
  t2 := time.Now()

  result := stream.GetResult()
  if result == nil {
    log.Fatal("no result returned")
  }

  payload := map[string]any{
    "confidence": nil,
    "decode_s":   round(t2.Sub(t1).Seconds()),
    "init_s":     round(t1.Sub(t0).Seconds()),
    "text":       result.Text,
    "total_s":    round(t2.Sub(t0).Seconds()),
  }
  out, err := json.Marshal(payload)
  if err != nil {
    log.Fatal(err)
  }
  fmt.Println(string(out))
}

func round(v float64) float64 {
  return float64(int(v*1000+0.5)) / 1000
}
`
}

async function ensureSherpaGoBinary(env: BenchEnvironment) {
  if (!env.goPath || !env.sherpaGoRepoPath) {
    throw new Error('Go toolchain and sherpa-onnx-go-macos repo are required')
  }

  const sourceDir = path.join(env.projectRoot, '.tmp', 'stt-bench', 'go-runner')
  await ensureDir(sourceDir)

  const goMod = `module stt-bench-go-runner

go 1.24

require github.com/k2-fsa/sherpa-onnx-go-macos v0.0.0

replace github.com/k2-fsa/sherpa-onnx-go-macos => ${env.sherpaGoRepoPath}
`

  await fs.writeFile(path.join(sourceDir, 'go.mod'), goMod, 'utf8')
  await fs.writeFile(path.join(sourceDir, 'main.go'), goBenchSource(), 'utf8')

  if (!(await pathExists(env.sherpaGoBinaryPath))) {
    await runCommand(env.goPath, ['build', '-o', env.sherpaGoBinaryPath, '.'], {
      cwd: sourceDir,
    })
  }

  return env.sherpaGoBinaryPath
}

function audioMetrics(
  audioDurationSeconds: number,
  metrics: {
    confidence?: number
    decode_s?: number
    init_s?: number
    processing_s?: number
    total_s?: number
    wallMs: number
  },
) {
  const processingSeconds = metrics.processing_s ?? metrics.total_s

  return {
    audioDurationSeconds,
    confidence: metrics.confidence,
    decodeMs:
      typeof metrics.decode_s === 'number' ? Math.round(metrics.decode_s * 1000) : undefined,
    initMs:
      typeof metrics.init_s === 'number' ? Math.round(metrics.init_s * 1000) : undefined,
    processingMs:
      typeof processingSeconds === 'number'
        ? Math.round(processingSeconds * 1000)
        : undefined,
    processingRtfx:
      typeof processingSeconds === 'number' && processingSeconds > 0
        ? Number((audioDurationSeconds / processingSeconds).toFixed(2))
        : undefined,
    totalMs:
      typeof metrics.total_s === 'number' ? Math.round(metrics.total_s * 1000) : undefined,
    wallMs: Math.round(metrics.wallMs),
    wallRtfx:
      metrics.wallMs > 0
        ? Number((audioDurationSeconds / (metrics.wallMs / 1000)).toFixed(2))
        : undefined,
  }
}

async function runFluidBench(
  env: BenchEnvironment,
  input: { audioDurationSeconds: number; canonicalPath: string; model: string },
): Promise<BenchRunResult> {
  if (!env.fluidPath) {
    return {
      method: 'fluid',
      model: input.model,
      status: 'unavailable',
      details:
        'FluidAudio CLI not found. Set STT_BENCH_FLUIDAUDIO_CLI_PATH or build /tmp/FluidAudio.',
    }
  }

  const outputPath = path.join(
    env.projectRoot,
    '.tmp',
    'stt-bench',
    `fluid-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  )

  const command = [
    env.fluidPath,
    'transcribe',
    input.canonicalPath,
    '--model-version',
    input.model,
    '--output-json',
    outputPath,
  ]

  const start = performance.now()

  try {
    const result = await runCommand(command[0], command.slice(1))
    const wallMs = performance.now() - start
    const payload = JSON.parse(await fs.readFile(outputPath, 'utf8')) as {
      confidence?: number
      processingTimeSeconds?: number
      text?: string
    }

    return {
      method: 'fluid',
      model: input.model,
      status: 'ok',
      command,
      runnerPath: env.fluidPath,
      stdout: truncate(result.stdout),
      stderr: truncate(result.stderr),
      transcript: payload.text ?? result.stdout.trim(),
      metrics: audioMetrics(input.audioDurationSeconds, {
        confidence: payload.confidence,
        processing_s: payload.processingTimeSeconds,
        wallMs,
      }),
    }
  } catch (error) {
    return {
      method: 'fluid',
      model: input.model,
      status: 'error',
      command,
      runnerPath: env.fluidPath,
      details: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await fs.rm(outputPath, { force: true })
  }
}

async function runSherpaPythonBench(
  env: BenchEnvironment,
  input: { audioDurationSeconds: number; canonicalPath: string; model: string },
): Promise<BenchRunResult> {
  if (!env.sherpaPythonPath) {
    return {
      method: 'sherpa-python',
      model: input.model,
      status: 'unavailable',
      details:
        'sherpa Python runtime not found. Set STT_BENCH_SHERPA_PYTHON_PATH or create /tmp/sherpa-py.',
    }
  }

  try {
    const modelDir = await ensureSherpaModelDir(env, input.model)
    const command = [
      env.sherpaPythonPath,
      env.sherpaScriptPath,
      '--wav',
      input.canonicalPath,
      '--repo-id',
      SHERPA_REPOS[input.model],
      '--model-dir',
      modelDir,
    ]

    const start = performance.now()
    const result = await runCommand(command[0], command.slice(1))
    const wallMs = performance.now() - start
    const payload = lastJsonLine(result.stdout)

    return {
      method: 'sherpa-python',
      model: input.model,
      status: 'ok',
      command,
      runnerPath: env.sherpaPythonPath,
      stdout: truncate(result.stdout),
      stderr: truncate(result.stderr),
      transcript: String(payload.text ?? ''),
      metrics: audioMetrics(input.audioDurationSeconds, {
        confidence: typeof payload.confidence === 'number' ? payload.confidence : undefined,
        decode_s: typeof payload.decode_s === 'number' ? payload.decode_s : undefined,
        init_s: typeof payload.init_s === 'number' ? payload.init_s : undefined,
        total_s: typeof payload.total_s === 'number' ? payload.total_s : undefined,
        wallMs,
      }),
    }
  } catch (error) {
    return {
      method: 'sherpa-python',
      model: input.model,
      status: 'error',
      runnerPath: env.sherpaPythonPath,
      details: error instanceof Error ? error.message : String(error),
    }
  }
}

async function runSherpaGoBench(
  env: BenchEnvironment,
  input: { audioDurationSeconds: number; canonicalPath: string; model: string },
): Promise<BenchRunResult> {
  if (!env.goPath || !env.sherpaGoRepoPath || !env.sherpaPythonPath) {
    return {
      method: 'sherpa-go',
      model: input.model,
      status: 'unavailable',
      details:
        'Go toolchain, sherpa-onnx-go-macos repo, and sherpa Python runtime are all required for this runner.',
    }
  }

  try {
    const modelDir = await ensureSherpaModelDir(env, input.model)
    const binaryPath = await ensureSherpaGoBinary(env)
    const command = [
      binaryPath,
      '--wav',
      input.canonicalPath,
      '--model-dir',
      modelDir,
      '--provider',
      'coreml',
      '--model-type',
      'nemo_transducer',
    ]

    const start = performance.now()
    const result = await runCommand(command[0], command.slice(1))
    const wallMs = performance.now() - start
    const payload = lastJsonLine(result.stdout)

    return {
      method: 'sherpa-go',
      model: input.model,
      status: 'ok',
      command,
      runnerPath: env.sherpaGoRepoPath,
      stdout: truncate(result.stdout),
      stderr: truncate(result.stderr),
      transcript: String(payload.text ?? ''),
      metrics: audioMetrics(input.audioDurationSeconds, {
        confidence: typeof payload.confidence === 'number' ? payload.confidence : undefined,
        decode_s: typeof payload.decode_s === 'number' ? payload.decode_s : undefined,
        init_s: typeof payload.init_s === 'number' ? payload.init_s : undefined,
        total_s: typeof payload.total_s === 'number' ? payload.total_s : undefined,
        wallMs,
      }),
    }
  } catch (error) {
    return {
      method: 'sherpa-go',
      model: input.model,
      status: 'error',
      runnerPath: env.sherpaGoRepoPath,
      details: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function runBenchmarks(input: {
  audioDurationSeconds: number
  canonicalPath: string
  runs: BenchRunRequestItem[]
  audio: Pick<PreparedAudio, 'canonicalName' | 'originalName' | 'sizeBytes' | 'type'>
}): Promise<BenchRunResponse> {
  const env = await resolveBenchEnvironment()
  const results: BenchRunResult[] = []

  for (const run of input.runs) {
    switch (run.method) {
      case 'fluid':
        results.push(
          await runFluidBench(env, {
            audioDurationSeconds: input.audioDurationSeconds,
            canonicalPath: input.canonicalPath,
            model: run.model,
          }),
        )
        break
      case 'sherpa-python':
        results.push(
          await runSherpaPythonBench(env, {
            audioDurationSeconds: input.audioDurationSeconds,
            canonicalPath: input.canonicalPath,
            model: run.model,
          }),
        )
        break
      case 'sherpa-go':
        results.push(
          await runSherpaGoBench(env, {
            audioDurationSeconds: input.audioDurationSeconds,
            canonicalPath: input.canonicalPath,
            model: run.model,
          }),
        )
        break
    }
  }

  return {
    audio: {
      canonicalName: input.audio.canonicalName,
      durationSeconds: input.audioDurationSeconds,
      name: input.audio.originalName,
      sizeBytes: input.audio.sizeBytes,
      type: input.audio.type,
    },
    results,
  }
}
