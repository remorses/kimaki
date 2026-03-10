// Pure event-stream derivation functions for session lifecycle state.
// These functions derive lifecycle decisions from an event buffer array.
// Zero imports from thread-session-runtime.ts, store.ts, or state.ts.
// Only types from @opencode-ai/sdk/v2 and the getOpencodeEventSessionId helper.

import type {
  Event as OpenCodeEvent,
  Message as OpenCodeMessage,
  Part,
} from '@opencode-ai/sdk/v2'
import { getOpencodeEventSessionId } from './opencode-session-event-log.js'

export type EventBufferEntry = {
  event: OpenCodeEvent
  timestamp: number
  eventIndex?: number
}

type AssistantMessage = Extract<OpenCodeMessage, { role: 'assistant' }>
type UserMessage = Extract<OpenCodeMessage, { role: 'user' }>

function getTaskChildSessionId({
  part,
}: {
  part: Extract<Part, { type: 'tool' }>
}): string | undefined {
  // Event-shape reference:
  // - discord/src/session-handler/event-stream-fixtures/real-session-task-three-parallel-sleeps.jsonl
  // - In real task events, state.metadata.sessionId appears on running/completed
  //   tool updates and is the canonical child-session identifier.
  // We intentionally do not parse state.output because it is user-facing text
  // and can change format across providers/versions.
  const metadataValue = (part.state as { metadata?: unknown }).metadata
  const metadataSessionId =
    metadataValue && typeof metadataValue === 'object'
      ? (metadataValue as { sessionId?: unknown }).sessionId
      : undefined
  if (typeof metadataSessionId === 'string' && metadataSessionId.length > 0) {
    return metadataSessionId
  }
  return undefined
}

function getTaskCandidateFromEvent({
  event,
  mainSessionId,
}: {
  event: OpenCodeEvent
  mainSessionId: string
}): { assistantMessageId: string; childSessionId: string; subagentType?: string } | undefined {
  if (event.type !== 'message.part.updated') {
    return undefined
  }

  const part = event.properties.part
  if (part.sessionID !== mainSessionId) {
    return undefined
  }
  if (part.type !== 'tool' || part.tool !== 'task') {
    return undefined
  }

  const childSessionId = getTaskChildSessionId({ part })
  if (!childSessionId) {
    return undefined
  }

  const subagentType = part.state.input?.subagent_type
  return {
    assistantMessageId: part.messageID,
    childSessionId,
    subagentType: typeof subagentType === 'string' ? subagentType : undefined,
  }
}

// Scans backward for most recent session-scoped lifecycle event.
// Returns true if the latest lifecycle event for sessionId is session.status busy.
export function isSessionBusy({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): boolean {
  const end = upToIndex ?? events.length - 1
  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const e = entry.event
    const eid = getOpencodeEventSessionId(e)
    if (eid !== sessionId) {
      continue
    }
    if (e.type === 'session.idle') {
      return false
    }
    if (e.type === 'session.status') {
      return e.properties.status.type === 'busy'
    }
  }
  return false
}

export function isAssistantMessageNaturalCompletion({
  message,
}: {
  message: AssistantMessage
}): boolean {
  if (typeof message.time.completed !== 'number') {
    return false
  }
  if (message.error) {
    return false
  }
  // finish="tool-calls" means the model's last step was tool execution.
  // Mid-turn tool-call steps don't get footers — the footer comes from the
  // final text response (finish="stop") that follows. If the turn ends with
  // only tool-calls and no text follow-up, no footer is emitted. This is
  // acceptable since models almost always follow up with text after tools.
  return message.finish !== 'tool-calls'
}

export function hasAssistantMessageCompletedBefore({
  events,
  sessionId,
  messageId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  messageId: string
  upToIndex?: number
}): boolean {
  const end = upToIndex ?? events.length - 1
  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const event = entry.event
    if (event.type !== 'message.updated') {
      continue
    }
    const info = event.properties.info
    if (info.sessionID !== sessionId || info.role !== 'assistant' || info.id !== messageId) {
      continue
    }
    return typeof info.time.completed === 'number'
  }
  return false
}

export function getLatestUserMessage({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): UserMessage | undefined {
  const end = upToIndex ?? events.length - 1
  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const event = entry.event
    if (event.type !== 'message.updated') {
      continue
    }
    const info = event.properties.info
    if (info.sessionID !== sessionId || info.role !== 'user') {
      continue
    }
    return info
  }
  return undefined
}

export function getCurrentTurnStartTime({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): number | undefined {
  const latestUserMessage = getLatestUserMessage({
    events,
    sessionId,
    upToIndex,
  })
  return latestUserMessage?.time.created
}

// Token total helper — sum of input + output + reasoning + cache.read + cache.write
function getTokenTotal(tokens: {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}): number {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

// Scans backward for most recent message.updated with role=assistant for sessionId.
// Extracts model, providerID, agent, tokensUsed.
export function getLatestRunInfo({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): {
  model: string | undefined
  providerID: string | undefined
  agent: string | undefined
  tokensUsed: number
} {
  const result = {
    model: undefined as string | undefined,
    providerID: undefined as string | undefined,
    agent: undefined as string | undefined,
    tokensUsed: 0,
  }
  const end = upToIndex ?? events.length - 1
  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const e = entry.event
    if (e.type !== 'message.updated') {
      continue
    }
    const msg = e.properties.info
    if (msg.sessionID !== sessionId || msg.role !== 'assistant') {
      continue
    }
    return {
      model: 'modelID' in msg ? (msg.modelID as string) : undefined,
      providerID: 'providerID' in msg ? (msg.providerID as string) : undefined,
      agent: 'mode' in msg ? (msg.mode as string) : undefined,
      tokensUsed: 'tokens' in msg && msg.tokens
        ? getTokenTotal(msg.tokens as { input: number; output: number; reasoning: number; cache: { read: number; write: number } })
        : 0,
    }
  }
  return result
}

export function getAssistantMessageIdsForLatestUserTurn({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): Set<string> {
  const latestUserMessage = getLatestUserMessage({
    events,
    sessionId,
    upToIndex,
  })
  if (!latestUserMessage) {
    return new Set<string>()
  }
  const end = upToIndex === undefined ? events.length : upToIndex + 1
  const assistantMessageIds = new Set<string>()
  for (let i = 0; i < end; i++) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const e = entry.event
    if (e.type !== 'message.updated') {
      continue
    }
    const msg = e.properties.info
    if (msg.sessionID !== sessionId || msg.role !== 'assistant') {
      continue
    }
    if (msg.parentID === latestUserMessage.id) {
      assistantMessageIds.add(msg.id)
    }
  }
  return assistantMessageIds
}

export function getLatestAssistantMessageIdForLatestUserTurn({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): string | undefined {
  const latestUserMessage = getLatestUserMessage({
    events,
    sessionId,
    upToIndex,
  })
  if (!latestUserMessage) {
    return undefined
  }
  const end = upToIndex ?? events.length - 1
  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const event = entry.event
    if (event.type !== 'message.updated') {
      continue
    }
    const info = event.properties.info
    if (info.sessionID !== sessionId || info.role !== 'assistant') {
      continue
    }
    if (info.parentID === latestUserMessage.id) {
      return info.id
    }
  }
  return undefined
}

export function doesLatestUserTurnHaveNaturalCompletion({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): boolean {
  const latestAssistantMessageId = getLatestAssistantMessageIdForLatestUserTurn({
    events,
    sessionId,
    upToIndex,
  })
  if (!latestAssistantMessageId) {
    return false
  }

  const end = upToIndex ?? events.length - 1
  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const event = entry.event
    if (event.type !== 'message.updated') {
      continue
    }
    const info = event.properties.info
    if (info.sessionID !== sessionId || info.role !== 'assistant') {
      continue
    }
    if (info.id !== latestAssistantMessageId) {
      continue
    }
    return isAssistantMessageNaturalCompletion({ message: info })
  }

  return false
}

export function isAssistantMessageInLatestUserTurn({
  events,
  sessionId,
  messageId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  messageId: string
  upToIndex?: number
}): boolean {
  const assistantMessageIds = getAssistantMessageIdsForLatestUserTurn({
    events,
    sessionId,
    upToIndex,
  })
  return assistantMessageIds.has(messageId)
}

// Returns a stable 1-based subtask index for candidateSessionId.
// Indexing scope is the parent assistant message that spawned the task tool calls,
// so numbering restarts at 1 for each assistant message.
export function getDerivedSubtaskIndex({
  events,
  mainSessionId,
  candidateSessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  mainSessionId: string
  candidateSessionId: string
  upToIndex?: number
}): number | undefined {
  const end = upToIndex ?? events.length - 1
  let parentAssistantMessageId: string | undefined

  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const candidate = getTaskCandidateFromEvent({
      event: entry.event,
      mainSessionId,
    })
    if (!candidate) {
      continue
    }
    if (candidate.childSessionId !== candidateSessionId) {
      continue
    }
    parentAssistantMessageId = candidate.assistantMessageId
    break
  }

  if (!parentAssistantMessageId) {
    return undefined
  }

  const indexByChildSessionId = new Map<string, number>()
  for (let i = 0; i <= end; i++) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const candidate = getTaskCandidateFromEvent({
      event: entry.event,
      mainSessionId,
    })
    if (!candidate || candidate.assistantMessageId !== parentAssistantMessageId) {
      continue
    }
    if (!indexByChildSessionId.has(candidate.childSessionId)) {
      indexByChildSessionId.set(
        candidate.childSessionId,
        indexByChildSessionId.size + 1,
      )
    }
  }

  return indexByChildSessionId.get(candidateSessionId)
}

// Returns the subagent_type (e.g. "explore", "general") for a given child session.
// Used to build labels like "explore-1" instead of generic "task-1".
export function getDerivedSubtaskAgentType({
  events,
  mainSessionId,
  candidateSessionId,
}: {
  events: EventBufferEntry[]
  mainSessionId: string
  candidateSessionId: string
}): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const candidate = getTaskCandidateFromEvent({
      event: entry.event,
      mainSessionId,
    })
    if (!candidate || candidate.childSessionId !== candidateSessionId) {
      continue
    }
    return candidate.subagentType
  }
  return undefined
}
