// Pure event-stream derivation functions for session lifecycle state.
// These functions derive lifecycle decisions from an event buffer array.
// Zero imports from thread-session-runtime.ts, store.ts, or state.ts.
// Only types from @opencode-ai/sdk/v2 and the getOpencodeEventSessionId helper.

import type { Event as OpenCodeEvent } from '@opencode-ai/sdk/v2'
import { getOpencodeEventSessionId } from './opencode-session-event-log.js'

export type EventBufferEntry = {
  event: OpenCodeEvent
  timestamp: number
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
  const runStart = getRunStartTimeForIdle({ events, sessionId, idleEventIndex })
  return runStart !== undefined
}

// Checks if candidateSessionId appears as a subtask of mainSessionId.
// A subtask is detected when a message.part.updated with tool=task has
// the candidateSessionId mentioned in the tool output (task_id: <sessionId>)
// or in state.metadata.sessionId.
export function isDerivedSubtaskSession({
  events,
  mainSessionId,
  candidateSessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  mainSessionId: string
  candidateSessionId: string
  upToIndex?: number
}): boolean {
  const end = upToIndex ?? events.length - 1
  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const e = entry.event
    if (e.type !== 'message.part.updated') {
      continue
    }
    const part = e.properties.part
    if (part.sessionID !== mainSessionId) {
      continue
    }
    if (part.type !== 'tool' || part.tool !== 'task') {
      continue
    }
    // Check state.output for "task_id: <candidateSessionId>"
    const state = part.state as { output?: string; metadata?: { sessionId?: string } } | undefined
    if (!state) {
      continue
    }
    // Check state.metadata.sessionId first (spec-defined path)
    if (state.metadata?.sessionId === candidateSessionId) {
      return true
    }
    // Fallback: extract from tool output "task_id: <sessionId>"
    if (typeof state.output === 'string' && state.output.includes(`task_id: ${candidateSessionId}`)) {
      return true
    }
  }
  return false
}
