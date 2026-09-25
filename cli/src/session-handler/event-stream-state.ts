// Pure derivations from native OpenCode v2 and Kimaki-local session events.

import type { V2Event } from '@opencode/client'
import {
  isJsonRecord,
  jsonFiniteNumber,
  jsonString,
  parseJsonUnknown,
} from '../utils.js'
import { getOpencodeEventSessionId } from './opencode-session-event-log.js'

export type KimakiLocalEvent =
  | {
      type: 'kimaki.queue-dispatch.started'
      data: { sessionID: string }
    }
  | {
      type: 'kimaki.queue-dispatch.settled'
      data: { sessionID: string }
    }
  | {
      type: 'kimaki.question-queue-handoff.started'
      data: {
        sessionID: string
        requestID?: string
      }
    }
  | {
      type: 'kimaki.subagent.routing'
      data: {
        sessionID: string
        assistantMessageID: string
        id: string
        childSessionID: string
        status?: string
      }
    }

export type EventBufferEvent = V2Event | KimakiLocalEvent

export type EventBufferEntry = {
  event: EventBufferEvent
  timestamp: number
  eventIndex?: number
}

const KIMAKI_LOCAL_EVENT_TYPES = new Set([
  'kimaki.queue-dispatch.started',
  'kimaki.queue-dispatch.settled',
  'kimaki.question-queue-handoff.started',
  'kimaki.subagent.routing',
])

function parseKimakiLocalEvent(value: Record<string, unknown>): KimakiLocalEvent | undefined {
  const type = jsonString(value.type)
  if (!type || !KIMAKI_LOCAL_EVENT_TYPES.has(type) || !isJsonRecord(value.data)) return undefined
  const sessionID = jsonString(value.data.sessionID)
  if (!sessionID) return undefined
  if (type === 'kimaki.queue-dispatch.started') {
    return { type: 'kimaki.queue-dispatch.started', data: { sessionID } }
  }
  if (type === 'kimaki.queue-dispatch.settled') {
    return { type: 'kimaki.queue-dispatch.settled', data: { sessionID } }
  }
  if (type === 'kimaki.question-queue-handoff.started') {
    const requestID = jsonString(value.data.requestID)
    if (requestID) {
      return { type: 'kimaki.question-queue-handoff.started', data: { sessionID, requestID } }
    }
    return { type: 'kimaki.question-queue-handoff.started', data: { sessionID } }
  }
  const assistantMessageID = jsonString(value.data.assistantMessageID)
  const id = jsonString(value.data.id)
  const childSessionID = jsonString(value.data.childSessionID)
  if (!assistantMessageID || !id || !childSessionID) return undefined
  const status = jsonString(value.data.status)
  if (status) {
    return {
      type: 'kimaki.subagent.routing',
      data: { sessionID, assistantMessageID, id, childSessionID, status },
    }
  }
  return {
    type: 'kimaki.subagent.routing',
    data: { sessionID, assistantMessageID, id, childSessionID },
  }
}

function parseNativeDurableIdentity(value: unknown): NativeDurableIdentity | undefined {
  if (!isJsonRecord(value)) return undefined
  const aggregateID = jsonString(value.aggregateID)
  const seq = jsonFiniteNumber(value.seq)
  if (!aggregateID || seq === undefined) return undefined
  return { aggregateID, seq }
}

export function parseEventBufferEvent(raw: string): EventBufferEvent | Error {
  const parsed = parseJsonUnknown(raw)
  if (parsed instanceof Error) {
    return new Error('Failed to parse persisted session event JSON', { cause: parsed })
  }
  if (!isJsonRecord(parsed)) {
    return new Error('Persisted session event is not an object')
  }
  const type = jsonString(parsed.type)
  if (!type) {
    return new Error('Persisted session event is missing type')
  }
  const local = parseKimakiLocalEvent(parsed)
  if (local) return local
  if (!type.includes('.')) {
    return new Error(`Persisted session event has unknown type: ${type}`)
  }
  const durable = parseNativeDurableIdentity(parsed.durable)
  const event = durable ? { ...parsed, type, durable } : { ...parsed, type }
  // OpenCode owns this JSON. Kimaki only checks it is an object with a dotted type.
  return event as EventBufferEvent
}

export type NativeDurableIdentity = {
  aggregateID: string
  seq: number
}

export function getNativeDurableIdentity(
  event: EventBufferEvent,
): NativeDurableIdentity | null {
  if (!('durable' in event)) return null
  return parseNativeDurableIdentity(event.durable) ?? null
}

export function hasSeenNativeDurableEvent({
  events,
  event,
}: {
  events: EventBufferEntry[]
  event: EventBufferEvent
}): boolean {
  const identity = getNativeDurableIdentity(event)
  if (!identity) return false
  return events.some((entry) => {
    const seen = getNativeDurableIdentity(entry.event)
    if (!seen) return false
    return seen.aggregateID === identity.aggregateID && seen.seq === identity.seq
  })
}

export function getEventBufferSessionId(event: EventBufferEvent): string | undefined {
  if (
    event.type === 'kimaki.queue-dispatch.started'
    || event.type === 'kimaki.queue-dispatch.settled'
    || event.type === 'kimaki.question-queue-handoff.started'
    || event.type === 'kimaki.subagent.routing'
  ) return event.data.sessionID
  return getOpencodeEventSessionId(event)
}

function readMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key]
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value
}

export function compactSubagentRoutingEvidence(
  event: EventBufferEvent,
): Extract<KimakiLocalEvent, { type: 'kimaki.subagent.routing' }> | undefined {
  if (event.type !== 'session.tool.progress') return undefined
  const childSessionID = readMetadataString(event.data.metadata, 'sessionID')
  if (!childSessionID) return undefined
  const status = readMetadataString(event.data.metadata, 'status')
  return {
    type: 'kimaki.subagent.routing',
    data: {
      sessionID: event.data.sessionID,
      assistantMessageID: event.data.assistantMessageID,
      id: event.data.id,
      childSessionID,
      status,
    },
  }
}

// Scans backward for the latest session-scoped lifecycle event.
// Busy on queue-dispatch.started, execution.started, step.started, or
// status busy/retry. Idle on execution terminals and session.idle.
// If those were evicted from the bounded buffer, a still-running parent
// subagent tool also counts as busy. That stops `. queue` from draining
// (and the 3s interrupt plugin from aborting) while a subagent is in flight.
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
  const terminalTaskIds = new Set<string>()
  const pendingTaskIds = new Set<string>()
  for (let i = end; i >= 0; i--) {
    const event = events[i]?.event
    if (!event || getEventBufferSessionId(event) !== sessionId) continue
    if (
      event.type === 'kimaki.queue-dispatch.settled'
      || event.type === 'session.idle'
      || event.type === 'session.execution.succeeded'
      || event.type === 'session.execution.interrupted'
      || event.type === 'session.execution.failed'
    ) return false
    if (
      event.type === 'kimaki.queue-dispatch.started'
      || event.type === 'session.execution.started'
      || event.type === 'session.step.started'
    ) return true
    if (event.type === 'session.status') {
      return event.data.status.type === 'busy' || event.data.status.type === 'retry'
    }
    if (event.type === 'session.tool.success' || event.type === 'session.tool.failed') {
      terminalTaskIds.add(event.data.id)
      continue
    }
    if (
      event.type === 'session.tool.input.started'
      && event.data.name === 'subagent'
      && !terminalTaskIds.has(event.data.id)
    ) {
      pendingTaskIds.add(event.data.id)
    }
  }
  return pendingTaskIds.size > 0
}

export function getLatestExecutionStartedTimestamp({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): number | undefined {
  const end = upToIndex ?? events.length - 1
  for (let i = end; i >= 0; i--) {
    const entry = events[i]
    if (!entry) continue
    if (
      entry.event.type === 'session.execution.started'
      && getEventBufferSessionId(entry.event) === sessionId
    ) {
      return entry.timestamp
    }
  }
  return undefined
}

export function didLatestExecutionUseTool({
  events,
  sessionId,
  toolName,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  toolName: string
  upToIndex?: number
}): boolean {
  const end = upToIndex ?? events.length - 1
  for (let i = end; i >= 0; i--) {
    const event = events[i]?.event
    if (!event || getEventBufferSessionId(event) !== sessionId) continue
    if (event.type === 'session.execution.started') return false
    if (
      event.type === 'session.tool.input.started'
      && event.data.name === toolName
    ) return true
  }
  return false
}

export function hasVisibleV2OutputSinceExecutionStart({
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
    const event = events[i]?.event
    if (!event || getEventBufferSessionId(event) !== sessionId) continue
    if (event.type === 'session.execution.started') return false
    if (event.type === 'session.text.ended' || event.type === 'session.tool.called') {
      return true
    }
  }
  return false
}

export function didQuestionQueueHandoffSinceLatestQuestionAsked({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): boolean {
  const end = upToIndex ?? events.length - 1
  let handoffRequestId: string | undefined
  let latestRequestId: string | undefined
  for (let i = end; i >= 0; i--) {
    const event = events[i]?.event
    if (!event || getEventBufferSessionId(event) !== sessionId) continue
    if (event.type === 'kimaki.question-queue-handoff.started') {
      handoffRequestId = event.data.requestID
      if (latestRequestId) return handoffRequestId === latestRequestId
      continue
    }
    if (event.type !== 'form.created' || event.data.form.metadata?.kind !== 'question') {
      continue
    }
    latestRequestId ??= event.data.form.id
    if (handoffRequestId) return handoffRequestId === latestRequestId
  }
  return false
}

export function derivePendingPermissionRequests({
  events,
  sessionId,
}: {
  events: EventBufferEntry[]
  sessionId: string
}): string[] {
  const permissions = new Set<string>()
  for (const { event } of events) {
    if (getEventBufferSessionId(event) !== sessionId) continue
    if (event.type === 'permission.asked') {
      permissions.add(event.data.id)
      continue
    }
    if (event.type === 'permission.replied') permissions.delete(event.data.requestID)
  }
  return [...permissions]
}

function getTokenTotal(tokens: {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}): number {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

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
  const end = upToIndex ?? events.length - 1
  const latestStepEnd = (() => {
    for (let i = end; i >= 0; i--) {
      const event = events[i]?.event
      if (event?.type === 'session.step.ended' && event.data.sessionID === sessionId) {
        return event
      }
    }
    return undefined
  })()
  const latestStepStart = (() => {
    for (let i = end; i >= 0; i--) {
      const event = events[i]?.event
      if (event?.type === 'session.step.started' && event.data.sessionID === sessionId) {
        return event
      }
    }
    return undefined
  })()
  return {
    model: latestStepStart?.data.model.id,
    providerID: latestStepStart?.data.model.providerID,
    agent: latestStepStart?.data.agent,
    tokensUsed: latestStepEnd ? getTokenTotal(latestStepEnd.data.tokens) : 0,
  }
}

export function getContextUsageNoticePercentage({
  events,
  sessionId,
  contextLimit,
}: {
  events: EventBufferEntry[]
  sessionId: string
  contextLimit: number
}): number | undefined {
  const priorTerminalIndex = events.findLastIndex(({ event }) => {
    if (getEventBufferSessionId(event) !== sessionId) return false
    return event.type === 'session.execution.succeeded'
      || event.type === 'session.execution.failed'
      || event.type === 'session.execution.interrupted'
  })
  const totals = events.slice(priorTerminalIndex + 1).flatMap(({ event }) => {
    if (event.type !== 'session.step.ended' || event.data.sessionID !== sessionId) return []
    return [getTokenTotal(event.data.tokens)]
  })
  const latestTotal = totals.at(-1)
  if (!latestTotal) return undefined
  const currentPercentage = Math.floor((latestTotal / contextLimit) * 100)
  const threshold = Math.floor(currentPercentage / 10) * 10
  if (threshold < 10) return undefined
  const priorThreshold = totals.slice(0, -1).reduce((maximum, total) => {
    return Math.max(maximum, Math.floor((total / contextLimit) * 10) * 10)
  }, 0)
  return threshold > priorThreshold ? currentPercentage : undefined
}

const MIN_PROMPT_CACHE_READ_TO_TRACK = 1024
const PROMPT_CACHE_DROP_RATIO = 0.5

export type PromptCacheClear = {
  // Tokens that should have been read from cache: the smaller of the previous cached prefix and the current prompt.
  expectedCacheRead: number
  currentCacheRead: number
  previousMessageId: string
  currentMessageId: string
}

function getStepModelKey({
  events,
  sessionId,
  assistantMessageId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  assistantMessageId: string
  upToIndex: number
}): string | undefined {
  for (let i = upToIndex; i >= 0; i--) {
    const event = events[i]?.event
    if (
      event?.type === 'session.step.started'
      && event.data.sessionID === sessionId
      && event.data.assistantMessageID === assistantMessageId
    ) return `${event.data.model.providerID}/${event.data.model.id}`
  }
  return undefined
}

// Same-model cache drop on the first step of the latest execution vs the last
// step of an earlier successful execution. Later steps re-read their own turn's
// writes. Compactions rewrite the prompt, so they block the comparison.
export function getPromptCacheClear({
  events,
  sessionId,
  currentMessageId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  currentMessageId: string
  upToIndex?: number
}): PromptCacheClear | undefined {
  const end = upToIndex ?? events.length - 1
  const currentIndex = events.findLastIndex(({ event }, index) => {
    return index <= end
      && event.type === 'session.step.ended'
      && event.data.sessionID === sessionId
      && event.data.assistantMessageID === currentMessageId
  })
  const current = events[currentIndex]?.event
  if (current?.type !== 'session.step.ended') return undefined
  const currentModel = getStepModelKey({
    events,
    sessionId,
    assistantMessageId: currentMessageId,
    upToIndex: currentIndex,
  })
  if (!currentModel) return undefined

  const executionStartIndex = events.findLastIndex(({ event }, index) => {
    return index < currentIndex
      && event.type === 'session.execution.started'
      && event.data.sessionID === sessionId
  })
  if (executionStartIndex < 0) return undefined
  const isFirstStep = !events.slice(executionStartIndex + 1, currentIndex).some(({ event }) => {
    return event.type === 'session.step.started'
      && event.data.sessionID === sessionId
      && event.data.assistantMessageID !== currentMessageId
  })
  if (!isFirstStep) return undefined

  let insideUnsuccessfulExecution = false
  for (let i = executionStartIndex - 1; i >= 0; i--) {
    const event = events[i]?.event
    if (!event || getEventBufferSessionId(event) !== sessionId) continue
    if (event.type === 'session.compaction.started' || event.type === 'session.compaction.ended') {
      return undefined
    }
    if (event.type === 'session.execution.interrupted' || event.type === 'session.execution.failed') {
      insideUnsuccessfulExecution = true
      continue
    }
    if (event.type === 'session.execution.succeeded' || event.type === 'session.execution.started') {
      insideUnsuccessfulExecution = false
      continue
    }
    if (insideUnsuccessfulExecution || event.type !== 'session.step.ended') continue
    if (event.data.finish === 'error') continue
    const previousModel = getStepModelKey({
      events,
      sessionId,
      assistantMessageId: event.data.assistantMessageID,
      upToIndex: i,
    })
    if (previousModel !== currentModel) return undefined
    const previous = event.data.tokens
    const tokens = current.data.tokens
    // Anthropic reports a fresh cache as write only, so read alone misses the turn after a miss.
    const previousCached = previous.cache.read + previous.cache.write
    const currentPrompt = tokens.input + tokens.cache.read + tokens.cache.write
    // A reverted (shorter) prompt can only reuse its own length from cache.
    const expectedCacheRead = Math.min(previousCached, currentPrompt)
    if (expectedCacheRead < MIN_PROMPT_CACHE_READ_TO_TRACK) return undefined
    if (tokens.cache.read > expectedCacheRead * PROMPT_CACHE_DROP_RATIO) return undefined
    return {
      expectedCacheRead,
      currentCacheRead: tokens.cache.read,
      previousMessageId: event.data.assistantMessageID,
      currentMessageId,
    }
  }
  return undefined
}

function formatCompactTokenCount(count: number): string {
  if (count >= 1000) {
    const thousands = count / 1000
    const rounded = thousands >= 10 ? thousands.toFixed(0) : thousands.toFixed(1)
    return `${rounded.replace(/\.0$/, '')}k`
  }
  return String(count)
}

export function formatPromptCacheClearMessage(clear: PromptCacheClear): string {
  return `prompt cache missed (${formatCompactTokenCount(clear.expectedCacheRead)} → ${formatCompactTokenCount(clear.currentCacheRead)})`
}

export function shouldShowRetryNotice({
  events,
  event,
}: {
  events: EventBufferEntry[]
  event: Extract<V2Event, { type: 'session.status' }>
}): boolean {
  if (event.data.status.type !== 'retry') return false
  const priorRetryCreated = events.reduce<number | undefined>((latest, { event: candidate }) => {
    if (candidate.type !== 'session.status' || candidate.id === event.id) return latest
    if (candidate.data.sessionID !== event.data.sessionID) return latest
    if (candidate.data.status.type !== 'retry' || candidate.created > event.created) return latest
    return Math.max(latest ?? 0, candidate.created)
  }, undefined)
  return priorRetryCreated === undefined || event.created - priorRetryCreated >= 10_000
}

export type NativeExecutionUsage = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
  cost: number
  model: string | undefined
  providerID: string | undefined
  agent: string | undefined
  assistantMessageCount: number
  startedAt: number | undefined
}

export type NativeExecutionTerminalEvent = Extract<V2Event, {
  type:
    | 'session.execution.succeeded'
    | 'session.execution.failed'
    | 'session.execution.interrupted'
}>

export function getNativeExecutionUsage({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): NativeExecutionUsage {
  const end = upToIndex ?? events.length - 1
  const executionStartIndex = (() => {
    for (let i = end; i >= 0; i--) {
      const event = events[i]?.event
      if (event?.type === 'session.execution.started' && event.data.sessionID === sessionId) {
        return i
      }
    }
    return -1
  })()
  const usage: NativeExecutionUsage = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    cost: 0,
    model: undefined,
    providerID: undefined,
    agent: undefined,
    assistantMessageCount: 0,
    startedAt: executionStartIndex >= 0
      ? events[executionStartIndex]?.timestamp
      : undefined,
  }
  if (executionStartIndex < 0) return usage

  const assistantMessageIds = new Set<string>()
  for (let i = executionStartIndex + 1; i <= end; i++) {
    const event = events[i]?.event
    if (event?.type === 'session.step.started' && event.data.sessionID === sessionId) {
      usage.model = event.data.model.id
      usage.providerID = event.data.model.providerID
      usage.agent = event.data.agent
      continue
    }
    if (event?.type !== 'session.step.ended' || event.data.sessionID !== sessionId) continue
    usage.input += event.data.tokens.input
    usage.output += event.data.tokens.output
    usage.reasoning += event.data.tokens.reasoning
    usage.cacheRead += event.data.tokens.cache.read
    usage.cacheWrite += event.data.tokens.cache.write
    usage.total += getTokenTotal(event.data.tokens)
    usage.cost += event.data.cost
    assistantMessageIds.add(event.data.assistantMessageID)
  }
  usage.assistantMessageCount = assistantMessageIds.size
  return usage
}

export function deriveNativeExecutionTerminalAnalytics({
  events,
  event,
}: {
  events: EventBufferEntry[]
  event: NativeExecutionTerminalEvent
}) {
  const nativeUsage = getNativeExecutionUsage({
    events,
    sessionId: event.data.sessionID,
  })
  const executionStartIndex = events.findLastIndex(({ event: candidate }) => {
    return candidate.type === 'session.execution.started'
      && candidate.data.sessionID === event.data.sessionID
  })
  const failedSteps = executionStartIndex < 0
    ? []
    : events.slice(executionStartIndex + 1).flatMap(({ event: candidate }) => {
        if (
          candidate.type !== 'session.step.failed'
          || candidate.data.sessionID !== event.data.sessionID
          || !candidate.data.tokens
        ) return []
        return [candidate]
      })
  const assistantMessageIds = executionStartIndex < 0
    ? new Set<string>()
    : new Set(events.slice(executionStartIndex + 1).flatMap(({ event: candidate }) => {
        if (
          (candidate.type !== 'session.step.ended'
            && candidate.type !== 'session.step.failed')
          || candidate.data.sessionID !== event.data.sessionID
        ) return []
        return [candidate.data.assistantMessageID]
      }))
  const usage = failedSteps.reduce((total, failed) => {
    const tokens = failed.data.tokens
    if (!tokens) return total
    return {
      ...total,
      input: total.input + tokens.input,
      output: total.output + tokens.output,
      reasoning: total.reasoning + tokens.reasoning,
      cacheRead: total.cacheRead + tokens.cache.read,
      cacheWrite: total.cacheWrite + tokens.cache.write,
      total: total.total
        + tokens.input
        + tokens.output
        + tokens.reasoning
        + tokens.cache.read
        + tokens.cache.write,
      cost: total.cost + (failed.data.cost ?? 0),
      assistantMessageCount: assistantMessageIds.size,
    }
  }, {
    ...nativeUsage,
    assistantMessageCount: assistantMessageIds.size,
  })
  const outcome = event.type === 'session.execution.succeeded'
    ? 'succeeded' as const
    : event.type === 'session.execution.failed'
      ? 'failed' as const
      : 'interrupted' as const
  return {
    outcome,
    durationSec: Math.max(
      0,
      Math.round((event.created - (usage.startedAt ?? event.created)) / 1000),
    ),
    usage,
  }
}

export function getAssistantMessageIdsForLatestExecution({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): Set<string> {
  const end = upToIndex ?? events.length - 1
  const ids = new Set<string>()
  for (let i = end; i >= 0; i--) {
    const event = events[i]?.event
    if (!event || getEventBufferSessionId(event) !== sessionId) continue
    if (event.type === 'session.execution.started') break
    if (event.type === 'session.step.started') ids.add(event.data.assistantMessageID)
  }
  return new Set([...ids].reverse())
}

export function getLatestAssistantMessageIdForLatestExecution({
  events,
  sessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  sessionId: string
  upToIndex?: number
}): string | undefined {
  const end = upToIndex ?? events.length - 1
  for (let i = end; i >= 0; i--) {
    const event = events[i]?.event
    if (!event || getEventBufferSessionId(event) !== sessionId) continue
    if (event.type === 'session.execution.started') return undefined
    if (event.type === 'session.step.started') return event.data.assistantMessageID
  }
  return undefined
}

export type DerivedSubagentSession = {
  childSessionId: string
  subagentType?: string
  description?: string
  timestamp: number
}

function getSubagentCallId({
  event,
  mainSessionId,
}: {
  event: EventBufferEvent
  mainSessionId: string
}): { assistantMessageId: string; callId: string } | undefined {
  if (event.type === 'kimaki.subagent.routing') {
    if (event.data.sessionID !== mainSessionId) return undefined
    return {
      assistantMessageId: event.data.assistantMessageID,
      callId: event.data.id,
    }
  }
  if (
    event.type !== 'session.tool.progress'
    && event.type !== 'session.tool.success'
    && event.type !== 'session.tool.failed'
  ) return undefined
  if (event.data.sessionID !== mainSessionId) return undefined
  return {
    assistantMessageId: event.data.assistantMessageID,
    callId: event.data.id,
  }
}

function getSubagentChildSessionId(event: EventBufferEvent): string | undefined {
  if (event.type === 'kimaki.subagent.routing') return event.data.childSessionID
  if (
    event.type !== 'session.tool.progress'
    && event.type !== 'session.tool.success'
    && event.type !== 'session.tool.failed'
  ) return undefined
  return readMetadataString(event.data.metadata, 'sessionID')
}

function getSubagentToolName({
  events,
  mainSessionId,
  assistantMessageId,
  callId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  mainSessionId: string
  assistantMessageId: string
  callId: string
  upToIndex: number
}): string | undefined {
  for (let i = upToIndex; i >= 0; i--) {
    const prior = events[i]?.event
    if (
      prior?.type === 'session.tool.input.started'
      && prior.data.sessionID === mainSessionId
      && prior.data.assistantMessageID === assistantMessageId
      && prior.data.id === callId
    ) return prior.data.name
  }
  return undefined
}

function getSubagentInput({
  events,
  mainSessionId,
  assistantMessageId,
  callId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  mainSessionId: string
  assistantMessageId: string
  callId: string
  upToIndex: number
}) {
  for (let i = upToIndex; i >= 0; i--) {
    const prior = events[i]?.event
    if (
      prior?.type === 'session.tool.called'
      && prior.data.sessionID === mainSessionId
      && prior.data.assistantMessageID === assistantMessageId
      && prior.data.id === callId
    ) return prior.data.input
  }
  return undefined
}

function getSubagentCandidate({
  events,
  eventIndex,
  mainSessionId,
}: {
  events: EventBufferEntry[]
  eventIndex: number
  mainSessionId: string
}): {
  assistantMessageId: string
  callId: string
  childSessionId: string
  subagentType?: string
  description?: string
} | undefined {
  const event = events[eventIndex]?.event
  if (!event) return undefined
  const call = getSubagentCallId({ event, mainSessionId })
  const childSessionId = getSubagentChildSessionId(event)
  if (!call || !childSessionId) return undefined
  if (getSubagentToolName({
    events,
    mainSessionId,
    assistantMessageId: call.assistantMessageId,
    callId: call.callId,
    upToIndex: eventIndex,
  }) !== 'subagent') return undefined
  const input = getSubagentInput({
    events,
    mainSessionId,
    assistantMessageId: call.assistantMessageId,
    callId: call.callId,
    upToIndex: eventIndex,
  })
  return {
    assistantMessageId: call.assistantMessageId,
    callId: call.callId,
    childSessionId,
    subagentType: typeof input?.agent === 'string' ? input.agent : undefined,
    description: typeof input?.description === 'string' ? input.description : undefined,
  }
}

function getParentSubagentCallIds({
  events,
  mainSessionId,
  assistantMessageId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  mainSessionId: string
  assistantMessageId: string
  upToIndex: number
}): string[] {
  const callIds: string[] = []
  for (let i = 0; i <= upToIndex; i++) {
    const event = events[i]?.event
    if (
      event?.type !== 'session.tool.input.started'
      || event.data.sessionID !== mainSessionId
      || event.data.assistantMessageID !== assistantMessageId
      || event.data.name !== 'subagent'
    ) continue
    if (!callIds.includes(event.data.id)) callIds.push(event.data.id)
  }
  return callIds
}

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
  const candidate = (() => {
    for (let i = end; i >= 0; i--) {
      const value = getSubagentCandidate({ events, eventIndex: i, mainSessionId })
      if (value?.childSessionId === candidateSessionId) return value
    }
    return undefined
  })()
  if (!candidate) return undefined
  const callIds = getParentSubagentCallIds({
    events,
    mainSessionId,
    assistantMessageId: candidate.assistantMessageId,
    upToIndex: end,
  })
  const index = callIds.indexOf(candidate.callId)
  if (index < 0) return undefined
  return index + 1
}

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
    const candidate = getSubagentCandidate({ events, eventIndex: i, mainSessionId })
    if (candidate?.childSessionId === candidateSessionId && candidate.subagentType) {
      return candidate.subagentType
    }
  }
  return undefined
}

export function getDerivedSubtaskLabel({
  events,
  mainSessionId,
  candidateSessionId,
}: {
  events: EventBufferEntry[]
  mainSessionId: string
  candidateSessionId: string
}): string | undefined {
  const index = getDerivedSubtaskIndex({ events, mainSessionId, candidateSessionId })
  if (!index) return undefined
  const agent = getDerivedSubtaskAgentType({ events, mainSessionId, candidateSessionId })
  return `${agent || 'task'}-${index}`
}

export function getDerivedSubagentSessions({
  events,
  mainSessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  mainSessionId: string
  upToIndex?: number
}): DerivedSubagentSession[] {
  const end = upToIndex ?? events.length - 1
  const seen = new Set<string>()
  const sessions: DerivedSubagentSession[] = []
  for (let i = end; i >= 0; i--) {
    const candidate = getSubagentCandidate({ events, eventIndex: i, mainSessionId })
    if (!candidate || seen.has(candidate.childSessionId)) continue
    seen.add(candidate.childSessionId)
    sessions.push({
      childSessionId: candidate.childSessionId,
      subagentType: candidate.subagentType,
      description: candidate.description,
      timestamp: events[i]?.timestamp ?? 0,
    })
  }
  return sessions
}

function getParentSession(event: EventBufferEvent): {
  sessionId: string
  parentID: string
} | undefined {
  if (event.type !== 'session.created' || !event.data.parentID) return undefined
  return { sessionId: event.data.sessionID, parentID: event.data.parentID }
}

// Native order in opencode-v2 Session.create + subagent tool:
// publish session.created, then progress({ sessionID: child.id, status: 'running' }),
// then sessions.prompt. Child output cannot exist before session.created.

export function getDerivedChildSessionIds({
  events,
  mainSessionId,
  upToIndex,
}: {
  events: EventBufferEntry[]
  mainSessionId: string
  upToIndex?: number
}): Set<string> {
  const end = upToIndex ?? events.length - 1
  const ids = new Set(
    getDerivedSubagentSessions({ events, mainSessionId, upToIndex })
      .map((session) => session.childSessionId),
  )
  let grew = true
  while (grew) {
    grew = false
    for (let i = 0; i <= end; i++) {
      const event = events[i]?.event
      if (!event) continue
      const parented = getParentSession(event)
      if (!parented || ids.has(parented.sessionId)) continue
      if (parented.parentID !== mainSessionId && !ids.has(parented.parentID)) continue
      ids.add(parented.sessionId)
      grew = true
    }
  }
  return ids
}

export function isDerivedChildSession({
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
  if (candidateSessionId === mainSessionId) return false
  return getDerivedChildSessionIds({ events, mainSessionId, upToIndex })
    .has(candidateSessionId)
}

export function isEventForSessionTree({
  events,
  event,
  mainSessionId,
}: {
  events: EventBufferEntry[]
  event: EventBufferEvent
  mainSessionId: string
}): boolean {
  const eventSessionId = getEventBufferSessionId(event)
  if (!eventSessionId) return false
  if (eventSessionId === mainSessionId) return true
  if (isDerivedChildSession({
    events,
    mainSessionId,
    candidateSessionId: eventSessionId,
  })) return true

  const parented = getParentSession(event)
  if (!parented) return false
  if (parented.parentID === mainSessionId) return true
  return isDerivedChildSession({
    events,
    mainSessionId,
    candidateSessionId: parented.parentID,
  })
}

// Child subagent sessions emit thousands of text/tool events. Those are
// still handled live for Discord display, but they must not occupy the bounded
// buffer or they evict parent busy/lifecycle events and `. queue` drains early.
// Keep child step and execution lifecycle: step.started gives the child's
// current assistant message for tool routing, step.ended carries child tokens.
export function shouldRetainSessionEvent({
  event,
  mainSessionId,
  isKnownChildSession,
}: {
  event: EventBufferEvent
  mainSessionId?: string
  isKnownChildSession: (sessionId: string) => boolean
}): boolean {
  if (event.type.endsWith('.delta')) {
    return false
  }
  if (event.type === 'tui.toast.show') {
    return true
  }

  const eventSessionId = getEventBufferSessionId(event)
  if (!eventSessionId) {
    return true
  }
  if (!mainSessionId) {
    return false
  }
  if (eventSessionId === mainSessionId) {
    return true
  }

  const parented = getParentSession(event)
  const isChild = isKnownChildSession(eventSessionId)
    || parented?.parentID === mainSessionId
    || Boolean(parented && isKnownChildSession(parented.parentID))
  if (!isChild) {
    return false
  }
  if (
    event.type === 'session.text.ended'
    || event.type === 'session.reasoning.ended'
    || event.type.startsWith('session.tool.')
  ) {
    return false
  }
  return true
}

export function trimEventBuffer({
  events,
  mainSessionId,
  max,
  isKnownChildSession,
}: {
  events: EventBufferEntry[]
  mainSessionId?: string
  max: number
  isKnownChildSession: (sessionId: string) => boolean
}): EventBufferEntry[] {
  const retained = events.filter((entry) => {
    return shouldRetainSessionEvent({
      event: entry.event,
      mainSessionId,
      isKnownChildSession,
    })
  })
  if (retained.length <= max) {
    return retained
  }
  return retained.slice(-max)
}
