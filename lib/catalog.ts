export type BenchMethod = 'fluid' | 'sherpa-python' | 'sherpa-go'

export interface BenchModelOption {
  description: string
  label: string
  value: string
}

export interface BenchMethodDefinition {
  description: string
  label: string
  models: BenchModelOption[]
}

export const STT_BENCH_CATALOG: Record<BenchMethod, BenchMethodDefinition> = {
  fluid: {
    label: 'FluidAudio',
    description: 'Apple-native CoreML benchmark via the FluidAudio CLI on this Mac.',
    models: [
      {
        value: 'v3',
        label: 'Parakeet TDT v3',
        description: 'Default FluidAudio batch transcription path.',
      },
      {
        value: 'v2',
        label: 'Parakeet TDT v2',
        description: 'Older FluidAudio TDT CoreML checkpoint.',
      },
      {
        value: 'tdt-ctc-110m',
        label: 'Parakeet TDT CTC 110m',
        description: 'Smaller hybrid checkpoint exposed by the CLI.',
      },
    ],
  },
  'sherpa-python': {
    label: 'sherpa-onnx',
    description:
      'Mainline sherpa-onnx via Python bindings using the CoreML execution provider.',
    models: [
      {
        value: 'parakeet-v3',
        label: 'Parakeet TDT v3 int8',
        description: 'sherpa-onnx NeMo transducer bundle for Parakeet TDT v3.',
      },
      {
        value: 'parakeet-v2',
        label: 'Parakeet TDT v2 int8',
        description: 'sherpa-onnx NeMo transducer bundle for Parakeet TDT v2.',
      },
    ],
  },
  'sherpa-go': {
    label: 'sherpa-onnx-go-macos',
    description:
      'The macOS Go adapter running the same sherpa CoreML path through cgo.',
    models: [
      {
        value: 'parakeet-v3',
        label: 'Parakeet TDT v3 int8',
        description: 'Go adapter wrapped around the sherpa Parakeet TDT v3 CoreML path.',
      },
      {
        value: 'parakeet-v2',
        label: 'Parakeet TDT v2 int8',
        description: 'Go adapter wrapped around the sherpa Parakeet TDT v2 CoreML path.',
      },
    ],
  },
}

export const DEFAULT_STT_BENCH_RUNS = [
  { method: 'fluid', model: 'v3' },
  { method: 'sherpa-python', model: 'parakeet-v3' },
  { method: 'sherpa-go', model: 'parakeet-v3' },
] as const
