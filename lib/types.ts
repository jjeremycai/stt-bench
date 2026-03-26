import type { BenchMethod } from './catalog'

export interface BenchRunnerStatus {
  available: boolean
  details: string
  detectedPath?: string
  method: BenchMethod
  modelCacheRoot?: string
}

export interface BenchRunRequestItem {
  method: BenchMethod
  model: string
}

export interface BenchRunMetrics {
  audioDurationSeconds: number
  confidence?: number
  decodeMs?: number
  initMs?: number
  processingMs?: number
  processingRtfx?: number
  totalMs?: number
  wallMs?: number
  wallRtfx?: number
}

export interface BenchRunResult {
  command?: string[]
  details?: string
  method: BenchMethod
  metrics?: BenchRunMetrics
  model: string
  runnerPath?: string
  status: 'ok' | 'error' | 'unavailable'
  stderr?: string
  stdout?: string
  transcript?: string
}

export interface BenchStatusResponse {
  audioTools: {
    details: string
    ffmpegPath?: string
    ffprobePath?: string
    ready: boolean
  }
  catalogVersion: 1
  runners: BenchRunnerStatus[]
}

export interface BenchRunResponse {
  audio: {
    canonicalName: string
    durationSeconds: number
    name: string
    sizeBytes: number
    type: string
  }
  results: BenchRunResult[]
}
