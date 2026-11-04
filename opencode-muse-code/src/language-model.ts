// AI SDK language model for one Muse model. A model ID is a Muse Code model (`muse-spark-1.3`).
//
// One OpenCode step = one Muse turn on the Muse session mapped to the OpenCode session:
//
//   doStream ──▶ new user text (+ agent prompt on a new Muse session) ──▶ runtime.run (muse.ts)
//            ──▶ items and deltas ──▶ stream parts (items.ts) ──▶ finish at `turn/completed`
//
// Muse keeps its own history and runs its own tools, so only the new user input is sent and
// OpenCode's tools and system prompt are not used.

import { APICallError, type LanguageModelV3, type LanguageModelV3CallOptions, type LanguageModelV3Prompt, type LanguageModelV3StreamPart, type LanguageModelV3StreamResult, type LanguageModelV3Usage } from '@ai-sdk/provider'
import * as errore from 'errore'
import type { ApprovalMode, ReasoningEffort, TokenUsage, TurnCompletedParams, TurnInputPart } from '@muse-code/sdk/dist/src/msp.js'
import { MuseSessionError, type MuseRuntime } from './muse.ts'

export const PROVIDER_ID = 'muse'
export const KIND_HEADER = 'x-muse-code-kind'
const SESSION_HEADER = 'x-opencode-session-id'
// Provider options: the agent prompt from the `context` hook, the rest from variants or agent `request.settings`.
export const AGENT_PROMPT_OPTION = 'museAgentPrompt'
const EFFORT_OPTION = 'reasoningEffort'
const APPROVAL_OPTION = 'approvalMode'
const PROFILE_OPTION = 'permissionProfile'
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const satisfies readonly ReasoningEffort[]
const APPROVAL_MODES = ['allowAll', 'promptUnmatched', 'onRequest', 'denyUnmatched'] as const satisfies readonly ApprovalMode[]
// Earlier OpenCode messages a new Muse session gets as context, newest kept.
const MAX_HISTORY_CHARS = 20_000
const HTTP_UNAUTHORIZED = 401
const HTTP_TOO_MANY_REQUESTS = 429
const SECOND_MS = 1_000
const MUSE_URL = 'msp://muse-serve'

export class MuseTurnError extends errore.createTaggedError({
  name: 'MuseTurnError',
  message: 'Muse turn $terminal: $reason',
}) {}

function textOf(message: LanguageModelV3Prompt[number]) {
  if (message.role === 'system') return message.content
  return message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
}

// The OpenCode input since Muse's last answer: text and images.
export function turnInput(prompt: LanguageModelV3Prompt) {
  const lastAssistant = prompt.findLastIndex((message) => message.role === 'assistant')
  const parts = prompt.slice(lastAssistant + 1).flatMap((message) => (message.role === 'user' ? message.content : []))
  const input: TurnInputPart[] = []
  const texts: string[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      texts.push(part.text)
      continue
    }
    // A string is base64; a URL would need a fetch, which Muse does not do for turn input.
    const base64 = typeof part.data === 'string' ? part.data : part.data instanceof Uint8Array ? Buffer.from(part.data).toString('base64') : null
    if (part.mediaType.startsWith('image/') && base64) {
      input.push({ type: 'image', base64Data: base64, mediaType: part.mediaType })
      continue
    }
    texts.push(`(attachment ${part.filename ?? part.mediaType} not sent: Muse only takes text and images here)`)
  }
  const text = texts.join('\n\n').trim()
  return { input: text ? [{ type: 'text' as const, text }, ...input] : input, displayText: text }
}

// The conversation before this turn, for a Muse session that starts mid-way (model switch).
export function earlierConversation(prompt: LanguageModelV3Prompt) {
  const lastAssistant = prompt.findLastIndex((message) => message.role === 'assistant')
  const lines = prompt
    .slice(0, lastAssistant + 1)
    .flatMap((message) => (message.role === 'user' || message.role === 'assistant' ? [`${message.role}: ${textOf(message)}`] : []))
    .filter((line) => !line.endsWith(': '))
  const text = lines.join('\n\n')
  return text.length > MAX_HISTORY_CHARS ? `…${text.slice(-MAX_HISTORY_CHARS)}` : text
}

export function preamble({ agentPrompt, history }: { agentPrompt: string; history: string }) {
  const sections = [
    agentPrompt ? `<opencode-agent-instructions>\n${agentPrompt}\n</opencode-agent-instructions>` : '',
    history ? `<earlier-conversation>\n${history}\n</earlier-conversation>` : '',
  ].filter(Boolean)
  // Muse joins text parts with nothing between them.
  return sections.length ? `${sections.join('\n\n')}\n\n` : ''
}

export function usageOf(usage: TokenUsage | undefined): LanguageModelV3Usage {
  const input = usage?.inputTokens ?? 0
  const cacheRead = usage?.cacheReadTokens ?? usage?.cachedTokens ?? 0
  const output = usage?.outputTokens ?? 0
  const reasoning = usage?.reasoningTokens ?? 0
  return {
    inputTokens: { total: input, noCache: Math.max(0, input - cacheRead), cacheRead, cacheWrite: usage?.cacheWriteTokens ?? 0 },
    outputTokens: { total: output, text: Math.max(0, output - reasoning), reasoning },
  }
}

// Errors as HTTP failures, so OpenCode and the fallback plugin can tell a used-up plan or a lost login apart.
export function turnFailure(params: TurnCompletedParams): Error {
  const error = params.error
  const message = error?.message ?? params.reason ?? 'Muse ended the turn without an answer'
  if (error?.quota) {
    const resetsAt = Math.ceil(error.quota.resetsAtMs / SECOND_MS)
    const retryAfter = Math.max(0, resetsAt - Math.ceil(Date.now() / SECOND_MS))
    return new APICallError({
      message: `Muse Code usage limit reached (${error.quota.limitKind}). Resets at ${new Date(error.quota.resetsAtMs).toISOString()}.`,
      url: MUSE_URL,
      requestBodyValues: {},
      statusCode: HTTP_TOO_MANY_REQUESTS,
      responseHeaders: { 'retry-after': String(retryAfter) },
      responseBody: JSON.stringify({ error: { type: 'usage_limit_reached', message, resets_at: resetsAt } }),
      isRetryable: true,
    })
  }
  if (error?.kind === 'authRequired') {
    return new APICallError({
      message: `${message}. Connect a Muse account with /connect, or run \`muse login\`.`,
      url: MUSE_URL,
      requestBodyValues: {},
      statusCode: HTTP_UNAUTHORIZED,
      responseBody: JSON.stringify({ error: { type: 'authentication_error', message } }),
      isRetryable: false,
    })
  }
  return new MuseTurnError({ terminal: params.terminal, reason: error ? `${message} (${error.kind})` : message })
}

function option<T extends string>({ value, allowed, name }: { value: unknown; allowed: readonly T[]; name: string }) {
  if (value === undefined || value === null || value === '') return null
  const match = allowed.find((candidate) => candidate === value)
  if (match) return match
  throw new Error(`Muse ${name} must be one of ${allowed.join(', ')}`)
}

export class MuseLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3'
  readonly provider = PROVIDER_ID
  readonly supportedUrls = {}

  readonly modelId: string
  readonly runtime: MuseRuntime
  // `null` uses the `muse login` of the machine.
  readonly apiKey: string | null
  readonly defaults: { approvalMode: ApprovalMode | null; permissionProfile: string | null }

  constructor(options: { modelId: string; runtime: MuseRuntime; apiKey: string | null; defaults: { approvalMode: ApprovalMode | null; permissionProfile: string | null } }) {
    this.modelId = options.modelId
    this.runtime = options.runtime
    this.apiKey = options.apiKey
    this.defaults = options.defaults
  }

  async doGenerate(): Promise<never> {
    throw new Error('Muse models only support streaming')
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const abort = new AbortController()
    const signal = options.abortSignal ? AbortSignal.any([abort.signal, options.abortSignal]) : abort.signal
    const kind = options.headers?.[KIND_HEADER]
    const sessionID = options.headers?.[SESSION_HEADER]
    const settings = options.providerOptions?.[PROVIDER_ID] ?? {}
    const effort = option({ value: settings[EFFORT_OPTION], allowed: EFFORTS, name: EFFORT_OPTION })
    const approvalMode = option({ value: settings[APPROVAL_OPTION], allowed: APPROVAL_MODES, name: APPROVAL_OPTION }) ?? this.defaults.approvalMode
    const permissionProfile = typeof settings[PROFILE_OPTION] === 'string' && settings[PROFILE_OPTION] ? settings[PROFILE_OPTION] : this.defaults.permissionProfile
    const agentPrompt = typeof settings[AGENT_PROMPT_OPTION] === 'string' ? settings[AGENT_PROMPT_OPTION] : ''
    const { input, displayText } = turnInput(options.prompt)
    const runtime = this.runtime
    const request = { model: this.modelId, apiKey: this.apiKey }
    let closed = false
    let task: Promise<void> = Promise.resolve()
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: (controller) => {
        controller.enqueue({ type: 'stream-start', warnings: [] })
        const emit = (part: LanguageModelV3StreamPart) => {
          if (!closed) controller.enqueue(part)
        }
        const finish = (result: TurnCompletedParams | Error) => {
          if (closed) return
          if (result instanceof Error && !errore.isAbortError(result)) emit({ type: 'error', error: result })
          if (!(result instanceof Error) && result.terminal === 'completed') {
            emit({ type: 'finish', finishReason: { unified: 'stop', raw: 'completed' }, usage: usageOf(result.usage) })
          }
          if (!(result instanceof Error) && result.terminal !== 'completed') emit({ type: 'error', error: turnFailure(result) })
          closed = true
          controller.close()
        }
        // Titles and summaries never reach Muse: the plugin answers them (see index.ts).
        if (kind !== 'primary' || !sessionID) {
          finish(new MuseSessionError({ operation: 'request', reason: `${kind ?? 'unknown'} requests are not supported by Muse models` }))
          return
        }
        if (input.length === 0) {
          finish(new MuseSessionError({ operation: 'turn', reason: 'the message has nothing to send' }))
          return
        }
        task = runtime
          .run({
            ...request,
            sessionID,
            effort,
            approvalMode,
            permissionProfile,
            input,
            preamble: preamble({ agentPrompt, history: earlierConversation(options.prompt) }),
            displayText,
            emit,
            signal,
          })
          .then(finish, (cause) => finish(new MuseSessionError({ operation: 'turn', reason: 'unexpected failure', cause })))
      },
      // Waits for the interrupt, so the next step does not queue behind the stopped turn.
      cancel: () => {
        closed = true
        abort.abort()
        return task
      },
    })
    return { stream }
  }
}
