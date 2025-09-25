import { createOpenAI } from '@ai-sdk/openai'
import { experimental_transcribe as transcribe } from 'ai'
import { createLogger } from './logger.js'

const voiceLogger = createLogger('VOICE')

export async function transcribeAudio({
  audio,
  prompt,
  language,
  temperature,
  openaiApiKey,
}: {
  audio: Buffer | Uint8Array | ArrayBuffer | string
  prompt?: string
  language?: string
  temperature?: number
  openaiApiKey?: string
}): Promise<string> {
  try {
    // Use provided API key or fall back to environment variable
    const apiKey = openaiApiKey || process.env.OPENAI_API_KEY
    
    if (!apiKey) {
      throw new Error('OpenAI API key is required for audio transcription')
    }
    
    // Create OpenAI provider instance with the API key
    const openaiProvider = createOpenAI({
      apiKey,
    })
    
    const result = await transcribe({
      model: openaiProvider.transcription('whisper-1'),
      audio,
      ...(prompt || language || temperature !== undefined
        ? {
            providerOptions: {
              openai: {
                ...(prompt && { prompt }),
                ...(language && { language }),
                ...(temperature !== undefined && { temperature }),
              },
            },
          }
        : {}),
    })

    return result.text
  } catch (error) {
    voiceLogger.error('Failed to transcribe audio:', error)
    throw new Error(
      `Audio transcription failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}
