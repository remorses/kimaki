// OpenCode plugin for interrupting queued user messages after a timeout.
// Tracks only whether each user message has started processing (sent) by
// correlating assistant message parentID events.

import type { Plugin } from '@opencode-ai/plugin'

type PluginHooks = Awaited<ReturnType<Plugin>>
type HookEvent = Parameters<NonNullable<PluginHooks['event']>>[0]['event']

type PendingMessage = {
  sessionID: string
  sent: boolean
  timer: ReturnType<typeof setTimeout>
}

type EventWaiter = {
  match: (event: HookEvent) => boolean
  finish: (matched: boolean) => void
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
  const pendingMessageIdsBySession = new Map<string, Set<string>>()
  const waiters = new Set<EventWaiter>()

  function waitForEvent(input: {
    match: (event: HookEvent) => boolean
    timeoutMs: number
  }): Promise<boolean> {
    return new Promise((resolve) => {
      const waiter: EventWaiter = {
        match: input.match,
        finish: () => {
          // initialized below
        },
        timer: setTimeout(() => {
          // initialized below
        }, input.timeoutMs),
      }

      const finish = (matched: boolean) => {
        clearTimeout(waiter.timer)
        waiters.delete(waiter)
        resolve(matched)
      }
      waiter.finish = finish
      waiter.timer = setTimeout(() => {
        finish(false)
      }, input.timeoutMs)
      waiters.add(waiter)
    })
  }

  function clearPendingByMessageId({ messageID }: { messageID: string }): void {
    const pending = pendingByMessageId.get(messageID)
    if (!pending) {
      return
    }
    clearTimeout(pending.timer)
    pendingByMessageId.delete(messageID)

    const messageIds = pendingMessageIdsBySession.get(pending.sessionID)
    if (!messageIds) {
      return
    }
    messageIds.delete(messageID)
    if (messageIds.size > 0) {
      return
    }
    pendingMessageIdsBySession.delete(pending.sessionID)
  }

  async function handleUnsentTimeout({ messageID }: { messageID: string }): Promise<void> {
    const pending = pendingByMessageId.get(messageID)
    if (!pending || pending.sent) {
      clearPendingByMessageId({ messageID })
      return
    }

    const sessionID = pending.sessionID
    const errorWait = waitForEvent({
      match: (event) => {
        return (
          event.type === 'session.error' &&
          event.properties.sessionID === sessionID
        )
      },
      timeoutMs: 2_000,
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
    await errorWait
    await idleWait

    const stillPending = pendingByMessageId.get(messageID)
    if (!stillPending || stillPending.sent) {
      clearPendingByMessageId({ messageID })
      return
    }

    await ctx.client.session.promptAsync({
      path: { id: sessionID },
      body: { parts: [] },
    })
    clearPendingByMessageId({ messageID })
  }

  return {
    async event({ event }) {
      Array.from(waiters).forEach((waiter) => {
        if (!waiter.match(event)) {
          return
        }
        waiter.finish(true)
      })

      if (event.type === 'message.updated' && event.properties.info.role === 'assistant') {
        const parentID = event.properties.info.parentID
        const pending = pendingByMessageId.get(parentID)
        if (!pending) {
          return
        }
        pending.sent = true
        clearPendingByMessageId({ messageID: parentID })
        return
      }

      if (event.type === 'session.deleted') {
        const sessionID = event.properties.info.id
        const pendingMessageIds = pendingMessageIdsBySession.get(sessionID)
        if (!pendingMessageIds) {
          return
        }
        Array.from(pendingMessageIds).forEach((messageID) => {
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

      const timer = setTimeout(() => {
        void (async () => {
          await handleUnsentTimeout({ messageID })
        })()
      }, interruptStepTimeoutMs)

      pendingByMessageId.set(messageID, {
        sessionID,
        sent: false,
        timer,
      })
      const messageIds = pendingMessageIdsBySession.get(sessionID)
      if (messageIds) {
        messageIds.add(messageID)
        return
      }
      pendingMessageIdsBySession.set(sessionID, new Set([messageID]))
    },
  }
}

export { interruptOpencodeSessionOnUserMessage }
