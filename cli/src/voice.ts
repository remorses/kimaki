// Audio transcription and TTS with plain fetch calls to OpenAI and Gemini.
// Transcription sends the audio plus a forced tool call, so we can pass full
// context (file tree, session info) for better word recognition and read
// routing hints (queue, new session, agent) as structured arguments.
//   - OpenAI: Chat Completions with gpt-audio input_audio parts.
//     https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
//   - Gemini: models.generateContent with inlineData audio parts.
//     https://ai.google.dev/api/generate-content
// No AI SDK: its Gemini response schema turned transient bad bodies into an
// opaque "Invalid JSON response". Parsing the body ourselves keeps the details.
// Uses errore for type-safe error handling.

import { Readable } from 'node:stream'
import * as errore from 'errore'
import prism from 'prism-media'

import { createLogger, LogPrefix } from './logger.js'
import {
  ApiKeyMissingError,
  InvalidAudioFormatError,
  TranscriptionError,
  TranscriptionApiError,
  EmptyTranscriptionError,
  NoResponseContentError,
  NoToolResponseError,
  SpeechGenerationError,
  type SpeechGenerationErrors,
} from './errors.js'

const voiceLogger = createLogger(LogPrefix.VOICE)

const OPENAI_BASE_URL = 'https://api.openai.com/v1'
const OPENAI_AUDIO_CHAT_MODEL = 'gpt-audio-1.5'
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
export const GEMINI_TRANSCRIPTION_MODEL = 'gemini-flash-latest'
const TRANSCRIPTION_TOOL_NAME = 'transcriptionResult'

export type TranscriptionTool = {
  name: string
  description: string
  /** JSON Schema object. Both OpenAI and Gemini `parameters` accept this subset. */
  inputSchema: Record<string, unknown>
}

// POST JSON and return the raw body. Non-2xx becomes TranscriptionApiError
// so the retry logic can decide by status.
async function postJson({
  url,
  headers,
  body,
}: {
  url: string
  headers: Record<string, string>
  body: unknown
}): Promise<TranscriptionError | TranscriptionApiError | string> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).catch((cause) => {
    return new TranscriptionError({ reason: `API call failed: ${String(cause)}`, cause })
  })
  if (response instanceof Error) return response
  const raw = await response.text().catch((cause) => {
    return new TranscriptionError({ reason: `Reading response failed: ${String(cause)}`, cause })
  })
  if (raw instanceof Error) return raw
  if (!response.ok) {
    return new TranscriptionApiError({ status: response.status, body: raw.slice(0, 500) })
  }
  return raw
}

export async function requestOpenAIAudioTranscription({
  apiKey,
  baseUrl = OPENAI_BASE_URL,
  prompt,
  audioBase64,
  mediaType,
  temperature,
  tool,
}: {
  apiKey: string
  baseUrl?: string
  prompt: string
  audioBase64: string
  mediaType: string
  temperature: number
  tool: TranscriptionTool
}): Promise<TranscriptionLoopError | TranscriptionResult> {
  const audioFormat = mediaType.includes('wav') ? 'wav' : 'mp3'
  const raw = await postJson({
    url: `${baseUrl}/chat/completions`,
    headers: { Authorization: `Bearer ${apiKey}` },
    body: {
      model: OPENAI_AUDIO_CHAT_MODEL,
      temperature,
      max_completion_tokens: 2048,
      user: 'kimaki:voice-transcription',
      safety_identifier: 'kimaki:voice-transcription',
      tools: [
        {
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: TRANSCRIPTION_TOOL_NAME } },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'input_audio',
              input_audio: { data: audioBase64, format: audioFormat },
            },
          ],
        },
      ],
    },
  })
  if (raw instanceof Error) return raw
  return parseOpenAIAudioChatResponse(raw)
}

// Request shape: https://ai.google.dev/api/generate-content#request-body
// Forced tool call: https://ai.google.dev/api/caching#FunctionCallingConfig (mode ANY)
// Thinking budget: https://ai.google.dev/gemini-api/docs/thinking
export async function requestGeminiAudioTranscription({
  apiKey,
  baseUrl = GEMINI_BASE_URL,
  prompt,
  audioBase64,
  mediaType,
  temperature,
  tool,
}: {
  apiKey: string
  baseUrl?: string
  prompt: string
  audioBase64: string
  mediaType: string
  temperature: number
  tool: TranscriptionTool
}): Promise<TranscriptionLoopError | TranscriptionResult> {
  const raw = await postJson({
    url: `${baseUrl}/models/${GEMINI_TRANSCRIPTION_MODEL}:generateContent`,
    headers: { 'x-goog-api-key': apiKey },
    body: {
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            { inlineData: { mimeType: mediaType, data: audioBase64 } },
          ],
        },
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          ],
        },
      ],
      toolConfig: {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: [TRANSCRIPTION_TOOL_NAME],
        },
      },
      generationConfig: {
        temperature,
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingBudget: 1024 },
      },
    },
  })
  if (raw instanceof Error) return raw
  return parseGeminiTranscriptionResponse(raw)
}

type GeminiPart = {
  text?: string
  thought?: boolean
  functionCall?: { name?: string; args?: Record<string, unknown> }
  inlineData?: { mimeType?: string; data?: string }
}

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] }
    finishReason?: string
  }>
  promptFeedback?: { blockReason?: string }
}

function parseGeminiResponse(body: string): TranscriptionError | GeminiResponse {
  return errore.try(
    () => JSON.parse(body) as GeminiResponse,
    (cause) => new TranscriptionError({ reason: `Invalid JSON response: ${body.slice(0, 300)}`, cause }),
  )
}

// Response shape: https://ai.google.dev/api/generate-content#v1beta.GenerateContentResponse
// No candidates means the prompt was rejected (see promptFeedback). A candidate
// with no parts usually has a finishReason like MALFORMED_FUNCTION_CALL.
export function parseGeminiTranscriptionResponse(
  body: string,
): TranscriptionLoopError | TranscriptionResult {
  const parsed = parseGeminiResponse(body)
  if (parsed instanceof Error) return parsed
  const candidate = parsed.candidates?.[0]
  if (!candidate) {
    const blockReason = parsed.promptFeedback?.blockReason
    return new TranscriptionError({
      reason: blockReason
        ? `Gemini blocked the prompt: ${blockReason}`
        : `Gemini returned no candidates: ${body.slice(0, 300)}`,
    })
  }
  const parts = candidate.content?.parts ?? []
  const content: TranscriptionContent[] = parts.flatMap((part): TranscriptionContent[] => {
    if (part.functionCall?.name) {
      return [{
        type: 'tool-call',
        toolName: part.functionCall.name,
        input: JSON.stringify(part.functionCall.args ?? {}),
      }]
    }
    if (typeof part.text === 'string') {
      return [{ type: part.thought ? 'reasoning' : 'text', text: part.text }]
    }
    return []
  })
  if (content.length === 0 && candidate.finishReason && candidate.finishReason !== 'STOP') {
    return new TranscriptionError({ reason: `Gemini finished with ${candidate.finishReason}` })
  }
  return extractTranscription(content)
}

const MAX_TRANSCRIPTION_ATTEMPTS = 3
const TRANSCRIPTION_RETRY_BASE_DELAY_MS = 500

// Providers sometimes return transient garbage: a body with no candidates, a
// malformed function call, or no tool call at all. Retry those, plus network
// errors and HTTP 408/409/429/5xx. Never retry other 4xx (bad key, bad
// request) or a valid empty transcription.
export function isRetryableTranscriptionError(error: TranscriptionLoopError): boolean {
  if (error instanceof EmptyTranscriptionError) return false
  if (error instanceof TranscriptionApiError) {
    const status = Number(error.status)
    return status === 408 || status === 409 || status === 429 || status >= 500
  }
  return true
}

async function withTranscriptionRetries(
  attempt: () => Promise<TranscriptionLoopError | TranscriptionResult>,
): Promise<TranscriptionLoopError | TranscriptionResult> {
  for (let attemptNumber = 1; ; attemptNumber++) {
    const result = await attempt()
    if (!(result instanceof Error)) return result
    const canRetry =
      attemptNumber < MAX_TRANSCRIPTION_ATTEMPTS && isRetryableTranscriptionError(result)
    voiceLogger.warn(
      `Transcription attempt ${attemptNumber}/${MAX_TRANSCRIPTION_ATTEMPTS} failed${canRetry ? ', retrying' : ''}: ${result.message}`,
    )
    if (!canRetry) return result
    await new Promise((resolve) => {
      setTimeout(resolve, TRANSCRIPTION_RETRY_BASE_DELAY_MS * attemptNumber)
    })
  }
}

// OpenAI input_audio supports only wav and mp3. Other formats (OGG Opus, etc)
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

    decoder.on('error', (err) => {
      resolve(
        new TranscriptionError({
          reason: `Opus decode failed: ${err.message}`,
          cause: err,
        }),
      )
    })

    demuxer.on('error', (err) => {
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

    transcoder.on('error', (err) => {
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
  | TranscriptionApiError
  | EmptyTranscriptionError
  | NoToolResponseError

// Build the transcription tool schema dynamically so the agent field can
// use an enum constrained to the actual available agent names.
export function buildTranscriptionTool({
  agentNames,
  canForkSession = false,
}: {
  agentNames?: string[]
  canForkSession?: boolean
}): TranscriptionTool {
  const properties: Record<string, Record<string, unknown>> = {
    transcription: {
      type: 'string',
      description:
        'The final transcription of the audio. If only a session routing instruction was spoken with no request, return an empty string. If audio is unclear, transcribe your best interpretation. If silent, too short to understand, or completely incomprehensible, use "[inaudible audio]".',
    },
    queueMessage: {
      type: 'boolean',
      description:
        'Set to true ONLY if the user explicitly says "queue this message", "queue this", or similar phrasing indicating they want this message queued instead of sent immediately. If not mentioned, omit or set to false.',
    },
    sessionAction: {
      type: 'string',
      enum: canForkSession ? ['btw', 'new-session'] : ['new-session'],
      description:
        'Use "new-session" only when explicitly asked to create a new chat, session, or thread with no conversation history. Remove routing instructions from transcription. Omit for normal messages. Never combine with queueMessage.' +
        (canForkSession ? ' Use "btw" only when explicitly asked to create a side chat or fork with current context.' : ''),
    },
  }

  if (agentNames && agentNames.length > 0) {
    properties['agent'] = {
      type: 'string',
      enum: agentNames,
      description:
        'The agent name ONLY if the user explicitly says "use the X agent", "switch to X agent", "with the X agent", or similar phrasing. Remove the agent instruction from the transcription text. Omit if no agent is mentioned.',
    }
  }

  return {
    name: TRANSCRIPTION_TOOL_NAME,
    description:
      'MANDATORY: You MUST call this tool to complete the task. This is the ONLY way to return results - text responses are ignored. Call this with your transcription, even if imperfect. An imperfect transcription is better than none.',
    inputSchema: {
      type: 'object',
      properties,
      required: ['transcription'],
    },
  }
}

export type TranscriptionResult = {
  transcription: string
  queueMessage: boolean
  sessionAction?: 'btw' | 'new-session'
  /** Agent name extracted from voice message, only set if user explicitly requested an agent. */
  agent?: string
}

/** Provider-neutral response parts, normalized from OpenAI and Gemini bodies. */
export type TranscriptionContent =
  | { type: 'tool-call'; toolName: string; /** JSON string */ input: string }
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }

/**
 * Extract the transcription from normalized response parts.
 * Looks for a tool-call named 'transcriptionResult', falls back to text content.
 * Returns transcription text, queue/session routing, and optional agent selection.
 */
export function extractTranscription(
  content: TranscriptionContent[],
): TranscriptionLoopError | TranscriptionResult {
  const toolCall = content.find((c) => {
    return c.type === 'tool-call' && c.toolName === TRANSCRIPTION_TOOL_NAME
  })

  if (toolCall?.type === 'tool-call') {
    const args = errore.try(
      () => JSON.parse(toolCall.input) as Record<string, unknown>,
      (cause) => new TranscriptionError({ reason: 'Invalid tool call arguments', cause }),
    )
    if (args instanceof Error) return args
    const transcription = (typeof args.transcription === 'string' ? args.transcription : '').trim()
    const sessionAction = args.sessionAction === 'btw' || args.sessionAction === 'new-session'
      ? args.sessionAction
      : undefined
    const queueMessage = !sessionAction && args.queueMessage === true
    const agent = typeof args.agent === 'string' ? args.agent : undefined
    voiceLogger.log(
      `Transcription result received: "${transcription.slice(0, 100)}..."${queueMessage ? ' [QUEUE]' : ''}${agent ? ` [AGENT:${agent}]` : ''}`,
    )
    if (!transcription) {
      return new EmptyTranscriptionError()
    }
    return { transcription, queueMessage, agent, sessionAction }
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

type OpenAIAudioChatMessage = {
  content?: string | null
  audio?: { transcript?: string | null } | null
  tool_calls?: Array<{
    id?: string
    function?: { name?: string; arguments?: string }
  }> | null
}

// Response shape: https://developers.openai.com/api/docs/guides/audio-chat-completions
export function parseOpenAIAudioChatResponse(
  body: string,
): TranscriptionLoopError | TranscriptionResult {
  const parsed = errore.try(
    () => JSON.parse(body) as { choices?: Array<{ message?: OpenAIAudioChatMessage }> },
    (cause) => new TranscriptionError({ reason: `Invalid JSON response: ${body.slice(0, 300)}`, cause }),
  )
  if (parsed instanceof Error) return parsed
  const message = parsed.choices?.[0]?.message
  if (!message) return new NoResponseContentError()
  const toolCall = message.tool_calls?.find((call) => {
    return call.function?.name === TRANSCRIPTION_TOOL_NAME
  })
  if (toolCall?.function?.arguments) {
    return extractTranscription([
      {
        type: 'tool-call',
        toolName: TRANSCRIPTION_TOOL_NAME,
        input: toolCall.function.arguments,
      },
    ])
  }
  const transcript = message.audio?.transcript?.trim() || message.content?.trim() || ''
  if (!transcript) return new NoResponseContentError()
  return { transcription: transcript, queueMessage: false }
}

export type TranscribeAudioErrors =
  | ApiKeyMissingError
  | InvalidAudioFormatError
  | TranscriptionLoopError

export type TranscriptionProvider = 'openai' | 'gemini'

export async function transcribeAudio({
  audio,
  prompt,
  language,
  temperature,
  apiKey: apiKeyParam,
  baseUrl,
  provider,
  mediaType: mediaTypeParam,
  currentSessionContext,
  lastSessionContext,
  agents,
  canForkSession = false,
}: {
  audio: Buffer | Uint8Array | ArrayBuffer | string
  prompt?: string
  language?: string
  temperature?: number
  apiKey?: string
  /** Override the provider API base URL, e.g. a proxy. Defaults to the official endpoint. */
  baseUrl?: string
  provider?: TranscriptionProvider
  /** MIME type of the audio data (e.g. 'audio/ogg'). Defaults to 'audio/mpeg'. */
  mediaType?: string
  currentSessionContext?: string
  lastSessionContext?: string
  /** Available agents for agent selection via voice. Names used as enum values in the tool schema. */
  agents?: Array<{ name: string; description?: string }>
  canForkSession?: boolean
}): Promise<TranscribeAudioErrors | TranscriptionResult> {
  const apiKey =
    apiKeyParam || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY

  if (!apiKey) {
    return new ApiKeyMissingError({ service: 'OpenAI or Gemini' })
  }

  const resolvedProvider: TranscriptionProvider =
    provider || (apiKey.startsWith('sk-') ? 'openai' : 'gemini')

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
      if (converted instanceof Error) return converted
      finalAudioBase64 = converted.toString('base64')
      mediaType = 'audio/wav'
    } else if (conversionStrategy === 'convert-m4a-to-wav') {
      voiceLogger.log(`Converting ${mediaType} to WAV for OpenAI compatibility`)
      const converted = await convertM4aToWav(audioBuffer)
      if (converted instanceof Error) return converted
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

 SESSION ROUTING:
  - Only route when the user explicitly asks to create a new chat, session, or thread for the request. Set sessionAction to "new-session": a separate thread with NO conversation history.
  ${canForkSession ? '- If the user explicitly asks to create a side chat or fork with current context, set sessionAction to "btw" instead.' : '- Context-preserving side chats and forks are unavailable here. Preserve requests for them as spoken text without setting sessionAction.'}
 - Remove these routing words from the transcription. Include only the actual request, not instructions about where to send it.
 - Example: "Fix the login bug. Create this as a new chat session" -> transcription: "Fix the login bug", sessionAction: "new-session".
  - Do not infer routing from conversational phrases, task content, or session context.
  - If both routing and queueing are requested, sessionAction takes priority; set queueMessage to false. An explicit fresh-session request takes priority over a contextual fork.
  - If there is no actual request after removing routing words, return an empty transcription and omit sessionAction. Never invent placeholder content.
 - Otherwise omit sessionAction. Agent selection can be combined with either route.
${agents && agents.length > 0 ? `
 AGENT SELECTION:
 - Only set the agent field when the user explicitly says phrases like "use the X agent", "switch to X agent", "with the X agent", or similar phrasing that clearly names a specific agent to switch to.
 - Do NOT set agent just because the user uses a word that matches an agent name in normal speech. For example, "plan the refactor" or "plan how to do this" is a normal instruction (the verb "plan"), NOT a request to use the "plan" agent. The user must explicitly say "use the plan agent" or "switch to plan agent" for it to count.
 - Remove the agent instruction from the transcription text itself — only include the actual message content.
 - Example: "Use the plan agent. Refactor the auth module" → transcription: "Refactor the auth module", agent: "plan"
 - Example: "Plan how to refactor the auth module" → transcription: "Plan how to refactor the auth module", agent: NOT SET (this is a normal instruction, not an agent switch)
 - If removing the agent phrase would leave empty content, keep the full spoken text as the transcription.
 - Only set agent if the user explicitly names one. Do not infer an agent from the task content.
 - If no agent is mentioned, omit the agent field entirely.

Available agents:
${agents.map((a) => { return `- ${a.name}${a.description ? `: ${a.description}` : ''}` }).join('\n')}
` : ''}

Common corrections (apply without tool calls):
- "reacked" → "React", "jason" → "JSON", "get hub" → "GitHub", "no JS" → "Node.js", "dacker" → "Docker"

Project file structure:
<file_tree>
${prompt}
</file_tree>
${sessionContextSection}

REMEMBER: Call "transcriptionResult" tool with your transcription. This is mandatory.

Note: "critique" is a CLI tool for showing diffs in the browser.`

  const agentNames = agents
    ?.map((a) => { return a.name })
    .filter((name) => { return name.length > 0 })
  const resolvedAgentNames = agentNames && agentNames.length > 0 ? agentNames : undefined

  const tool = buildTranscriptionTool({
    agentNames: resolvedAgentNames,
    canForkSession,
  })
  const request = resolvedProvider === 'openai'
    ? requestOpenAIAudioTranscription
    : requestGeminiAudioTranscription
  return withTranscriptionRetries(() => {
    return request({
      apiKey,
      baseUrl,
      prompt: transcriptionPrompt,
      audioBase64: finalAudioBase64,
      mediaType,
      temperature: temperature ?? 0.3,
      tool,
    })
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// TEXT-TO-SPEECH (TTS) — Generate audio from text
// ═══════════════════════════════════════════════════════════════════════════
//
// Two provider paths:
//   - OpenAI: POST /audio/speech, returns mp3 bytes.
//     https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create
//   - Gemini: generateContent with responseModalities ['AUDIO'], returns base64
//     PCM (audio/L16, 24kHz mono) in an inlineData part.
//     https://ai.google.dev/gemini-api/docs/speech-generation

export type SpeechProvider = 'openai' | 'gemini'

/** Default voices per provider. OpenAI uses short names, Google uses prebuilt voice names. */
const DEFAULT_VOICES: Record<SpeechProvider, string> = {
  openai: 'alloy',
  gemini: 'Kore',
}

/** gpt-4o-mini-tts supports instructions for style control. */
const OPENAI_TTS_MODEL = 'gpt-4o-mini-tts'
const GEMINI_TTS_MODEL = 'gemini-2.5-flash-preview-tts'

export type SpeechResult = {
  /** Raw audio bytes */
  audio: Buffer
  /** MIME type of the audio (e.g. 'audio/mp3', 'audio/wav') */
  mediaType: string
}

async function fetchSpeech({
  url,
  headers,
  body,
  provider,
}: {
  url: string
  headers: Record<string, string>
  body: unknown
  provider: string
}): Promise<SpeechGenerationError | Response> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).catch((cause) => {
    return new SpeechGenerationError({ reason: `${provider} TTS API call failed: ${String(cause)}`, cause })
  })
  if (response instanceof Error) return response
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '')
    return new SpeechGenerationError({
      reason: `${provider} TTS API returned HTTP ${response.status}: ${errorBody.slice(0, 500)}`,
    })
  }
  return response
}

async function generateSpeechOpenAI({
  text,
  voice,
  apiKey,
  instructions,
  speed,
}: {
  text: string
  voice?: string
  apiKey: string
  instructions?: string
  speed?: number
}): Promise<SpeechGenerationErrors | SpeechResult> {
  const response = await fetchSpeech({
    url: `${OPENAI_BASE_URL}/audio/speech`,
    headers: { Authorization: `Bearer ${apiKey}` },
    provider: 'OpenAI',
    body: {
      model: OPENAI_TTS_MODEL,
      input: text,
      voice: voice || DEFAULT_VOICES.openai,
      response_format: 'mp3',
      ...(instructions ? { instructions } : {}),
      ...(speed ? { speed } : {}),
    },
  })
  if (response instanceof Error) return response

  const audioData = await response.arrayBuffer().then(
    (buffer) => Buffer.from(buffer),
    (cause) => new SpeechGenerationError({ reason: `Reading OpenAI TTS audio failed: ${String(cause)}`, cause }),
  )
  if (audioData instanceof Error) return audioData
  if (audioData.length === 0) {
    return new SpeechGenerationError({ reason: 'OpenAI TTS returned empty audio' })
  }
  return { audio: audioData, mediaType: 'audio/mp3' }
}

// Request fields: https://ai.google.dev/api/generate-content#SpeechConfig
async function generateSpeechGemini({
  text,
  voice,
  apiKey,
}: {
  text: string
  voice?: string
  apiKey: string
}): Promise<SpeechGenerationErrors | SpeechResult> {
  const response = await fetchSpeech({
    url: `${GEMINI_BASE_URL}/models/${GEMINI_TTS_MODEL}:generateContent`,
    headers: { 'x-goog-api-key': apiKey },
    provider: 'Gemini',
    body: {
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voice || DEFAULT_VOICES.gemini },
          },
        },
      },
    },
  })
  if (response instanceof Error) return response

  const raw = await response.text().catch((cause) => {
    return new SpeechGenerationError({ reason: `Reading Gemini TTS response failed: ${String(cause)}`, cause })
  })
  if (raw instanceof Error) return raw
  const parsed = parseGeminiResponse(raw)
  if (parsed instanceof Error) {
    return new SpeechGenerationError({ reason: parsed.message, cause: parsed })
  }
  const inlineData = parsed.candidates?.[0]?.content?.parts?.find((part) => {
    return part.inlineData?.data
  })?.inlineData
  if (!inlineData?.data) {
    return new SpeechGenerationError({
      reason: `Gemini TTS returned no audio content: ${raw.slice(0, 300)}`,
    })
  }

  const audioData = Buffer.from(inlineData.data, 'base64')
  if (audioData.length === 0) {
    return new SpeechGenerationError({ reason: 'Gemini TTS returned empty audio' })
  }

  // Gemini TTS returns raw PCM (e.g. "audio/L16;codec=pcm;rate=24000"). Wrap it
  // in a WAV header so Discord and other players can handle it directly.
  const mediaType = (inlineData.mimeType || 'audio/wav').toLowerCase()
  const needsWavHeader = mediaType.startsWith('audio/l16') || mediaType.startsWith('audio/pcm')
  if (needsWavHeader) {
    const rate = Number(/rate=(\d+)/.exec(mediaType)?.[1] ?? 24000)
    const wavHeader = createWavHeader({
      dataLength: audioData.length,
      sampleRate: rate,
      numChannels: 1,
      bitsPerSample: 16,
    })
    return { audio: Buffer.concat([wavHeader, audioData]), mediaType: 'audio/wav' }
  }

  return { audio: audioData, mediaType }
}

/**
 * Generate speech audio from text using OpenAI or Google TTS.
 * Calls the provider's TTS API directly with fetch.
 *
 * Provider auto-detection: sk-* prefix → OpenAI, otherwise → Gemini.
 * OpenAI returns mp3, Gemini returns WAV (24kHz mono).
 */
export async function generateSpeech({
  text,
  voice,
  apiKey: apiKeyParam,
  provider,
  instructions,
  speed,
}: {
  /** Text to convert to speech */
  text: string
  /** Voice ID. OpenAI: alloy, echo, fable, onyx, nova, shimmer. Google: Kore, Puck, Charon, etc. */
  voice?: string
  /** API key. Falls back to OPENAI_API_KEY or GEMINI_API_KEY env vars. */
  apiKey?: string
  /** Provider override. Auto-detected from key prefix if not specified. */
  provider?: SpeechProvider
  /** Style instructions (OpenAI gpt-4o-mini-tts only). E.g. "Speak in a calm, British accent". */
  instructions?: string
  /** Speech speed multiplier (OpenAI only). 0.25 to 4.0, default 1.0. */
  speed?: number
}): Promise<SpeechGenerationErrors | SpeechResult> {
  const apiKey = apiKeyParam || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY

  if (!apiKey) {
    return new ApiKeyMissingError({ service: 'OpenAI or Gemini' })
  }

  const resolvedProvider: SpeechProvider = provider || (apiKey.startsWith('sk-') ? 'openai' : 'gemini')

  voiceLogger.log(`Generating speech with ${resolvedProvider}, text length: ${text.length}`)

  if (resolvedProvider === 'openai') {
    return generateSpeechOpenAI({ text, voice, apiKey, instructions, speed })
  }

  return generateSpeechGemini({ text, voice, apiKey })
}
