// Pure event-stream derivation functions for session lifecycle state.
// These functions derive lifecycle decisions from an event buffer array.
// Zero imports from thread-session-runtime.ts, store.ts, or state.ts.
// Only types from @opencode-ai/sdk/v2 and the getOpencodeEventSessionId helper.

import type { Event as OpenCodeEvent, Part } from '@opencode-ai/sdk/v2'
import { getOpencodeEventSessionId } from './opencode-session-event-log.js'

export type EventBufferEntry = {
  event: OpenCodeEvent
  timestamp: number
  eventIndex?: number
}

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

// Called after idle event is pushed. Skips the current idle, looks for
// session.error(MessageAbortedError) preceding it.
// Event order on abort: session.error(MessageAbortedError) → session.idle
// Event order on normal: step-finish → session.idle (no error between)
export function wasRecentlyAborted({
  events,
  sessionId,
  idleEventIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  idleEventIndex: number
}): boolean {
  let skippedCurrentIdle = false
  for (let i = idleEventIndex; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const e = entry.event
    const eid = getOpencodeEventSessionId(e)
    if (eid !== sessionId) {
      continue
    }
    // Skip the current session.idle that triggered this call
    if (!skippedCurrentIdle && e.type === 'session.idle') {
      skippedCurrentIdle = true
      continue
    }
    if (e.type === 'session.error') {
      return e.properties.error?.name === 'MessageAbortedError'
    }
    // Hit a previous idle or busy — no abort preceded the current idle
    if (e.type === 'session.idle') {
      return false
    }
    if (e.type === 'session.status' && e.properties.status.type === 'busy') {
      return false
    }
  }
  return false
}

// Finds the timestamp of the session.status busy event that started the run
// ending at the given idle event. Scans backward from idleEventIndex.
export function getRunStartTimeForIdle({
  events,
  sessionId,
  idleEventIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  idleEventIndex: number
}): number | undefined {
  // Scan backward from the idle to find the previous idle (run boundary).
  // Then scan forward from that boundary to find the first busy — that's the run start.
  // If no previous idle, scan from start of buffer for first busy.
  for (let i = idleEventIndex - 1; i >= 0; i--) {
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
      // Found previous idle — scan forward for first busy
      for (let j = i + 1; j < idleEventIndex; j++) {
        const entry2 = events[j]
        if (!entry2) {
          continue
        }
        const e2 = entry2.event
        const eid2 = getOpencodeEventSessionId(e2)
        if (eid2 !== sessionId) {
          continue
        }
        if (e2.type === 'session.status' && e2.properties.status.type === 'busy') {
          return entry2.timestamp
        }
      }
      return undefined
    }
  }
  // No previous idle — find the first busy for this session from start
  for (let i = 0; i < idleEventIndex; i++) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const e = entry.event
    const eid = getOpencodeEventSessionId(e)
    if (eid !== sessionId) {
      continue
    }
    if (e.type === 'session.status' && e.properties.status.type === 'busy') {
      return entry.timestamp
    }
  }
  return undefined
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

// Combines wasRecentlyAborted (false) + checks there was actually a run
// (getRunStartTimeForIdle returns a value).
export function shouldEmitFooter({
  events,
  sessionId,
  idleEventIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  idleEventIndex: number
}): boolean {
  if (wasRecentlyAborted({ events, sessionId, idleEventIndex })) {
    return false
  }

  const runWindowStart = getRunWindowStartIndex({
    events,
    sessionId,
    idleEventIndex,
  })
  const latestAssistantMessageId = getLatestAssistantMessageIdInRunWindow({
    events,
    sessionId,
    runWindowStart,
    idleEventIndex,
  })
  if (!latestAssistantMessageId) {
    return false
  }

  return hasAssistantStepFinishInRunWindow({
    events,
    sessionId,
    runWindowStart,
    idleEventIndex,
    assistantMessageId: latestAssistantMessageId,
  })
}

// Checks whether an assistant message ID belongs to the current run window.
// The run window starts after the most recent session.idle for the session
// before upToIndex and ends at upToIndex (exclusive).
export function isAssistantMessageInCurrentRunWindow({
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
  const end = upToIndex ?? events.length
  let runWindowStart = 0

  for (let i = end - 1; i >= 0; i--) {
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
      runWindowStart = i + 1
      break
    }
  }

  for (let i = runWindowStart; i < end; i++) {
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
    if (msg.id === messageId) {
      return true
    }
  }

  return false
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

function getRunWindowStartIndex({
  events,
  sessionId,
  idleEventIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  idleEventIndex: number
}): number {
  for (let i = idleEventIndex - 1; i >= 0; i--) {
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
      return i + 1
    }
  }

  return 0
}

function getLatestAssistantMessageIdInRunWindow({
  events,
  sessionId,
  runWindowStart,
  idleEventIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  runWindowStart: number
  idleEventIndex: number
}): string | undefined {
  for (let i = idleEventIndex - 1; i >= runWindowStart; i--) {
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
    return msg.id
  }
  return undefined
}

function hasAssistantStepFinishInRunWindow({
  events,
  sessionId,
  runWindowStart,
  idleEventIndex,
  assistantMessageId,
}: {
  events: EventBufferEntry[]
  sessionId: string
  runWindowStart: number
  idleEventIndex: number
  assistantMessageId: string
}): boolean {
  for (let i = runWindowStart; i < idleEventIndex; i++) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const e = entry.event
    const eid = getOpencodeEventSessionId(e)
    if (eid !== sessionId) {
      continue
    }
    if (e.type !== 'message.part.updated') {
      continue
    }
    if (e.properties.part.type !== 'step-finish') {
      continue
    }
    if (e.properties.part.messageID === assistantMessageId) {
      return true
    }
  }

  return false
}
