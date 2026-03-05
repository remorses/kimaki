// OpenCode plugin for interrupting queued user messages after a timeout.
// Tracks only whether each user message has started processing (sent) by
// correlating assistant message parentID events.

import type { Plugin } from '@opencode-ai/plugin'
import {
  createInterruptState,
  getPendingInterruptMessage,
  hasUnsentPendingForSession,
  hasUnsentPendingMessage,
  listPendingMessageIdsForSession,
  reduceInterruptState,
  type InterruptEvent,
} from './opencode-interrupt-state.js'

type EventWaiter = {
  match: (event: InterruptEvent) => boolean
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
  let state = createInterruptState()
  const timersByMessageId = new Map<string, ReturnType<typeof setTimeout>>()
  const recoveringSessions = new Set<string>()
  const waiters = new Set<EventWaiter>()

  function clearTimer({ messageID }: { messageID: string }): void {
    const timer = timersByMessageId.get(messageID)
    if (!timer) {
      return
    }
    clearTimeout(timer)
    timersByMessageId.delete(messageID)
  }

  function clearPendingByMessageId({ messageID }: { messageID: string }): void {
    clearTimer({ messageID })
    state = reduceInterruptState({
      state,
      action: { type: 'clear-message', messageID },
    })
  }

  function scheduleTimeout({
    messageID,
    delayMs,
    onTimeout,
  }: {
    messageID: string
    delayMs: number
    onTimeout: ({ messageID }: { messageID: string }) => Promise<void>
  }): void {
    clearTimer({ messageID })
    const timer = setTimeout(() => {
      void onTimeout({ messageID })
    }, delayMs)
    timersByMessageId.set(messageID, timer)
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
        finish,
        timer: setTimeout(() => {
          finish(false)
        }, input.timeoutMs),
      }
      waiters.add(waiter)
    })
  }

  async function handleUnsentTimeout({ messageID }: { messageID: string }): Promise<void> {
    if (!hasUnsentPendingMessage({ state, messageID })) {
      clearPendingByMessageId({ messageID })
      return
    }

    const pending = getPendingInterruptMessage({ state, messageID })
    if (!pending) {
      clearPendingByMessageId({ messageID })
      return
    }

    const sessionID = pending.sessionID
    if (recoveringSessions.has(sessionID)) {
      scheduleTimeout({
        messageID,
        delayMs: 200,
        onTimeout: handleUnsentTimeout,
      })
      return
    }

    recoveringSessions.add(sessionID)
    try {
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

      if (!hasUnsentPendingMessage({ state, messageID })) {
        clearPendingByMessageId({ messageID })
        return
      }

      await ctx.client.session.promptAsync({
        path: { id: sessionID },
        body: { parts: [] },
      })
      clearPendingByMessageId({ messageID })

      if (!hasUnsentPendingForSession({ state, sessionID })) {
        return
      }
      const nextMessageID = listPendingMessageIdsForSession({ state, sessionID }).find(
        (pendingMessageID) => {
          return hasUnsentPendingMessage({ state, messageID: pendingMessageID })
        },
      )
      if (!nextMessageID) {
        return
      }
      scheduleTimeout({
        messageID: nextMessageID,
        delayMs: 50,
        onTimeout: handleUnsentTimeout,
      })
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
        waiter.finish(true)
      })

      if (event.type === 'message.updated' && event.properties.info.role === 'assistant') {
        const parentID = event.properties.info.parentID
        if (!getPendingInterruptMessage({ state, messageID: parentID })) {
          return
        }
        state = reduceInterruptState({
          state,
          action: { type: 'event', event },
        })
        clearPendingByMessageId({ messageID: parentID })
        return
      }

      if (event.type === 'session.deleted') {
        const sessionID = event.properties.info.id
        const pendingMessageIds = listPendingMessageIdsForSession({
          state,
          sessionID,
        })
        if (pendingMessageIds.length === 0) {
          return
        }
        state = reduceInterruptState({
          state,
          action: { type: 'event', event },
        })
        pendingMessageIds.forEach((messageID) => {
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
      const nextState = reduceInterruptState({
        state,
        action: {
          type: 'queue',
          sessionID,
          messageID,
        },
      })
      if (nextState === state) {
        return
      }
      state = nextState
      scheduleTimeout({
        messageID,
        delayMs: interruptStepTimeoutMs,
        onTimeout: handleUnsentTimeout,
      })
    },
  }
}

export { interruptOpencodeSessionOnUserMessage }
