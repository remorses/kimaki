// OpenCode plugin for interrupting queued user messages after a timeout.
// Tracks only whether each user message has started processing (sent) by
// correlating assistant message parentID events.

import type { Plugin } from '@opencode-ai/plugin'

type PluginHooks = Awaited<ReturnType<Plugin>>
type InterruptEvent = Parameters<NonNullable<PluginHooks['event']>>[0]['event']

type PendingMessage = {
  sessionID: string
  sent: boolean
  timer: ReturnType<typeof setTimeout>
}

type EventWaiter = {
  match: (event: InterruptEvent) => boolean
  finish: () => void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_INTERRUPT_STEP_TIMEOUT_MS = 3_000

function getInterruptStepTimeoutMsFromEnv(): number {
  const raw = process.env['KIMAKI_INTERRUPT_STEP_TIMEOUT_MS']
  if (!raw) {
    return DEFAULT_INTERRUPT_STEP_TIMEOUT_MS
  }
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_INTERRUPT_STEP_TIMEOUT_MS
  }
  return parsed
}

// Interrupt a session when a queued user message has not started within timeout.
// "Started" is detected when message.updated for an assistant has parentID equal
// to the queued user message ID.
const interruptOpencodeSessionOnUserMessage: Plugin = async (ctx) => {
  const interruptStepTimeoutMs = getInterruptStepTimeoutMsFromEnv()
  const pendingByMessageId = new Map<string, PendingMessage>()
  const recoveringSessions = new Set<string>()
  const waiters = new Set<EventWaiter>()

  function clearPendingByMessageId({ messageID }: { messageID: string }): void {
    const pending = pendingByMessageId.get(messageID)
    if (!pending) {
      return
    }
    clearTimeout(pending.timer)
    pendingByMessageId.delete(messageID)
  }

  function waitForEvent(input: {
    match: (event: InterruptEvent) => boolean
    timeoutMs: number
  }): Promise<boolean> {
    return new Promise((resolve) => {
      const finish = (matched: boolean) => {
        clearTimeout(waiter.timer)
        waiters.delete(waiter)
        resolve(matched)
      }
      const waiter: EventWaiter = {
        match: input.match,
        finish: () => {
          finish(true)
        },
        timer: setTimeout(() => {
          finish(false)
        }, input.timeoutMs),
      }
      waiters.add(waiter)
    })
  }

  function scheduleTimeout({
    messageID,
    sessionID,
    delayMs,
  }: {
    messageID: string
    sessionID: string
    delayMs: number
  }): void {
    const existing = pendingByMessageId.get(messageID)
    if (existing) {
      clearTimeout(existing.timer)
    }

    const timer = setTimeout(() => {
      void handleUnsentTimeout({ messageID })
    }, delayMs)

    pendingByMessageId.set(messageID, {
      sessionID,
      sent: false,
      timer,
    })
  }

  function markSent({ messageID }: { messageID: string }): void {
    const pending = pendingByMessageId.get(messageID)
    if (!pending) {
      return
    }
    pending.sent = true
    clearPendingByMessageId({ messageID })
  }

  function getNextUnsentMessageId({ sessionID }: { sessionID: string }):
    | string
    | undefined {
    for (const [messageID, pending] of pendingByMessageId.entries()) {
      if (pending.sessionID !== sessionID) {
        continue
      }
      if (pending.sent) {
        continue
      }
      return messageID
    }
    return undefined
  }

  async function handleUnsentTimeout({ messageID }: { messageID: string }): Promise<void> {
    const pending = pendingByMessageId.get(messageID)
    if (!pending) {
      clearPendingByMessageId({ messageID })
      return
    }
    if (pending.sent) {
      clearPendingByMessageId({ messageID })
      return
    }

    const sessionID = pending.sessionID
    if (recoveringSessions.has(sessionID)) {
      scheduleTimeout({ messageID, sessionID, delayMs: 200 })
      return
    }

    recoveringSessions.add(sessionID)
    try {
      const abortedAssistantWait = waitForEvent({
        match: (event) => {
          return (
            event.type === 'message.updated'
            && event.properties.info.role === 'assistant'
            && event.properties.info.sessionID === sessionID
            && event.properties.info.error?.name === 'MessageAbortedError'
          )
        },
        timeoutMs: 5_000,
      })
      const idleWait = waitForEvent({
        match: (event) => {
          return event.type === 'session.idle' && event.properties.sessionID === sessionID
        },
        timeoutMs: 10_000,
      })

      await ctx.client.session.abort({
        path: { id: sessionID },
      })
      await abortedAssistantWait
      await idleWait

      const currentPending = pendingByMessageId.get(messageID)
      if (!currentPending || currentPending.sent) {
        clearPendingByMessageId({ messageID })
        return
      }

      await ctx.client.session.promptAsync({
        path: { id: sessionID },
        body: { parts: [] },
      })
      clearPendingByMessageId({ messageID })

      const nextMessageID = getNextUnsentMessageId({ sessionID })
      if (!nextMessageID) {
        return
      }
      scheduleTimeout({ messageID: nextMessageID, sessionID, delayMs: 50 })
    } finally {
      recoveringSessions.delete(sessionID)
    }
  }

  return {
    async event({ event }) {
      Array.from(waiters).forEach((waiter) => {
        if (!waiter.match(event)) {
          return
        }
        waiter.finish()
      })

      if (event.type === 'message.updated' && event.properties.info.role === 'assistant') {
        const parentID = event.properties.info.parentID
        markSent({ messageID: parentID })
        return
      }

      if (event.type === 'session.deleted') {
        const sessionID = event.properties.info.id
        Array.from(pendingByMessageId.entries()).forEach(([messageID, pending]) => {
          if (pending.sessionID !== sessionID) {
            return
          }
          clearPendingByMessageId({ messageID })
        })
      }
    },

    async 'chat.message'(input, output) {
      const sessionID = input.sessionID
      if (!sessionID) {
        return
      }

      const messageID = input.messageID || output.message.id
      if (!messageID) {
        return
      }
      if (pendingByMessageId.has(messageID)) {
        return
      }
      scheduleTimeout({
        messageID,
        sessionID,
        delayMs: interruptStepTimeoutMs,
      })
    },
  }
}

export { interruptOpencodeSessionOnUserMessage }
