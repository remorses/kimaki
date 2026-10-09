// Pure derivations over the session event log. Everything the session needs to
// know (messages, resume handle, usage, tool loop) is computed here from events.

import type { HistoryItem, RealtimeEvent, Usage } from './types.ts'

export type Message =
  | { kind: 'summary'; text: string }
  | { kind: 'user'; text: string; itemId: string | null; done: boolean }
  | {
      kind: 'assistant'
      text: string
      itemId: string | null
      done: boolean
      interrupted: boolean
      /** Audio was cut and the heard part of the text is unknown. Left out of history. */
      truncated: boolean
    }
  | { kind: 'tool'; callId: string; name: string; args: string; output: string | null; cancelled: boolean }

export type View = {
  connected: boolean
  messages: Message[]
  resumeHandle: string | null
  usage: Usage
  /** A model reply started and has not finished yet. */
  responding: boolean
  /** Tool calls without an output. */
  pendingToolCalls: string[]
  /** All tool outputs of the last reply are in, and no new reply was requested yet. */
  needsResponse: boolean
  /** OpenAI/xAI item of the latest reply audio, the target of a truncate. */
  outputItemId: string | null
}

export const emptyUsage: Usage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  inputAudioTokens: 0,
  outputAudioTokens: 0,
  billedSeconds: 0,
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    inputAudioTokens: a.inputAudioTokens + b.inputAudioTokens,
    outputAudioTokens: a.outputAudioTokens + b.outputAudioTokens,
    billedSeconds: a.billedSeconds + b.billedSeconds,
  }
}

export function deriveMessages(events: readonly RealtimeEvent[]): Message[] {
  const messages: Message[] = []
  // Gemini text has no ids and input/output transcripts interleave, so fragments join the open message of their role.
  const openUser = () => messages.findLast((m) => m.kind === 'user' && !m.done && m.itemId === null)
  const openAssistant = () => messages.findLast((m) => m.kind === 'assistant' && !m.done)
  const closeAssistant = (interrupted: boolean) => {
    for (const message of messages) {
      if (message.kind !== 'assistant' || message.done) continue
      message.done = true
      message.interrupted = message.interrupted || interrupted
    }
  }

  for (const event of events) {
    switch (event.type) {
      case 'history.seeded': {
        for (const item of event.items) {
          if (item.role === 'summary') messages.push({ kind: 'summary', text: item.text })
          if (item.role === 'user') messages.push({ kind: 'user', text: item.text, itemId: null, done: true })
          if (item.role === 'assistant') {
            messages.push({ kind: 'assistant', text: item.text, itemId: null, done: true, interrupted: false, truncated: false })
          }
          if (item.role === 'tool') messages.push({ kind: 'tool', ...item, cancelled: false })
        }
        break
      }
      case 'input.committed': {
        if (messages.some((m) => m.kind === 'user' && m.itemId === event.itemId)) break
        messages.push({ kind: 'user', text: '', itemId: event.itemId, done: false })
        break
      }
      case 'input.text': {
        // With an item id the provider sends the full transcript (OpenAI, xAI); without one, fragments (Gemini).
        if (event.itemId !== null) {
          const message = messages.find((m) => m.kind === 'user' && m.itemId === event.itemId)
          if (message?.kind === 'user') {
            message.text = event.text
            message.done = message.done || event.final
            break
          }
          messages.push({ kind: 'user', text: event.text, itemId: event.itemId, done: event.final })
          break
        }
        const open = openUser()
        if (open?.kind === 'user') {
          open.text += event.text
          open.done = event.final
          break
        }
        messages.push({ kind: 'user', text: event.text, itemId: null, done: event.final })
        break
      }
      case 'speech.started': {
        // A new utterance starts: earlier id-less transcripts are complete.
        for (const message of messages) {
          if (message.kind === 'user' && message.itemId === null) message.done = true
        }
        break
      }
      case 'user.text': {
        messages.push({ kind: 'user', text: event.text, itemId: null, done: true })
        break
      }
      case 'output.text': {
        const open = event.itemId === null
          ? openAssistant()
          : messages.find((m) => m.kind === 'assistant' && m.itemId === event.itemId && !m.done)
        if (open?.kind === 'assistant') {
          open.text += event.text
          break
        }
        messages.push({ kind: 'assistant', text: event.text, itemId: event.itemId, done: false, interrupted: false, truncated: false })
        break
      }
      case 'tool.call': {
        messages.push({ kind: 'tool', callId: event.callId, name: event.name, args: event.args, output: null, cancelled: false })
        break
      }
      case 'tool.result': {
        const message = messages.find((m) => m.kind === 'tool' && m.callId === event.callId)
        if (message?.kind === 'tool') message.output = event.output
        break
      }
      case 'tools.cancelled': {
        for (const message of messages) {
          if (message.kind === 'tool' && event.callIds.includes(message.callId)) message.cancelled = true
        }
        break
      }
      case 'output.truncated': {
        const message = messages.find((m) => m.kind === 'assistant' && m.itemId === event.itemId)
        if (message?.kind !== 'assistant') break
        if (event.text !== null) message.text = event.text
        message.truncated = event.text === null
        break
      }
      case 'interrupted': {
        closeAssistant(true)
        break
      }
      case 'session.closed': {
        // Nothing continues across connections; the next reply is a new message.
        closeAssistant(true)
        for (const message of messages) {
          if (message.kind === 'user' && message.itemId === null) message.done = true
        }
        break
      }
      case 'response.done': {
        closeAssistant(event.status === 'cancelled')
        break
      }
    }
  }
  return messages
}

export function deriveHistory(events: readonly RealtimeEvent[]): HistoryItem[] {
  return deriveMessages(events).flatMap((message): HistoryItem[] => {
    if (message.kind === 'summary') return [{ role: 'summary', text: message.text }]
    if (message.kind === 'tool') {
      if (message.output === null) return []
      return [{ role: 'tool', callId: message.callId, name: message.name, args: message.args, output: message.output }]
    }
    // Unheard words must not come back as said after a resume.
    if (message.kind === 'assistant' && message.truncated) return []
    const text = message.text.trim()
    if (!text) return []
    return [{ role: message.kind, text }]
  })
}

/**
 * OpenAI/xAI only continue after tool outputs when the client sends response.create.
 * True when the last reply completed with tool calls, all of them have outputs,
 * and no new reply was requested or started since.
 */
function needsResponse(events: readonly RealtimeEvent[]): boolean {
  const done = events.findLastIndex((e) => e.type === 'response.done')
  const reply = events[done]
  if (reply?.type !== 'response.done' || reply.status !== 'completed') return false
  const previousDone = events.findLastIndex((e, i) => i < done && e.type === 'response.done')
  const calls = events.slice(previousDone + 1, done).flatMap((e) => (e.type === 'tool.call' ? [e.callId] : []))
  if (calls.length === 0) return false
  const results = new Set(events.flatMap((e) => (e.type === 'tool.result' ? [e.callId] : [])))
  if (!calls.every((id) => results.has(id))) return false
  return !events.some((e, i) => i > done && (e.type === 'response.requested' || e.type === 'response.started'))
}

/** Resume handles only count when issued by the latest connection. */
function resumeHandle(events: readonly RealtimeEvent[]): string | null {
  const lastStart = events.findLastIndex((e) => e.type === 'session.started')
  const connectionStart = events.findLastIndex((e, i) => i < lastStart && e.type === 'session.closed')
  const handle = events.findLast((e, i) => i > connectionStart && e.type === 'resume.handle')
  return handle?.type === 'resume.handle' ? handle.handle : null
}

export function deriveView(events: readonly RealtimeEvent[]): View {
  const messages = deriveMessages(events)
  const lastStart = events.findLastIndex((e) => e.type === 'session.started')
  const lastClose = events.findLastIndex((e) => e.type === 'session.closed')
  const replyEnd = events.findLastIndex(
    (e) => e.type === 'response.done' || e.type === 'interrupted' || e.type === 'session.closed',
  )
  const outputItem = events.findLast((e) => e.type === 'output.item')
  return {
    connected: lastStart > lastClose,
    messages,
    resumeHandle: resumeHandle(events),
    usage: events.reduce((total, e) => (e.type === 'usage' ? addUsage(total, e.usage) : total), emptyUsage),
    responding: events.some(
      (e, i) => i > replyEnd && (e.type === 'response.started' || e.type === 'output.item' || e.type === 'output.text'),
    ),
    pendingToolCalls: messages.flatMap((m) =>
      m.kind === 'tool' && m.output === null && !m.cancelled ? [m.callId] : [],
    ),
    needsResponse: needsResponse(events),
    outputItemId: outputItem?.type === 'output.item' ? outputItem.itemId : null,
  }
}
