import { GoogleGenAI } from '@google/genai'
import { createLogger } from './logger.js'

const voiceLogger = createLogger('VOICE')

export async function transcribeAudio({
  audio,
  prompt,
  language,
  temperature,
  geminiApiKey,
}: {
  audio: Buffer | Uint8Array | ArrayBuffer | string
  prompt?: string
  language?: string
  temperature?: number
  geminiApiKey?: string
}): Promise<string> {
  try {
    // Use provided API key or fall back to environment variable
    const apiKey = geminiApiKey || process.env.GEMINI_API_KEY

    if (!apiKey) {
      throw new Error('Gemini API key is required for audio transcription')
    }

    // Initialize Google Generative AI
    const genAI = new GoogleGenAI({ apiKey })

    // Convert audio to base64 string if it's not already
    let audioBase64: string
    if (typeof audio === 'string') {
      audioBase64 = audio
    } else if (audio instanceof Buffer) {
      audioBase64 = audio.toString('base64')
    } else if (audio instanceof Uint8Array) {
      audioBase64 = Buffer.from(audio).toString('base64')
    } else if (audio instanceof ArrayBuffer) {
      audioBase64 = Buffer.from(audio).toString('base64')
    } else {
      throw new Error('Invalid audio format')
    }

    // Build the transcription prompt
    let transcriptionPrompt = `Transcribe this audio accurately. The transcription will be sent to a coding agent (like Claude Code) to execute programming tasks.

Assume the speaker is using technical and programming terminology: file paths, function names, CLI commands, package names, API names, programming concepts, etc. Prioritize technical accuracy over literal transcription - if a word sounds like a common programming term, prefer that interpretation.

If the spoken message is unclear or ambiguous, rephrase it to better convey the intended meaning for a coding agent. The goal is effective communication of the user's programming intent, not a word-for-word transcription.

Here are relevant filenames and context that may appear in the audio:
<context>
${prompt}
</context>
`
    if (language) {
      transcriptionPrompt += `\nThe audio is in ${language}.`
    }

    // Create the content with audio using the inline data format
    const response = await genAI.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          parts: [
            { text: transcriptionPrompt },
            {
              inlineData: {
                data: audioBase64,
                mimeType: 'audio/mpeg',
              },
            },
          ],
        },
      ],
      config:
        temperature !== undefined
          ? {
              temperature,
            }
          : undefined,
    })

    return response.text || ''
  } catch (error) {
    voiceLogger.error('Failed to transcribe audio:', error)
    throw new Error(
      `Audio transcription failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}
