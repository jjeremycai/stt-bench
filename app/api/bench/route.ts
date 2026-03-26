import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  cleanupPreparedAudio,
  getBenchStatus,
  prepareUploadedAudio,
  runBenchmarks,
} from '@/lib/runners'

const runItemSchema = z.object({
  method: z.enum(['fluid', 'sherpa-python', 'sherpa-go']),
  model: z.string().min(1).max(64),
})

const runsSchema = z.array(runItemSchema).min(1).max(3)

export async function GET() {
  try {
    return NextResponse.json(await getBenchStatus())
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to resolve STT bench status',
      },
      { status: 500 },
    )
  }
}

export async function POST(request: Request) {
  let prepared: Awaited<ReturnType<typeof prepareUploadedAudio>> | undefined

  try {
    const formData = (await request.formData()) as unknown as {
      get(name: string): FormDataEntryValue | null
    }

    const audio = formData.get('audio')
    const runsRaw = formData.get('runs')

    if (!(audio instanceof File)) {
      return NextResponse.json(
        { error: 'Audio file is required in form-data' },
        { status: 400 },
      )
    }

    if (audio.size <= 0) {
      return NextResponse.json(
        { error: 'Uploaded audio file is empty' },
        { status: 400 },
      )
    }

    if (typeof runsRaw !== 'string') {
      return NextResponse.json(
        { error: 'runs must be a JSON string in form-data' },
        { status: 400 },
      )
    }

    const parsedRuns = runsSchema.safeParse(JSON.parse(runsRaw))
    if (!parsedRuns.success) {
      return NextResponse.json(
        {
          error: parsedRuns.error.issues[0]?.message ?? 'Invalid runs payload',
        },
        { status: 400 },
      )
    }

    prepared = await prepareUploadedAudio(audio)

    const response = await runBenchmarks({
      audioDurationSeconds: prepared.audioDurationSeconds,
      canonicalPath: prepared.canonicalPath,
      runs: parsedRuns.data,
      audio: {
        canonicalName: prepared.canonicalName,
        originalName: prepared.originalName,
        sizeBytes: prepared.sizeBytes,
        type: prepared.type,
      },
    })

    return NextResponse.json(response)
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to run STT benchmark',
      },
      { status: 500 },
    )
  } finally {
    if (prepared) {
      await cleanupPreparedAudio(prepared.tempDir)
    }
  }
}

export const runtime = 'nodejs'
