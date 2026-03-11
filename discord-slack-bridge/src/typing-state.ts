// Pure event-sourced typing state derivation for Slack assistant thread status.

export type TypingEvent =
  | {
      type: 'typing.start-requested'
      atMs: number
      source: 'discord-route'
      requestId?: string
    }
  | {
      type: 'assistant.message-sent'
      atMs: number
      source: 'bridge-rest'
      channelId: string
      threadTs: string
      messageTs?: string
    }
  | {
      type: 'typing.stop-requested'
      atMs: number
      source: 'internal'
      reason: 'lease-expired' | 'idle-timeout' | 'manual-clear'
    }
  | {
      type: 'slack.status-sent'
      atMs: number
      channelId: string
      threadTs: string
      statusText: string
      mode: 'start' | 'refresh'
    }
  | {
      type: 'slack.status-cleared'
      atMs: number
      channelId: string
      threadTs: string
      by: 'empty-status' | 'auto-on-reply' | 'inferred'
    }
  | {
      type: 'slack.rate-limited'
      atMs: number
      channelId: string
      threadTs: string
      retryAfterMs: number
      retryAtMs: number
      method: 'assistant.threads.setStatus'
    }
  | {
      type: 'tick'
      atMs: number
    }

export type TypingStateConfig = {
  leaseMs: number
  stopDebounceMs: number
}

export const DEFAULT_TYPING_STATE_CONFIG: TypingStateConfig = {
  leaseMs: 10_000,
  stopDebounceMs: 2_000,
}

export type TypingIntent = {
  isTypingActive: boolean
  hasStartAfterStatus: boolean
  shouldSendStatus: boolean
  shouldClearStatus: boolean
  statusMode?: 'start' | 'refresh'
  clearReason?: 'assistant-debounce' | 'lease-expired' | 'explicit-stop'
  blockedByRateLimit: boolean
  nextWakeAtMs?: number
}

type ThreadTypingRuntimeState = {
  running: boolean
  dirty: boolean
  wakeTimer?: ReturnType<typeof setTimeout>
}

export type ThreadTypingTarget = {
  channelId: string
  threadTs?: string
}

export type TypingCoordinator = {
  requestStart: ({ threadChannelId }: { threadChannelId: string }) => void
  noteAssistantMessage: ({
    threadChannelId,
    messageId,
  }: {
    threadChannelId: string
    messageId?: string
  }) => void
}

export function createTypingCoordinator({
  setStatus,
  clearStatus,
  resolveThreadTarget,
  statusText,
  maxEvents = 200,
  nowMs = () => {
    return Date.now()
  },
}: {
  setStatus: ({
    threadChannelId,
    statusText,
  }: {
    threadChannelId: string
    statusText: string
  }) => Promise<{ channelId: string; threadTs: string }>
  clearStatus: ({
    threadChannelId,
  }: {
    threadChannelId: string
  }) => Promise<{ channelId: string; threadTs: string }>
  resolveThreadTarget: ({ threadChannelId }: { threadChannelId: string }) => ThreadTypingTarget
  statusText: string
  maxEvents?: number
  nowMs?: () => number
}): TypingCoordinator {
  const typingEventsByThread = new Map<string, TypingEvent[]>()
  const typingRuntimeByThread = new Map<string, ThreadTypingRuntimeState>()

  const getThreadTypingRuntime = ({
    threadChannelId,
  }: {
    threadChannelId: string
  }): ThreadTypingRuntimeState => {
    const existing = typingRuntimeByThread.get(threadChannelId)
    if (existing) {
      return existing
    }
    const created: ThreadTypingRuntimeState = {
      running: false,
      dirty: false,
    }
    typingRuntimeByThread.set(threadChannelId, created)
    return created
  }

  const maybeDeleteThreadTypingRuntime = ({
    threadChannelId,
  }: {
    threadChannelId: string
  }): void => {
    const runtime = typingRuntimeByThread.get(threadChannelId)
    if (!runtime) {
      return
    }
    if (runtime.running || runtime.dirty || runtime.wakeTimer) {
      return
    }
    if (typingEventsByThread.has(threadChannelId)) {
      return
    }
    typingRuntimeByThread.delete(threadChannelId)
  }

  const appendThreadTypingEvent = ({
    threadChannelId,
    event,
  }: {
    threadChannelId: string
    event: TypingEvent
  }): void => {
    const current = typingEventsByThread.get(threadChannelId) ?? []
    const next = appendTypingEvent({
      events: current,
      event,
      maxEvents,
    })
    typingEventsByThread.set(threadChannelId, next)
  }

  const clearThreadTypingWakeTimer = ({
    threadChannelId,
  }: {
    threadChannelId: string
  }): void => {
    const runtime = typingRuntimeByThread.get(threadChannelId)
    const timer = runtime?.wakeTimer
    if (!timer) {
      return
    }
    clearTimeout(timer)
    runtime.wakeTimer = undefined
    maybeDeleteThreadTypingRuntime({ threadChannelId })
  }

  const scheduleThreadTypingWake = ({
    threadChannelId,
  }: {
    threadChannelId: string
  }): void => {
    clearThreadTypingWakeTimer({ threadChannelId })
    const events = typingEventsByThread.get(threadChannelId) ?? []
    if (events.length === 0) {
      maybeDeleteThreadTypingRuntime({ threadChannelId })
      return
    }

    const currentNowMs = nowMs()
    const intent = deriveTypingIntent({
      events,
      nowMs: currentNowMs,
    })

    if (intent.nextWakeAtMs === undefined) {
      if (!intent.isTypingActive && !intent.hasStartAfterStatus) {
        typingEventsByThread.delete(threadChannelId)
      }
      maybeDeleteThreadTypingRuntime({ threadChannelId })
      return
    }

    const runtime = getThreadTypingRuntime({ threadChannelId })
    const delayMs = Math.max(0, intent.nextWakeAtMs - currentNowMs)
    const timer = setTimeout(() => {
      const latestRuntime = typingRuntimeByThread.get(threadChannelId)
      if (latestRuntime) {
        latestRuntime.wakeTimer = undefined
      }
      void reconcileThreadTypingState({ threadChannelId })
    }, delayMs)
    timer.unref()
    runtime.wakeTimer = timer
  }

  const reconcileThreadTypingState = async ({
    threadChannelId,
  }: {
    threadChannelId: string
  }): Promise<void> => {
    const runtime = getThreadTypingRuntime({ threadChannelId })
    runtime.dirty = true
    if (runtime.running) {
      return
    }

    runtime.running = true
    try {
      while (runtime.dirty) {
        runtime.dirty = false
        const events = typingEventsByThread.get(threadChannelId) ?? []
        const intent = deriveTypingIntent({
          events,
          nowMs: nowMs(),
        })

        if (intent.shouldSendStatus) {
          try {
            const target = await setStatus({
              threadChannelId,
              statusText,
            })
            appendThreadTypingEvent({
              threadChannelId,
              event: {
                type: 'slack.status-sent',
                atMs: nowMs(),
                channelId: target.channelId,
                threadTs: target.threadTs,
                statusText,
                mode: intent.statusMode ?? 'start',
              },
            })
          } catch (error) {
            const retryAfterMs = readSlackRetryAfterMs({ error })
            if (retryAfterMs !== undefined) {
              const target = resolveThreadTarget({ threadChannelId })
              if (target.threadTs) {
                const atMs = nowMs()
                appendThreadTypingEvent({
                  threadChannelId,
                  event: {
                    type: 'slack.rate-limited',
                    atMs,
                    channelId: target.channelId,
                    threadTs: target.threadTs,
                    retryAfterMs,
                    retryAtMs: atMs + retryAfterMs,
                    method: 'assistant.threads.setStatus',
                  },
                })
              }
            }
          }
        }

        if (intent.shouldClearStatus) {
          try {
            const target = await clearStatus({ threadChannelId })
            appendThreadTypingEvent({
              threadChannelId,
              event: {
                type: 'slack.status-cleared',
                atMs: nowMs(),
                channelId: target.channelId,
                threadTs: target.threadTs,
                by: 'empty-status',
              },
            })
          } catch {
            const target = resolveThreadTarget({ threadChannelId })
            if (target.threadTs) {
              appendThreadTypingEvent({
                threadChannelId,
                event: {
                  type: 'slack.status-cleared',
                  atMs: nowMs(),
                  channelId: target.channelId,
                  threadTs: target.threadTs,
                  by: 'inferred',
                },
              })
            }
          }
        }
      }
    } finally {
      runtime.running = false
      scheduleThreadTypingWake({ threadChannelId })
      maybeDeleteThreadTypingRuntime({ threadChannelId })
    }
  }

  return {
    requestStart: ({ threadChannelId }) => {
      appendThreadTypingEvent({
        threadChannelId,
        event: {
          type: 'typing.start-requested',
          atMs: nowMs(),
          source: 'discord-route',
        },
      })
      void reconcileThreadTypingState({ threadChannelId })
    },
    noteAssistantMessage: ({ threadChannelId, messageId }) => {
      const target = resolveThreadTarget({ threadChannelId })
      if (!target.threadTs) {
        return
      }
      appendThreadTypingEvent({
        threadChannelId,
        event: {
          type: 'assistant.message-sent',
          atMs: nowMs(),
          source: 'bridge-rest',
          channelId: target.channelId,
          threadTs: target.threadTs,
          messageTs: messageId,
        },
      })
      void reconcileThreadTypingState({ threadChannelId })
    },
  }
}

export function appendTypingEvent({
  events,
  event,
  maxEvents,
}: {
  events: TypingEvent[]
  event: TypingEvent
  maxEvents: number
}): TypingEvent[] {
  const appended: TypingEvent[] = [...events, event]
  if (appended.length <= maxEvents) {
    return appended
  }
  return appended.slice(appended.length - maxEvents)
}

export function deriveTypingIntent({
  events,
  nowMs,
  config = DEFAULT_TYPING_STATE_CONFIG,
}: {
  events: TypingEvent[]
  nowMs: number
  config?: TypingStateConfig
}): TypingIntent {
  const lastStatusSentAt = lastEventAt({ events, type: 'slack.status-sent' })
  const lastStatusClearedAt = lastEventAt({ events, type: 'slack.status-cleared' })
  const lastStartAt = lastEventAt({ events, type: 'typing.start-requested' })
  const lastAssistantMessageAt = lastEventAt({ events, type: 'assistant.message-sent' })
  const lastExplicitStopAt = lastEventAt({ events, type: 'typing.stop-requested' })
  const rateLimitedUntil = lastRateLimitedUntil({ events })

  const isTypingActive =
    lastStatusSentAt !== undefined &&
    (lastStatusClearedAt === undefined || lastStatusSentAt > lastStatusClearedAt)

  const blockedByRateLimit =
    rateLimitedUntil !== undefined && nowMs < rateLimitedUntil

  const hasStartAfterStatus =
    lastStartAt !== undefined &&
    (lastStatusSentAt === undefined || lastStartAt > lastStatusSentAt)

  const hasStartAfterAssistantMessage =
    lastStartAt !== undefined &&
    lastAssistantMessageAt !== undefined &&
    lastStartAt > lastAssistantMessageAt

  const hasExplicitStop =
    lastExplicitStopAt !== undefined &&
    (lastStatusSentAt === undefined || lastExplicitStopAt > lastStatusSentAt)

  const assistantStopDueAt =
    lastAssistantMessageAt !== undefined && !hasStartAfterAssistantMessage
      ? lastAssistantMessageAt + config.stopDebounceMs
      : undefined

  if (!isTypingActive) {
    const canStartNow = hasStartAfterStatus && !blockedByRateLimit
    return {
      isTypingActive,
      hasStartAfterStatus,
      shouldSendStatus: canStartNow,
      shouldClearStatus: false,
      statusMode: canStartNow ? 'start' : undefined,
      clearReason: undefined,
      blockedByRateLimit,
      nextWakeAtMs: blockedByRateLimit
        ? rateLimitedUntil
        : undefined,
    }
  }

  if (hasExplicitStop && !hasStartAfterStatus) {
    return {
      isTypingActive,
      hasStartAfterStatus,
      shouldSendStatus: false,
      shouldClearStatus: true,
      statusMode: undefined,
      clearReason: 'explicit-stop',
      blockedByRateLimit,
      nextWakeAtMs: undefined,
    }
  }

  const shouldClearForAssistantDebounce =
    assistantStopDueAt !== undefined && nowMs >= assistantStopDueAt

  if (shouldClearForAssistantDebounce) {
    return {
      isTypingActive,
      hasStartAfterStatus,
      shouldSendStatus: false,
      shouldClearStatus: true,
      statusMode: undefined,
      clearReason: 'assistant-debounce',
      blockedByRateLimit,
      nextWakeAtMs: undefined,
    }
  }

  const leaseExpiresAt =
    lastStatusSentAt === undefined
      ? undefined
      : lastStatusSentAt + config.leaseMs

  const leaseExpired =
    leaseExpiresAt !== undefined && nowMs >= leaseExpiresAt

  if (leaseExpired) {
    if (hasStartAfterStatus && !blockedByRateLimit) {
      return {
        isTypingActive,
        hasStartAfterStatus,
        shouldSendStatus: true,
        shouldClearStatus: false,
        statusMode: 'refresh',
        clearReason: undefined,
        blockedByRateLimit,
        nextWakeAtMs: undefined,
      }
    }

    if (hasStartAfterStatus && blockedByRateLimit) {
      return {
        isTypingActive,
        hasStartAfterStatus,
        shouldSendStatus: false,
        shouldClearStatus: false,
        statusMode: undefined,
        clearReason: undefined,
        blockedByRateLimit,
        nextWakeAtMs: rateLimitedUntil,
      }
    }

    return {
      isTypingActive,
      hasStartAfterStatus,
      shouldSendStatus: false,
      shouldClearStatus: true,
      statusMode: undefined,
      clearReason: 'lease-expired',
      blockedByRateLimit,
      nextWakeAtMs: undefined,
    }
  }

  const nextWakeCandidates: number[] = [
    ...(leaseExpiresAt !== undefined ? [leaseExpiresAt] : []),
    ...(assistantStopDueAt !== undefined ? [assistantStopDueAt] : []),
    ...(blockedByRateLimit && rateLimitedUntil !== undefined ? [rateLimitedUntil] : []),
  ]

  return {
    isTypingActive,
    hasStartAfterStatus,
    shouldSendStatus: false,
    shouldClearStatus: false,
    statusMode: undefined,
    clearReason: undefined,
    blockedByRateLimit,
    nextWakeAtMs:
      nextWakeCandidates.length === 0
        ? undefined
        : Math.min(...nextWakeCandidates),
  }
}

function lastRateLimitedUntil({
  events,
}: {
  events: TypingEvent[]
}): number | undefined {
  return events.reduce<number | undefined>((latest, event) => {
    if (event.type !== 'slack.rate-limited') {
      return latest
    }
    if (latest === undefined) {
      return event.retryAtMs
    }
    return event.retryAtMs > latest ? event.retryAtMs : latest
  }, undefined)
}

function readSlackRetryAfterMs({ error }: { error: unknown }): number | undefined {
  if (!isRecord(error)) {
    return undefined
  }

  const data = readRecord(error, 'data')
  const dataRetryAfter =
    (data ? normalizeRetryAfterMs(readNumber(data, 'retryAfter')) : undefined) ??
    (data ? normalizeRetryAfterMs(readString(data, 'retryAfter')) : undefined)
  if (dataRetryAfter !== undefined) {
    return dataRetryAfter
  }

  const dataHeaders = data ? readRecord(data, 'headers') : undefined
  const headerRetryAfter = dataHeaders
    ? normalizeRetryAfterMs(readString(dataHeaders, 'retry-after'))
    : undefined
  if (headerRetryAfter !== undefined) {
    return headerRetryAfter
  }

  const rootHeaders = readRecord(error, 'headers')
  return rootHeaders
    ? normalizeRetryAfterMs(readString(rootHeaders, 'retry-after'))
    : undefined
}

function normalizeRetryAfterMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.ceil(value * 1000)
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.ceil(parsed * 1000)
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key]
  return isRecord(value) ? value : undefined
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key]
  return typeof value === 'number' ? value : undefined
}

function lastEventAt<TType extends TypingEvent['type']>({
  events,
  type,
}: {
  events: TypingEvent[]
  type: TType
}): number | undefined {
  return events.reduce<number | undefined>((latest, event) => {
    if (event.type !== type) {
      return latest
    }
    if (latest === undefined) {
      return event.atMs
    }
    return event.atMs > latest ? event.atMs : latest
  }, undefined)
}
