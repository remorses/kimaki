// Derive session UI state from OpenCode v2 fact events.
// Footer on execution.succeeded. No footer on execution.interrupted.

export type V2Event = {
  type: string
  data?: {
    sessionID?: string
    inboxID?: string
    status?: string | { type?: string }
    model?: {
      id?: string
      providerID?: string
    }
    tokens?: {
      input?: number
      output?: number
      reasoning?: number
      cache?: {
        read?: number
        write?: number
      }
    }
  }
}

export type EventEntry = {
  event: V2Event
  timestamp?: number
}

function sessionIdOf(event: V2Event) {
  const id = event.data?.sessionID
  return typeof id === 'string' ? id : undefined
}

function statusType(event: V2Event) {
  const status = event.data?.status
  if (typeof status === 'string') return status
  if (status && typeof status === 'object') return status.type
  return undefined
}

export function isSessionBusy({
  events,
  sessionId,
}: {
  events: EventEntry[]
  sessionId: string
}) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]?.event
    if (!event || sessionIdOf(event) !== sessionId) continue
    if (event.type === 'session.status') return statusType(event) === 'busy'
    if (event.type === 'session.idle') return false
    if (event.type === 'session.execution.started') return true
    if (
      event.type === 'session.execution.succeeded'
      || event.type === 'session.execution.failed'
      || event.type === 'session.execution.interrupted'
    ) {
      return false
    }
  }
  return false
}

export function wasInterrupted({
  events,
  sessionId,
}: {
  events: EventEntry[]
  sessionId: string
}) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]?.event
    if (!event || sessionIdOf(event) !== sessionId) continue
    if (event.type === 'session.execution.interrupted') return true
    if (event.type === 'session.execution.succeeded') return false
    if (event.type === 'session.execution.started') return false
  }
  return false
}

export function shouldShowFooter({
  events,
  sessionId,
}: {
  events: EventEntry[]
  sessionId: string
}) {
  if (isSessionBusy({ events, sessionId })) return false
  if (wasInterrupted({ events, sessionId })) return false
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]?.event
    if (!event || sessionIdOf(event) !== sessionId) continue
    return event.type === 'session.execution.succeeded'
  }
  return false
}

export function queuedInboxIds({
  events,
  sessionId,
}: {
  events: EventEntry[]
  sessionId: string
}) {
  const ids = new Set<string>()
  for (const entry of events) {
    const event = entry.event
    if (sessionIdOf(event) !== sessionId) continue
    const inboxID = event.data?.inboxID
    if (typeof inboxID !== 'string') continue
    if (event.type === 'session.inbox.enqueued') ids.add(inboxID)
    if (event.type === 'session.inbox.cancelled' || event.type === 'session.inbox.delivered') {
      ids.delete(inboxID)
    }
  }
  return [...ids]
}

export function lastExecutionStartedAt({
  events,
  sessionId,
}: {
  events: EventEntry[]
  sessionId: string
}) {
  for (let i = events.length - 1; i >= 0; i--) {
    const entry = events[i]
    if (!entry || sessionIdOf(entry.event) !== sessionId) continue
    if (entry.event.type !== 'session.execution.started') continue
    return entry.timestamp
  }
  return undefined
}

export function sessionModel({
  events,
  sessionId,
}: {
  events: EventEntry[]
  sessionId: string
}) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]?.event
    if (!event || sessionIdOf(event) !== sessionId) continue
    if (event.type !== 'session.created' && event.type !== 'session.step.started') continue
    const id = event.data?.model?.id
    const providerID = event.data?.model?.providerID
    if (typeof id !== 'string' || typeof providerID !== 'string') continue
    if (!id || !providerID) continue
    return { providerID, modelID: id }
  }
  return undefined
}

export function contextPercent({
  events,
  sessionId,
}: {
  events: EventEntry[]
  sessionId: string
}) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]?.event
    if (!event || sessionIdOf(event) !== sessionId) continue
    if (event.type !== 'session.usage.updated' && event.type !== 'session.step.ended') continue
    if (!event.data?.tokens) return undefined
    return 0
  }
  return undefined
}
