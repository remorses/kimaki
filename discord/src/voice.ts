// Audio transcription service using Google Gemini.
// Transcribes voice messages with code-aware context.
// Uses errore for type-safe error handling.

import { GoogleGenAI, Type, type Content } from '@google/genai'
import * as errore from 'errore'
import { createLogger, LogPrefix } from './logger.js'
import {
  ApiKeyMissingError,
  InvalidAudioFormatError,
  TranscriptionError,
  EmptyTranscriptionError,
  NoResponseContentError,
  NoToolResponseError,
} from './errors.js'

const voiceLogger = createLogger(LogPrefix.VOICE)

type TranscriptionLoopError =
  | NoResponseContentError
  | TranscriptionError
  | EmptyTranscriptionError
  | NoToolResponseError

async function runTranscriptionOnce({
  genAI,
  model,
  initialContents,
  temperature,
}: {
  genAI: GoogleGenAI
  model: string
  initialContents: Content[]
  temperature: number
}): Promise<TranscriptionLoopError | string> {
  const response = await errore.tryAsync({
    try: () =>
      genAI.models.generateContent({
        model,

        contents: initialContents,
        config: {

          temperature,
          maxOutputTokens: 2048,
          thinkingConfig: {
            thinkingBudget: 1024,
          },
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'transcriptionResult',
                  description:
                    'MANDATORY: You MUST call this tool to complete the task. This is the ONLY way to return results - text responses are ignored. Call this with your transcription, even if imperfect. An imperfect transcription is better than none.',
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      transcription: {
                        type: Type.STRING,
                        description:
                          'The final transcription of the audio. MUST be non-empty. If audio is unclear, transcribe your best interpretation. If silent, use "[inaudible audio]".',
                      },
                    },
                    required: ['transcription'],
                  },
                },
              ],
            },
          ],
        },
      }),
    catch: (e) => new TranscriptionError({ reason: `API call failed: ${String(e)}`, cause: e }),
  })

  if (response instanceof Error) {
    return response
  }

  const candidate = response.candidates?.[0]
  const parts = candidate?.content?.parts
  if (!parts) {
    const text = response.text?.trim()
    if (text) {
      voiceLogger.log(`No parts but got text response: "${text.slice(0, 100)}..."`)
      return text
    }
    return new NoResponseContentError()
  }

  const call = parts
    .map((part) => part.functionCall)
    .find((functionCall) => functionCall?.name === 'transcriptionResult')

  if (!call) {
    const text = response.text?.trim()
    if (text) {
      voiceLogger.log(`No function call but got text: "${text.slice(0, 100)}..."`)
      return text
    }
    return new TranscriptionError({ reason: 'Model did not produce a transcription' })
  }

  const args = call.args as Record<string, string> | undefined
  const transcription = args?.transcription?.trim() || ''
  voiceLogger.log(`Transcription result received: "${transcription.slice(0, 100)}..."`)

  if (!transcription) {
    return new EmptyTranscriptionError()
  }

  return transcription
}

export type TranscribeAudioErrors =
  | ApiKeyMissingError
  | InvalidAudioFormatError
  | TranscriptionLoopError

export function transcribeAudio({
  audio,
  prompt,
  language,
  temperature,
  geminiApiKey,
  currentSessionContext,
  lastSessionContext,
}: {
  audio: Buffer | Uint8Array | ArrayBuffer | string
  prompt?: string
  language?: string
  temperature?: number
  geminiApiKey?: string
  currentSessionContext?: string
  lastSessionContext?: string
}): Promise<TranscribeAudioErrors | string> {
  const apiKey = geminiApiKey || process.env.GEMINI_API_KEY

  if (!apiKey) {
    return Promise.resolve(new ApiKeyMissingError({ service: 'Gemini' }))
  }

  const genAI = new GoogleGenAI({ apiKey })

  const audioBase64: string = (() => {
    if (typeof audio === 'string') {
      return audio
    }
    if (audio instanceof Buffer) {
      return audio.toString('base64')
    }
    if (audio instanceof Uint8Array) {
      return Buffer.from(audio).toString('base64')
    }
    if (audio instanceof ArrayBuffer) {
      return Buffer.from(audio).toString('base64')
    }
    return ''
  })()

  if (!audioBase64) {
    return Promise.resolve(new InvalidAudioFormatError())
  }

  const languageHint = language ? `The audio is in ${language}.\n\n` : ''

  // build session context section
  const sessionContextParts: string[] = []
  if (lastSessionContext) {
    sessionContextParts.push(`<last_session>
${lastSessionContext}
</last_session>`)
  }
  if (currentSessionContext) {
    sessionContextParts.push(`<current_session>
${currentSessionContext}
</current_session>`)
  }
  const sessionContextSection =
    sessionContextParts.length > 0
      ? `\nSession context (use to understand references to files, functions, tools used):\n${sessionContextParts.join('\n\n')}`
      : ''

  const transcriptionPrompt = `${languageHint}Transcribe this audio for a coding agent (like Claude Code or OpenCode).

 CRITICAL REQUIREMENT: You MUST call the "transcriptionResult" tool to complete this task.
 - The transcriptionResult tool is the ONLY way to return results
 - Text responses are completely ignored - only tool calls work
 - You MUST call transcriptionResult even if you run out of tool calls
 - Always call transcriptionResult with your best approximation of what was said
 - DO NOT end without calling transcriptionResult

This is a software development environment. The speaker is giving instructions to an AI coding assistant. Expect:
- File paths, function names, CLI commands, package names, API endpoints

 RULES:
 - If audio is unclear, transcribe your best interpretation, even with strong accents. Always provide an approximation.
 - If audio seems silent/empty, call transcriptionResult with "[inaudible audio]"
 - Use the session context below to understand technical terms, file names, function names mentioned

Common corrections (apply without tool calls):
- "reacked" → "React", "jason" → "JSON", "get hub" → "GitHub", "no JS" → "Node.js", "dacker" → "Docker"

Project file structure:
<file_tree>
${prompt}
</file_tree>
${sessionContextSection}

REMEMBER: Call "transcriptionResult" tool with your transcription. This is mandatory.

Note: "critique" is a CLI tool for showing diffs in the browser.`

  const initialContents: Content[] = [
    {
      role: 'user',
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
  ]

  return runTranscriptionOnce({
    genAI,
    model: 'gemini-2.5-flash',
    initialContents,
    temperature: temperature ?? 0.3,
  })
}
