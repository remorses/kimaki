import { openai } from '@ai-sdk/openai'
import { experimental_transcribe as transcribe } from 'ai'
import { createLogger } from './logger.js'

const voiceLogger = createLogger('VOICE')

export async function transcribeAudio({
  audio,
  prompt,
  language,
  temperature,
}: {
  audio: Buffer | Uint8Array | ArrayBuffer | string
  prompt?: string
  language?: string
  temperature?: number
}): Promise<string> {
  try {
    const result = await transcribe({
      model: openai.transcription('whisper-1'),
      audio,
      ...(prompt || language || temperature !== undefined ? {
        providerOptions: {
          openai: {
            ...(prompt && { prompt }),
            ...(language && { language }),
            ...(temperature !== undefined && { temperature }),
          }
        }
      } : {})
    })

    return result.text
  } catch (error) {
    voiceLogger.error('Failed to transcribe audio:', error)
    throw new Error(`Audio transcription failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
  }
}
