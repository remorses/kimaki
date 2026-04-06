// OpenCode plugin for interrupting queued user messages at the next assistant
// step boundary, with a hard timeout as fallback.
// Tracks only whether each user message has started processing by
// correlating assistant message parentID events.
//
// State design: all mutable state (pending messages, recovery locks, event
// waiters, latest assistant IDs) is encapsulated in a closure-based factory
// (createInterruptState). The plugin hooks only interact with the returned
// API — they cannot directly touch Maps/Sets or break invariants like
// forgetting to clear a timer.

import type { Plugin } from '@opencode-ai/plugin'
import type {
  Part,
  TextPartInput,
  FilePartInput,
  AgentPartInput,
  SubtaskPartInput,
} from '@opencode-ai/sdk'

type PluginHooks = Awaited<ReturnType<Plugin>>
type InterruptEvent = Parameters<NonNullable<PluginHooks['event']>>[0]['event']
type PromptPartInput = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput

type PendingMessage = {
  sessionID: string
  started: boolean
  timer: ReturnType<typeof setTimeout>
  abortAfterStepMessageID: string | undefined
  parts: PromptPartInput[]
  agent: string | undefined
  model:
    | {
        providerID: string
        modelID: string
      }
    | undefined
}

type InterruptChatOutput =
  NonNullable<PluginHooks['chat.message']> extends (
    input: unknown,
    output: infer T,
  ) => Promise<void>
    ? T
    : never

function toPromptParts(parts: Part[]): PromptPartInput[] {
  return parts.reduce<PromptPartInput[]>((acc, part) => {
    if (part.type === 'text') {
      acc.push({
        id: part.id,
        type: 'text',
        text: part.text,
        synthetic: part.synthetic,
        ignored: part.ignored,
        time: part.time,
        metadata: part.metadata,
      })
      return acc
    }
    if (part.type === 'file') {
      acc.push({
        id: part.id,
        type: 'file',
        mime: part.mime,
        filename: part.filename,
        url: part.url,
        source: part.source,
      })
      return acc
    }
    if (part.type === 'agent') {
      acc.push({
        id: part.id,
        type: 'agent',
        name: part.name,
        source: part.source,
      })
      return acc
    }
    if (part.type === 'subtask') {
      acc.push({
        id: part.id,
        type: 'subtask',
        prompt: part.prompt,
        description: part.description,
        agent: part.agent,
      })
      return acc
    }
    return acc
  }, [])
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

// ── Encapsulated interrupt state ─────────────────────────────────
// All 4 mutable variables (pendingByMessageId, latestAssistantMessageID,
// recoveringSessions, waiters) are trapped inside this closure. The plugin
// hooks only see the returned API methods — they cannot break invariants
// like forgetting to clear a timer or leaving a stale recovery lock.

function createInterruptState() {
  const pendingByMessageId = new Map<string, PendingMessage>()
  const latestAssistantMessageIDBySession = new Map<string, string>()
  const recoveringSessions = new Set<string>()
  const waiters = new Set<EventWaiter>()

  function clearPending(messageID: string): void {
    const pending = pendingByMessageId.get(messageID)
    if (!pending) {
      return
    }
    clearTimeout(pending.timer)
    pendingByMessageId.delete(messageID)
  }

  function dispatchEvent(event: InterruptEvent): void {
    Array.from(waiters).forEach((waiter) => {
      if (!waiter.match(event)) {
        return
      }
      waiter.finish()
    })
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

  function getNextPendingForSession(
    sessionID: string,
  ): { messageID: string; pending: PendingMessage } | undefined {
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

  return {
    dispatchEvent,
    waitForEvent,
    getNextPendingForSession,

    hasPending(messageID: string): boolean {
      return pendingByMessageId.has(messageID)
    },

    getPending(messageID: string): PendingMessage | undefined {
      return pendingByMessageId.get(messageID)
    },

    // Schedule a timeout to interrupt a pending message. Cleans up any
    // existing timer for the same messageID before setting a new one.
    schedulePending({
      messageID,
      sessionID,
      parts,
      delayMs,
      onTimeout,
    }: {
      messageID: string
      sessionID: string
      parts: PromptPartInput[]
      delayMs: number
      onTimeout: () => void
    }): void {
      const existing = pendingByMessageId.get(messageID)
      if (existing) {
        clearTimeout(existing.timer)
      }
      const timer = setTimeout(onTimeout, delayMs)
      pendingByMessageId.set(messageID, {
        sessionID,
        started: false,
        timer,
        abortAfterStepMessageID: latestAssistantMessageIDBySession.get(sessionID),
        parts,
        agent: undefined,
        model: undefined,
      })
    },

    markStarted(messageID: string): void {
      const pending = pendingByMessageId.get(messageID)
      if (!pending) {
        return
      }
      pending.started = true
      clearPending(messageID)
    },

    clearPending,

    isRecovering(sessionID: string): boolean {
      return recoveringSessions.has(sessionID)
    },

    setRecovering(sessionID: string): void {
      recoveringSessions.add(sessionID)
    },

    clearRecovering(sessionID: string): void {
      recoveringSessions.delete(sessionID)
    },

    setLatestAssistantMessage(sessionID: string, messageID: string): void {
      latestAssistantMessageIDBySession.set(sessionID, messageID)
    },

    clearLatestAssistantMessage(sessionID: string): void {
      latestAssistantMessageIDBySession.delete(sessionID)
    },

    // Clean up all state for a deleted session — timers, recovery locks, etc.
    cleanupSession(sessionID: string): void {
      latestAssistantMessageIDBySession.delete(sessionID)
      Array.from(pendingByMessageId.entries()).forEach(([messageID, pending]) => {
        if (pending.sessionID !== sessionID) {
          return
        }
        clearPending(messageID)
      })
    },
  }
}

// ── Plugin ───────────────────────────────────────────────────────

const interruptOpencodeSessionOnUserMessage: Plugin = async (ctx) => {
  const interruptStepTimeoutMs = getInterruptStepTimeoutMsFromEnv()
  const state = createInterruptState()

  async function interruptPendingMessage(messageID: string): Promise<void> {
    const pending = state.getPending(messageID)
    if (!pending) {
      state.clearPending(messageID)
      return
    }
    if (pending.started) {
      state.clearPending(messageID)
      return
    }

    const sessionID = pending.sessionID
    if (state.isRecovering(sessionID)) {
      state.schedulePending({
        messageID,
        sessionID,
        parts: pending.parts,
        delayMs: 200,
        onTimeout: () => {
          void interruptPendingMessage(messageID)
        },
      })
      return
    }

    state.setRecovering(sessionID)
    try {
      const abortedAssistantWait = state.waitForEvent({
        match: (event) => {
          return (
            event.type === 'message.updated' &&
            event.properties.info.role === 'assistant' &&
            event.properties.info.sessionID === sessionID &&
            event.properties.info.error?.name === 'MessageAbortedError'
          )
        },
        timeoutMs: 5_000,
      })
      const idleWait = state.waitForEvent({
        match: (event) => {
          return event.type === 'session.idle' && event.properties.sessionID === sessionID
        },
        timeoutMs: 10_000,
      })

      await ctx.client.session.abort({ path: { id: sessionID } })
      await abortedAssistantWait
      await idleWait

      const currentPending = state.getPending(messageID)
      if (!currentPending || currentPending.started) {
        state.clearPending(messageID)
        return
      }

      // Resubmit the original queued user message after abort.
      // session.abort() clears OpenCode's internal prompt queue, so resuming
      // with an empty parts array can silently drop the user's message.
      // Keep the original messageID + parts and preserve agent/model context so
      // session overrides (issue #77) survive the abort + replay path.
      const replayBody: {
        messageID: string
        parts: PromptPartInput[]
        agent?: string
        model?: { providerID: string; modelID: string }
      } = {
        messageID,
        parts: currentPending.parts,
      }
      if (currentPending.agent) {
        replayBody.agent = currentPending.agent
      }
      if (currentPending.model) {
        replayBody.model = currentPending.model
      }

      await ctx.client.session.promptAsync({
        path: { id: sessionID },
        body: replayBody,
      })
      state.clearPending(messageID)

      const nextPending = state.getNextPendingForSession(sessionID)
      if (!nextPending) {
        return
      }
      state.schedulePending({
        messageID: nextPending.messageID,
        sessionID,
        parts: nextPending.pending.parts,
        delayMs: 50,
        onTimeout: () => {
          void interruptPendingMessage(nextPending.messageID)
        },
      })
    } finally {
      state.clearRecovering(sessionID)
    }
  }

  return {
    async event({ event }) {
      state.dispatchEvent(event)

      if (event.type === 'message.part.updated' && event.properties.part.type === 'step-finish') {
        const nextPending = state.getNextPendingForSession(event.properties.part.sessionID)
        if (!nextPending) {
          return
        }
        if (state.isRecovering(nextPending.pending.sessionID)) {
          return
        }
        if (!nextPending.pending.abortAfterStepMessageID) {
          return
        }
        if (event.properties.part.messageID !== nextPending.pending.abortAfterStepMessageID) {
          return
        }
        void interruptPendingMessage(nextPending.messageID)
        return
      }

      if (event.type === 'message.updated' && event.properties.info.role === 'assistant') {
        if (!event.properties.info.error) {
          state.setLatestAssistantMessage(event.properties.info.sessionID, event.properties.info.id)
        }

        const nextPending = state.getNextPendingForSession(event.properties.info.sessionID)
        if (
          nextPending &&
          !nextPending.pending.started &&
          !event.properties.info.error &&
          event.properties.info.parentID !== nextPending.messageID
        ) {
          nextPending.pending.abortAfterStepMessageID = event.properties.info.id
        }

        const parentID = event.properties.info.parentID
        state.markStarted(parentID)
        return
      }

      if (event.type === 'session.idle') {
        state.clearLatestAssistantMessage(event.properties.sessionID)
        return
      }

      if (event.type === 'session.deleted') {
        state.cleanupSession(event.properties.info.id)
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
      if (state.hasPending(messageID)) {
        return
      }
      state.schedulePending({
        messageID,
        sessionID,
        parts: toPromptParts(output.parts),
        delayMs: interruptStepTimeoutMs,
        onTimeout: () => {
          void interruptPendingMessage(messageID)
        },
      })
      const pending = state.getPending(messageID)
      if (!pending) {
        return
      }
      pending.agent = output.message.agent
      pending.model = output.message.model
    },
  }
}

export { interruptOpencodeSessionOnUserMessage }
