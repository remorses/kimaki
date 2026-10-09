// OpenAI Realtime (GA) and xAI Grok Voice adapters. xAI speaks an OpenAI-like
// protocol with a flatter session shape, so both share one codec with a dialect flag.
// Docs: https://developers.openai.com/api/reference/resources/realtime/client-events
//       https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech

import * as errore from 'errore'
import { base64ToPcm, pcmToBase64 } from './audio.ts'
import type { Adapter, Command, Decoded, HistoryItem, ResponseStatus, SetupInput, Usage } from './types.ts'

export class UnsupportedOptionError extends errore.createTaggedError({
  name: 'UnsupportedOptionError',
  message: '$provider does not support $option',
}) {}

type Dialect = 'openai' | 'xai'
type Auth = { apiKey: string; token?: never } | { token: string; apiKey?: never }

const RATE = 24000

type WireUsage = {
  input_tokens?: number
  output_tokens?: number
  input_token_details?: { cached_tokens?: number; audio_tokens?: number }
  output_token_details?: { audio_tokens?: number }
  /** xAI bills by audio time. */
  billable_audio_seconds?: number
}

type Wire = {
  type?: string
  session?: { id?: string }
  conversation?: { id?: string }
  item?: { id?: string; type?: string }
  item_id?: string
  transcript?: string
  delta?: string
  response_id?: string
  response?: { id?: string; status?: string; usage?: WireUsage }
  /** xAI sends usage here and leaves response.usage empty. */
  usage?: WireUsage
  call_id?: string
  name?: string
  arguments?: string
  error?: { message?: string; code?: string | null }
}

function toStatus(status: string | undefined): ResponseStatus {
  if (status === 'cancelled' || status === 'incomplete' || status === 'failed') return status
  return 'completed'
}

function toUsage(usage: WireUsage): Usage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    cachedInputTokens: usage.input_token_details?.cached_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    inputAudioTokens: usage.input_token_details?.audio_tokens ?? 0,
    outputAudioTokens: usage.output_token_details?.audio_tokens ?? 0,
    billedSeconds: usage.billable_audio_seconds ?? 0,
  }
}

function decode({ message, dialect, model }: { message: unknown; dialect: Dialect; model: string }): Decoded[] {
  const event = message as Wire
  const itemId = event.item_id ?? null
  switch (event.type) {
    // session.created carries the default config; session.updated confirms ours.
    case 'session.updated':
      return [{ type: 'session.started', provider: dialect, model, sessionId: event.session?.id ?? null }]
    case 'conversation.created':
      // xAI only resumes with this id when session.resumption is enabled, which setup() always does.
      if (dialect !== 'xai' || !event.conversation?.id) return []
      return [{ type: 'resume.handle', handle: event.conversation.id }]
    case 'input_audio_buffer.speech_started':
      return [{ type: 'speech.started' }]
    case 'input_audio_buffer.speech_stopped':
      return [{ type: 'speech.stopped' }]
    case 'input_audio_buffer.committed':
      return itemId ? [{ type: 'input.committed', itemId }] : []
    case 'conversation.item.input_audio_transcription.completed':
      return [{ type: 'input.text', text: event.transcript ?? '', itemId, final: true }]
    case 'conversation.item.truncated':
      return itemId ? [{ type: 'output.truncated', itemId, text: typeof event.transcript === 'string' ? event.transcript : null }] : []
    case 'response.output_item.added':
      return event.item?.type === 'message' && event.item.id ? [{ type: 'output.item', itemId: event.item.id }] : []
    case 'response.created':
      return [{ type: 'response.started', responseId: event.response?.id ?? null }]
    case 'response.output_audio.delta':
    case 'response.audio.delta':
      return event.delta ? [{ type: 'output.audio', pcm: base64ToPcm(event.delta), rate: RATE, itemId }] : []
    case 'response.output_audio_transcript.delta':
    case 'response.output_text.delta':
    case 'response.text.delta':
      return event.delta ? [{ type: 'output.text', text: event.delta, itemId }] : []
    case 'response.function_call_arguments.done':
      return [{ type: 'tool.call', callId: event.call_id ?? '', name: event.name ?? '', args: event.arguments ?? '{}' }]
    case 'response.done': {
      const usage = event.usage?.output_tokens !== undefined ? event.usage : event.response?.usage
      return [
        ...(usage ? [{ type: 'usage' as const, usage: toUsage(usage) }] : []),
        { type: 'response.done', status: toStatus(event.response?.status) },
      ]
    }
    case 'error':
      return [{ type: 'error', message: event.error?.message ?? 'Unknown error', code: event.error?.code ?? null }]
    default:
      return []
  }
}

function turnDetection({ input, dialect }: { input: SetupInput; dialect: Dialect }): Error | Record<string, unknown> | null {
  const turns = input.turns ?? { mode: 'server' }
  if (turns.mode === 'manual') return null
  if (turns.mode === 'semantic') {
    if (dialect === 'xai') return new UnsupportedOptionError({ provider: 'xAI', option: 'semantic turn detection' })
    return { type: 'semantic_vad', eagerness: turns.eagerness ?? 'auto' }
  }
  // xAI documents only `type` and `idle_timeout_ms`; tuning fields are OpenAI only.
  if (dialect === 'xai') return { type: 'server_vad' }
  const threshold = turns.sensitivity === 'low' ? 0.7 : turns.sensitivity === 'high' ? 0.35 : undefined
  return {
    type: 'server_vad',
    silence_duration_ms: turns.silenceMs ?? 500,
    ...(turns.prefixMs !== undefined ? { prefix_padding_ms: turns.prefixMs } : {}),
    ...(threshold !== undefined ? { threshold } : {}),
    create_response: true,
    interrupt_response: turns.interrupt ?? true,
  }
}

function seedItem({ item, dialect }: { item: HistoryItem; dialect: Dialect }): unknown[] {
  const create = (body: Record<string, unknown>) => ({ type: 'conversation.item.create', item: body })
  const message = (role: string, contentType: string, text: string) =>
    create({ type: 'message', role, content: [{ type: contentType, text }] })
  if (item.role === 'summary') return [message('system', dialect === 'xai' ? 'text' : 'input_text', item.text)]
  if (item.role === 'user') return [message('user', 'input_text', item.text)]
  if (item.role === 'assistant') return [message('assistant', dialect === 'xai' ? 'text' : 'output_text', item.text)]
  return [
    create({ type: 'function_call', call_id: item.callId, name: item.name, arguments: item.args }),
    create({ type: 'function_call_output', call_id: item.callId, output: item.output }),
  ]
}

function setup({ input, dialect, options }: { input: SetupInput; dialect: Dialect; options: Record<string, unknown> }) {
  const detection = turnDetection({ input, dialect })
  if (detection instanceof Error) return detection
  const transcribe = input.transcribe ?? true
  const format = { type: 'audio/pcm', rate: RATE }
  const tools = (input.tools ?? []).map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
  const builtinTools = (options.builtinTools as unknown[] | undefined) ?? []
  const session =
    dialect === 'openai'
      ? {
          type: 'realtime',
          output_modalities: ['audio'],
          ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
          ...(input.maxOutputTokens !== undefined ? { max_output_tokens: input.maxOutputTokens } : {}),
          // Drop 20% of history at once when the context is full, so later turns keep hitting the cache.
          truncation: { type: 'retention_ratio', retention_ratio: 0.8 },
          audio: {
            input: {
              format,
              turn_detection: detection,
              noise_reduction: options.noiseReduction === null ? null : { type: options.noiseReduction ?? 'near_field' },
              ...(transcribe ? { transcription: { model: options.transcriptionModel ?? 'gpt-4o-mini-transcribe' } } : {}),
            },
            output: { format, ...(input.voice !== undefined ? { voice: input.voice } : {}) },
          },
          ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
        }
      : {
          ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
          ...(input.voice !== undefined ? { voice: input.voice } : {}),
          turn_detection: detection,
          audio: { input: { format }, output: { format } },
          ...(options.reasoning !== undefined ? { reasoning: { effort: options.reasoning } } : {}),
          resumption: { enabled: true },
          ...(tools.length + builtinTools.length > 0 ? { tools: [...tools, ...builtinTools] } : {}),
        }
  return [{ type: 'session.update', session }]
}

function encode(command: Command): unknown[] {
  switch (command.type) {
    case 'audio':
      return [{ type: 'input_audio_buffer.append', audio: pcmToBase64(command.pcm) }]
    case 'audio.end':
      return []
    case 'turn.start':
      return [{ type: 'input_audio_buffer.clear' }]
    case 'turn.end':
      return [{ type: 'input_audio_buffer.commit' }, { type: 'response.create' }]
    case 'text':
      return [
        { type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: command.text }] } },
        ...(command.respond ? [{ type: 'response.create' }] : []),
      ]
    case 'tool.result':
      return [
        { type: 'conversation.item.create', item: { type: 'function_call_output', call_id: command.callId, output: command.output } },
      ]
    case 'response.create':
      return [{ type: 'response.create' }]
    case 'response.cancel':
      return [{ type: 'response.cancel' }]
    case 'truncate':
      return [{ type: 'conversation.item.truncate', item_id: command.itemId, content_index: 0, audio_end_ms: Math.round(command.playedMs) }]
  }
}

export type OpenAIOptions = Auth & {
  model?: string
  /** Mic type. `null` turns noise reduction off. Default `near_field`. */
  noiseReduction?: 'near_field' | 'far_field' | null
  transcriptionModel?: string
  baseUrl?: string
}

export function openai(options: OpenAIOptions): Adapter {
  const model = options.model ?? 'gpt-realtime-2.1'
  const host = options.baseUrl ?? 'wss://api.openai.com/v1/realtime'
  return {
    provider: 'openai',
    model,
    inputRate: RATE,
    outputRate: RATE,
    needsResponseCreate: true,
    connect: () => {
      const url = `${host}?model=${encodeURIComponent(model)}`
      if (options.token) return { url, protocols: ['realtime', `openai-insecure-api-key.${options.token}`] }
      return { url, headers: { Authorization: `Bearer ${options.apiKey}` } }
    },
    setup: (input) => setup({ input, dialect: 'openai', options }),
    seed: (history) => history.flatMap((item) => seedItem({ item, dialect: 'openai' })),
    encode,
    decode: (message) => decode({ message, dialect: 'openai', model }),
  }
}

export type XaiOptions = Auth & {
  model?: string
  /** `none` turns reasoning off for lower latency. xAI default is `high`. */
  reasoning?: 'high' | 'none'
  /** Server-side tools, e.g. `{ type: 'web_search' }`, `{ type: 'x_search' }`. */
  builtinTools?: Record<string, unknown>[]
  baseUrl?: string
}

export function xai(options: XaiOptions): Adapter {
  const model = options.model ?? 'grok-voice-think-fast-2.0'
  const host = options.baseUrl ?? 'wss://api.x.ai/v1/realtime'
  return {
    provider: 'xai',
    model,
    inputRate: RATE,
    outputRate: RATE,
    needsResponseCreate: true,
    connect: ({ resumeHandle }) => {
      const url = `${host}?model=${encodeURIComponent(model)}${resumeHandle ? `&conversation_id=${encodeURIComponent(resumeHandle)}` : ''}`
      if (options.token) return { url, protocols: [`xai-client-secret.${options.token}`] }
      return { url, headers: { Authorization: `Bearer ${options.apiKey}` } }
    },
    setup: (input) => setup({ input, dialect: 'xai', options }),
    seed: (history) => history.flatMap((item) => seedItem({ item, dialect: 'xai' })),
    encode,
    decode: (message) => decode({ message, dialect: 'xai', model }),
  }
}

/** Server side: mint a short-lived browser token. */
export async function clientSecret({
  provider,
  apiKey,
  ttlSeconds = 60,
}: {
  provider: 'openai' | 'xai'
  apiKey: string
  ttlSeconds?: number
}) {
  const url = provider === 'openai' ? 'https://api.openai.com/v1/realtime/client_secrets' : 'https://api.x.ai/v1/realtime/client_secrets'
  const body =
    provider === 'openai'
      ? { expires_after: { anchor: 'created_at', seconds: ttlSeconds }, session: { type: 'realtime' } }
      : { expires_after: { seconds: ttlSeconds } }
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch((e) => new ClientSecretError({ provider, reason: 'request failed', cause: e }))
  if (response instanceof Error) return response
  if (!response.ok) return new ClientSecretError({ provider, reason: `HTTP ${response.status}: ${await response.text()}` })
  const data = await (response.json() as Promise<{ value: string; expires_at: number }>).catch(
    (e) => new ClientSecretError({ provider, reason: 'invalid JSON', cause: e }),
  )
  if (data instanceof Error) return data
  return { token: data.value, expiresAt: data.expires_at }
}

export class ClientSecretError extends errore.createTaggedError({
  name: 'ClientSecretError',
  message: 'Could not create a $provider client secret: $reason',
}) {}
