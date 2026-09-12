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

export type EventBufferEvent = V2Event | KimakiLocalEvent

export type EventBufferEntry = {
  event: EventBufferEvent
  timestamp: number
  eventIndex?: number
}

export function getEventBufferSessionId(event: EventBufferEvent): string | undefined {
  if (
    event.type === 'kimaki.queue-dispatch.started'
    || event.type === 'kimaki.queue-dispatch.settled'
    || event.type === 'kimaki.question-queue-handoff.started'
  ) return event.data.sessionID
  return getOpencodeEventSessionId(event)
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
  childSessionId: string
  subagentType?: string
  description?: string
} | undefined {
  const event = events[eventIndex]?.event
  if (event?.type !== 'session.tool.success' && event?.type !== 'session.tool.failed') {
    return undefined
  }
  if (event.data.sessionID !== mainSessionId) return undefined
  const childSessionId = event.data.metadata?.sessionID
  if (typeof childSessionId !== 'string' || childSessionId.length === 0) return undefined

  const input = (() => {
    for (let i = eventIndex - 1; i >= 0; i--) {
      const prior = events[i]?.event
      if (
        prior?.type === 'session.tool.called'
        && prior.data.sessionID === mainSessionId
        && prior.data.assistantMessageID === event.data.assistantMessageID
        && prior.data.id === event.data.id
      ) return prior.data.input
    }
    return undefined
  })()
  const toolName = (() => {
    for (let i = eventIndex - 1; i >= 0; i--) {
      const prior = events[i]?.event
      if (
        prior?.type === 'session.tool.input.started'
        && prior.data.sessionID === mainSessionId
        && prior.data.assistantMessageID === event.data.assistantMessageID
        && prior.data.id === event.data.id
      ) return prior.data.name
    }
    return undefined
  })()
  if (toolName !== 'subagent') return undefined
  return {
    assistantMessageId: event.data.assistantMessageID,
    childSessionId,
    subagentType: typeof input?.agent === 'string' ? input.agent : undefined,
    description: typeof input?.description === 'string' ? input.description : undefined,
  }
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

  const indexByChildSessionId = new Map<string, number>()
  for (let i = 0; i <= end; i++) {
    const value = getSubagentCandidate({ events, eventIndex: i, mainSessionId })
    if (!value || value.assistantMessageId !== candidate.assistantMessageId) continue
    if (!indexByChildSessionId.has(value.childSessionId)) {
      indexByChildSessionId.set(value.childSessionId, indexByChildSessionId.size + 1)
    }
  }
  return indexByChildSessionId.get(candidateSessionId)
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
