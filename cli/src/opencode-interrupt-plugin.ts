// Interrupts queued user messages while a session is busy, then replays them.
//
// Runs INSIDE the opencode server child process. When a user sends a new
// message while the session is busy (e.g. a long-running bash tool), this
// plugin: (1) aborts the running message via session.abort, then (2) replays
// the queued user message via session.promptAsync so the original parts +
// agent/model overrides are preserved (session.abort clears OpenCode's
// internal prompt queue, so replay is required, issue #77).
//
// IMPORTANT: this builds its OWN v2 OpenCode client from ctx.serverUrl instead
// of using the plugin-provided ctx.client. The plugin's ctx.client (v1 SDK)
// does not reliably make REST calls in this process: session.abort/status calls
// through it silently no-op. See plugin-opencode-client.ts.
//
// Abort confirmation uses session.status polling, NOT event waiting. OpenCode's
// SessionPrompt.cancel() (packages/opencode/src/session/prompt.ts) calls
// abort.abort() then SessionStatus.set(idle) synchronously, so the session
// reports idle right after abort. Event-based waiting was unreliable: the
// post-abort message.updated (MessageAbortedError) and session.idle events did
// not always reach the plugin's event hook, so abort silently no-opped.
//
// Logging goes through client.app.log (OpenCode's structured logger) via
// createPluginAppLogger. Plugins must not use console.* or import the kimaki
// logger.

import type { Plugin } from '@opencode-ai/plugin'
import type {
  Part,
  TextPartInput,
  FilePartInput,
  AgentPartInput,
  SubtaskPartInput,
} from '@opencode-ai/sdk/v2'
import {
  createPluginClient,
  createPluginAppLogger,
} from './plugin-opencode-client.js'

type PromptPartInput = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput

type PendingMessage = {
  sessionID: string
  timer: ReturnType<typeof setTimeout>
  parts: PromptPartInput[]
  agent: string | undefined
  model: { providerID: string; modelID: string } | undefined
}

const LOG_SERVICE = 'kimaki-interrupt'
const DEFAULT_INTERRUPT_STEP_TIMEOUT_MS = 3_000

// Poll session.status after abort until the session reports idle. cancel() sets
// status to idle synchronously, so this usually resolves on the first poll.
const ABORT_IDLE_POLL_INTERVAL_MS = 100
const ABORT_IDLE_POLL_TIMEOUT_MS = 3_000

function getInterruptStepTimeoutMs(): number {
  const raw = process.env['KIMAKI_INTERRUPT_STEP_TIMEOUT_MS']
  if (!raw) return DEFAULT_INTERRUPT_STEP_TIMEOUT_MS
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERRUPT_STEP_TIMEOUT_MS
}

function toPromptParts(parts: Part[]): PromptPartInput[] {
  const PROMPT_PART_TYPES = new Set(['text', 'file', 'agent', 'subtask'])
  return parts.filter((p): p is Part & { type: 'text' | 'file' | 'agent' | 'subtask' } =>
    PROMPT_PART_TYPES.has(p.type),
  ).map((p) => {
    // Strip runtime-only fields (sessionID, messageID) that Part has but PartInput doesn't
    const { sessionID: _s, messageID: _m, ...input } = p as Part & Record<string, unknown>
    return input as PromptPartInput
  })
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const interruptOpencodeSessionOnUserMessage: Plugin = async (ctx) => {
  const interruptStepTimeoutMs = getInterruptStepTimeoutMs()
  const directory = ctx.directory

  // Build our own v2 client against the same server. ctx.client (v1) does not
  // reliably make REST calls from inside this plugin process.
  const client = createPluginClient({ serverUrl: ctx.serverUrl, directory })
  const log = createPluginAppLogger({ client, service: LOG_SERVICE })

  // Queued messages awaiting their interrupt timer, keyed by messageID.
  const pending = new Map<string, PendingMessage>()
  // Sessions currently running an abort+replay. Guards against concurrent
  // interrupts and re-entrant scheduling while an interrupt is in flight.
  const interrupting = new Set<string>()
  // Messages replayed after abort. chat.message skips scheduling a new
  // interrupt timer for these to prevent infinite abort→replay loops when the
  // LLM takes longer than interruptStepTimeoutMs to respond.
  const replayedMessageIds = new Set<string>()

  function clearPending(messageID: string): void {
    const entry = pending.get(messageID)
    if (!entry) return
    clearTimeout(entry.timer)
    pending.delete(messageID)
  }

  function getNextPending(sessionID: string): string | undefined {
    for (const [messageID, entry] of pending.entries()) {
      if (entry.sessionID === sessionID) return messageID
    }
    return undefined
  }

  function cleanupSession(sessionID: string): void {
    for (const [messageID, entry] of [...pending.entries()]) {
      if (entry.sessionID !== sessionID) continue
      replayedMessageIds.delete(messageID)
      clearPending(messageID)
    }
  }

  function schedulePending(messageID: string, entry: Omit<PendingMessage, 'timer'>, delayMs: number): void {
    clearPending(messageID)
    const timer = setTimeout(() => void interruptPendingMessage(messageID), delayMs)
    pending.set(messageID, { ...entry, timer })
    log('info', 'scheduled pending interrupt', {
      sessionID: entry.sessionID,
      messageID,
      delayMs,
    })
  }

  // Poll session.status until the session reports idle (or times out). Returns
  // the number of polls and whether the session became idle.
  async function waitForSessionIdle(
    sessionID: string,
  ): Promise<{ polls: number; becameIdle: boolean; finalStatus: string }> {
    const startedAt = Date.now()
    let polls = 0
    let finalStatus = 'unknown'
    while (Date.now() - startedAt < ABORT_IDLE_POLL_TIMEOUT_MS) {
      polls += 1
      const statusResponse = await client.session.status({ directory })
      const sessionStatus = statusResponse.data?.[sessionID]
      finalStatus = sessionStatus?.type ?? 'idle'
      // No entry means the session is not running anything → idle.
      if (!sessionStatus || sessionStatus.type === 'idle') {
        return { polls, becameIdle: true, finalStatus }
      }
      await delay(ABORT_IDLE_POLL_INTERVAL_MS)
    }
    return { polls, becameIdle: false, finalStatus }
  }

  async function interruptPendingMessage(messageID: string): Promise<void> {
    const entry = pending.get(messageID)
    if (!entry) return

    const sessionID = entry.sessionID
    if (interrupting.has(sessionID)) {
      // Another interrupt is in flight for this session; retry shortly so we
      // don't drop the user's message.
      schedulePending(messageID, entry, 200)
      return
    }

    interrupting.add(sessionID)
    try {
      log('info', 'starting abort+replay', { sessionID, messageID })

      await client.session.abort({ sessionID, directory })
      log('info', 'session.abort called', { sessionID, messageID })

      const idleResult = await waitForSessionIdle(sessionID)
      log(idleResult.becameIdle ? 'info' : 'warn', 'status poll resolved', {
        sessionID,
        messageID,
        pollCount: idleResult.polls,
        becameIdle: idleResult.becameIdle,
        finalStatus: idleResult.finalStatus,
        pollTimeoutMs: ABORT_IDLE_POLL_TIMEOUT_MS,
      })
      // On timeout we still replay rather than silently dropping the user's
      // message: a queued promptAsync runs after the current turn anyway.

      const current = pending.get(messageID)
      if (!current) {
        log('info', 'replay skipped (dropped during abort)', { sessionID, messageID })
        return
      }

      // Replay the original queued message after abort. session.abort() clears
      // OpenCode's internal prompt queue, so we must resend the original parts +
      // agent/model to preserve session overrides (#77).
      const replayParams: {
        sessionID: string
        directory: string
        messageID: string
        parts: PromptPartInput[]
        agent?: string
        model?: { providerID: string; modelID: string }
      } = { sessionID, directory, messageID, parts: current.parts }
      if (current.agent) replayParams.agent = current.agent
      if (current.model) replayParams.model = current.model

      // Mark replayed BEFORE promptAsync so the chat.message hook skips
      // scheduling a new interrupt timer for this message.
      replayedMessageIds.add(messageID)
      clearPending(messageID)
      await client.session.promptAsync(replayParams)
      log('info', 'replayed queued message', {
        sessionID,
        messageID,
        replayPartCount: current.parts.length,
      })
    } catch (error) {
      log('error', 'abort+replay threw', {
        sessionID,
        messageID,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      interrupting.delete(sessionID)
    }

    // Drain the next queued message for this session, if any.
    const next = getNextPending(sessionID)
    if (next) {
      const nextEntry = pending.get(next)
      if (nextEntry) {
        log('info', 'scheduling next pending after replay', {
          sessionID,
          nextMessageID: next,
        })
        schedulePending(next, nextEntry, 50)
      }
    }
  }

  return {
    async event({ event }) {
      // When an assistant message starts processing a queued user message
      // (parentID match), cancel its interrupt timer: the message began running
      // normally within the timeout window, so there is nothing to interrupt.
      if (event.type === 'message.updated' && event.properties.info.role === 'assistant') {
        if (!event.properties.info.error) {
          clearPending(event.properties.info.parentID)
        }
        return
      }

      if (event.type === 'session.deleted') {
        log('debug', 'session deleted, cleaning up', { sessionID: event.properties.info.id })
        cleanupSession(event.properties.info.id)
      }
    },

    async 'chat.message'(input, output) {
      const sessionID = input.sessionID
      if (!sessionID) return
      if (output.parts.length === 0) return

      const messageID = input.messageID || output.message.id
      if (!messageID) return

      if (replayedMessageIds.has(messageID)) {
        replayedMessageIds.delete(messageID)
        log('debug', 'chat.message skipped (replayed message)', { sessionID, messageID })
        return
      }
      if (pending.has(messageID)) {
        log('debug', 'chat.message skipped (already pending)', { sessionID, messageID })
        return
      }

      schedulePending(
        messageID,
        {
          sessionID,
          parts: toPromptParts(output.parts),
          agent: output.message.agent,
          model: output.message.model,
        },
        interruptStepTimeoutMs,
      )
      log('info', 'chat.message queued for interrupt', {
        sessionID,
        messageID,
        agent: output.message.agent ?? null,
        model: output.message.model
          ? `${output.message.model.providerID}/${output.message.model.modelID}`
          : null,
        partCount: output.parts.length,
      })
    },
  }
}

export { interruptOpencodeSessionOnUserMessage }
