// Pure derivations from native OpenCode v2 and Kimaki-local session events.

import type { V2Event } from '@opencode/client'
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

export type NativeDurableIdentity = {
  aggregateID: string
  seq: number
}

export function getNativeDurableIdentity(
  event: EventBufferEvent,
): NativeDurableIdentity | null {
  const durable = (event as EventBufferEvent & {
    durable?: NativeDurableIdentity
  }).durable
  if (!durable) return null
  return {
    aggregateID: durable.aggregateID,
    seq: durable.seq,
  }
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
  }
  return false
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
    if (candidate?.childSessionId === candidateSessionId) return candidate.subagentType
  }
  return undefined
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
