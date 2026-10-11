// Backend of voice calls. GPT-Live talks; for real work it delegates, and this tool loop
// does the work with a fast model on the same ChatGPT subscription (the Codex Responses
// endpoint OpenCode also uses). OpenAI recommends gpt-6-luna as the GPT-Live backend:
// https://developers.openai.com/api/docs/guides/live-delegation#reduce-backend-latency
//
//   run(text) ─▶ POST /codex/responses (SSE) ─▶ function calls? ─▶ execute, append outputs, repeat
//                                            └▶ text ─▶ returned, GPT-Live says it
//
// The endpoint only takes store: false, so every request sends the whole history; the fixed
// prompt_cache_key and stable instructions and tools keep that prefix cached.

import crypto from 'node:crypto'
import * as errore from 'errore'
import { EventSourceParserStream } from 'eventsource-parser/stream'

import type { ChatGPTAuth } from './live-call.ts'

export const DEFAULT_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
const MODEL = 'gpt-6-luna'
// Stops a model that keeps calling tools without ever answering.
const MAX_STEPS = 30
// One stalled response must not block the call: later requests wait in the queue.
const RESPONSE_TIMEOUT_MS = 60_000

export type AgentTool = {
  description: string
  // JSON Schema of the arguments object.
  parameters: Record<string, unknown>
  // Receives the parsed JSON arguments. The return value goes back to the model as JSON.
  execute(args: unknown): unknown
}

export class VoiceAgentError extends errore.createTaggedError({
  name: 'VoiceAgentError',
  message: 'Voice backend $operation failed',
}) {}

export class VoiceAgentStoppedError extends errore.createTaggedError({
  name: 'VoiceAgentStoppedError',
  message: 'Voice backend stopped: the call ended',
  extends: errore.AbortError,
}) {}

type InputItem =
  | { type: 'message'; role: 'user'; content: Array<{ type: 'input_text'; text: string }> }
  | { type: 'message'; role: 'assistant'; content: Array<{ type: 'output_text'; text: string }> }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

type OutputItem = {
  type?: string
  call_id?: string
  name?: string
  arguments?: string
  content?: Array<{ type?: string; text?: string }>
  action?: { query?: string }
}

type StreamEvent = { type?: string; item?: OutputItem; response?: { error?: { message?: string } }; message?: string }

const userMessage = (text: string): InputItem => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] })

export function createVoiceAgent({
  auth,
  url = DEFAULT_RESPONSES_URL,
  instructions,
  tools,
  onToolCall,
  onToolResult,
}: {
  auth: ChatGPTAuth
  url?: string
  instructions: string
  tools: Record<string, AgentTool>
  // Every tool call, also server-side web_search; args is the JSON string of the arguments.
  onToolCall: (call: { name: string; args: string }) => void
  onToolResult: (result: { name: string; output: string }) => void
}) {
  const history: InputItem[] = []
  const cacheKey = crypto.randomUUID()
  const abort = new AbortController()
  const definitions = [
    ...Object.entries(tools).map(([name, tool]) => ({ type: 'function', name, description: tool.description, parameters: tool.parameters })),
    { type: 'web_search' },
  ]
  // Runs one at a time; a run waits for the ones before it.
  const queue = { tail: Promise.resolve() as Promise<unknown> }

  // One model response: its function calls and its text.
  async function respond() {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${auth.accessToken}`,
        ...(auth.accountId && { 'chatgpt-account-id': auth.accountId }),
        originator: 'codex_cli_rs',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        reasoning: { effort: 'low' },
        service_tier: 'priority',
        instructions,
        tools: definitions,
        parallel_tool_calls: true,
        input: history,
        stream: true,
        store: false,
        prompt_cache_key: cacheKey,
      }),
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(RESPONSE_TIMEOUT_MS)]),
    }).catch((cause) => new VoiceAgentError({ operation: 'request', cause }))
    if (response instanceof Error) return response
    if (!response.ok || !response.body) {
      const body = await response.text().catch(() => '')
      return new VoiceAgentError({ operation: `request (HTTP ${response.status}: ${body.slice(0, 300)})` })
    }
    const items: OutputItem[] = []
    const events = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream())
    const read = await (async () => {
      for await (const message of events) {
        const event = errore.try(() => JSON.parse(message.data) as StreamEvent)
        if (event instanceof Error) continue
        if (event.type === 'response.output_item.done' && event.item) items.push(event.item)
        if (event.type === 'response.completed') return
        if (event.type === 'response.failed' || event.type === 'response.incomplete') {
          return new VoiceAgentError({ operation: `response (${event.response?.error?.message ?? event.type})` })
        }
        if (event.type === 'error') return new VoiceAgentError({ operation: `response (${event.message ?? 'error'})` })
      }
      // A cut-off answer must not count as the final one.
      return new VoiceAgentError({ operation: 'response (stream ended before response.completed)' })
    })().catch((cause) => new VoiceAgentError({ operation: 'stream', cause }))
    if (read instanceof Error) return read
    for (const item of items) {
      if (item.type === 'web_search_call') onToolCall({ name: 'web_search', args: JSON.stringify({ query: item.action?.query ?? '' }) })
    }
    const calls = items.flatMap((item) =>
      item.type === 'function_call' && item.call_id && item.name ? [{ call_id: item.call_id, name: item.name, arguments: item.arguments ?? '{}' }] : [],
    )
    const text = items
      .flatMap((item) => (item.type === 'message' ? (item.content ?? []) : []))
      .map((part) => part.text ?? '')
      .join('')
      .trim()
    return { calls, text }
  }

  async function execute(call: { call_id: string; name: string; arguments: string }) {
    onToolCall({ name: call.name, args: call.arguments })
    const tool = tools[call.name]
    const args = errore.try(() => JSON.parse(call.arguments) as unknown)
    const result = await (async () => {
      if (!tool) return { error: `Unknown tool ${call.name}` }
      if (args instanceof Error) return { error: `Invalid JSON arguments: ${call.arguments}` }
      const value = await Promise.resolve()
        .then(() => tool.execute(args))
        .catch((cause) => new VoiceAgentError({ operation: `tool ${call.name}`, cause }))
      if (value instanceof Error) return { error: value.cause instanceof Error ? value.cause.message : value.message }
      return value ?? null
    })()
    const output = JSON.stringify(result) ?? 'null'
    onToolResult({ name: call.name, output })
    return { type: 'function_call_output' as const, call_id: call.call_id, output }
  }

  async function turn(text: string): Promise<VoiceAgentError | VoiceAgentStoppedError | string> {
    history.push(userMessage(text))
    for (let step = 0; step < MAX_STEPS; step++) {
      const reply = await respond()
      if (reply instanceof Error) return reply
      if (reply.text) history.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply.text }] })
      if (reply.calls.length === 0) return reply.text
      history.push(...reply.calls.map((call) => ({ type: 'function_call' as const, ...call })))
      history.push(...(await Promise.all(reply.calls.map(execute))))
      if (abort.signal.aborted) return new VoiceAgentStoppedError()
    }
    return new VoiceAgentError({ operation: `run (more than ${MAX_STEPS} tool steps)` })
  }

  return {
    // Runs the model on a new user message and resolves with its final text.
    run(text: string): Promise<VoiceAgentError | VoiceAgentStoppedError | string> {
      const result = queue.tail.then(() => turn(text))
      queue.tail = result
      return result
    },
    // Context for the next run, without running the model now.
    note(text: string) {
      queue.tail = queue.tail.then(() => history.push(userMessage(text)))
    },
    stop() {
      abort.abort(new VoiceAgentStoppedError())
    },
  }
}
