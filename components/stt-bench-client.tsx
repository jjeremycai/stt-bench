'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_STT_BENCH_RUNS, STT_BENCH_CATALOG, type BenchMethod } from '@/lib/catalog'
import type {
  BenchRunRequestItem,
  BenchRunResponse,
  BenchRunResult,
  BenchRunnerStatus,
  BenchStatusResponse,
} from '@/lib/types'

type RunConfigState = Record<BenchMethod, { enabled: boolean; model: string }>
type BrowserRecorderState = 'idle' | 'recording' | 'stopping'

const DEFAULT_ESTIMATED_WALL_MS: Record<BenchMethod, number> = {
  fluid: 3000,
  'sherpa-python': 35000,
  'sherpa-go': 22000,
}

function initialRunConfigState(): RunConfigState {
  return {
    fluid: {
      enabled: true,
      model:
        DEFAULT_STT_BENCH_RUNS.find((run) => run.method === 'fluid')?.model ??
        STT_BENCH_CATALOG.fluid.models[0].value,
    },
    'sherpa-python': {
      enabled: true,
      model:
        DEFAULT_STT_BENCH_RUNS.find((run) => run.method === 'sherpa-python')?.model ??
        STT_BENCH_CATALOG['sherpa-python'].models[0].value,
    },
    'sherpa-go': {
      enabled: true,
      model:
        DEFAULT_STT_BENCH_RUNS.find((run) => run.method === 'sherpa-go')?.model ??
        STT_BENCH_CATALOG['sherpa-go'].models[0].value,
    },
  }
}

function formatMs(value?: number) {
  return typeof value === 'number' ? `${(value / 1000).toFixed(2)}s` : '—'
}

function formatRtfx(value?: number) {
  return typeof value === 'number' ? `${value.toFixed(2)}x` : '—'
}

function formatConfidence(value?: number) {
  return typeof value === 'number' ? value.toFixed(3) : '—'
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatRecordingDuration(seconds: number) {
  const totalSeconds = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(totalSeconds / 60)
  const remainder = totalSeconds % 60
  return `${minutes}:${remainder.toString().padStart(2, '0')}`
}

function resultTone(result: BenchRunResult): 'success' | 'danger' | 'muted' {
  if (result.status === 'ok') return 'success'
  if (result.status === 'error') return 'danger'
  return 'muted'
}

function getPreferredRecordingMimeType() {
  if (typeof MediaRecorder === 'undefined') return undefined

  const candidates = [
    'audio/webm;codecs=opus',
    'audio/mp4',
    'audio/webm',
    'audio/ogg;codecs=opus',
  ]

  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate))
}

function extensionForMimeType(mimeType?: string) {
  if (!mimeType) return 'webm'
  if (mimeType.includes('mp4')) return 'm4a'
  if (mimeType.includes('ogg')) return 'ogg'
  if (mimeType.includes('wav')) return 'wav'
  return 'webm'
}

function estimateTotalWallMs(
  runs: BenchRunRequestItem[],
  previousResults: BenchRunResponse | null,
) {
  return runs.reduce((total, run) => {
    const previousMatch = previousResults?.results.find(
      (result) =>
        result.method === run.method &&
        result.model === run.model &&
        typeof result.metrics?.wallMs === 'number',
    )

    return total + (previousMatch?.metrics?.wallMs ?? DEFAULT_ESTIMATED_WALL_MS[run.method])
  }, 0)
}

function useAudioLevel(mediaStream: MediaStream | null) {
  const [level, setLevel] = useState(0)

  useEffect(() => {
    if (!mediaStream) {
      setLevel(0)
      return
    }

    const audioContext = new (
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    )()
    const source = audioContext.createMediaStreamSource(mediaStream)
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 32
    analyser.smoothingTimeConstant = 0.4
    source.connect(analyser)

    const dataArray = new Uint8Array(analyser.frequencyBinCount)
    let frameId = 0

    const tick = () => {
      analyser.getByteFrequencyData(dataArray)
      let sum = 0
      for (const value of dataArray) {
        sum += value * value
      }
      setLevel(Math.sqrt(sum / dataArray.length) / 255)
      frameId = requestAnimationFrame(tick)
    }

    frameId = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(frameId)
      source.disconnect()
      audioContext.close()
    }
  }, [mediaStream])

  return level
}

export function SttBenchClient() {
  const [status, setStatus] = useState<BenchStatusResponse | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [audioPreviewUrl, setAudioPreviewUrl] = useState<string | null>(null)
  const [runConfig, setRunConfig] = useState<RunConfigState>(initialRunConfigState)
  const [results, setResults] = useState<BenchRunResponse | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)
  const [runProgressPercent, setRunProgressPercent] = useState(0)
  const [browserRecorderState, setBrowserRecorderState] =
    useState<BrowserRecorderState>('idle')
  const [browserRecordingError, setBrowserRecordingError] = useState<string | null>(null)
  const [browserRecordingSeconds, setBrowserRecordingSeconds] = useState(0)
  const [browserRecordingStream, setBrowserRecordingStream] = useState<MediaStream | null>(
    null,
  )

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const runProgressFrameRef = useRef<number | null>(null)
  const recordingChunksRef = useRef<Blob[]>([])
  const recordingStartedAtRef = useRef<number | null>(null)
  const isUnmountingRef = useRef(false)
  const browserRecordingLevel = useAudioLevel(browserRecordingStream)

  useEffect(() => {
    if (!file) {
      setAudioPreviewUrl(null)
      return
    }

    const url = URL.createObjectURL(file)
    setAudioPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const stopBrowserStream = useCallback((clearState = true) => {
    const stream = mediaStreamRef.current
    if (stream) {
      stream.getTracks().forEach((track) => track.stop())
      mediaStreamRef.current = null
    }

    if (clearState) {
      setBrowserRecordingStream(null)
    }
  }, [])

  useEffect(() => {
    if (browserRecorderState !== 'recording') {
      if (browserRecorderState === 'idle') {
        setBrowserRecordingSeconds(0)
      }
      return
    }

    const timer = window.setInterval(() => {
      const startedAt = recordingStartedAtRef.current
      if (!startedAt) return
      setBrowserRecordingSeconds((Date.now() - startedAt) / 1000)
    }, 100)

    return () => window.clearInterval(timer)
  }, [browserRecorderState])

  useEffect(() => {
    return () => {
      isUnmountingRef.current = true
      if (runProgressFrameRef.current) {
        cancelAnimationFrame(runProgressFrameRef.current)
      }
      const recorder = mediaRecorderRef.current
      if (recorder) {
        recorder.ondataavailable = null
        recorder.onerror = null
        recorder.onstop = null
        if (recorder.state !== 'inactive') {
          recorder.stop()
        }
      }
      const stream = mediaStreamRef.current
      if (stream) {
        stream.getTracks().forEach((track) => track.stop())
      }
    }
  }, [])

  const applySelectedFile = useCallback((nextFile: File | null) => {
    setFile(nextFile)
    setResults(null)
    setRunError(null)
  }, [])

  const refreshStatus = useCallback(async () => {
    setIsRefreshing(true)
    setStatusError(null)

    try {
      const response = await fetch('/api/bench', { cache: 'no-store' })
      const payload = (await response.json()) as BenchStatusResponse | { error: string }
      if (!response.ok || 'error' in payload) {
        throw new Error('error' in payload ? payload.error : 'Failed to load runner availability')
      }
      setStatus(payload)
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : 'Failed to load runner availability')
    } finally {
      setIsRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  const runnerStatusByMethod = useMemo(() => {
    const entries =
      status?.runners.map(
        (runner): readonly [BenchMethod, BenchRunnerStatus] => [runner.method, runner],
      ) ?? []
    return new Map<BenchMethod, BenchRunnerStatus>(entries)
  }, [status])

  const selectedRuns = useMemo(() => {
    return (Object.keys(runConfig) as BenchMethod[])
      .filter((method) => {
        const config = runConfig[method]
        const runner = runnerStatusByMethod.get(method)
        return config.enabled && runner?.available
      })
      .map(
        (method): BenchRunRequestItem => ({
          method,
          model: runConfig[method].model,
        }),
      )
  }, [runConfig, runnerStatusByMethod])

  const startBrowserRecording = useCallback(async () => {
    if (browserRecorderState !== 'idle') return

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setBrowserRecordingError('Microphone recording is not available in this browser context')
      return
    }

    if (typeof MediaRecorder === 'undefined') {
      setBrowserRecordingError('MediaRecorder is not available in this browser')
      return
    }

    try {
      setBrowserRecordingError(null)
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      })
      const mimeType = getPreferredRecordingMimeType()
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)

      mediaStreamRef.current = stream
      setBrowserRecordingStream(stream)
      mediaRecorderRef.current = recorder
      recordingChunksRef.current = []
      recordingStartedAtRef.current = Date.now()
      setBrowserRecordingSeconds(0)

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recordingChunksRef.current.push(event.data)
        }
      }

      recorder.onerror = () => {
        if (isUnmountingRef.current) return
        setBrowserRecordingError('Microphone recording failed')
        setBrowserRecorderState('idle')
        stopBrowserStream()
      }

      recorder.onstop = () => {
        const nextMimeType =
          recorder.mimeType ||
          mimeType ||
          recordingChunksRef.current[0]?.type ||
          'audio/webm'

        const nextFile =
          recordingChunksRef.current.length > 0
            ? new File(
                [new Blob(recordingChunksRef.current, { type: nextMimeType })],
                `stt-bench-${new Date()
                  .toISOString()
                  .replace(/[:.]/g, '-')}.${extensionForMimeType(nextMimeType)}`,
                {
                  type: nextMimeType,
                  lastModified: Date.now(),
                },
              )
            : null

        recordingChunksRef.current = []
        recordingStartedAtRef.current = null
        mediaRecorderRef.current = null
        stopBrowserStream()

        if (isUnmountingRef.current) return

        setBrowserRecorderState('idle')
        setBrowserRecordingSeconds(0)

        if (!nextFile) {
          setBrowserRecordingError('No audio was captured')
          return
        }

        applySelectedFile(nextFile)
      }

      recorder.start(250)
      setBrowserRecorderState('recording')
    } catch (error) {
      stopBrowserStream()
      setBrowserRecordingError(
        error instanceof Error ? error.message : 'Failed to access the microphone',
      )
    }
  }, [applySelectedFile, browserRecorderState, stopBrowserStream])

  const stopBrowserRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state === 'inactive') return
    setBrowserRecorderState('stopping')
    recorder.stop()
  }, [])

  const startRunProgress = useCallback(
    (runs: BenchRunRequestItem[]) => {
      if (runProgressFrameRef.current) {
        cancelAnimationFrame(runProgressFrameRef.current)
      }

      const expectedWallMs = Math.max(estimateTotalWallMs(runs, results), 1000)
      const startedAt = performance.now()

      const tick = () => {
        const elapsedMs = performance.now() - startedAt
        const nextPercent =
          elapsedMs <= expectedWallMs
            ? (elapsedMs / expectedWallMs) * 90
            : 90 +
              Math.min(
                ((elapsedMs - expectedWallMs) / expectedWallMs) * 8,
                8,
              )

        setRunProgressPercent(Math.min(nextPercent, 98))
        runProgressFrameRef.current = requestAnimationFrame(tick)
      }

      setRunProgressPercent(0)
      runProgressFrameRef.current = requestAnimationFrame(tick)
    },
    [results],
  )

  const stopRunProgress = useCallback((complete: boolean) => {
    if (runProgressFrameRef.current) {
      cancelAnimationFrame(runProgressFrameRef.current)
      runProgressFrameRef.current = null
    }

    setRunProgressPercent(complete ? 100 : 0)
  }, [])

  const handleRun = useCallback(async () => {
    if (browserRecorderState !== 'idle') {
      setRunError('Stop the current recording before running the benchmark')
      return
    }

    if (!file) {
      setRunError('Select or record an audio file before running the benchmark')
      return
    }

    if (!status?.audioTools.ready) {
      setRunError('ffmpeg and ffprobe are required before the benchmark can run')
      return
    }

    if (!selectedRuns.length) {
      setRunError('Enable at least one available runner')
      return
    }

    setIsRunning(true)
    setRunError(null)
    startRunProgress(selectedRuns)

    try {
      const formData = new FormData()
      formData.append('audio', file)
      formData.append('runs', JSON.stringify(selectedRuns))

      const response = await fetch('/api/bench', {
        method: 'POST',
        body: formData,
      })

      const payload = (await response.json()) as BenchRunResponse | { error: string }
      if (!response.ok || 'error' in payload) {
        throw new Error('error' in payload ? payload.error : 'Benchmark run failed')
      }

      setResults(payload)
      stopRunProgress(true)
    } catch (error) {
      setRunError(error instanceof Error ? error.message : 'Benchmark run failed')
      stopRunProgress(false)
    } finally {
      setIsRunning(false)
    }
  }, [browserRecorderState, file, selectedRuns, startRunProgress, status, stopRunProgress])

  return (
    <main className="page-shell">
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow-row">
            <span className="badge" data-tone="muted">
              Standalone Project
            </span>
            <span className="badge" data-tone={status?.audioTools.ready ? 'success' : 'danger'}>
              {status?.audioTools.ready ? 'Audio Tools Ready' : 'Audio Tools Missing'}
            </span>
          </div>
          <h1 className="title">Speech Stack Bench</h1>
          <p className="subtitle">
            Upload or record one clip, route it through FluidAudio, sherpa-onnx, and
            sherpa-onnx-go-macos, and compare timing plus transcript quality on the same
            machine.
          </p>
        </div>

        <div className="hero-actions">
          <button className="button button--secondary" onClick={() => void refreshStatus()} disabled={isRefreshing}>
            {isRefreshing ? 'Refreshing…' : 'Refresh Status'}
          </button>
          <button className="button" onClick={() => void handleRun()} disabled={isRunning}>
            {isRunning ? 'Running…' : 'Run Bench'}
          </button>
        </div>
      </section>

      {statusError ? <div className="alert">{statusError}</div> : null}
      {runError ? <div className="alert">{runError}</div> : null}
      {isRunning ? (
        <section className="run-progress panel" aria-live="polite">
          <div className="run-progress__head">
            <div>
              <p className="panel-title">Running Benchmark</p>
              <p className="panel-copy">
                Estimated progress based on the selected runners and recent wall times.
              </p>
            </div>
            <span className="badge" data-tone="success">
              {Math.round(runProgressPercent)}%
            </span>
          </div>
          <div className="run-progress__track" aria-hidden="true">
            <div
              className="run-progress__fill"
              style={{ width: `${Math.max(runProgressPercent, 2)}%` }}
            />
          </div>
        </section>
      ) : null}

      <section className="main-grid">
        <div className="stack">
          <article className="panel">
            <div className="panel-header">
              <h2 className="panel-title">Input</h2>
              <p className="panel-copy">
                The backend normalizes every input to one shared 16&nbsp;kHz mono WAV before
                dispatching it to the selected runners.
              </p>
            </div>
            <div className="panel-body stack">
              <div className="recorder-panel">
                <div className="controls-row">
                  <div>
                    <p className="input-label">Record In Browser</p>
                    <p className="input-help">
                      Capture a clip from your microphone and reuse it as the benchmark input.
                    </p>
                  </div>

                  <div className="recorder-actions">
                    <span
                      className="badge"
                      data-tone={
                        browserRecorderState === 'recording'
                          ? 'danger'
                          : browserRecorderState === 'stopping'
                            ? 'muted'
                            : 'success'
                      }
                    >
                      {browserRecorderState === 'recording'
                        ? `Recording ${formatRecordingDuration(browserRecordingSeconds)}`
                        : browserRecorderState === 'stopping'
                          ? 'Finalizing…'
                          : 'Ready'}
                    </span>
                    <div className="meter" aria-hidden="true">
                      {[0.65, 1, 0.8].map((scale) => (
                        <span
                          key={scale}
                          className="meter-bar"
                          style={{
                            transform: `scaleY(${Math.max(0.15, browserRecordingLevel * scale)})`,
                          }}
                        />
                      ))}
                    </div>
                    {browserRecorderState === 'idle' ? (
                      <button className="button" onClick={() => void startBrowserRecording()}>
                        Start Recording
                      </button>
                    ) : (
                      <button
                        className="button button--danger"
                        onClick={stopBrowserRecording}
                        disabled={browserRecorderState === 'stopping'}
                      >
                        {browserRecorderState === 'stopping' ? 'Finalizing…' : 'Stop Recording'}
                      </button>
                    )}
                    {file ? (
                      <button
                        className="button button--ghost"
                        onClick={() => applySelectedFile(null)}
                        disabled={browserRecorderState !== 'idle'}
                      >
                        Clear Clip
                      </button>
                    ) : null}
                  </div>
                </div>

                {browserRecordingError ? <div className="alert">{browserRecordingError}</div> : null}
              </div>

              <div>
                <label className="input-label" htmlFor="audio-file">
                  Upload Audio
                </label>
                <p className="input-help">Choose a local recording, memo export, or recorded clip.</p>
                <input
                  id="audio-file"
                  className="native-input"
                  type="file"
                  accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg,.webm"
                  disabled={browserRecorderState !== 'idle'}
                  onChange={(event) => {
                    applySelectedFile(event.currentTarget.files?.[0] ?? null)
                  }}
                />
              </div>

              {file ? (
                <div className="file-preview">
                  <div className="file-meta">
                    <span className="badge" data-tone="muted">
                      {file.name}
                    </span>
                    <span className="badge" data-tone="muted">
                      {formatBytes(file.size)}
                    </span>
                    {file.type ? (
                      <span className="badge" data-tone="muted">
                        {file.type}
                      </span>
                    ) : null}
                  </div>

                  {audioPreviewUrl ? (
                    <audio className="audio-player" controls src={audioPreviewUrl}>
                      <track kind="captions" />
                    </audio>
                  ) : null}
                </div>
              ) : (
                <div className="empty-state">No clip selected yet.</div>
              )}

              <div className="divider" />

              <div className="stack">
                <div>
                  <p className="input-label">Environment</p>
                  <p className="input-help">This project is meant to run locally against your installed tools.</p>
                </div>

                <div className="env-grid">
                  <div className="env-card">
                    <div className="panel-body">
                      <p className="input-label">ffmpeg</p>
                      <p className="code-line">{status?.audioTools.ffmpegPath ?? 'Not detected'}</p>
                    </div>
                  </div>
                  <div className="env-card">
                    <div className="panel-body">
                      <p className="input-label">ffprobe</p>
                      <p className="code-line">{status?.audioTools.ffprobePath ?? 'Not detected'}</p>
                    </div>
                  </div>
                </div>

                <p className="muted">{status?.audioTools.details ?? 'Checking local audio tools…'}</p>
              </div>
            </div>
          </article>
        </div>

        <article className="panel">
          <div className="panel-header">
            <h2 className="panel-title">Runners</h2>
            <p className="panel-copy">
              Enable the stacks you want, choose a model per stack, and run them sequentially so
              the numbers stay comparable.
            </p>
          </div>
          <div className="panel-body runner-grid">
            {(Object.keys(STT_BENCH_CATALOG) as BenchMethod[]).map((method) => {
              const runner = runnerStatusByMethod.get(method)
              const config = runConfig[method]
              const definition = STT_BENCH_CATALOG[method]

              return (
                <div className="runner-card" key={method}>
                  <div className="runner-head">
                    <div>
                      <div className="eyebrow-row">
                        <span className="badge" data-tone={runner?.available ? 'success' : 'danger'}>
                          {runner?.available ? 'Available' : 'Unavailable'}
                        </span>
                      </div>
                      <h3 className="panel-title">{definition.label}</h3>
                      <p className="runner-copy">{definition.description}</p>
                      <p className="runner-copy">{runner?.details ?? 'Checking runner…'}</p>
                      {runner?.detectedPath ? <p className="code-line">{runner.detectedPath}</p> : null}
                    </div>
                  </div>

                  <div className="runner-controls">
                    <label className="runner-inline">
                      <span>
                        <span className="input-label">Enable</span>
                        <span className="input-help">Run this stack for the current clip.</span>
                      </span>
                      <input
                        type="checkbox"
                        checked={config.enabled}
                        disabled={!runner?.available || isRunning}
                        onChange={(event) => {
                          const enabled = event.currentTarget.checked
                          setRunConfig((current) => ({
                            ...current,
                            [method]: {
                              ...current[method],
                              enabled,
                            },
                          }))
                        }}
                      />
                    </label>

                    <div>
                      <label className="input-label" htmlFor={`${method}-model`}>
                        Model
                      </label>
                      <select
                        id={`${method}-model`}
                        className="native-select"
                        value={config.model}
                        disabled={!runner?.available || isRunning}
                        onChange={(event) => {
                          const model = event.currentTarget.value
                          setRunConfig((current) => ({
                            ...current,
                            [method]: {
                              ...current[method],
                              model,
                            },
                          }))
                        }}
                      >
                        {definition.models.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <p className="runner-copy">
                        {definition.models.find((option) => option.value === config.model)?.description}
                      </p>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </article>
      </section>

      <section className="summary-shell">
        <article className="panel">
          <div className="panel-header">
            <h2 className="panel-title">Run Summary</h2>
            <p className="panel-copy">
              `wall` is end-to-end command time. `processing` is the method-reported internal
              inference time when the runner exposes it.
            </p>
          </div>
          <div className="panel-body">
            {results ? (
              <>
                <div className="summary-top">
                  <span className="badge" data-tone="muted">
                    {results.audio.name}
                  </span>
                  <span className="badge" data-tone="muted">
                    {results.audio.durationSeconds.toFixed(2)}s canonical WAV
                  </span>
                  <span className="badge" data-tone="muted">
                    {formatBytes(results.audio.sizeBytes)}
                  </span>
                </div>

                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Method</th>
                        <th>Model</th>
                        <th>Status</th>
                        <th>Wall</th>
                        <th>Processing</th>
                        <th>Init</th>
                        <th>Decode</th>
                        <th>Wall RTFx</th>
                        <th>Processing RTFx</th>
                        <th>Confidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.results.map((result) => (
                        <tr key={`${result.method}-${result.model}`}>
                          <td>{STT_BENCH_CATALOG[result.method].label}</td>
                          <td>{result.model}</td>
                          <td>
                            <span className="badge" data-tone={resultTone(result)}>
                              {result.status}
                            </span>
                          </td>
                          <td className="metric">{formatMs(result.metrics?.wallMs)}</td>
                          <td className="metric">{formatMs(result.metrics?.processingMs)}</td>
                          <td className="metric">{formatMs(result.metrics?.initMs)}</td>
                          <td className="metric">{formatMs(result.metrics?.decodeMs)}</td>
                          <td className="metric">{formatRtfx(result.metrics?.wallRtfx)}</td>
                          <td className="metric">{formatRtfx(result.metrics?.processingRtfx)}</td>
                          <td className="metric">{formatConfidence(result.metrics?.confidence)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <div className="empty-state">
                Run the workbench to populate comparable metrics and transcripts.
              </div>
            )}
          </div>
        </article>

        {results ? (
          <div className="detail-grid">
            {results.results.map((result) => (
              <article className="detail-card" key={`detail-${result.method}-${result.model}`}>
                <div className="eyebrow-row">
                  <span className="badge" data-tone={resultTone(result)}>
                    {result.status}
                  </span>
                </div>
                <h3 className="panel-title">{STT_BENCH_CATALOG[result.method].label}</h3>
                <p className="runner-copy">{result.model}</p>

                <div className="detail-metrics">
                  <div className="metric-card">
                    <p className="metric-label">Wall</p>
                    <p className="metric-value">{formatMs(result.metrics?.wallMs)}</p>
                  </div>
                  <div className="metric-card">
                    <p className="metric-label">Processing</p>
                    <p className="metric-value">{formatMs(result.metrics?.processingMs)}</p>
                  </div>
                </div>

                <div>
                  <p className="section-label">Transcript</p>
                  <textarea
                    className="native-textarea"
                    readOnly
                    value={result.transcript ?? result.details ?? ''}
                  />
                </div>

                {result.details ? (
                  <div>
                    <p className="section-label">Details</p>
                    <textarea className="native-textarea" readOnly value={result.details} />
                  </div>
                ) : null}

                {result.stderr ? (
                  <div>
                    <p className="section-label">stderr</p>
                    <textarea className="native-textarea" readOnly value={result.stderr} />
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        ) : null}
      </section>
    </main>
  )
}
