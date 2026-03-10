// OpenCode plugin for interrupting queued user messages at the next assistant
// step boundary, with a hard timeout as fallback.
// Tracks only whether each user message has started processing by
// correlating assistant message parentID events.

import type { Plugin } from '@opencode-ai/plugin'

type PluginHooks = Awaited<ReturnType<Plugin>>
type InterruptEvent = Parameters<NonNullable<PluginHooks['event']>>[0]['event']

type PendingMessage = {
  sessionID: string
  started: boolean
  timer: ReturnType<typeof setTimeout>
  abortAfterStepMessageID: string | undefined
  agent: string | undefined
  model:
    | {
        providerID: string
        modelID: string
      }
    | undefined
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

// Interrupt a session when a queued user message has not started yet.
// "Started" is detected when an assistant message.updated has parentID equal to
// the queued user message ID.
const interruptOpencodeSessionOnUserMessage: Plugin = async (ctx) => {
  const interruptStepTimeoutMs = getInterruptStepTimeoutMsFromEnv()
  const pendingByMessageId = new Map<string, PendingMessage>()
  const latestAssistantMessageIDBySession = new Map<string, string>()
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
      void interruptPendingMessage({ messageID })
    }, delayMs)

    pendingByMessageId.set(messageID, {
      sessionID,
      started: false,
      timer,
      abortAfterStepMessageID: latestAssistantMessageIDBySession.get(sessionID),
      agent: undefined,
      model: undefined,
    })
  }

  function markStarted({ messageID }: { messageID: string }): void {
    const pending = pendingByMessageId.get(messageID)
    if (!pending) {
      return
    }
    pending.started = true
    clearPendingByMessageId({ messageID })
  }

  function getNextPendingMessage({ sessionID }: { sessionID: string }):
    | { messageID: string; pending: PendingMessage }
    | undefined {
    for (const [messageID, pending] of pendingByMessageId.entries()) {
      if (pending.sessionID !== sessionID) {
        continue
      }
      if (pending.started) {
        continue
      }
      return { messageID, pending }
    }
    return undefined
  }

  async function interruptPendingMessage({ messageID }: { messageID: string }): Promise<void> {
    const pending = pendingByMessageId.get(messageID)
    if (!pending) {
      clearPendingByMessageId({ messageID })
      return
    }
    if (pending.started) {
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
      if (!currentPending || currentPending.started) {
        clearPendingByMessageId({ messageID })
        return
      }

      // Keep the queued user message execution context across abort+resume.
      // Without this, OpenCode re-resolves model defaults and can ignore
      // /model session overrides (issue #77).
      const resumeBody: {
        parts: []
        agent?: string
        model?: {
          providerID: string
          modelID: string
        }
      } = { parts: [] }
      if (currentPending.agent) {
        resumeBody.agent = currentPending.agent
      }
      if (currentPending.model) {
        resumeBody.model = currentPending.model
      }

      await ctx.client.session.promptAsync({
        path: { id: sessionID },
        body: resumeBody,
      })
      clearPendingByMessageId({ messageID })

      const nextPending = getNextPendingMessage({ sessionID })
      if (!nextPending) {
        return
      }
      scheduleTimeout({ messageID: nextPending.messageID, sessionID, delayMs: 50 })
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

      if (event.type === 'message.part.updated' && event.properties.part.type === 'step-finish') {
        const nextPending = getNextPendingMessage({
          sessionID: event.properties.part.sessionID,
        })
        if (!nextPending) {
          return
        }
        if (recoveringSessions.has(nextPending.pending.sessionID)) {
          return
        }
        if (!nextPending.pending.abortAfterStepMessageID) {
          return
        }
        if (event.properties.part.messageID !== nextPending.pending.abortAfterStepMessageID) {
          return
        }
        void interruptPendingMessage({ messageID: nextPending.messageID })
        return
      }

      if (event.type === 'message.updated' && event.properties.info.role === 'assistant') {
        if (!event.properties.info.error) {
          latestAssistantMessageIDBySession.set(
            event.properties.info.sessionID,
            event.properties.info.id,
          )
        }

        const nextPending = getNextPendingMessage({
          sessionID: event.properties.info.sessionID,
        })
        if (
          nextPending
          && !nextPending.pending.started
          && !event.properties.info.error
          && event.properties.info.parentID !== nextPending.messageID
        ) {
          nextPending.pending.abortAfterStepMessageID = event.properties.info.id
        }

        const parentID = event.properties.info.parentID
        markStarted({ messageID: parentID })
        return
      }

      if (event.type === 'session.idle') {
        latestAssistantMessageIDBySession.delete(event.properties.sessionID)
        return
      }

      if (event.type === 'session.deleted') {
        const sessionID = event.properties.info.id
        latestAssistantMessageIDBySession.delete(sessionID)
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

      // Ignore empty-parts messages (e.g. our own promptAsync({ parts: [] })
      // resume calls). These are synthetic and should not trigger interruption.
      if (output.parts.length === 0) {
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
      const pending = pendingByMessageId.get(messageID)
      if (!pending) {
        return
      }
      pending.agent = output.message.agent
      pending.model = output.message.model
    },
  }
}

export { interruptOpencodeSessionOnUserMessage }
