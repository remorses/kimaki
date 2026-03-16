// Audio transcription service using AI SDK providers.
// Supports three providers:
//   - openai: GPT-4o audio (requires OpenAI API key)
//   - gemini: Gemini 2.5 Flash (requires Google API key)  
//   - parakeet: Local NVIDIA Parakeet via MLX (no API key needed!)
//
// For OpenAI/Gemini: Uses LanguageModelV3 (chat model) with audio file parts + tool calling.
// For Parakeet: Uses local HTTP service (asr-service/asr_server.py)
//   - Install: cd asr-service && pip install -r requirements.txt
//   - Run: python asr_server.py
//   - Set: ASR_PROVIDER=parakeet or provider: 'parakeet'

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FunctionTool,
  LanguageModelV3Content,
  LanguageModelV3ToolCall,
} from '@ai-sdk/provider'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { Readable } from 'node:stream'
import prism from 'prism-media'
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

const ASR_SERVICE_URL = process.env.ASR_SERVICE_URL || 'http://127.0.0.1:8765'

// Environment variable for default ASR provider
const DEFAULT_ASR_PROVIDER = (() => {
  const env = process.env.ASR_PROVIDER?.toLowerCase()
  if (env === 'parakeet' || env === 'openai' || env === 'gemini') {
    return env as TranscriptionProvider
  }
  return 'gemini' as TranscriptionProvider
})()

const voiceLogger = createLogger(LogPrefix.VOICE)

// OpenAI input_audio only supports wav and mp3. Other formats (OGG Opus, etc)
// must be converted before sending.
const OPENAI_SUPPORTED_AUDIO_TYPES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
])

const OGG_AUDIO_TYPES = new Set([
  'audio/ogg',
  'audio/opus',
])

const M4A_AUDIO_TYPES = new Set([
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
])

export function normalizeAudioMediaType(mediaType: string): string {
  const normalized = mediaType.trim().toLowerCase()
  if (normalized === 'audio/x-m4a' || normalized === 'audio/m4a') {
    return 'audio/mp4'
  }
  return normalized
}

type OpenAIAudioConversionStrategy =
  | 'none'
  | 'convert-ogg-to-wav'
  | 'convert-m4a-to-wav'
  | 'unsupported'

export function getOpenAIAudioConversionStrategy(
  mediaType: string,
): OpenAIAudioConversionStrategy {
  if (OPENAI_SUPPORTED_AUDIO_TYPES.has(mediaType)) {
    return 'none'
  }
  if (OGG_AUDIO_TYPES.has(mediaType)) {
    return 'convert-ogg-to-wav'
  }
  if (M4A_AUDIO_TYPES.has(mediaType)) {
    return 'convert-m4a-to-wav'
  }
  return 'unsupported'
}

/**
 * Convert OGG Opus audio to WAV using prism-media (already installed for Discord voice).
 * Pipeline: OGG buffer → OggDemuxer → Opus Decoder → PCM → WAV (with header).
 * No ffmpeg needed — uses @discordjs/opus native bindings.
 */
export function convertOggToWav(input: Buffer): Promise<TranscriptionError | Buffer> {
  return new Promise((resolve) => {
    const pcmChunks: Buffer[] = []

    const demuxer = new prism.opus.OggDemuxer()
    const decoder = new prism.opus.Decoder({
      rate: 48000,
      channels: 1,
      frameSize: 960,
    })

    decoder.on('data', (chunk: Buffer) => {
      pcmChunks.push(chunk)
    })

    decoder.on('end', () => {
      const pcmData = Buffer.concat(pcmChunks)
      const wavHeader = createWavHeader({
        dataLength: pcmData.length,
        sampleRate: 48000,
        numChannels: 1,
        bitsPerSample: 16,
      })
      resolve(Buffer.concat([wavHeader, pcmData]))
    })

    decoder.on('error', (err: Error) => {
      resolve(
        new TranscriptionError({
          reason: `Opus decode failed: ${err.message}`,
          cause: err,
        }),
      )
    })

    demuxer.on('error', (err: Error) => {
      resolve(
        new TranscriptionError({
          reason: `OGG demux failed: ${err.message}`,
          cause: err,
        }),
      )
    })

    Readable.from(input).pipe(demuxer).pipe(decoder)
  })
}

/**
 * Convert M4A/MP4 audio to WAV using prism-media FFmpeg wrapper.
 * This depends on an ffmpeg binary available in PATH.
 */
export function convertM4aToWav(input: Buffer): Promise<TranscriptionError | Buffer> {
  return new Promise((resolve) => {
    const pcmChunks: Buffer[] = []
    const transcoder = new prism.FFmpeg({
      args: [
        '-analyzeduration',
        '0',
        '-loglevel',
        '0',
        '-f',
        'mp4',
        '-i',
        'pipe:0',
        '-f',
        's16le',
        '-acodec',
        'pcm_s16le',
        '-ac',
        '1',
        '-ar',
        '48000',
        'pipe:1',
      ],
    })

    transcoder.on('data', (chunk: Buffer) => {
      pcmChunks.push(chunk)
    })

    transcoder.on('end', () => {
      const pcmData = Buffer.concat(pcmChunks)
      if (pcmData.length === 0) {
        resolve(
          new TranscriptionError({
            reason: 'FFmpeg conversion produced empty audio output',
          }),
        )
        return
      }

      const wavHeader = createWavHeader({
        dataLength: pcmData.length,
        sampleRate: 48000,
        numChannels: 1,
        bitsPerSample: 16,
      })
      resolve(Buffer.concat([wavHeader, pcmData]))
    })

    transcoder.on('error', (err: Error) => {
      const lower = err.message.toLowerCase()
      const isMissingFfmpeg =
        lower.includes('ffmpeg') &&
        (lower.includes('not found') ||
          lower.includes('enoent') ||
          lower.includes('spawn'))
      if (isMissingFfmpeg) {
        resolve(
          new TranscriptionError({
            reason:
              'M4A transcription with OpenAI requires ffmpeg to be installed and available in PATH',
            cause: err,
          }),
        )
        return
      }

      resolve(
        new TranscriptionError({
          reason: `M4A decode failed: ${err.message}`,
          cause: err,
        }),
      )
    })

    Readable.from(input).pipe(transcoder)
  })
}

function createWavHeader({
  dataLength,
  sampleRate,
  numChannels,
  bitsPerSample,
}: {
  dataLength: number
  sampleRate: number
  numChannels: number
  bitsPerSample: number
}): Buffer {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8
  const blockAlign = (numChannels * bitsPerSample) / 8
  const buffer = Buffer.alloc(44)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataLength, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(numChannels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bitsPerSample, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataLength, 40)
  return buffer
}

type TranscriptionLoopError =
  | NoResponseContentError
  | TranscriptionError
  | EmptyTranscriptionError
  | NoToolResponseError

const transcriptionTool: LanguageModelV3FunctionTool = {
  type: 'function',
  name: 'transcriptionResult',
  description:
    'MANDATORY: You MUST call this tool to complete the task. This is the ONLY way to return results - text responses are ignored. Call this with your transcription, even if imperfect. An imperfect transcription is better than none.',
  inputSchema: {
    type: 'object',
    properties: {
      transcription: {
        type: 'string',
        description:
          'The final transcription of the audio. MUST be non-empty. If audio is unclear, transcribe your best interpretation. If silent, too short to understand, or completely incomprehensible, use "[inaudible audio]".',
      },
      queueMessage: {
        type: 'boolean',
        description:
          'Set to true ONLY if the user explicitly says "queue this message", "queue this", or similar phrasing indicating they want this message queued instead of sent immediately. If not mentioned, omit or set to false.',
      },
    },
    required: ['transcription'],
  },
}

export type TranscriptionResult = {
  transcription: string
  queueMessage: boolean
}

/**
 * Extract transcription result from doGenerate content array.
 * Looks for a tool-call named 'transcriptionResult', falls back to text content.
 * Returns structured result with transcription text and queueMessage flag.
 */
export function extractTranscription(
  content: Array<LanguageModelV3Content>,
): TranscriptionLoopError | TranscriptionResult {
  const toolCall = content.find(
    (c): c is LanguageModelV3ToolCall =>
      c.type === 'tool-call' && c.toolName === 'transcriptionResult',
  )

  if (toolCall) {
    // toolCall.input is a JSON string in LanguageModelV3
    const args: Record<string, unknown> = (() => {
      if (typeof toolCall.input === 'string') {
        return JSON.parse(toolCall.input) as Record<string, unknown>
      }
      return {}
    })()
    const transcription = (typeof args.transcription === 'string' ? args.transcription : '').trim()
    const queueMessage = args.queueMessage === true
    voiceLogger.log(
      `Transcription result received: "${transcription.slice(0, 100)}..."${queueMessage ? ' [QUEUE]' : ''}`,
    )
    if (!transcription) {
      return new EmptyTranscriptionError()
    }
    return { transcription, queueMessage }
  }

  // Fall back to text content if no tool call
  const textPart = content.find((c) => c.type === 'text')
  if (textPart && textPart.type === 'text' && textPart.text.trim()) {
    voiceLogger.log(
      `No tool call but got text: "${textPart.text.trim().slice(0, 100)}..."`,
    )
    return { transcription: textPart.text.trim(), queueMessage: false }
  }

  if (content.length === 0) {
    return new NoResponseContentError()
  }

  return new TranscriptionError({
    reason: 'Model did not produce a transcription',
  })
}

async function runTranscriptionOnce({
  model,
  prompt,
  audioBase64,
  mediaType,
  temperature,
}: {
  model: LanguageModelV3
  prompt: string
  audioBase64: string
  mediaType: string
  temperature: number
}): Promise<TranscriptionLoopError | TranscriptionResult> {
  const options: LanguageModelV3CallOptions = {
    prompt: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'file',
            data: audioBase64,
            mediaType,
          },
        ],
      },
    ],
    temperature,
    maxOutputTokens: 2048,
    tools: [transcriptionTool],
    toolChoice: { type: 'tool', toolName: 'transcriptionResult' },
    providerOptions: {
      google: {
        thinkingConfig: { thinkingBudget: 1024 },
      },
    },
  }

  // doGenerate returns PromiseLike, wrap in Promise.resolve for errore compatibility
  const response = await errore.tryAsync({
    try: () => Promise.resolve(model.doGenerate(options)),
    catch: (e: Error) =>
      new TranscriptionError({
        reason: `API call failed: ${String(e)}`,
        cause: e,
      }),
  })

  if (response instanceof TranscriptionError) {
    return response
  }

  return extractTranscription(response.content)
}

export type TranscribeAudioErrors =
  | ApiKeyMissingError
  | InvalidAudioFormatError
  | TranscriptionLoopError

export type TranscriptionProvider = 'openai' | 'gemini' | 'parakeet'

/**
 * Create a LanguageModelV3 for transcription.
 * Both providers use chat models that accept audio file parts, so we get full
 * context (prompt, session info, tool calling) for better word recognition.
 *
 * OpenAI: must use .chat() to get the Chat Completions API model, because the
 * default callable (Responses API) doesn't support audio file parts.
 * Gemini: language models natively accept audio in chat.
 */
export function createTranscriptionModel({
  apiKey,
  provider,
}: {
  apiKey: string
  provider?: TranscriptionProvider
}): LanguageModelV3 {
  const resolvedProvider: TranscriptionProvider =
    provider || (apiKey.startsWith('sk-') ? 'openai' : 'gemini')

  if (resolvedProvider === 'openai') {
    const openai = createOpenAI({ apiKey })
    return openai.chat('gpt-4o-audio-preview')
  }

  const google = createGoogleGenerativeAI({ apiKey })
  return google('gemini-2.5-flash')
}

/**
 * Transcribe audio using local parakeet-mlx service.
 * Requires the ASR service to be running (python asr_server.py)
 */
export async function transcribeWithParakeet({
  audioBuffer,
  mediaType,
}: {
  audioBuffer: Buffer
  mediaType: string
}): Promise<TranscriptionError | TranscriptionResult> {
  const audioBase64 = audioBuffer.toString('base64')

  voiceLogger.log(`Transcribing with parakeet-mlx service at ${ASR_SERVICE_URL}`)

  try {
    const response = await fetch(`${ASR_SERVICE_URL}/transcribe/base64`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audio_data: audioBase64,
        media_type: mediaType,
        language: 'en',
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      return new TranscriptionError({
        reason: `Parakeet service error: ${response.status} - ${errorText}`,
      })
    }

    const result = await response.json() as { text: string }

    if (!result.text || result.text.trim() === '') {
      return new EmptyTranscriptionError()
    }

    voiceLogger.log(`Parakeet transcription: "${result.text.slice(0, 50)}..."`)

    return {
      transcription: result.text.trim(),
      queueMessage: false,
    }
  } catch (error) {
    const err = error as Error
    // Check if service is running
    if (err.message.includes('ECONNREFUSED')) {
      return new TranscriptionError({
        reason: 'Parakeet ASR service is not running. Start it with: cd asr-service && pip install -r requirements.txt && python asr_server.py',
        cause: err,
      })
    }
    return new TranscriptionError({
      reason: `Parakeet transcription failed: ${err.message}`,
      cause: err,
    })
  }
}

/**
 * Check if the parakeet service is available.
 */
export async function checkParakeetService(): Promise<boolean> {
  try {
    const response = await fetch(`${ASR_SERVICE_URL}/health`, {
      method: 'GET',
    })
    return response.ok
  } catch {
    return false
  }
}

export async function transcribeAudio({
  audio,
  prompt,
  language,
  temperature,
  apiKey: apiKeyParam,
  model,
  provider,
  mediaType: mediaTypeParam,
  currentSessionContext,
  lastSessionContext,
}: {
  audio: Buffer | Uint8Array | ArrayBuffer | string
  prompt?: string
  language?: string
  temperature?: number
  apiKey?: string
  model?: LanguageModelV3
  provider?: TranscriptionProvider
  /** MIME type of the audio data (e.g. 'audio/ogg'). Defaults to 'audio/mpeg'. */
  mediaType?: string
  currentSessionContext?: string
  lastSessionContext?: string
}): Promise<TranscribeAudioErrors | TranscriptionResult> {
  const apiKey =
    apiKeyParam || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY

  // Parakeet doesn't require an API key (local transcription)
  const requiresApiKey = provider !== 'parakeet' && !model

  if (requiresApiKey && !apiKey) {
    return Promise.resolve(new ApiKeyMissingError({ service: 'OpenAI or Gemini' }))
  }

  const resolvedProvider: TranscriptionProvider = (() => {
    if (provider) {
      return provider
    }
    // Use environment variable as default (ASR_PROVIDER=parakeet|openai|gemini)
    if (DEFAULT_ASR_PROVIDER) {
      return DEFAULT_ASR_PROVIDER
    }
    if (apiKey) {
      return apiKey.startsWith('sk-') ? 'openai' : 'gemini'
    }
    // Default to parakeet if no API key is provided (local fallback)
    return 'parakeet'
  })()

  // Handle parakeet (local) transcription - no API key needed
  if (resolvedProvider === 'parakeet') {
    // Convert audio to Buffer
    const audioBuffer: Buffer = (() => {
      if (typeof audio === 'string') {
        return Buffer.from(audio, 'base64')
      }
      if (audio instanceof Buffer) {
        return audio
      }
      if (audio instanceof ArrayBuffer) {
        return Buffer.from(new Uint8Array(audio))
      }
      return Buffer.from(audio)
    })()

    if (audioBuffer.length === 0) {
      return new InvalidAudioFormatError()
    }

    const mediaType = normalizeAudioMediaType(mediaTypeParam || 'audio/mpeg')
    return transcribeWithParakeet({
      audioBuffer,
      mediaType,
    })
  }

  const languageModel: LanguageModelV3 =
    model || createTranscriptionModel({ apiKey: apiKey!, provider: resolvedProvider })

  // Convert audio to Buffer for potential format conversion
  const audioBuffer: Buffer = (() => {
    if (typeof audio === 'string') {
      return Buffer.from(audio, 'base64')
    }
    if (audio instanceof Buffer) {
      return audio
    }
    if (audio instanceof ArrayBuffer) {
      return Buffer.from(new Uint8Array(audio))
    }
    return Buffer.from(audio)
  })()

  if (audioBuffer.length === 0) {
    return new InvalidAudioFormatError()
  }

  let mediaType = normalizeAudioMediaType(mediaTypeParam || 'audio/mpeg')
  let finalAudioBase64 = audioBuffer.toString('base64')

  // OpenAI input_audio supports only a subset of audio formats.
  // Convert based on MIME so OGG conversion runs only for real OGG/Opus inputs.
  if (resolvedProvider === 'openai') {
    const conversionStrategy = getOpenAIAudioConversionStrategy(mediaType)
    if (conversionStrategy === 'convert-ogg-to-wav') {
      voiceLogger.log(`Converting ${mediaType} to WAV for OpenAI compatibility`)
      const converted = await convertOggToWav(audioBuffer)
      if (converted instanceof Error) {
        return converted
      }
      finalAudioBase64 = converted.toString('base64')
      mediaType = 'audio/wav'
    } else if (conversionStrategy === 'convert-m4a-to-wav') {
      voiceLogger.log(`Converting ${mediaType} to WAV for OpenAI compatibility`)
      const converted = await convertM4aToWav(audioBuffer)
      if (converted instanceof Error) {
        return converted
      }
      finalAudioBase64 = converted.toString('base64')
      mediaType = 'audio/wav'
    } else if (conversionStrategy === 'unsupported') {
      return new InvalidAudioFormatError()
    }
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
      ? `\n<session_context>
${sessionContextParts.join('\n\n')}
</session_context>`
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
 - NEVER change the meaning or intent of the user's message. Your job is ONLY to transcribe, not to respond or answer.
 - If the user asks a question, keep it as a question. Do NOT answer it. Do NOT rephrase it as a statement.
 - Only fix grammar, punctuation, and markdown formatting. Preserve the original content faithfully.
 - If audio is unclear, transcribe your best interpretation, even with strong accents. Always provide an approximation.
 - If audio seems silent/empty, is too short to understand, or is completely incomprehensible, call transcriptionResult with "[inaudible audio]"
 - The session context below is ONLY for understanding technical terms, file names, and function names. It may contain previous transcriptions — NEVER copy or reuse them. Always transcribe fresh from the current audio.

 QUEUE DETECTION:
 - If the user says "queue this message", "queue this", "add this to the queue", or similar phrasing indicating they want the message queued instead of sent immediately, set queueMessage to true.
 - Remove the queue instruction from the transcription text itself — only include the actual message content.
 - Example: "Queue this message. Fix the login bug in auth.ts" → transcription: "Fix the login bug in auth.ts", queueMessage: true
 - If removing the queue phrase would leave empty content (user only said "queue this" with nothing else), keep the full spoken text as the transcription — never return an empty transcription.
 - If no queue intent is detected, omit queueMessage or set it to false.

Common corrections (apply without tool calls):
- "reacked" → "React", "jason" → "JSON", "get hub" → "GitHub", "no JS" → "Node.js", "dacker" → "Docker"

Project file structure:
<file_tree>
${prompt}
</file_tree>
${sessionContextSection}

REMEMBER: Call "transcriptionResult" tool with your transcription. This is mandatory.

Note: "critique" is a CLI tool for showing diffs in the browser.`

  return runTranscriptionOnce({
    model: languageModel,
    prompt: transcriptionPrompt,
    audioBase64: finalAudioBase64,
    mediaType,
    temperature: temperature ?? 0.3,
  })
}
