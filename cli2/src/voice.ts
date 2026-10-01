// Voice messages (spec 9.4, 16): transcription with a forced tool call that
// also returns the route, so a voice message becomes the same Route as text.
//
//   audio ─▶ OpenAI gpt-audio (OGG/M4A converted to WAV) or Gemini (raw audio)
//        ─▶ tool call { transcription, route, agent? } ─▶ parseVoiceMessage ─▶ Route
//
// Key order (V1): bot_api_keys OpenAI, then Gemini, then OPENAI_API_KEY /
// GEMINI_API_KEY. Gateway installs without a key use the free kimaki.dev
// Whisper endpoint, which has no tool call: the route is always steer.
// Plain fetch, no AI SDK: we parse provider bodies ourselves so transient
// bad responses keep their details and can be retried.

import { execFile } from 'node:child_process'
import path from 'node:path'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import * as errore from 'errore'
import prism from 'prism-media'
import dedent from 'string-dedent'

import { credentialsFromRow, gatewayUrlsFromEnv } from './credentials.ts'
import type { KimakiDb } from './db.ts'
import { DbError } from './errors.ts'
import { createLogger } from './logger.ts'
import type { Route } from './routes.ts'

const logger = createLogger('VOICE')
const execFileAsync = promisify(execFile)

const OPENAI_BASE_URL = 'https://api.openai.com/v1'
const OPENAI_AUDIO_MODEL = 'gpt-audio-1.5'
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
const GEMINI_MODEL = 'gemini-flash-latest'
const TOOL_NAME = 'transcriptionResult'
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 500

export class TranscriptionError extends errore.createTaggedError({
  name: 'TranscriptionError',
  message: 'Transcription failed: $reason',
}) {}

export class TranscriptionApiError extends errore.createTaggedError({
  name: 'TranscriptionApiError',
  message: 'Transcription API returned $status: $body',
}) {}

export class TranscriptionBlockedError extends errore.createTaggedError({
  name: 'TranscriptionBlockedError',
  message: 'The transcription provider refused the audio ($reason)',
}) {}

export class EmptyTranscriptionError extends errore.createTaggedError({
  name: 'EmptyTranscriptionError',
  message: 'No request was transcribed. Record another voice message with the task to send.',
}) {}

export class NoTranscriptionKeyError extends errore.createTaggedError({
  name: 'NoTranscriptionKeyError',
  message: 'Voice transcription needs an OpenAI or Gemini API key. Set OPENAI_API_KEY or GEMINI_API_KEY and restart Kimaki',
}) {}

type TranscriptionFailure = TranscriptionError | TranscriptionApiError | TranscriptionBlockedError | EmptyTranscriptionError

export type VoiceRoute = 'steer' | 'queue' | 'btw' | 'new-session'

export type TranscriptionResult = {
  transcription: string
  route: VoiceRoute
  agent: string | null
}

// --- attachment detection (V1 voice-attachment.ts)

const VOICE_EXTENSIONS = new Set(['.m4a', '.mp3', '.oga', '.ogg', '.opus', '.wav'])
const VIDEO_EXTENSIONS = new Set(['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.webm'])

export type AttachmentLike = {
  contentType: string | null
  name: string
  duration: number | null
  waveform: string | null
  width: number | null
  height: number | null
}

// iOS videos also have a duration: visual media is never a voice message.
export function isVoiceAttachment(attachment: AttachmentLike): boolean {
  const contentType = attachment.contentType?.trim().toLowerCase() ?? ''
  const extension = path.extname(attachment.name).toLowerCase()
  const visual =
    contentType.startsWith('video/') ||
    VIDEO_EXTENSIONS.has(extension) ||
    ((attachment.width ?? 0) > 0 && (attachment.height ?? 0) > 0)
  if (visual) return false
  if (contentType.startsWith('audio/')) return true
  if ((attachment.duration ?? 0) > 0 || attachment.waveform?.trim()) return true
  return VOICE_EXTENSIONS.has(extension)
}

// --- tool schema and prompt

export function buildTranscriptionTool({ agentNames, inSession }: { agentNames: readonly string[]; inSession: boolean }) {
  // btw and queue need a session to fork from or wait for (V1 "contextual routing").
  const routes: VoiceRoute[] = inSession ? ['steer', 'queue', 'btw', 'new-session'] : ['steer', 'new-session']
  const properties: Record<string, Record<string, unknown>> = {
    transcription: {
      type: 'string',
      description:
        'The final transcription of the audio, without routing or agent instructions. If silent or incomprehensible, use "[inaudible audio]".',
    },
    route: {
      type: 'string',
      enum: routes,
      description: [
        'Where the message goes. "steer" (default): send it now.',
        inSession ? '"queue": only if the user explicitly says to queue it after the current work.' : null,
        inSession ? '"btw": only if the user explicitly asks for a side chat or fork with the current context.' : null,
        '"new-session": only if the user explicitly asks for a new chat, session or thread with no history.',
      ]
        .filter((line) => line !== null)
        .join(' '),
    },
    ...(agentNames.length > 0 && {
      agent: {
        type: 'string',
        enum: agentNames,
        description: 'Only if the user explicitly says "use the X agent" or "switch to X agent". Omit otherwise.',
      },
    }),
  }
  return {
    name: TOOL_NAME,
    description: 'MANDATORY: call this tool with the transcription. Text responses are ignored.',
    inputSchema: { type: 'object', properties, required: ['transcription'] },
  }
}

function transcriptionPrompt({ fileTree, agents }: { fileTree: string; agents: ReadonlyArray<{ name: string; description: string }> }) {
  const agentList = agents.map((agent) => `- ${agent.name}${agent.description ? `: ${agent.description}` : ''}`).join('\n')
  return dedent`
    Transcribe this audio for a coding agent. You MUST call the "${TOOL_NAME}" tool; text responses are ignored.

    The speaker gives instructions to an AI coding assistant. Expect file paths, function names, CLI commands and package names.

    Rules:
    - Never change the meaning. Only transcribe; never answer questions or rephrase them as statements.
    - Fix only grammar, punctuation and markdown formatting.
    - Remove routing instructions ("queue this", "new chat", "side question") and agent instructions ("use the plan agent") from the transcription.
    - Route only on explicit requests. Never infer a route or an agent from the task content. "Plan the refactor" is not a request for the plan agent.
    - If nothing is left after removing routing words, return an empty transcription.

    ${agentList ? `Available agents:\n${agentList}` : 'No agents to pick from.'}

    Project files (for spelling names):
    <file_tree>
    ${fileTree}
    </file_tree>
  `
}

// --- response parsing

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJsonObject(body: string): TranscriptionError | Record<string, unknown> {
  const parsed = errore.try(
    () => ({ value: JSON.parse(body) as unknown }),
    (cause) => new TranscriptionError({ reason: `invalid JSON: ${body.slice(0, 300)}`, cause }),
  )
  if (parsed instanceof Error) return parsed
  if (!isRecord(parsed.value)) return new TranscriptionError({ reason: `not a JSON object: ${body.slice(0, 300)}` })
  return parsed.value
}

// Tool arguments -> result. Unknown or missing route is steer.
export function toTranscriptionResult(args: Record<string, unknown>): EmptyTranscriptionError | TranscriptionResult {
  const transcription = typeof args['transcription'] === 'string' ? args['transcription'].trim() : ''
  if (!transcription) return new EmptyTranscriptionError()
  const route = args['route']
  return {
    transcription,
    route: route === 'queue' || route === 'btw' || route === 'new-session' ? route : 'steer',
    agent: typeof args['agent'] === 'string' && args['agent'] ? args['agent'] : null,
  }
}

// OpenAI sends arguments as a JSON string, Gemini as an object.
function fromToolArguments(raw: string | Record<string, unknown>): TranscriptionFailure | TranscriptionResult {
  const args = typeof raw === 'string' ? parseJsonObject(raw) : raw
  if (args instanceof Error) return args
  return toTranscriptionResult(args)
}

const GEMINI_BLOCKED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'LANGUAGE'])

// https://ai.google.dev/api/generate-content#v1beta.GenerateContentResponse
export function parseGeminiResponse(body: string): TranscriptionFailure | TranscriptionResult {
  const parsed = parseJsonObject(body)
  if (parsed instanceof Error) return parsed
  const candidate = (Array.isArray(parsed['candidates']) ? parsed['candidates'] : []).find(isRecord)
  if (!candidate) {
    const feedback = parsed['promptFeedback']
    const blockReason = isRecord(feedback) && typeof feedback['blockReason'] === 'string' ? feedback['blockReason'] : null
    if (blockReason) return new TranscriptionBlockedError({ reason: blockReason })
    return new TranscriptionError({ reason: `Gemini returned no candidates: ${body.slice(0, 300)}` })
  }
  const finishReason = typeof candidate['finishReason'] === 'string' ? candidate['finishReason'] : null
  if (finishReason && GEMINI_BLOCKED.has(finishReason)) return new TranscriptionBlockedError({ reason: finishReason })
  if (finishReason && finishReason !== 'STOP' && finishReason !== 'FINISH_REASON_UNSPECIFIED') {
    return new TranscriptionError({ reason: `Gemini finished with ${finishReason}` })
  }
  const content = isRecord(candidate['content']) ? candidate['content'] : {}
  const parts = (Array.isArray(content['parts']) ? content['parts'] : []).filter(isRecord)
  const call = parts.map((part) => part['functionCall']).find(isRecord)
  if (call?.['name'] === TOOL_NAME) return fromToolArguments(isRecord(call['args']) ? call['args'] : {})
  const text = parts.find((part) => typeof part['text'] === 'string' && part['thought'] !== true)?.['text']
  if (typeof text === 'string' && text.trim()) return { transcription: text.trim(), route: 'steer', agent: null }
  return new TranscriptionError({ reason: 'Gemini returned no transcription' })
}

// https://developers.openai.com/api/docs/guides/audio-chat-completions
export function parseOpenAIResponse(body: string): TranscriptionFailure | TranscriptionResult {
  const parsed = parseJsonObject(body)
  if (parsed instanceof Error) return parsed
  const choice = (Array.isArray(parsed['choices']) ? parsed['choices'] : []).find(isRecord)
  const finishReason = choice?.['finish_reason']
  if (finishReason === 'content_filter') return new TranscriptionBlockedError({ reason: 'content_filter' })
  if (finishReason === 'length') return new TranscriptionError({ reason: 'OpenAI response was cut off' })
  const message = isRecord(choice?.['message']) ? choice['message'] : null
  if (!message) return new TranscriptionError({ reason: `OpenAI returned no message: ${body.slice(0, 300)}` })
  const calls = (Array.isArray(message['tool_calls']) ? message['tool_calls'] : []).filter(isRecord)
  const call = calls.map((candidate) => candidate['function']).find((fn) => isRecord(fn) && fn['name'] === TOOL_NAME)
  if (isRecord(call) && typeof call['arguments'] === 'string') return fromToolArguments(call['arguments'])
  const text = typeof message['content'] === 'string' ? message['content'].trim() : ''
  if (text) return { transcription: text, route: 'steer', agent: null }
  return new TranscriptionError({ reason: 'OpenAI returned no transcription' })
}

// --- audio conversion (OpenAI accepts only wav and mp3)

function wavHeader({ dataLength, sampleRate, channels }: { dataLength: number; sampleRate: number; channels: number }) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataLength, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * channels * 2, 28)
  header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataLength, 40)
  return header
}

// PCM s16le 48 kHz mono from a prism stream -> WAV.
function pcmToWav({ stream, label }: { stream: NodeJS.ReadableStream; label: string }): Promise<TranscriptionError | Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('end', () => {
      const pcm = Buffer.concat(chunks)
      if (pcm.length === 0) {
        resolve(new TranscriptionError({ reason: `${label} produced no audio` }))
        return
      }
      resolve(Buffer.concat([wavHeader({ dataLength: pcm.length, sampleRate: 48_000, channels: 1 }), pcm]))
    })
    stream.on('error', (error: Error) => resolve(new TranscriptionError({ reason: `${label} failed: ${error.message}`, cause: error })))
  })
}

// prism constructors throw synchronously when the opus library or the
// ffmpeg binary is missing.
async function oggToWav(input: Buffer): Promise<TranscriptionError | Buffer> {
  const pipeline = errore.try(
    () => {
      const demuxer = new prism.opus.OggDemuxer()
      const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 1, frameSize: 960 })
      demuxer.on('error', (error) => decoder.emit('error', error))
      Readable.from(input).pipe(demuxer).pipe(decoder)
      return decoder
    },
    (cause) => new TranscriptionError({ reason: 'the OGG Opus decoder could not start', cause }),
  )
  if (pipeline instanceof Error) return pipeline
  return pcmToWav({ stream: pipeline, label: 'OGG Opus decode' })
}

async function m4aToWav(input: Buffer): Promise<TranscriptionError | Buffer> {
  const args = ['-analyzeduration', '0', '-loglevel', '0', '-f', 'mp4', '-i', 'pipe:0']
  const transcoder = errore.try(
    () => new prism.FFmpeg({ args: [...args, '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '48000', 'pipe:1'] }),
    (cause) =>
      new TranscriptionError({
        reason: 'M4A voice messages with OpenAI need ffmpeg. Install it (brew install ffmpeg) or use a Gemini key',
        cause,
      }),
  )
  if (transcoder instanceof Error) return transcoder
  Readable.from(input).pipe(transcoder)
  return pcmToWav({ stream: transcoder, label: 'M4A decode with ffmpeg' })
}

async function openAIAudio({ audio, mediaType }: { audio: Buffer; mediaType: string }) {
  if (mediaType === 'audio/mpeg' || mediaType === 'audio/mp3') return { data: audio, format: 'mp3' }
  if (mediaType === 'audio/wav' || mediaType === 'audio/x-wav') return { data: audio, format: 'wav' }
  const converted = await (() => {
    if (mediaType === 'audio/ogg' || mediaType === 'audio/opus') return oggToWav(audio)
    if (mediaType === 'audio/mp4' || mediaType === 'audio/m4a' || mediaType === 'audio/x-m4a') return m4aToWav(audio)
    return new TranscriptionError({ reason: `unsupported audio type ${mediaType}` })
  })()
  if (converted instanceof Error) return converted
  return { data: converted, format: 'wav' }
}

// --- requests

async function postJson({ url, headers, body }: { url: string; headers: Record<string, string>; body: unknown }) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).catch((cause) => new TranscriptionError({ reason: `request to ${url} failed`, cause }))
  if (response instanceof Error) return response
  const text = await response.text().catch((cause) => new TranscriptionError({ reason: 'reading the response failed', cause }))
  if (text instanceof Error) return text
  if (!response.ok) return new TranscriptionApiError({ status: String(response.status), body: text.slice(0, 500) })
  return text
}

type Tool = ReturnType<typeof buildTranscriptionTool>

async function requestGemini({ apiKey, baseUrl, prompt, audio, mediaType, tool }: ProviderRequest) {
  const raw = await postJson({
    url: `${baseUrl}/models/${GEMINI_MODEL}:generateContent`,
    headers: { 'x-goog-api-key': apiKey },
    body: {
      contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: mediaType, data: audio.toString('base64') } }] }],
      tools: [{ functionDeclarations: [{ name: tool.name, description: tool.description, parameters: tool.inputSchema }] }],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [TOOL_NAME] } },
      generationConfig: { temperature: 0.3, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 1024 } },
    },
  })
  if (raw instanceof Error) return raw
  return parseGeminiResponse(raw)
}

async function requestOpenAI({ apiKey, baseUrl, prompt, audio, mediaType, tool }: ProviderRequest) {
  const input = await openAIAudio({ audio, mediaType })
  if (input instanceof Error) return input
  const raw = await postJson({
    url: `${baseUrl}/chat/completions`,
    headers: { authorization: `Bearer ${apiKey}` },
    body: {
      model: OPENAI_AUDIO_MODEL,
      temperature: 0.3,
      max_completion_tokens: 2048,
      tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }],
      tool_choice: { type: 'function', function: { name: TOOL_NAME } },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'input_audio', input_audio: { data: input.data.toString('base64'), format: input.format } },
          ],
        },
      ],
    },
  })
  if (raw instanceof Error) return raw
  return parseOpenAIResponse(raw)
}

type ProviderRequest = { apiKey: string; baseUrl: string; prompt: string; audio: Buffer; mediaType: string; tool: Tool }

// Retries transient failures: network, 408/409/429/5xx, bad bodies. Never
// bad keys, refusals or an empty transcription.
function isRetryable(error: TranscriptionFailure): boolean {
  if (error instanceof EmptyTranscriptionError || error instanceof TranscriptionBlockedError) return false
  if (!(error instanceof TranscriptionApiError)) return true
  const status = Number(error.status)
  return status === 408 || status === 409 || status === 429 || status >= 500
}

async function withRetries(attempt: () => Promise<TranscriptionFailure | TranscriptionResult>) {
  for (let number = 1; ; number++) {
    const result = await attempt()
    if (!(result instanceof Error)) return result
    const retry = number < MAX_ATTEMPTS && isRetryable(result)
    logger.warn(`transcription attempt ${number}/${MAX_ATTEMPTS} failed${retry ? ', retrying' : ''}: ${result.message}`)
    if (!retry) return result
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * number))
  }
}

// Free Whisper through kimaki.dev, authenticated with the gateway client
// credentials (website POST /api/transcribe). No routing: always steer.
async function transcribeViaGateway({ audio, mediaType, clientId, clientSecret }: {
  audio: Buffer
  mediaType: string
  clientId: string
  clientSecret: string
}): Promise<TranscriptionFailure | TranscriptionResult> {
  const response = await fetch(new URL('/api/transcribe', gatewayUrlsFromEnv().website), {
    method: 'POST',
    headers: { authorization: `Bearer ${clientId}:${clientSecret}`, 'content-type': mediaType },
    body: new Uint8Array(audio),
  }).catch((cause) => new TranscriptionError({ reason: 'kimaki.dev transcription not reachable', cause }))
  if (response instanceof Error) return response
  const body = await response.text().catch(() => '')
  if (!response.ok) return new TranscriptionApiError({ status: String(response.status), body: body.slice(0, 300) })
  const parsed = parseJsonObject(body)
  if (parsed instanceof Error) return parsed
  return toTranscriptionResult({ transcription: parsed['text'] })
}

// --- routing

export function parseVoiceMessage(result: TranscriptionResult): Route {
  return { kind: result.route, text: result.transcription, ...(result.agent && { agent: result.agent }) }
}

async function projectFileTree(directory: string): Promise<string> {
  const result = await execFileAsync('git', ['ls-files'], { cwd: directory, timeout: 5_000, maxBuffer: 10_000_000 }).catch(
    () => null,
  )
  return result?.stdout.split('\n').slice(0, 400).join('\n') ?? ''
}

export type TranscriptionBaseUrls = { openai?: string; gemini?: string }

export function createTranscriber({
  db,
  token,
  baseUrls = {},
}: {
  db: KimakiDb
  // The running bot's token: selects its bot_tokens row and API keys.
  token: string
  baseUrls?: TranscriptionBaseUrls
}) {
  async function provider() {
    const row = await db.query.bot_tokens
      .findFirst({ where: { token }, with: { api_keys: true } })
      .catch((e) => new DbError({ operation: 'read transcription keys', cause: e }))
    if (row instanceof Error) return row
    const keys = row?.api_keys
    // Stored keys first, then env, each in V1 order: OpenAI, then Gemini.
    const candidates = [
      { kind: 'openai' as const, apiKey: keys?.openai_api_key },
      { kind: 'gemini' as const, apiKey: keys?.gemini_api_key },
      { kind: 'openai' as const, apiKey: process.env['OPENAI_API_KEY'] },
      { kind: 'gemini' as const, apiKey: process.env['GEMINI_API_KEY'] },
    ]
    const found = candidates.find((candidate) => candidate.apiKey)
    if (found?.apiKey) return { kind: found.kind, apiKey: found.apiKey }
    const credentials = row ? credentialsFromRow(row) : null
    const [clientId, clientSecret] = credentials?.mode === 'gateway' ? credentials.token.split(':') : []
    if (clientId && clientSecret) return { kind: 'gateway' as const, clientId, clientSecret }
    return new NoTranscriptionKeyError()
  }

  return {
    async transcribe({
      audio,
      mediaType,
      directory,
      agents,
      inSession,
    }: {
      audio: Buffer
      mediaType: string
      directory: string
      agents: ReadonlyArray<{ name: string; description: string }>
      inSession: boolean
    }): Promise<DbError | NoTranscriptionKeyError | TranscriptionFailure | TranscriptionResult> {
      const selected = await provider()
      if (selected instanceof Error) return selected
      const type = mediaType.trim().toLowerCase() || 'audio/ogg'
      if (selected.kind === 'gateway') return transcribeViaGateway({ audio, mediaType: type, ...selected })
      const tool = buildTranscriptionTool({ agentNames: agents.map((agent) => agent.name), inSession })
      const prompt = transcriptionPrompt({ fileTree: await projectFileTree(directory), agents })
      const request = { apiKey: selected.apiKey, prompt, audio, mediaType: type, tool }
      if (selected.kind === 'openai') {
        return withRetries(() => requestOpenAI({ ...request, baseUrl: baseUrls.openai ?? OPENAI_BASE_URL }))
      }
      return withRetries(() => requestGemini({ ...request, baseUrl: baseUrls.gemini ?? GEMINI_BASE_URL }))
    },
  }
}

export type Transcriber = ReturnType<typeof createTranscriber>

// --- text to speech (`kimaki tts`)
//
//   OpenAI: POST /audio/speech, mp3 bytes.
//     https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create
//   Gemini: generateContent with responseModalities ['AUDIO'], base64 PCM
//     (audio/L16, 24 kHz mono), wrapped in a WAV header here.
//     https://ai.google.dev/gemini-api/docs/speech-generation

export class SpeechError extends errore.createTaggedError({
  name: 'SpeechError',
  message: 'Speech generation failed: $reason',
}) {}

export type SpeechProvider = 'openai' | 'gemini'

const DEFAULT_VOICES: Record<SpeechProvider, string> = { openai: 'alloy', gemini: 'Kore' }
const OPENAI_TTS_MODEL = 'gpt-4o-mini-tts'
const GEMINI_TTS_MODEL = 'gemini-2.5-flash-preview-tts'

async function postSpeech({ url, headers, body }: { url: string; headers: Record<string, string>; body: string }): Promise<SpeechError | Response> {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })
    .catch((cause) => new SpeechError({ reason: `request to ${url} failed`, cause }))
  if (response instanceof Error) return response
  if (response.ok) return response
  const text = await response.text().catch(() => '')
  return new SpeechError({ reason: `HTTP ${response.status}: ${text.slice(0, 500)}` })
}

// The provider follows the key: sk-* is OpenAI, anything else Gemini.
export async function generateSpeech({
  text,
  apiKey,
  provider = apiKey.startsWith('sk-') ? 'openai' : 'gemini',
  voice,
  instructions,
  speed,
  baseUrls = {},
}: {
  text: string
  apiKey: string
  provider?: SpeechProvider
  // OpenAI: alloy, echo, nova, ... Gemini: Kore, Puck, Charon, ...
  voice?: string
  // OpenAI only: style, e.g. "Speak calmly".
  instructions?: string
  // OpenAI only: 0.25 to 4.0.
  speed?: number
  baseUrls?: TranscriptionBaseUrls
}): Promise<SpeechError | { audio: Buffer; mediaType: 'audio/mp3' | 'audio/wav' | (string & {}) }> {
  if (provider === 'openai') {
    const response = await postSpeech({
      url: `${baseUrls.openai ?? OPENAI_BASE_URL}/audio/speech`,
      headers: { authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: OPENAI_TTS_MODEL, input: text, voice: voice || DEFAULT_VOICES.openai, response_format: 'mp3', ...(instructions && { instructions }), ...(speed && { speed }) }),
    })
    if (response instanceof Error) return response
    const audio = await response.arrayBuffer().then((buffer) => Buffer.from(buffer), (cause) => new SpeechError({ reason: 'reading OpenAI audio failed', cause }))
    if (audio instanceof Error) return audio
    if (audio.length === 0) return new SpeechError({ reason: 'OpenAI returned empty audio' })
    return { audio, mediaType: 'audio/mp3' }
  }
  // Fields: https://ai.google.dev/api/generate-content#SpeechConfig
  const response = await postSpeech({
    url: `${baseUrls.gemini ?? GEMINI_BASE_URL}/models/${GEMINI_TTS_MODEL}:generateContent`,
    headers: { 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || DEFAULT_VOICES.gemini } } } },
    }),
  })
  if (response instanceof Error) return response
  const raw = await response.text().catch((cause) => new SpeechError({ reason: 'reading Gemini response failed', cause }))
  if (raw instanceof Error) return raw
  const parsed = parseJsonObject(raw)
  if (parsed instanceof Error) return new SpeechError({ reason: parsed.message, cause: parsed })
  const candidate = (Array.isArray(parsed['candidates']) ? parsed['candidates'] : []).find(isRecord)
  const content = isRecord(candidate?.['content']) ? candidate['content'] : {}
  const inline = (Array.isArray(content['parts']) ? content['parts'] : []).filter(isRecord).map((part) => part['inlineData']).find(isRecord)
  const data = typeof inline?.['data'] === 'string' ? Buffer.from(inline['data'], 'base64') : null
  if (!data?.length) return new SpeechError({ reason: `Gemini returned no audio: ${raw.slice(0, 300)}` })
  const mediaType = (typeof inline?.['mimeType'] === 'string' ? inline['mimeType'] : 'audio/wav').toLowerCase()
  // Raw PCM plays nowhere; a WAV header makes it a normal audio file.
  if (!mediaType.startsWith('audio/l16') && !mediaType.startsWith('audio/pcm')) return { audio: data, mediaType }
  const sampleRate = Number(/rate=(\d+)/.exec(mediaType)?.[1] ?? 24_000)
  return { audio: Buffer.concat([wavHeader({ dataLength: data.length, sampleRate, channels: 1 }), data]), mediaType: 'audio/wav' }
}
