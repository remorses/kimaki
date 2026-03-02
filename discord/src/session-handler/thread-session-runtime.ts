// ThreadSessionRuntime — one per active thread.
// Owns resource handles (listener controller, typing timers, part buffer).
// Delegates all state to the global store via thread-runtime-state.ts transitions.
//
// This is the sole session orchestrator. Discord handlers and slash commands
// call runtime APIs (enqueueIncoming, abortActiveRun, etc.) without inspecting
// run internals. The old per-message handleOpencodeSession was removed in Phase 5.

import { ChannelType, type ThreadChannel } from 'discord.js'
import type {
  Event as OpenCodeEvent,
  Part,
  PermissionRequest,
  QuestionRequest,
  Message as OpenCodeMessage,
} from '@opencode-ai/sdk/v2'
import path from 'node:path'
import prettyMilliseconds from 'pretty-ms'
import * as errore from 'errore'
import * as threadState from './thread-runtime-state.js'
import type { QueuedMessage } from './thread-runtime-state.js'
import {
  pureMarkCurrentPromptEvidence,
  pureHandleMainSessionIdle,
  pureBeginPromptCycle,
  pureSetBaselineAssistantIds,
  pureMarkDispatching,
  pureMarkPromptResolvedAndConsumeDeferredIdle,
  pureMarkFinished,
  pureMarkAborted,
} from './state.js'
import type { MainRunState } from './state.js'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import {
  getOpencodeClient,
  initializeOpencodeForDirectory,
} from '../opencode.js'
import { isAbortError } from '../utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import {
  sendThreadMessage,
  SILENT_MESSAGE_FLAGS,
  NOTIFY_MESSAGE_FLAGS,
} from '../discord-utils.js'
import type { DiscordFileAttachment } from '../message-formatting.js'
import { formatPart } from '../message-formatting.js'
import {
  getChannelVerbosity,
  getPartMessageIds,
  setPartMessage,
  getThreadSession,
  setThreadSession,
  getThreadWorktree,
  getChannelDirectory,
  setSessionAgent,
  getVariantCascade,
  setSessionStartSource,
} from '../database.js'
import {
  showPermissionButtons,
  cleanupPermissionContext,
  addPermissionRequestToContext,
  arePatternsCoveredBy,
} from '../commands/permissions.js'
import {
  showAskUserQuestionDropdowns,
  cancelPendingQuestion,
  pendingQuestionContexts,
} from '../commands/ask-question.js'
import {
  showActionButtons,
  cancelPendingActionButtons,
  waitForQueuedActionButtonsRequest,
} from '../commands/action-buttons.js'
import { cancelPendingFileUpload } from '../commands/file-upload.js'
import {
  getCurrentModelInfo,
  ensureSessionPreferencesSnapshot,
} from '../commands/model.js'
import {
  getOpencodeSystemMessage,
  type AgentInfo,
  type WorktreeInfo,
} from '../system-message.js'
import { resolveValidatedAgentPreference } from './agent-utils.js'

// Track multiple pending permissions per thread (keyed by permission ID).
// OpenCode handles blocking/sequencing — we just need to track all pending
// permissions to avoid duplicates and properly clean up on auto-reject.
// Moved from session-handler.ts in Phase 5: the runtime is the sole owner.
export const pendingPermissions = new Map<
  string, // threadId
  Map<
    string,
    {
      permission: PermissionRequest
      messageId: string
      directory: string
      permissionDirectory: string
      contextHash: string
      dedupeKey: string
    }
  > // permissionId -> data
>()
import {
  getThinkingValuesForModel,
  matchThinkingValue,
} from '../thinking-utils.js'
import { execAsync } from '../worktree-utils.js'
import { SessionAbortError } from '../errors.js'
import { notifyError } from '../sentry.js'

const logger = createLogger(LogPrefix.SESSION)
const discordLogger = createLogger(LogPrefix.DISCORD)

// ── Registry ─────────────────────────────────────────────────────
// Runtime instances are kept in a plain Map (not Zustand — the Map
// is not reactive state, just a lookup for resource handles).

const runtimes = new Map<string, ThreadSessionRuntime>()

export function getRuntime(
  threadId: string,
): ThreadSessionRuntime | undefined {
  return runtimes.get(threadId)
}

export type RuntimeOptions = {
  threadId: string
  thread: ThreadChannel
  projectDirectory: string
  sdkDirectory: string
  channelId?: string
  appId?: string
}

export function getOrCreateRuntime(
  opts: RuntimeOptions,
): ThreadSessionRuntime {
  const existing = runtimes.get(opts.threadId)
  if (existing) {
    // Reconcile sdkDirectory: worktree threads transition from pending
    // (projectDirectory) to ready (worktree path) after runtime creation.
    if (existing.sdkDirectory !== opts.sdkDirectory) {
      existing.sdkDirectory = opts.sdkDirectory
    }
    return existing
  }
  threadState.ensureThread(opts.threadId) // add to global store
  const runtime = new ThreadSessionRuntime(opts)
  runtimes.set(opts.threadId, runtime)
  return runtime
}

export function disposeRuntime(threadId: string): void {
  const runtime = runtimes.get(threadId)
  if (!runtime) {
    return
  }
  runtime.dispose()
  runtimes.delete(threadId)
  threadState.removeThread(threadId) // remove from global store
}

export function disposeRuntimesForDirectory({
  directory,
  channelId,
}: {
  directory: string
  channelId?: string
}): number {
  let count = 0
  for (const [threadId, runtime] of runtimes) {
    if (runtime.projectDirectory !== directory) {
      continue
    }
    if (channelId && runtime.channelId !== channelId) {
      continue
    }
    runtime.dispose()
    runtimes.delete(threadId)
    threadState.removeThread(threadId)
    count++
  }
  return count
}

/** Returns number of active runtimes (useful for diagnostics). */
export function getRuntimeCount(): number {
  return runtimes.size
}

// Max time to wait for the current tool call to finish before aborting.
// When a user sends a message while a tool is running, we give the tool
// this much time to complete naturally (step-finish event) instead of
// killing it mid-execution. If the step doesn't finish in time, we abort.
const GRACEFUL_STEP_WAIT_MS = 3_000

// ── Helpers ──────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

type TokenUsage = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

function getTokenTotal(tokens: TokenUsage): number {
  return (
    tokens.input +
    tokens.output +
    tokens.reasoning +
    tokens.cache.read +
    tokens.cache.write
  )
}

/** Check if a tool part is "essential" (shown in text-and-essential-tools mode). */
function isEssentialToolName(toolName: string): boolean {
  const essentialTools = [
    'edit',
    'write',
    'bash',
    'webfetch',
    'websearch',
    'googlesearch',
    'codesearch',
    'task',
    'todowrite',
    'skill',
  ]
  // Also match any MCP tool that contains these names
  return essentialTools.some((name) => {
    return toolName === name || toolName.endsWith(`_${name}`)
  })
}

function isEssentialToolPart(part: Part): boolean {
  if (part.type !== 'tool') {
    return false
  }
  if (!isEssentialToolName(part.tool)) {
    return false
  }
  if (part.tool === 'bash') {
    const hasSideEffect = part.state.input?.hasSideEffect
    return hasSideEffect !== false
  }
  return true
}

// ── Ingress input type ───────────────────────────────────────────

export type EnqueueResult = {
  /** True if the message is waiting in queue behind an active run. */
  queued: boolean
  /** Queue position (1-based). Only set when queued is true. */
  position?: number
}

export type IngressInput = {
  prompt: string
  userId: string
  username: string
  images?: DiscordFileAttachment[]
  appId?: string
  command?: { name: string; arguments: string }
  /** true = abort active run + cancel interactive UIs before enqueueing.
   *  Normal user messages use true, /queue uses false. */
  interruptActive: boolean
  // First-dispatch-only overrides (used when creating a new session)
  agent?: string
  model?: string
  sessionStartSource?: { scheduleKind: 'at' | 'cron'; scheduledTaskId?: number }
  /** Optional guard for retries: skip enqueue when session has changed. */
  expectedSessionId?: string
}

type AbortRunOutcome = {
  abortId: string
  reason: string
  apiAbortPromise: Promise<void> | undefined
}

// ── Runtime class ────────────────────────────────────────────────

export class ThreadSessionRuntime {
  readonly threadId: string
  readonly projectDirectory: string
  // Mutable: worktree threads transition from pending (projectDirectory)
  // to ready (worktree path) after creation. getOrCreateRuntime reconciles
  // this on each call so dispatch always uses the current path.
  sdkDirectory: string
  readonly channelId: string | undefined
  readonly appId: string | undefined
  readonly thread: ThreadChannel

  // ── Resource handles (mechanisms, not domain state) ──

  // Reentrancy guard for startEventListener (not domain state —
  // just prevents calling the async loop twice).
  private listenerLoopRunning = false

  // Typing indicator handles
  private typingInterval: ReturnType<typeof setInterval> | null = null
  private typingRestartTimeout: ReturnType<typeof setTimeout> | null = null

  // Part output buffering (write-side cache, not domain state)
  private partBuffer = new Map<string, Map<string, Part>>()

  // Derivable cache (perf optimization for provider.list API call)
  private modelContextLimit: number | undefined
  private modelContextLimitKey: string | undefined

  // Serialized action queue — all mutations flow through dispatchAction
  private actionQueue: Array<() => Promise<void>> = []
  private processingAction = false

  // Step-finish waiter: resolved when a step-finish event arrives.
  // Used by enqueueIncoming to wait for the current tool call to complete
  // before aborting, giving tools up to GRACEFUL_STEP_WAIT_MS to finish.
  private stepFinishWaiter: { resolve: () => void; promise: Promise<void> } | undefined

  constructor(opts: RuntimeOptions) {
    this.threadId = opts.threadId
    this.projectDirectory = opts.projectDirectory
    this.sdkDirectory = opts.sdkDirectory
    this.channelId = opts.channelId
    this.appId = opts.appId
    this.thread = opts.thread
    threadState.updateThread(this.threadId, (t) => ({
      ...t,
      listenerController: new AbortController(),
    }))
  }

  // Read own state from global store
  get state(): threadState.ThreadRunState | undefined {
    return threadState.getThreadState(this.threadId)
  }

  /** Whether the listener has been disposed. */
  private get listenerAborted(): boolean {
    return this.state?.listenerController?.signal.aborted ?? true
  }

  /** The listener AbortSignal, used to pass to SDK subscribe calls. */
  private get listenerSignal(): AbortSignal | undefined {
    return this.state?.listenerController?.signal
  }

  /** Current assistant message ID from the centralized run state. */
  private get currentAssistantMessageId(): string | undefined {
    return this.state?.runState.currentAssistantMessageId
  }

  /** Shorthand for the current run info from the store. */
  private get run(): threadState.CurrentRunInfo | undefined {
    return this.state?.currentRun
  }

  /** Update fields on the current run info in the store. */
  private updateRun(
    updater: (r: threadState.CurrentRunInfo) => threadState.CurrentRunInfo,
  ): void {
    threadState.updateThread(this.threadId, (t) => ({
      ...t,
      currentRun: t.currentRun ? updater(t.currentRun) : t.currentRun,
    }))
  }

  private nextAbortId(reason: string): string {
    return `${reason}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  }

  private formatRunStateForLog(runState: MainRunState | undefined): string {
    if (!runState) {
      return 'none'
    }
    return `phase=${runState.phase},idle=${runState.idleState},eventSeq=${runState.eventSeq},evidenceSeq=${String(runState.evidenceSeq)},deferredIdleSeq=${String(runState.deferredIdleSeq)},currentAssistant=${runState.currentAssistantMessageId || 'none'}`
  }

  // ── Lifecycle ────────────────────────────────────────────────

  dispose(): void {
    this.state?.listenerController?.abort()
    this.state?.runController?.abort()
    threadState.updateThread(this.threadId, (t) => ({
      ...t,
      runController: undefined,
      listenerController: undefined,
    }))
    this.stopTyping()
  }

  // Seed sentPartIds from DB to avoid re-sending parts that were
  // already sent in a previous runtime or before a reconnect.
  private async bootstrapSentPartIds(): Promise<void> {
    const existingPartIds = await getPartMessageIds(this.thread.id)
    if (existingPartIds.length === 0) {
      return
    }
    threadState.updateThread(this.threadId, (t) => {
      const newIds = new Set(t.sentPartIds)
      for (const id of existingPartIds) {
        newIds.add(id)
      }
      return { ...t, sentPartIds: newIds }
    })
  }

  // ── Event Listener Loop (§7.3) ──────────────────────────────
  // Persistent event.subscribe loop with exponential backoff.
  // Reconnects automatically on transient disconnects.
  // Only killed when listenerController is aborted (dispose/fatal).
  // Run abort never affects this loop.

  async startEventListener(): Promise<void> {
    if (this.listenerLoopRunning) {
      return
    }
    this.listenerLoopRunning = true

    const client = getOpencodeClient(this.projectDirectory)
    if (!client) {
      logger.warn(
        `[LISTENER] No OpenCode client for directory: ${this.projectDirectory}`,
      )
      this.listenerLoopRunning = false
      return
    }

    // Bootstrap sentPartIds from DB so we don't re-send parts that
    // were already sent in a previous runtime or before a reconnect.
    await this.bootstrapSentPartIds()

    let backoffMs = 500
    const maxBackoffMs = 30_000

    while (!this.listenerAborted) {
      const signal = this.listenerSignal
      if (!signal) {
        return // disposed before we could subscribe
      }
      const subscribeResult = await errore.tryAsync(() => {
        return client.event.subscribe(
          { directory: this.sdkDirectory },
          { signal },
        )
      })

      if (subscribeResult instanceof Error) {
        if (isAbortError(subscribeResult)) {
          return // disposed
        }
        const subscribeError: Error = subscribeResult
        logger.warn(
          `[LISTENER] Subscribe failed for thread ${this.threadId}, retrying in ${backoffMs}ms:`,
          subscribeError.message,
        )
        await delay(backoffMs)
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
        continue
      }

      // Reset backoff on successful connection
      backoffMs = 500
      const events = subscribeResult.stream

      logger.log(
        `[LISTENER] Connected to event stream for thread ${this.threadId}`,
      )

      // Re-bootstrap sentPartIds on reconnect to prevent re-sending
      // parts that arrived while we were disconnected and were handled
      // by the old code path in session-handler.ts.
      await this.bootstrapSentPartIds()

      // TODO Phase 3: Reconnect reconciliation — after listener reconnect,
      // fetch session status/messages snapshot to repair run state if events
      // were missed during the disconnect. If recovery cannot prove progress,
      // move run to terminal error path and continue queue processing.
      // See migration plan §11 (Reconnect recovery behavior).

      const iterResult = await errore.tryAsync(async () => {
        for await (const event of events) {
          // Each event is dispatched through the serialized action queue
          // to prevent interleaving mutations from concurrent events.
          await this.dispatchAction(() => {
            return this.handleEvent(event)
          })
        }
      })

      if (iterResult instanceof Error) {
        if (isAbortError(iterResult)) {
          return // disposed
        }
        const iterError: Error = iterResult
        logger.warn(
          `[LISTENER] Stream broke for thread ${this.threadId}, reconnecting in ${backoffMs}ms:`,
          iterError.message,
        )
        await delay(backoffMs)
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
      }
    }
  }

  // ── Session Demux Guard ─────────────────────────────────────
  // Events scoped to a session must match the current session.
  // Global events (tui.toast.show) bypass the guard.
  // Subtask sessions also bypass — they're tracked in subtaskSessions.

  private async handleEvent(event: OpenCodeEvent): Promise<void> {
    const sessionId = this.state?.sessionId

    // Extract sessionID from event based on event type.
    // The sessionID lives at different paths per event type:
    //   message.updated      → event.properties.info.sessionID
    //   message.part.updated → event.properties.part.sessionID
    //   session.*            → event.properties.sessionID
    //   permission.*         → event.properties.sessionID
    //   question.*           → event.properties.sessionID
    const eventSessionId: string | undefined = (() => {
      switch (event.type) {
        case 'message.updated':
          return event.properties.info.sessionID
        case 'message.part.updated':
          return event.properties.part.sessionID
        case 'session.idle':
        case 'session.error':
        case 'session.status':
        case 'permission.asked':
        case 'permission.replied':
        case 'question.asked':
          return (event.properties as { sessionID?: string }).sessionID
        default:
          return undefined
      }
    })()

    const isGlobalEvent = event.type === 'tui.toast.show'

    // Drop events that don't match current session (stale events from
    // previous sessions), unless it's a global event or a subtask session.
    if (!isGlobalEvent && eventSessionId && eventSessionId !== sessionId) {
      if (!this.run?.subtaskSessions.has(eventSessionId)) {
        return // stale event from previous session
      }
    }

    switch (event.type) {
      case 'message.updated':
        await this.handleMessageUpdated(event.properties.info)
        break
      case 'message.part.updated':
        await this.handlePartUpdated(event.properties.part)
        break
      case 'session.idle':
        await this.handleSessionIdle(event.properties.sessionID)
        break
      case 'session.error':
        await this.handleSessionError(event.properties)
        break
      case 'permission.asked':
        await this.handlePermissionAsked(event.properties)
        break
      case 'permission.replied':
        this.handlePermissionReplied(event.properties)
        break
      case 'question.asked':
        await this.handleQuestionAsked(event.properties)
        break
      case 'session.status':
        await this.handleSessionStatus(event.properties)
        break
      case 'tui.toast.show':
        await this.handleTuiToast(event.properties)
        break
      default:
        break
    }
  }

  // ── Serialized Action Queue (§7.4) ──────────────────────────
  // All mutations (ingress actions + events) are serialized through
  // one internal queue to prevent interleaving writes.

  async dispatchAction(action: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.actionQueue.push(async () => {
        const result = await errore.tryAsync(action)
        if (result instanceof Error) {
          reject(result)
          return
        }
        resolve()
      })
      void this.processActionQueue()
    })
  }

  // Process serialized action queue. Uses try/finally to guarantee
  // processingAction is always reset — if we didn't, a thrown action
  // would leave the flag true and deadlock all future actions.
  private async processActionQueue(): Promise<void> {
    if (this.processingAction) {
      return
    }
    this.processingAction = true
    try {
      while (this.actionQueue.length > 0) {
        const next = this.actionQueue.shift()
        if (!next) {
          continue
        }
        // Each queued action already wraps itself with errore.tryAsync
        // and calls resolve/reject, so this should not throw. But if it
        // does, the try/finally ensures we don't deadlock.
        const result = await errore.tryAsync(next)
        if (result instanceof Error) {
          logger.error('[ACTION QUEUE] Unexpected action failure:', result)
        }
      }
    } finally {
      this.processingAction = false
    }
  }

  // ── Typing Indicator Management ─────────────────────────────

  private startTyping(): void {
    if (this.listenerAborted) {
      return
    }

    this.clearTypingRestartTimeout()
    this.clearTypingInterval()

    void errore
      .tryAsync(() => {
        return this.thread.sendTyping()
      })
      .then((result) => {
        if (result instanceof Error) {
          discordLogger.log(`Failed to send initial typing: ${result}`)
        }
      })

    this.typingInterval = setInterval(() => {
      if (this.listenerAborted) {
        this.clearTypingInterval()
        return
      }
      void errore
        .tryAsync(() => {
          return this.thread.sendTyping()
        })
        .then((result) => {
          if (result instanceof Error) {
            discordLogger.log(`Failed to send periodic typing: ${result}`)
          }
        })
    }, 8000)
  }

  private stopTyping(): void {
    this.clearTypingInterval()
    this.clearTypingRestartTimeout()
  }

  private clearTypingInterval(): void {
    if (!this.typingInterval) {
      return
    }
    clearInterval(this.typingInterval)
    this.typingInterval = null
  }

  private clearTypingRestartTimeout(): void {
    if (!this.typingRestartTimeout) {
      return
    }
    clearTimeout(this.typingRestartTimeout)
    this.typingRestartTimeout = null
  }

  private scheduleTypingRestart(): void {
    this.clearTypingRestartTimeout()
    if (this.listenerAborted) {
      return
    }

    this.typingRestartTimeout = setTimeout(() => {
      this.typingRestartTimeout = null
      if (this.listenerAborted) {
        return
      }
      // Don't restart typing if the run was aborted — a step-finish event
      // can schedule this timeout right before abort fires, and the 300ms
      // delay means it fires after abort already cleared typing.
      if (this.state?.runState.phase === 'aborted') {
        return
      }
      // Don't restart typing if interactive UI is pending
      const hasPendingQuestion = [...pendingQuestionContexts.values()].some(
        (ctx) => {
          return ctx.thread.id === this.thread.id
        },
      )
      const hasPendingPermission =
        (pendingPermissions.get(this.thread.id)?.size ?? 0) > 0
      if (hasPendingQuestion || hasPendingPermission) {
        return
      }
      this.startTyping()
    }, 300)
  }

  // ── Step-finish waiter (graceful interrupt) ─────────────────
  // When a user message interrupts an active tool call, we wait up to
  // GRACEFUL_STEP_WAIT_MS for the step to finish naturally before aborting.
  // This avoids killing tool calls that are about to complete.

  /** Create a waiter that resolves when notifyStepFinished() is called. */
  private createStepFinishWaiter(): Promise<void> {
    if (this.stepFinishWaiter) {
      return this.stepFinishWaiter.promise
    }
    let resolve!: () => void
    const promise = new Promise<void>((r) => {
      resolve = r
    })
    this.stepFinishWaiter = { resolve, promise }
    return promise
  }

  /** Called from handleMainPart on step-finish to resolve any pending waiter. */
  private notifyStepFinished(): void {
    if (!this.stepFinishWaiter) {
      return
    }
    this.stepFinishWaiter.resolve()
    this.stepFinishWaiter = undefined
  }

  // ── Part Buffering & Output ─────────────────────────────────

  private getVerbosityChannelId(): string {
    return this.channelId || this.thread.parentId || this.thread.id
  }

  private async getVerbosity() {
    return getChannelVerbosity(this.getVerbosityChannelId())
  }

  private storePart(part: Part): void {
    const messageParts =
      this.partBuffer.get(part.messageID) || new Map<string, Part>()
    messageParts.set(part.id, part)
    this.partBuffer.set(part.messageID, messageParts)
  }

  private getBufferedParts(messageID: string): Part[] {
    return Array.from(this.partBuffer.get(messageID)?.values() ?? [])
  }

  private shouldSendPart({
    part,
    force,
  }: {
    part: Part
    force: boolean
  }): boolean {
    if (part.type === 'step-start' || part.type === 'step-finish') {
      return false
    }
    if (part.type === 'tool' && part.state.status === 'pending') {
      return false
    }
    if (!force && part.type === 'text' && !part.time?.end) {
      return false
    }
    if (!force && part.type === 'tool' && part.state.status === 'completed') {
      return false
    }
    return true
  }

  private async sendPartMessage(part: Part): Promise<void> {
    const verbosity = await this.getVerbosity()
    if (verbosity === 'text-only' && part.type !== 'text') {
      return
    }
    if (verbosity === 'text-and-essential-tools') {
      if (part.type !== 'text' && !(part.type === 'tool' && isEssentialToolPart(part))) {
        return
      }
    }

    const content = formatPart(part) + '\n\n'
    if (!content.trim() || content.length === 0) {
      return
    }
    if (this.state?.sentPartIds.has(part.id)) {
      return
    }
    // Mark as sent BEFORE the async send to prevent concurrent flushes
    // from sending the same part while this await is in-flight.
    threadState.updateThread(this.threadId, (t) => {
      const newIds = new Set(t.sentPartIds)
      newIds.add(part.id)
      return { ...t, sentPartIds: newIds }
    })

    const sendResult = await errore.tryAsync(() => {
      return sendThreadMessage(this.thread, content)
    })
    if (sendResult instanceof Error) {
      threadState.updateThread(this.threadId, (t) => {
        const newIds = new Set(t.sentPartIds)
        newIds.delete(part.id)
        return { ...t, sentPartIds: newIds }
      })
      discordLogger.error(
        `ERROR: Failed to send part ${part.id}:`,
        sendResult,
      )
      return
    }
    await setPartMessage(part.id, sendResult.id, this.thread.id)
  }

  private async flushBufferedParts({
    messageID,
    force,
    skipPartId,
  }: {
    messageID: string | undefined
    force: boolean
    skipPartId?: string
  }): Promise<void> {
    if (!messageID) {
      return
    }
    const parts = this.getBufferedParts(messageID)
    for (const part of parts) {
      if (skipPartId && part.id === skipPartId) {
        continue
      }
      if (!this.shouldSendPart({ part, force })) {
        continue
      }
      await this.sendPartMessage(part)
    }
  }

  private async showInteractiveUi({
    skipPartId,
    flushMessageId,
    show,
  }: {
    skipPartId?: string
    flushMessageId?: string
    show: () => Promise<void>
  }): Promise<void> {
    this.stopTyping()
    const targetMessageId = flushMessageId || this.currentAssistantMessageId
    if (targetMessageId) {
      await this.flushBufferedParts({
        messageID: targetMessageId,
        force: true,
        skipPartId,
      })
    }
    await show()
  }

  private async ensureModelContextLimit(): Promise<void> {
    const run = this.run
    if (!run?.providerID || !run.model) {
      return
    }
    const key = `${run.providerID}/${run.model}`
    if (this.modelContextLimit && this.modelContextLimitKey === key) {
      return
    }
    const client = getOpencodeClient(this.projectDirectory)
    if (!client) {
      return
    }
    const providersResponse = await errore.tryAsync(() => {
      return client.provider.list({ directory: this.sdkDirectory })
    })
    if (providersResponse instanceof Error) {
      logger.error(
        'Failed to fetch provider info for context limit:',
        providersResponse,
      )
      return
    }
    const provider = providersResponse.data?.all?.find(
      (p) => {
        return p.id === run.providerID
      },
    )
    const model = provider?.models?.[run.model || '']
    if (!model?.limit?.context) {
      return
    }
    this.modelContextLimit = model.limit.context
    this.modelContextLimitKey = key
  }

  // ── Event Handlers ──────────────────────────────────────────
  // Extracted from session-handler.ts eventHandler closure.
  // These operate on runtime instance state + global store transitions.

  private async handleMessageUpdated(msg: OpenCodeMessage): Promise<void> {
    const sessionId = this.state?.sessionId

    // Track subtask assistant message IDs
    const subtaskInfo = this.run?.subtaskSessions.get(msg.sessionID)
    if (subtaskInfo && msg.role === 'assistant') {
      this.updateRun((r) => {
        const newSubs = new Map(r.subtaskSessions)
        const existing = newSubs.get(msg.sessionID)
        if (existing) {
          newSubs.set(msg.sessionID, { ...existing, assistantMessageId: msg.id })
        }
        return { ...r, subtaskSessions: newSubs }
      })
    }

    if (msg.sessionID !== sessionId) {
      return
    }
    if (msg.role !== 'assistant') {
      return
    }

    // Update run state: mark evidence of current prompt's response
    threadState.updateRunState(this.threadId, (rs) => {
      return pureMarkCurrentPromptEvidence(rs, msg.id)
    })

    // Track tokens, model, provider, agent from assistant messages
    this.updateRun((r) => {
      let tokensUsed = r.tokensUsed
      if ('tokens' in msg && msg.tokens) {
        const newTokensTotal = getTokenTotal(msg.tokens)
        if (newTokensTotal > 0) {
          tokensUsed = newTokensTotal
        }
      }
      return {
        ...r,
        tokensUsed,
        model: 'modelID' in msg ? msg.modelID : r.model,
        providerID: 'providerID' in msg ? msg.providerID : r.providerID,
        agent: 'mode' in msg ? msg.mode : r.agent,
      }
    })

    await this.flushBufferedParts({
      messageID: this.currentAssistantMessageId,
      force: false,
    })

    // Context usage notice
    const run = this.run
    if (!run || run.tokensUsed === 0 || !run.providerID || !run.model) {
      return
    }
    await this.ensureModelContextLimit()
    if (!this.modelContextLimit) {
      return
    }
    const currentPercentage = Math.floor(
      (run.tokensUsed / this.modelContextLimit) * 100,
    )
    const thresholdCrossed = Math.floor(currentPercentage / 10) * 10
    if (
      thresholdCrossed <= run.lastDisplayedContextPercentage ||
      thresholdCrossed < 10
    ) {
      return
    }
    this.updateRun((r) => ({
      ...r,
      lastDisplayedContextPercentage: thresholdCrossed,
    }))
    const chunk = `⬦ context usage ${currentPercentage}%`
    const sendResult = await errore.tryAsync(() => {
      return this.thread.send({ content: chunk, flags: SILENT_MESSAGE_FLAGS })
    })
    if (sendResult instanceof Error) {
      discordLogger.error('Failed to send context usage notice:', sendResult)
    }
  }

  private async handlePartUpdated(part: Part): Promise<void> {
    this.storePart(part)
    const sessionId = this.state?.sessionId

    const subtaskInfo = this.run?.subtaskSessions.get(part.sessionID)
    const isSubtaskEvent = Boolean(subtaskInfo)

    if (part.sessionID !== sessionId && !isSubtaskEvent) {
      return
    }

    // Update run state evidence for main session parts
    if (part.sessionID === sessionId) {
      threadState.updateRunState(this.threadId, (rs) => {
        return pureMarkCurrentPromptEvidence(rs, part.messageID)
      })
    }

    if (isSubtaskEvent && subtaskInfo) {
      await this.handleSubtaskPart(part, subtaskInfo)
      return
    }

    await this.handleMainPart(part)
  }

  private async handleMainPart(part: Part): Promise<void> {
    const isActiveMessage = this.currentAssistantMessageId
      ? part.messageID === this.currentAssistantMessageId
      : false
    const allowEarlyProcessing =
      !this.currentAssistantMessageId &&
      part.type === 'tool' &&
      part.state.status === 'running'
    if (!isActiveMessage && !allowEarlyProcessing) {
      if (part.type !== 'step-start') {
        return
      }
    }

    if (part.type === 'step-start') {
      const hasPendingQuestion = [...pendingQuestionContexts.values()].some(
        (ctx) => {
          return ctx.thread.id === this.thread.id
        },
      )
      const hasPendingPermission =
        (pendingPermissions.get(this.thread.id)?.size ?? 0) > 0
      if (!hasPendingQuestion && !hasPendingPermission) {
        this.startTyping()
      }
      return
    }

    if (part.type === 'tool' && part.state.status === 'running') {
      threadState.setHasRunningTool(this.threadId, true)
      await this.flushBufferedParts({
        messageID: this.currentAssistantMessageId || part.messageID,
        force: true,
        skipPartId: part.id,
      })
      await this.sendPartMessage(part)

      // Track task tool spawning subtask sessions
      if (part.tool === 'task' && !this.state?.sentPartIds.has(part.id)) {
        const description = (part.state.input?.description as string) || ''
        const agent = (part.state.input?.subagent_type as string) || 'task'
        const childSessionId =
          (part.state.metadata?.sessionId as string) || ''
        if (description && childSessionId) {
          threadState.updateThread(this.threadId, (t) => {
            const r = t.currentRun
            if (!r) {
              return t
            }
            const newCounts = { ...r.agentSpawnCounts }
            newCounts[agent] = (newCounts[agent] || 0) + 1
            const label = `${agent}-${newCounts[agent]}`
            const newSubs = new Map(r.subtaskSessions)
            newSubs.set(childSessionId, { label, assistantMessageId: undefined })
            const newSentIds = new Set(t.sentPartIds)
            newSentIds.add(part.id)
            return {
              ...t,
              sentPartIds: newSentIds,
              currentRun: {
                ...r,
                agentSpawnCounts: newCounts,
                subtaskSessions: newSubs,
              },
            }
          })
          if ((await this.getVerbosity()) !== 'text-only') {
            const spawnCount = this.run?.agentSpawnCounts[agent] || 1
            const taskDisplay = `┣ task **${description}**${agent ? ` _${agent}_` : ''}`
            await sendThreadMessage(this.thread, taskDisplay + '\n\n')
          }
        }
      }
      return
    }

    // Action buttons tool handler
    if (
      part.type === 'tool' &&
      part.state.status === 'completed' &&
      part.tool.endsWith('kimaki_action_buttons')
    ) {
      const sessionId = this.state?.sessionId
      await this.showInteractiveUi({
        skipPartId: part.id,
        flushMessageId: this.currentAssistantMessageId || part.messageID,
        show: async () => {
          if (!sessionId) {
            return
          }
          const request = await waitForQueuedActionButtonsRequest({
            sessionId,
            timeoutMs: 1500,
          })
          if (!request) {
            logger.warn(
              `[ACTION] No queued action-buttons request found for session ${sessionId}`,
            )
            return
          }
          if (request.threadId !== this.thread.id) {
            logger.warn(
              `[ACTION] Ignoring queued action-buttons for different thread`,
            )
            return
          }
          const showResult = await errore.tryAsync(() => {
            return showActionButtons({
              thread: this.thread,
              sessionId: request.sessionId,
              directory: request.directory,
              buttons: request.buttons,
            })
          })
          if (showResult instanceof Error) {
            logger.error(
              '[ACTION] Failed to show action buttons:',
              showResult,
            )
            await sendThreadMessage(
              this.thread,
              `Failed to show action buttons: ${showResult.message}`,
            )
          }
        },
      })
      return
    }

    // Large output notification for completed tools
    if (part.type === 'tool' && part.state.status === 'completed') {
      const showLargeOutput = await (async () => {
        const verbosity = await this.getVerbosity()
        if (verbosity === 'text-only') {
          return false
        }
        if (verbosity === 'text-and-essential-tools') {
          return isEssentialToolPart(part)
        }
        return true
      })()
      if (showLargeOutput) {
        const output = part.state.output || ''
        const outputTokens = Math.ceil(output.length / 4)
        const largeOutputThreshold = 3000
        if (outputTokens >= largeOutputThreshold) {
          await this.ensureModelContextLimit()
          const formattedTokens =
            outputTokens >= 1000
              ? `${(outputTokens / 1000).toFixed(1)}k`
              : String(outputTokens)
          const percentageSuffix = (() => {
            if (!this.modelContextLimit) {
              return ''
            }
            const pct = (outputTokens / this.modelContextLimit) * 100
            if (pct < 1) {
              return ''
            }
            return ` (${pct.toFixed(1)}%)`
          })()
          const chunk = `⬦ ${part.tool} returned ${formattedTokens} tokens${percentageSuffix}`
          const largeOutputResult = await errore.tryAsync(() => {
            return this.thread.send({
              content: chunk,
              flags: SILENT_MESSAGE_FLAGS,
            })
          })
          if (largeOutputResult instanceof Error) {
            discordLogger.error('Failed to send large output notice:', largeOutputResult)
          }
        }
      }
    }

    if (part.type === 'reasoning') {
      await this.sendPartMessage(part)
      return
    }

    if (part.type === 'text' && part.time?.end) {
      await this.sendPartMessage(part)
      return
    }

    if (part.type === 'step-finish') {
      threadState.setHasRunningTool(this.threadId, false)
      this.notifyStepFinished()
      await this.flushBufferedParts({
        messageID: this.currentAssistantMessageId || part.messageID,
        force: true,
      })
      this.scheduleTypingRestart()
    }
  }

  private async handleSubtaskPart(
    part: Part,
    subtaskInfo: { label: string; assistantMessageId?: string },
  ): Promise<void> {
    const verbosity = await this.getVerbosity()
    if (verbosity === 'text-only') {
      return
    }
    if (verbosity === 'text-and-essential-tools') {
      if (!isEssentialToolPart(part)) {
        return
      }
    }
    if (part.type === 'step-start' || part.type === 'step-finish') {
      return
    }
    if (part.type === 'tool' && part.state.status === 'pending') {
      return
    }
    if (part.type === 'text') {
      return
    }
    if (
      !subtaskInfo.assistantMessageId ||
      part.messageID !== subtaskInfo.assistantMessageId
    ) {
      return
    }

    const content = formatPart(part, subtaskInfo.label)
    if (!content.trim() || this.state?.sentPartIds.has(part.id)) {
      return
    }
    const sendResult = await errore.tryAsync(() => {
      return sendThreadMessage(this.thread, content + '\n\n')
    })
    if (sendResult instanceof Error) {
      discordLogger.error(
        `ERROR: Failed to send subtask part ${part.id}:`,
        sendResult,
      )
      return
    }
    threadState.updateThread(this.threadId, (t) => {
      const newIds = new Set(t.sentPartIds)
      newIds.add(part.id)
      return { ...t, sentPartIds: newIds }
    })
    await setPartMessage(part.id, sendResult.id, this.thread.id)
  }

  private async handleSessionIdle(idleSessionId: string): Promise<void> {
    const sessionId = this.state?.sessionId

    if (idleSessionId === sessionId) {
      const result = pureHandleMainSessionIdle(
        this.state?.runState ?? {
          phase: 'waiting-dispatch',
          idleState: 'none',
          baselineAssistantIds: new Set<string>(),
          currentAssistantMessageId: undefined,
          eventSeq: 0,
          evidenceSeq: undefined,
          deferredIdleSeq: undefined,
        },
      )
      threadState.updateRunState(this.threadId, () => {
        return result.state
      })

      if (result.decision === 'deferred') {
        logger.log(
          `[SESSION IDLE] decision=deferred sessionId=${sessionId} runState=${this.formatRunStateForLog(result.state)}`,
        )
        return
      }
      if (result.decision === 'ignore-no-evidence') {
        logger.log(
          `[SESSION IDLE] decision=ignore-no-evidence sessionId=${sessionId} runState=${this.formatRunStateForLog(result.state)}`,
        )
        return
      }
      if (result.decision === 'ignore-inactive-phase') {
        logger.log(
          `[SESSION IDLE] decision=ignore-inactive-phase sessionId=${sessionId} runState=${this.formatRunStateForLog(result.state)}`,
        )
        return
      }

      // decision === 'process' — run finished.
      // finishRun marks finished, flushes parts, emits footer, drains queue.
      logger.log(
        `[SESSION IDLE] decision=process sessionId=${sessionId} runState=${this.formatRunStateForLog(result.state)}`,
      )
      await this.finishRun({ expectedRunId: this.run?.runId })
      return
    }

    // Subtask idle
    if (!this.run?.subtaskSessions.has(idleSessionId)) {
      return
    }
    const subtask = this.run.subtaskSessions.get(idleSessionId)
    logger.log(
      `[SUBTASK IDLE] Subtask "${subtask?.label}" completed`,
    )
    this.updateRun((r) => {
      const newSubs = new Map(r.subtaskSessions)
      newSubs.delete(idleSessionId)
      return { ...r, subtaskSessions: newSubs }
    })
  }

  private async handleSessionError(properties: {
    sessionID?: string
    error?: {
      name?: string
      data?: {
        message?: string
        statusCode?: number
        providerID?: string
        isRetryable?: boolean
        responseBody?: string
      }
    }
  }): Promise<void> {
    const sessionId = this.state?.sessionId
    if (!properties.sessionID || properties.sessionID !== sessionId) {
      logger.log(
        `Ignoring error for different session (expected: ${sessionId}, got: ${properties.sessionID})`,
      )
      return
    }

    // Skip abort errors — they are expected when operations are cancelled
    if (properties.error?.name === 'MessageAbortedError') {
      logger.log(
        `[SESSION ERROR] Operation aborted (expected) sessionId=${sessionId} runState=${this.formatRunStateForLog(this.state?.runState)}`,
      )
      return
    }
    // Check the run controller abort too
    const runController = this.state?.runController
    if (runController?.signal.aborted) {
      logger.log(
        `[SESSION ERROR] Operation aborted (run controller aborted) sessionId=${sessionId} runState=${this.formatRunStateForLog(this.state?.runState)}`,
      )
      return
    }

    const errorMessage = formatSessionErrorFromProps(properties.error)
    logger.error(`Sending error to thread: ${errorMessage}`)
    await sendThreadMessage(
      this.thread,
      `✗ opencode session error: ${errorMessage}`,
    )
  }

  private async handlePermissionAsked(
    permission: PermissionRequest,
  ): Promise<void> {
    const sessionId = this.state?.sessionId
    const isMainSession = permission.sessionID === sessionId
    const isSubtaskSession = this.run?.subtaskSessions.has(permission.sessionID) ?? false

    if (!isMainSession && !isSubtaskSession) {
      logger.log(
        `[PERMISSION IGNORED] Permission for unknown session (expected: ${sessionId} or subtask, got: ${permission.sessionID})`,
      )
      return
    }

    const subtaskLabel = isSubtaskSession
      ? this.run?.subtaskSessions.get(permission.sessionID)?.label
      : undefined

    const dedupeKey = buildPermissionDedupeKey({
      permission,
      directory: this.projectDirectory,
    })
    const threadPermissions = pendingPermissions.get(this.thread.id)
    const existingPending = threadPermissions
      ? Array.from(threadPermissions.values()).find((pending) => {
          if (pending.dedupeKey === dedupeKey) {
            return true
          }
          if (pending.directory !== this.projectDirectory) {
            return false
          }
          if (pending.permission.permission !== permission.permission) {
            return false
          }
          return arePatternsCoveredBy({
            patterns: permission.patterns,
            coveringPatterns: pending.permission.patterns,
          })
        })
      : undefined

    if (existingPending) {
      logger.log(
        `[PERMISSION] Deduped permission ${permission.id} (matches pending ${existingPending.permission.id})`,
      )
      this.stopTyping()
      if (!pendingPermissions.has(this.thread.id)) {
        pendingPermissions.set(this.thread.id, new Map())
      }
      pendingPermissions.get(this.thread.id)!.set(permission.id, {
        permission,
        messageId: existingPending.messageId,
        directory: this.projectDirectory,
        permissionDirectory: existingPending.permissionDirectory,
        contextHash: existingPending.contextHash,
        dedupeKey,
      })
      const added = addPermissionRequestToContext({
        contextHash: existingPending.contextHash,
        requestId: permission.id,
      })
      if (!added) {
        logger.log(
          `[PERMISSION] Failed to attach duplicate request ${permission.id} to context`,
        )
      }
      return
    }

    logger.log(
      `Permission requested: permission=${permission.permission}, patterns=${permission.patterns.join(', ')}${subtaskLabel ? `, subtask=${subtaskLabel}` : ''}`,
    )

    this.stopTyping()

    const { messageId, contextHash } = await showPermissionButtons({
      thread: this.thread,
      permission,
      directory: this.projectDirectory,
      permissionDirectory: this.sdkDirectory,
      subtaskLabel,
    })

    if (!pendingPermissions.has(this.thread.id)) {
      pendingPermissions.set(this.thread.id, new Map())
    }
    pendingPermissions.get(this.thread.id)!.set(permission.id, {
      permission,
      messageId,
      directory: this.projectDirectory,
      permissionDirectory: this.sdkDirectory,
      contextHash,
      dedupeKey,
    })
  }

  private handlePermissionReplied(properties: {
    requestID: string
    reply: string
    sessionID: string
  }): void {
    const sessionId = this.state?.sessionId
    const isMainSession = properties.sessionID === sessionId
    const isSubtaskSession = this.run?.subtaskSessions.has(properties.sessionID) ?? false

    if (!isMainSession && !isSubtaskSession) {
      return
    }

    logger.log(
      `Permission ${properties.requestID} replied with: ${properties.reply}`,
    )

    const threadPermissions = pendingPermissions.get(this.thread.id)
    if (!threadPermissions) {
      return
    }
    const pending = threadPermissions.get(properties.requestID)
    if (!pending) {
      return
    }
    cleanupPermissionContext(pending.contextHash)
    threadPermissions.delete(properties.requestID)
    if (threadPermissions.size === 0) {
      pendingPermissions.delete(this.thread.id)
    }
  }

  private async handleQuestionAsked(
    questionRequest: QuestionRequest,
  ): Promise<void> {
    const sessionId = this.state?.sessionId
    if (questionRequest.sessionID !== sessionId) {
      logger.log(
        `[QUESTION IGNORED] Question for different session (expected: ${sessionId}, got: ${questionRequest.sessionID})`,
      )
      return
    }

    logger.log(
      `Question requested: id=${questionRequest.id}, questions=${questionRequest.questions.length}`,
    )

    await this.showInteractiveUi({
      flushMessageId: this.currentAssistantMessageId,
      show: async () => {
        if (!sessionId) {
          return
        }
        await showAskUserQuestionDropdowns({
          thread: this.thread,
          sessionId,
          directory: this.projectDirectory,
          requestId: questionRequest.id,
          input: { questions: questionRequest.questions },
        })
      },
    })

    // TODO Phase 3: Queue drain on question shown is intentionally NOT done
    // here. The migration plan (§11) changes behavior to block dispatch while
    // question/permission is pending. The old code in session-handler.ts
    // (line 2018) immediately drains the queue, which auto-dismisses questions.
  }

  private async handleSessionStatus(properties: {
    sessionID: string
    status:
      | { type: 'idle' }
      | { type: 'retry'; attempt: number; message: string; next: number }
      | { type: 'busy' }
  }): Promise<void> {
    const sessionId = this.state?.sessionId
    if (properties.sessionID !== sessionId) {
      return
    }
    if (properties.status.type !== 'retry') {
      return
    }
    // Throttle to once per 10 seconds
    const now = Date.now()
    if (now - (this.run?.lastRateLimitDisplayTime ?? 0) < 10_000) {
      return
    }
    this.updateRun((r) => ({ ...r, lastRateLimitDisplayTime: now }))

    const { attempt, message, next } = properties.status
    const remainingMs = Math.max(0, next - now)
    const remainingSec = Math.ceil(remainingMs / 1000)
    const duration = (() => {
      if (remainingSec < 60) {
        return `${remainingSec}s`
      }
      const mins = Math.floor(remainingSec / 60)
      const secs = remainingSec % 60
      return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
    })()

    const chunk = `⬦ ${message} - retrying in ${duration} (attempt #${attempt})`
    const retryResult = await errore.tryAsync(() => {
      return this.thread.send({ content: chunk, flags: SILENT_MESSAGE_FLAGS })
    })
    if (retryResult instanceof Error) {
      discordLogger.error('Failed to send retry notice:', retryResult)
    }
  }

  private async handleTuiToast(properties: {
    title?: string
    message: string
    variant: 'info' | 'success' | 'warning' | 'error'
    duration?: number
  }): Promise<void> {
    if (properties.variant === 'warning') {
      return
    }
    const toastMessage = properties.message.trim()
    if (!toastMessage) {
      return
    }
    const titlePrefix = properties.title
      ? `${properties.title.trim()}: `
      : ''
    const chunk = `⬦ ${properties.variant}: ${titlePrefix}${toastMessage}`
    const toastResult = await errore.tryAsync(() => {
      return this.thread.send({ content: chunk, flags: SILENT_MESSAGE_FLAGS })
    })
    if (toastResult instanceof Error) {
      discordLogger.error('Failed to send toast notice:', toastResult)
    }
  }

  // ── Phase 3: Ingress API ─────────────────────────────────────

  /**
   * Enqueue an incoming message/command, optionally interrupting the active run.
   * Normal user messages use interruptActive: true (abort + enqueue + drain).
   * /queue command uses interruptActive: false (just enqueue + drain).
   *
   * Returns { queued, position } computed atomically inside dispatchAction
   * so callers can show queue notifications without a race window.
   */
  async enqueueIncoming(input: IngressInput): Promise<EnqueueResult> {
    const queuedMessage: QueuedMessage = {
      prompt: input.prompt,
      userId: input.userId,
      username: input.username,
      queuedAt: Date.now(),
      images: input.images,
      appId: input.appId,
      command: input.command,
      agent: input.agent,
      model: input.model,
      sessionStartScheduleKind: input.sessionStartSource?.scheduleKind,
      sessionStartScheduledTaskId: input.sessionStartSource?.scheduledTaskId,
    }

    let result: EnqueueResult = { queued: false }
    let pendingAbortOutcome: AbortRunOutcome | undefined
    // Whether a tool was running when the interrupt arrived — used to
    // decide if we should wait for the step to finish before aborting.
    let toolWasRunning = false
    // Promise that resolves when a step-finish event arrives. Created
    // INSIDE dispatchAction to prevent a lost-wake race where step-finish
    // fires before the waiter is registered.
    let stepFinishPromise: Promise<void> | undefined

    await this.dispatchAction(async () => {
      if (
        input.expectedSessionId &&
        this.state?.sessionId !== input.expectedSessionId
      ) {
        logger.log(
          `[ENQUEUE] Skipping stale enqueue for thread ${this.threadId}: expected session ${input.expectedSessionId}, current session ${this.state?.sessionId || 'none'}`,
        )
        return
      }

      if (input.interruptActive) {
        // Cancel interactive UIs immediately regardless of graceful wait —
        // these block the session and the user clearly wants to move on.
        await this.autoRejectPendingPermissions()

        const questionAnswered = await cancelPendingQuestion(
          this.thread.id,
          input.prompt,
        )
        if (questionAnswered) {
          logger.log(
            `[ENQUEUE] Answered pending question with user message`,
          )
        }

        const fileUploadCancelled = await cancelPendingFileUpload(
          this.thread.id,
        )
        if (fileUploadCancelled) {
          logger.log(
            `[ENQUEUE] Cancelled pending file upload due to new message`,
          )
        }

        const actionButtonsDismissed = cancelPendingActionButtons(
          this.thread.id,
        )
        if (actionButtonsDismissed) {
          logger.log(
            `[ENQUEUE] Dismissed pending action buttons due to new message`,
          )
        }

        // Check if a tool call is currently in-flight. If so, we'll
        // wait for it to finish (up to GRACEFUL_STEP_WAIT_MS) outside
        // dispatchAction before aborting — this avoids killing tool
        // calls that are about to complete.
        toolWasRunning = this.state?.hasRunningTool ?? false

        if (!toolWasRunning) {
          // No tool running (text generation or between steps) — abort immediately.
          pendingAbortOutcome = this.abortActiveRunInternal({
            reason: 'new-request',
            forceApiAbortWithoutRunController: true,
          })
        } else {
          // Register the waiter inside dispatchAction so it exists before
          // any step-finish event can be processed (events also serialize
          // through dispatchAction). This prevents a lost-wake race.
          stepFinishPromise = this.createStepFinishWaiter()
          logger.log(
            `[ENQUEUE] Tool running — deferring abort for up to ${GRACEFUL_STEP_WAIT_MS}ms threadId=${this.threadId}`,
          )
        }
      }

      // Enqueue the message
      threadState.enqueueItem(this.threadId, queuedMessage)

      // Determine if the message is genuinely waiting in queue (behind an
      // active run or blocker) vs being dispatched immediately.
      // This must be computed here — inside dispatchAction, after enqueueItem
      // but before tryDrainQueue — because tryDrainQueue will dequeue and
      // dispatch the item if the session is idle. If the caller tried to
      // check queue state after enqueueIncoming returns, a race exists where
      // the queue already drained and the position reads as 0.
      //
      // canDispatchNext returns true when queue has items AND no run is active
      // AND no blockers are pending. If it's true, the item will be dispatched
      // immediately by tryDrainQueue below, so it's not really "queued".
      const stateAfterEnqueue = threadState.getThreadState(this.threadId)
      const position = stateAfterEnqueue?.queueItems.length ?? 0
      const willDrainNow = stateAfterEnqueue
        ? threadState.canDispatchNext(stateAfterEnqueue)
        : false
      result = !willDrainNow && position > 0
        ? { queued: true, position }
        : { queued: false }

      // Ensure listener is running
      if (!this.listenerLoopRunning) {
        void this.startEventListener()
      }

      if (!input.interruptActive) {
        // Try to drain queue immediately — no indicator because the user just
        // typed this message into an idle/non-interrupting flow.
        await this.tryDrainQueue()
      }
    })

    if (input.interruptActive) {
      if (toolWasRunning && stepFinishPromise) {
        // Graceful step wait: give the current tool call time to finish
        // before aborting. The step-finish event handler will resolve the
        // waiter when the tool completes. We wait outside dispatchAction
        // so event processing (which also uses dispatchAction) isn't blocked.
        let stepFinished = false
        await Promise.race([
          stepFinishPromise.then(() => {
            stepFinished = true
          }),
          delay(GRACEFUL_STEP_WAIT_MS),
        ])
        // Clean up waiter if we timed out (prevent stale resolve later)
        if (!stepFinished) {
          this.notifyStepFinished()
        }

        // Check if the run already finished naturally during our wait
        // (session.idle arrived and finishRun() processed it). Check this
        // independent of stepFinished — even if the signal was lost, the
        // run state is the source of truth.
        const phase = this.state?.runState.phase
        const runFinishedNaturally =
          phase === 'finished' || phase === 'waiting-dispatch'

        if (runFinishedNaturally) {
          // The model's turn completed naturally — no need to abort.
          // Just drain the queue so the user's new message gets dispatched.
          logger.log(
            `[ENQUEUE] Graceful wait: run finished naturally, skipping abort threadId=${this.threadId} stepFinished=${stepFinished}`,
          )
          await this.dispatchAction(async () => {
            await this.tryDrainQueue()
          })
        } else {
          // Step finished but model has more steps, or timeout — abort now.
          if (stepFinished) {
            logger.log(
              `[ENQUEUE] Graceful wait: step finished but run still active, aborting threadId=${this.threadId}`,
            )
          } else {
            logger.log(
              `[ENQUEUE] Graceful wait: timeout after ${GRACEFUL_STEP_WAIT_MS}ms, aborting threadId=${this.threadId}`,
            )
          }
          await this.dispatchAction(async () => {
            pendingAbortOutcome = this.abortActiveRunInternal({
              reason: 'new-request',
              forceApiAbortWithoutRunController: true,
            })
          })
          if (pendingAbortOutcome) {
            await this.waitForAbortSettlement(pendingAbortOutcome)
          }
          await this.dispatchAction(async () => {
            await this.tryDrainQueue()
          })
        }
      } else if (pendingAbortOutcome) {
        // No tool was running — immediate abort path (original behavior).
        await this.waitForAbortSettlement(pendingAbortOutcome)
        await this.dispatchAction(async () => {
          await this.tryDrainQueue()
        })
      }
    }

    return result
  }

  /**
   * Abort the currently active run. Does NOT kill the listener.
   * Aborts the per-prompt run controller and calls session.abort best-effort.
   */
  private async abortSessionViaApi({
    abortId,
    reason,
    sessionId,
  }: {
    abortId: string
    reason: string
    sessionId: string
  }): Promise<void> {
    const client = getOpencodeClient(this.projectDirectory)
    if (!client) {
      logger.log(
        `[ABORT API] id=${abortId} reason=${reason} sessionId=${sessionId} skipped=no-client`,
      )
      return
    }

    const startedAt = Date.now()
    logger.log(
      `[ABORT API] id=${abortId} reason=${reason} sessionId=${sessionId} start`,
    )
    const abortResult = await errore.tryAsync(() => {
      return client.session.abort({
        sessionID: sessionId,
        directory: this.sdkDirectory,
      })
    })
    if (!(abortResult instanceof Error)) {
      logger.log(
        `[ABORT API] id=${abortId} reason=${reason} sessionId=${sessionId} success durationMs=${Date.now() - startedAt}`,
      )
      return
    }
    logger.log(
      `[ABORT API] id=${abortId} reason=${reason} sessionId=${sessionId} failed durationMs=${Date.now() - startedAt} message=${abortResult.message}`,
    )
  }

  private abortActiveRunInternal({
    reason,
    forceApiAbortWithoutRunController,
  }: {
    reason: string
    forceApiAbortWithoutRunController?: boolean
  }): AbortRunOutcome {
    const abortId = this.nextAbortId(reason)
    const state = this.state
    if (!state) {
      logger.log(
        `[ABORT] id=${abortId} reason=${reason} threadId=${this.threadId} skipped=no-state`,
      )
      return {
        abortId,
        reason,
        apiAbortPromise: undefined,
      }
    }

    const runController = state.runController
    const sessionId = state.sessionId
    const runControllerAlreadyAborted = Boolean(runController?.signal.aborted)
    const hasRunController = Boolean(runController)

    logger.log(
      `[ABORT] id=${abortId} reason=${reason} threadId=${this.threadId} sessionId=${sessionId || 'none'} queueLength=${state.queueItems.length} runState=${this.formatRunStateForLog(state.runState)} hasRunController=${hasRunController} runControllerAborted=${runControllerAlreadyAborted}`,
    )

    if (!runController || runControllerAlreadyAborted) {
      // No active run or already aborted — just mark state.
      threadState.updateRunState(this.threadId, pureMarkAborted)
      threadState.setHasRunningTool(this.threadId, false)
      this.notifyStepFinished()
      // Stop typing immediately — don't wait for the async API abort response.
      this.stopTyping()
      const apiAbortPromise = forceApiAbortWithoutRunController && sessionId
        ? this.abortSessionViaApi({ abortId, reason, sessionId })
        : undefined
      logger.log(
        `[ABORT] id=${abortId} reason=${reason} threadId=${this.threadId} local-abort-skipped hasRunController=${hasRunController} alreadyAborted=${runControllerAlreadyAborted}`,
      )
      return {
        abortId,
        reason,
        apiAbortPromise,
      }
    }

    runController.abort(new SessionAbortError({ reason }))
    threadState.updateRunState(this.threadId, pureMarkAborted)
    threadState.setRunController(this.threadId, undefined)
    threadState.setHasRunningTool(this.threadId, false)
    this.notifyStepFinished()
    // Stop typing immediately — don't wait for the async API abort response.
    // Downstream paths (dispatchPrompt response.error) call stopTyping() too
    // but that's idempotent; this ensures typing stops the instant abort fires.
    this.stopTyping()

    const apiAbortPromise = sessionId
      ? this.abortSessionViaApi({ abortId, reason, sessionId })
      : undefined

    logger.log(
      `[ABORT] id=${abortId} reason=${reason} threadId=${this.threadId} local-abort-done runState=${this.formatRunStateForLog(this.state?.runState)}`,
    )

    return {
      abortId,
      reason,
      apiAbortPromise,
    }
  }

  private async waitForAbortSettlement(
    outcome: AbortRunOutcome,
    options?: {
      timeoutMs?: number
      pollMs?: number
      stablePolls?: number
      apiAbortTimeoutMs?: number
    },
  ): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? 1_200
    const pollMs = options?.pollMs ?? 25
    const stablePolls = options?.stablePolls ?? 1
    const apiAbortTimeoutMs = options?.apiAbortTimeoutMs ?? 300
    const startedAt = Date.now()

    logger.log(
      `[ABORT WAIT] id=${outcome.abortId} reason=${outcome.reason} threadId=${this.threadId} timeoutMs=${timeoutMs} pollMs=${pollMs}`,
    )

    if (outcome.apiAbortPromise) {
      await Promise.race([outcome.apiAbortPromise, delay(apiAbortTimeoutMs)])
    }

    let consecutiveStablePolls = 0
    while (!this.listenerAborted && Date.now() - startedAt < timeoutMs) {
      const state = this.state
      const runControllerCleared = !state?.runController
      const runState = state?.runState
      const phaseSettled =
        runState?.phase === 'aborted' ||
        runState?.phase === 'finished' ||
        runState?.phase === 'waiting-dispatch'

      if (runControllerCleared && phaseSettled) {
        consecutiveStablePolls += 1
        if (consecutiveStablePolls >= stablePolls) {
          logger.log(
            `[ABORT WAIT] id=${outcome.abortId} reason=${outcome.reason} settled durationMs=${Date.now() - startedAt} runState=${this.formatRunStateForLog(runState)}`,
          )
          return
        }
      } else {
        consecutiveStablePolls = 0
      }

      await delay(pollMs)
    }

    logger.warn(
      `[ABORT WAIT] id=${outcome.abortId} reason=${outcome.reason} timeout durationMs=${Date.now() - startedAt} runState=${this.formatRunStateForLog(this.state?.runState)} processingAction=${this.processingAction} actionQueueLength=${this.actionQueue.length}`,
    )
  }

  abortActiveRun(
    reason: string,
    options?: { forceApiAbortWithoutRunController?: boolean },
  ): void {
    const outcome = this.abortActiveRunInternal({
      reason,
      forceApiAbortWithoutRunController:
        options?.forceApiAbortWithoutRunController,
    })
    if (outcome.apiAbortPromise) {
      void outcome.apiAbortPromise
    }
    // Drain queued messages after abort — the SDK session abort response
    // handler no longer drains (it raced with interrupt drains and showed
    // the » indicator for non-queued messages). This covers /abort and
    // other external callers that need queued messages to continue.
    void this.dispatchAction(() => {
      return this.tryDrainQueue({ showIndicator: true })
    })
  }

  /** Number of messages waiting in the queue. */
  getQueueLength(): number {
    return this.state?.queueItems.length ?? 0
  }

  /** Clear all queued messages. */
  clearQueue(): void {
    threadState.clearQueueItems(this.threadId)
  }

  // ── Phase 3: Queue Drain ─────────────────────────────────────

  /**
   * Check if we can dispatch the next queued message. If so, dequeue and
   * start dispatchPrompt (detached — does not block the action queue).
   * Called after enqueue, after run finishes, or after a blocker resolves.
   *
   * @param showIndicator - When true, shows "» username: prompt" in Discord.
   *   Only set to true when draining after a previous run finishes or a
   *   blocker resolves — not on the immediate first dispatch from enqueueIncoming.
   */
  private async tryDrainQueue({ showIndicator = false } = {}): Promise<void> {
    const thread = threadState.getThreadState(this.threadId)
    if (!thread || !threadState.canDispatchNext(thread)) {
      return
    }

    const next = threadState.dequeueItem(this.threadId)
    if (!next) {
      return
    }

    logger.log(
      `[QUEUE DRAIN] Processing queued message from ${next.username}`,
    )

    // Show queued message indicator only for messages that actually waited
    // behind a running request — not for the first immediate dispatch.
    if (showIndicator) {
      const displayText = next.command
        ? `/${next.command.name}`
        : `${next.prompt.slice(0, 150)}${next.prompt.length > 150 ? '...' : ''}`
      if (displayText.trim()) {
        await sendThreadMessage(
          this.thread,
          `» **${next.username}:** ${displayText}`,
        )
      }
    }

    // Start dispatch (detached — does not block the action queue).
    // The prompt call is long-running. Events continue to flow through
    // the action queue while the SDK call is in-flight. State machine
    // invariants (isRunActive) prevent concurrent dispatches.
    void this.dispatchPrompt(next).catch(async (err) => {
      logger.error('[DISPATCH] Prompt dispatch failed:', err)
      void notifyError(err, 'Runtime prompt dispatch failed')
    })
  }

  // ── Phase 3: Prompt Dispatch ─────────────────────────────────
  // Prompt dispatch: resolve session, build system message, send to OpenCode
  // (session-handler.ts lines 2384-2620). The listener is already running,
  // so this only handles session ensure + model/agent + SDK call + state.

  private async dispatchPrompt(input: QueuedMessage): Promise<void> {
    // Initialize currentRun in the store (replaces resetPerRunState + dispatchStartTime)
    threadState.updateThread(this.threadId, (t) => ({
      ...t,
      lastRunId: t.lastRunId + 1,
      currentRun: threadState.initialCurrentRunInfo({ runId: t.lastRunId + 1 }),
    }))
    const dispatchRunId = this.run?.runId

    // ── Ensure session ────────────────────────────────────────
    const sessionResult = await this.ensureSession({
      prompt: input.prompt,
      agent: input.agent,
      sessionStartScheduleKind: input.sessionStartScheduleKind,
      sessionStartScheduledTaskId: input.sessionStartScheduledTaskId,
    })
    if (sessionResult instanceof Error) {
      await sendThreadMessage(
        this.thread,
        `✗ ${sessionResult.message}`,
      )
      // Show indicator: this dispatch failed, so the next queued message
      // has been waiting — the user needs to see which one is starting.
      await this.tryDrainQueue({ showIndicator: true })
      return
    }
    const { session, getClient, createdNewSession } = sessionResult

    // Ensure listener is running now that we have a valid OpenCode client.
    // The eager start in enqueueIncoming may have failed if the client
    // wasn't initialized yet (fresh thread, first message).
    if (!this.listenerLoopRunning) {
      void this.startEventListener()
    }

    // ── Resolve model + agent preferences ─────────────────────
    const channelId = this.channelId
    const channelInfo = channelId
      ? await getChannelDirectory(channelId)
      : undefined
    const resolvedAppId = channelInfo?.appId ?? input.appId

    if (input.agent && createdNewSession) {
      await setSessionAgent(session.id, input.agent)
    }

    await ensureSessionPreferencesSnapshot({
      sessionId: session.id,
      channelId,
      appId: resolvedAppId,
      getClient,
      agentOverride: input.agent,
      modelOverride: input.model,
      force: createdNewSession,
    })

    const earlyAgentResult = await errore.tryAsync(() => {
      return resolveValidatedAgentPreference({
        agent: input.agent,
        sessionId: session.id,
        channelId,
        getClient,
      })
    })
    if (earlyAgentResult instanceof Error) {
      await sendThreadMessage(
        this.thread,
        `Failed to resolve agent: ${earlyAgentResult.message}`,
      )
      // Show indicator: dispatch failed mid-setup, next queued message was waiting.
      await this.tryDrainQueue({ showIndicator: true })
      return
    }
    const earlyAgentPreference = earlyAgentResult.agentPreference
    const earlyAvailableAgents = earlyAgentResult.agents

    const [earlyModelResult, preferredVariant] = await Promise.all([
      errore.tryAsync(async () => {
        if (input.model) {
          const [providerID, ...modelParts] = input.model.split('/')
          const modelID = modelParts.join('/')
          if (providerID && modelID) {
            return { providerID, modelID }
          }
        }
        const modelInfo = await getCurrentModelInfo({
          sessionId: session.id,
          channelId,
          appId: resolvedAppId,
          agentPreference: earlyAgentPreference,
          getClient,
        })
        if (modelInfo.type === 'none') {
          return undefined
        }
        return { providerID: modelInfo.providerID, modelID: modelInfo.modelID }
      }),
      getVariantCascade({
        sessionId: session.id,
        channelId,
        appId: resolvedAppId,
      }),
    ])
    if (earlyModelResult instanceof Error) {
      await sendThreadMessage(
        this.thread,
        `Failed to resolve model: ${earlyModelResult.message}`,
      )
      // Show indicator: dispatch failed mid-setup, next queued message was waiting.
      await this.tryDrainQueue({ showIndicator: true })
      return
    }
    const earlyModelParam = earlyModelResult
    if (!earlyModelParam) {
      await sendThreadMessage(
        this.thread,
        'No AI provider connected. Configure a provider in OpenCode with `/connect` command.',
      )
      // Show indicator: dispatch failed, next queued message was waiting.
      await this.tryDrainQueue({ showIndicator: true })
      return
    }

    // Set initial model info from early resolution
    this.updateRun((r) => ({
      ...r,
      model: earlyModelParam.modelID,
      providerID: earlyModelParam.providerID,
    }))

    // Resolve thinking variant
    const earlyThinkingValue = await (async (): Promise<string | undefined> => {
      if (!preferredVariant) {
        return undefined
      }
      const providersResponse = await errore.tryAsync(() => {
        return getClient().provider.list({ directory: this.sdkDirectory })
      })
      if (providersResponse instanceof Error || !providersResponse.data) {
        return undefined
      }
      const availableValues = getThinkingValuesForModel({
        providers: providersResponse.data.all,
        providerId: earlyModelParam.providerID,
        modelId: earlyModelParam.modelID,
      })
      if (availableValues.length === 0) {
        return undefined
      }
      return matchThinkingValue({
        requestedValue: preferredVariant,
        availableValues,
      }) || undefined
    })()

    // ── Create run controller ─────────────────────────────────
    const runController = new AbortController()
    threadState.setRunController(this.threadId, runController)

    // ── Start typing ──────────────────────────────────────────
    this.startTyping()

    // ── Build prompt parts ────────────────────────────────────
    const images = input.images || []
    const promptWithImagePaths = (() => {
      if (images.length === 0) {
        return input.prompt
      }
      const imageList = images
        .map((img) => {
          return `- ${img.sourceUrl || img.filename}`
        })
        .join('\n')
      return `${input.prompt}\n\n**The following images are already included in this message as inline content (do not use Read tool on these):**\n${imageList}`
    })()

    let syntheticContext = ''
    if (input.username) {
      syntheticContext += `<discord-user name="${input.username}" />`
    }
    const parts = [
      { type: 'text' as const, text: promptWithImagePaths },
      { type: 'text' as const, text: syntheticContext, synthetic: true },
      ...images,
    ]

    // ── Worktree info for system message ──────────────────────
    const worktreeInfo = await getThreadWorktree(this.thread.id)
    const worktree: WorktreeInfo | undefined =
      worktreeInfo?.status === 'ready' && worktreeInfo.worktree_directory
        ? {
            worktreeDirectory: worktreeInfo.worktree_directory,
            branch: worktreeInfo.worktree_name,
            mainRepoDirectory: worktreeInfo.project_directory,
          }
        : undefined

    const channelTopic = await (async () => {
      if (this.thread.parent?.type === ChannelType.GuildText) {
        return this.thread.parent.topic?.trim() || undefined
      }
      if (!channelId) {
        return undefined
      }
      const fetched = await errore.tryAsync(() => {
        return this.thread.guild.channels.fetch(channelId)
      })
      if (fetched instanceof Error || !fetched) {
        return undefined
      }
      if (fetched.type !== ChannelType.GuildText) {
        return undefined
      }
      return fetched.topic?.trim() || undefined
    })()

    // ── Run state: begin prompt cycle + baseline ──────────────
    threadState.updateRunState(this.threadId, pureBeginPromptCycle)

    const messagesBeforePromptResult = await errore.tryAsync(() => {
      return getClient().session.messages({
        sessionID: session.id,
        directory: this.sdkDirectory,
      })
    })
    if (!(messagesBeforePromptResult instanceof Error)) {
      const messagesBeforePrompt = messagesBeforePromptResult.data || []
      const baselineAssistantIds = new Set(
        messagesBeforePrompt
          .filter((message) => {
            return message.info.role === 'assistant'
          })
          .map((message) => {
            return message.info.id
          }),
      )
      threadState.updateRunState(this.threadId, (rs) => {
        return pureSetBaselineAssistantIds(rs, baselineAssistantIds)
      })
    }

    // ── Dispatch SDK call ─────────────────────────────────────
    threadState.updateRunState(this.threadId, pureMarkDispatching)

    const variantField = earlyThinkingValue
      ? { variant: earlyThinkingValue }
      : {}

    // SDK prompt/command calls return { data, error } instead of throwing.
    // The abort signal CAN throw (AbortError), which we catch separately.
    const sdkCall = input.command
      ? getClient().session.command(
          {
            sessionID: session.id,
            directory: this.sdkDirectory,
            command: input.command.name,
            arguments: input.command.arguments,
            agent: earlyAgentPreference,
            ...variantField,
          },
          { signal: runController.signal },
        )
      : getClient().session.prompt(
          {
            sessionID: session.id,
            directory: this.sdkDirectory,
            parts,
            system: getOpencodeSystemMessage({
              sessionId: session.id,
              channelId,
              guildId: this.thread.guildId,
              threadId: this.thread.id,
              worktree,
              channelTopic,
              username: input.username,
              userId: input.userId,
              agents: earlyAvailableAgents,
            }),
            model: earlyModelParam,
            agent: earlyAgentPreference,
            ...variantField,
          },
          { signal: runController.signal },
        )

    // Catch abort/network errors from the SDK call. The SDK itself returns
    // errors in { error } field, but AbortController throws on signal abort.
    const response = await sdkCall.catch(async (thrown: unknown) => {
      if (isAbortError(thrown)) {
        // Stop typing immediately — abortActiveRunInternal already calls
        // stopTyping() but this covers any code path where the SDK call
        // is aborted without going through abortActiveRunInternal.
        this.stopTyping()
        return undefined // aborted by user or new message
      }
      const errMsg =
        thrown instanceof Error ? thrown.message : String(thrown)
      const errObj =
        thrown instanceof Error ? thrown : new Error(errMsg)
      logger.error(`[DISPATCH] Prompt SDK call failed: ${errMsg}`)
      void notifyError(errObj, 'Failed to send prompt to OpenCode')
      threadState.updateRunState(this.threadId, pureMarkAborted)
      threadState.setRunController(this.threadId, undefined)
      threadState.setHasRunningTool(this.threadId, false)
      this.notifyStepFinished()
      this.stopTyping()
      await sendThreadMessage(
        this.thread,
        `✗ Unexpected bot Error: ${errMsg}`,
      )
      // Show indicator: SDK call failed, next queued message was waiting.
      await this.dispatchAction(() => {
        return this.tryDrainQueue({ showIndicator: true })
      })
      return undefined
    })

    if (!response) {
      return // aborted or errored (already handled)
    }
    if (response.error) {
      const err = response.error

      // SessionAbortError is expected when a new message interrupts an
      // active run — abortActiveRun sends session.abort which returns this.
      // Silently mark aborted and drain queue; don't show error to user.
      // response.error is a plain JSON object (not an Error instance), so
      // check the message field directly for abort indicators.
      const errMessage = err && typeof err === 'object' && 'message' in err
        ? String(err.message)
        : ''
      const isSessionAbort = errMessage.includes('aborted')
      if (isSessionAbort) {
        logger.log(
          `[DISPATCH] Session aborted (expected) sessionId=${session.id} runState=${this.formatRunStateForLog(this.state?.runState)} error=${JSON.stringify(err).slice(0, 200)}`,
        )
        threadState.updateRunState(this.threadId, pureMarkAborted)
        threadState.setRunController(this.threadId, undefined)
        threadState.setHasRunningTool(this.threadId, false)
        this.notifyStepFinished()
        this.stopTyping()
        // Don't drain the queue here — the caller that triggered the abort
        // handles draining: interrupt code (enqueueIncoming) drains without
        // the » indicator, and /abort drains via abortActiveRun with indicator.
        // Draining here raced with the interrupt's drain because this
        // dispatchAction ran during waitForAbortSettlement's await yield,
        // causing the » user: message indicator to show for interrupts.
        return
      }

      const errorMessage = (() => {
        if (err && typeof err === 'object') {
          if (
            'data' in err &&
            err.data &&
            typeof err.data === 'object' &&
            'message' in err.data
          ) {
            return String(err.data.message)
          }
          if (
            'errors' in err &&
            Array.isArray(err.errors) &&
            err.errors.length > 0
          ) {
            return JSON.stringify(err.errors)
          }
        }
        return JSON.stringify(err)
      })()
      const apiError = new Error(`OpenCode API error: ${errorMessage}`)
      logger.error(`[DISPATCH] ${apiError.message}`)
      void notifyError(apiError, 'OpenCode API error during prompt')
      threadState.updateRunState(this.threadId, pureMarkAborted)
      threadState.setRunController(this.threadId, undefined)
      threadState.setHasRunningTool(this.threadId, false)
      this.notifyStepFinished()
      this.stopTyping()
      await sendThreadMessage(this.thread, `✗ ${apiError.message}`)
      // Show indicator: API error, next queued message was waiting.
      await this.dispatchAction(() => {
        return this.tryDrainQueue({ showIndicator: true })
      })
      return
    }

    // ── Prompt resolved → consume deferred idle ───────────────
    const currentRunState = this.state?.runState
    if (currentRunState) {
      const result = pureMarkPromptResolvedAndConsumeDeferredIdle(
        currentRunState,
      )
      threadState.updateRunState(this.threadId, () => {
        return result.state
      })

      if (result.decision === 'process') {
        logger.log(
          `[SESSION IDLE] deferred=process sessionId=${session.id} runState=${this.formatRunStateForLog(result.state)}`,
        )
        // Run finishRun through action queue to serialize with events
        await this.dispatchAction(() => {
          return this.finishRun({ expectedRunId: dispatchRunId })
        })
      } else if (result.decision === 'ignore-no-evidence') {
        logger.log(
          `[SESSION IDLE] deferred=ignore-no-evidence sessionId=${session.id} runState=${this.formatRunStateForLog(result.state)}`,
        )
      } else if (result.decision === 'ignore-before-evidence') {
        logger.log(
          `[SESSION IDLE] deferred=ignore-before-evidence sessionId=${session.id} runState=${this.formatRunStateForLog(result.state)}`,
        )
      }
    }

    logger.log(`[DISPATCH] Successfully sent prompt for session ${session.id}`)
  }

  // ── Phase 3: Session Ensure ──────────────────────────────────
  // Creates or reuses the OpenCode session for this thread.

  private async ensureSession({
    prompt,
    agent,
    sessionStartScheduleKind,
    sessionStartScheduledTaskId,
  }: {
    prompt: string
    agent?: string
    sessionStartScheduleKind?: 'at' | 'cron'
    sessionStartScheduledTaskId?: number
  }): Promise<
    | Error
    | {
        session: { id: string }
        getClient: () => OpencodeClient
        createdNewSession: boolean
      }
  > {
    const directory = this.projectDirectory

    // Resolve worktree info for server initialization
    const worktreeInfo = await getThreadWorktree(this.thread.id)
    const worktreeDirectory =
      worktreeInfo?.status === 'ready' && worktreeInfo.worktree_directory
        ? worktreeInfo.worktree_directory
        : undefined
    const originalRepoDirectory = worktreeDirectory
      ? worktreeInfo?.project_directory
      : undefined

    const getClientResult = await initializeOpencodeForDirectory(directory, {
      originalRepoDirectory,
      channelId: this.channelId,
    })
    if (getClientResult instanceof Error) {
      return getClientResult
    }
    const getClient = getClientResult

    // Check thread state for existing session ID
    let sessionId = this.state?.sessionId
    if (!sessionId) {
      // Fallback to DB
      sessionId = await getThreadSession(this.thread.id) || undefined
    }

    let session: { id: string } | undefined
    let createdNewSession = false

    if (sessionId) {
      const sessionResponse = await errore.tryAsync(() => {
        return getClient().session.get({
          sessionID: sessionId,
          directory: this.sdkDirectory,
        })
      })
      if (!(sessionResponse instanceof Error) && sessionResponse.data) {
        session = sessionResponse.data
      }
    }

    if (!session) {
      const sessionTitle =
        prompt.length > 80 ? prompt.slice(0, 77) + '...' : prompt.slice(0, 80)
      const sessionResponse = await getClient().session.create({
        title: sessionTitle,
        directory: this.sdkDirectory,
      })
      session = sessionResponse.data
      createdNewSession = true
    }

    if (!session) {
      return new Error('Failed to create or get session')
    }

    // Store session in DB and thread state
    await setThreadSession(this.thread.id, session.id)
    threadState.setSessionId(this.threadId, session.id)

    // Store session start source for scheduled tasks
    if (createdNewSession && sessionStartScheduleKind) {
      await errore.tryAsync(() => {
        return setSessionStartSource({
          sessionId: session!.id,
          scheduleKind: sessionStartScheduleKind,
          scheduledTaskId: sessionStartScheduledTaskId,
        })
      })
    }

    // Store agent preference if provided
    if (agent && createdNewSession) {
      await setSessionAgent(session.id, agent)
    }

    return { session, getClient, createdNewSession }
  }

  // ── Phase 3: Run Finish + Footer ─────────────────────────────

  /**
   * Called when session.idle decision is 'process' — the run finished.
   * Marks finished, flushes parts, emits footer, drains queue.
   */
  private async finishRun({ expectedRunId }: { expectedRunId?: number } = {}): Promise<void> {
    if (typeof expectedRunId === 'number') {
      const activeRunId = this.run?.runId
      if (activeRunId !== expectedRunId) {
        logger.log(
          `[FINISH] Skip stale finish (expectedRunId=${expectedRunId}, activeRunId=${String(activeRunId)})`,
        )
        return
      }
    }

    // Guard against double-finish
    const currentPhase = this.state?.runState.phase
    if (currentPhase === 'finished' || currentPhase === 'aborted') {
      return
    }

    threadState.updateRunState(this.threadId, pureMarkFinished)
    this.stopTyping()

    // Flush remaining buffered parts
    if (this.currentAssistantMessageId) {
      await this.flushBufferedParts({
        messageID: this.currentAssistantMessageId,
        force: true,
      })
    }

    // Emit footer
    await this.emitFooter()

    // Clear run controller
    threadState.setRunController(this.threadId, undefined)

    // Reset per-run caches
    this.resetPerRunState()

    // Show indicator: previous run finished, any queued message has been
    // waiting for this run to complete — show which one is starting next.
    await this.tryDrainQueue({ showIndicator: true })
  }

  /**
   * Emit the run footer: duration, model, context%, project info.
   * Equivalent to session-handler.ts footer logic (lines 2232-2327).
   */
  private async emitFooter(): Promise<void> {
    const run = this.run
    const elapsedMs = Date.now() - (run?.dispatchStartTime ?? Date.now())
    const sessionDuration =
      elapsedMs < 1000
        ? '<1s'
        : prettyMilliseconds(elapsedMs, { secondsDecimalDigits: 0 })
    const modelInfo = run?.model ? ` ⋅ ${run.model}` : ''
    const agentInfo =
      run?.agent && run.agent.toLowerCase() !== 'build'
        ? ` ⋅ **${run.agent}**`
        : ''
    let contextInfo = ''
    const folderName = path.basename(this.sdkDirectory)

    const sessionId = this.state?.sessionId
    const client = getOpencodeClient(this.projectDirectory)

    // Run git branch, token fetch, and provider list in parallel
    const [branchResult, contextResult] = await Promise.all([
      errore.tryAsync(() => {
        return execAsync('git symbolic-ref --short HEAD', {
          cwd: this.sdkDirectory,
        })
      }),
      errore.tryAsync(async () => {
        if (!client || !sessionId) {
          return
        }
        let tokensUsed = run?.tokensUsed ?? 0
        // Fetch final token count from API
        const [messagesResult, providersResult] = await Promise.all([
          tokensUsed === 0
            ? errore.tryAsync(() => {
                return client.session.messages({
                  sessionID: sessionId,
                  directory: this.sdkDirectory,
                })
              })
            : null,
          errore.tryAsync(() => {
            return client.provider.list({
              directory: this.sdkDirectory,
            })
          }),
        ])

        if (messagesResult && !(messagesResult instanceof Error)) {
          const messages = messagesResult.data || []
          const lastAssistant = [...messages]
            .reverse()
            .find((m) => {
              if (m.info.role !== 'assistant') {
                return false
              }
              if (!('tokens' in m.info) || !m.info.tokens) {
                return false
              }
              return getTokenTotal(m.info.tokens) > 0
            })
          if (lastAssistant && 'tokens' in lastAssistant.info) {
            tokensUsed = getTokenTotal(lastAssistant.info.tokens)
            this.updateRun((r) => ({ ...r, tokensUsed }))
          }
        }

        if (providersResult && !(providersResult instanceof Error)) {
          const provider = providersResult.data?.all?.find((p) => {
            return p.id === run?.providerID
          })
          const model = provider?.models?.[run?.model || '']
          if (model?.limit?.context) {
            const percentage = Math.round(
              (tokensUsed / model.limit.context) * 100,
            )
            contextInfo = ` ⋅ ${percentage}%`
          }
        }
      }),
    ])
    const branchName =
      branchResult instanceof Error ? '' : branchResult.stdout.trim()
    if (contextResult instanceof Error) {
      logger.error(
        'Failed to fetch provider info for context percentage:',
        contextResult,
      )
    }

    const projectInfo = branchName
      ? `${folderName} ⋅ ${branchName} ⋅ `
      : `${folderName} ⋅ `
    await sendThreadMessage(
      this.thread,
      `*${projectInfo}${sessionDuration}${contextInfo}${modelInfo}${agentInfo}*`,
      { flags: NOTIFY_MESSAGE_FLAGS },
    )
    logger.log(
      `DURATION: Session completed in ${sessionDuration}, model ${run?.model}, tokens ${run?.tokensUsed ?? 0}`,
    )
  }

  /** Reset per-run state for the next prompt dispatch. */
  private resetPerRunState(): void {
    threadState.updateThread(this.threadId, (t) => ({
      ...t,
      currentRun: undefined,
      hasRunningTool: false,
    }))
    this.notifyStepFinished()
    this.modelContextLimit = undefined
    this.modelContextLimitKey = undefined
  }

  /**
   * Auto-reject all pending permissions for this thread.
   * Called when a new interrupting message arrives.
   */
  private async autoRejectPendingPermissions(): Promise<void> {
    const threadPermissions = pendingPermissions.get(this.thread.id)
    if (!threadPermissions || threadPermissions.size === 0) {
      return
    }

    const client = getOpencodeClient(this.projectDirectory)

    for (const [permId, pendingPerm] of threadPermissions) {
      logger.log(
        `[PERMISSION] Auto-rejecting permission ${permId} due to new message`,
      )
      // Remove buttons from Discord message
      const removeButtonsResult = await errore.tryAsync(async () => {
        const msg = await this.thread.messages.fetch(pendingPerm.messageId)
        await msg.edit({ components: [] })
      })
      if (removeButtonsResult instanceof Error) {
        logger.log(
          `[PERMISSION] Failed to remove buttons for ${permId}:`,
          removeButtonsResult,
        )
      }
      if (!client) {
        cleanupPermissionContext(pendingPerm.contextHash)
        continue
      }
      const rejectResult = await errore.tryAsync(() => {
        return client.permission.reply({
          requestID: permId,
          directory: pendingPerm.permissionDirectory,
          reply: 'reject',
        })
      })
      if (rejectResult instanceof Error) {
        logger.log(
          `[PERMISSION] Failed to auto-reject permission ${permId}:`,
          rejectResult,
        )
      }
      cleanupPermissionContext(pendingPerm.contextHash)
    }
    pendingPermissions.delete(this.thread.id)
  }

  // ── Phase 4: Retry last user prompt (for model-change flow) ──

  /**
   * Abort the active run and re-send the last user message with the
   * (now-updated) model preference. Used by /model and /unset-model.
   * Returns true if a retry was actually dispatched.
   */
  async retryLastUserPrompt(): Promise<boolean> {
    const state = this.state
    if (!state?.sessionId) {
      logger.log(`[RETRY] No session for thread ${this.threadId}`)
      return false
    }

    const sessionId = state.sessionId

    // 1. Abort active run
    let abortOutcome: AbortRunOutcome | undefined
    const abortResult = await errore.tryAsync(() => {
      return this.dispatchAction(async () => {
        abortOutcome = this.abortActiveRunInternal({
          reason: 'model-change',
          forceApiAbortWithoutRunController: true,
        })
      })
    })
    if (abortResult instanceof Error) {
      logger.error('[RETRY] Failed to abort active run before retry:', abortResult)
      return false
    }

    if (abortOutcome) {
      await this.waitForAbortSettlement(abortOutcome)
    }

    if (this.listenerAborted) {
      logger.log(`[RETRY] Runtime disposed before retry for thread ${this.threadId}`)
      return false
    }

    if (this.state?.sessionId !== sessionId) {
      logger.log(
        `[RETRY] Session changed before retry for thread ${this.threadId}`,
      )
      return false
    }

    // 2. Fetch last user message from API
    const client = getOpencodeClient(this.projectDirectory)
    if (!client) {
      logger.log(`[RETRY] No OpenCode client for ${this.projectDirectory}`)
      return false
    }

    logger.log(`[RETRY] Fetching last user message for session ${sessionId}`)
    const messagesResult = await errore.tryAsync(() => {
      return client.session.messages({
        sessionID: sessionId,
        directory: this.sdkDirectory,
      })
    })
    if (messagesResult instanceof Error) {
      logger.error(`[RETRY] Failed to fetch messages:`, messagesResult)
      return false
    }

    const messages = messagesResult.data || []
    const lastUserMessage = [...messages]
      .reverse()
      .find((m) => m.info.role === 'user')

    if (!lastUserMessage) {
      logger.log(`[RETRY] No user message found in session ${sessionId}`)
      return false
    }

    // Extract text and images from parts (skip synthetic parts like branch context)
    const textPart = lastUserMessage.parts.find(
      (p) => p.type === 'text' && !('synthetic' in p && p.synthetic),
    ) as { type: 'text'; text: string } | undefined
    const prompt = textPart?.text || ''
    const images = lastUserMessage.parts.filter(
      (p) => p.type === 'file',
    ) as DiscordFileAttachment[]

    logger.log(
      `[RETRY] Re-enqueuing last user prompt for session ${sessionId}`,
    )

    // 3. Enqueue the retry (non-interrupting since we already aborted)
    await this.enqueueIncoming({
      prompt,
      userId: '',
      username: '',
      images,
      appId: this.appId,
      interruptActive: false,
      expectedSessionId: sessionId,
    })

    if (this.state?.sessionId !== sessionId) {
      logger.log(
        `[RETRY] Session changed while retry was enqueued for thread ${this.threadId}`,
      )
      return false
    }

    return true
  }
}

// ── Module-level helpers ──────────────────────────────────────────

function buildPermissionDedupeKey({
  permission,
  directory,
}: {
  permission: PermissionRequest
  directory: string
}): string {
  const normalizedPatterns = [...permission.patterns].sort((a, b) => {
    return a.localeCompare(b)
  })
  return `${directory}::${permission.permission}::${normalizedPatterns.join('|')}`
}

/** Format a session error from event properties for display. */
function formatSessionErrorFromProps(error?: {
  name?: string
  data?: {
    message?: string
    statusCode?: number
    providerID?: string
    isRetryable?: boolean
    responseBody?: string
  }
}): string {
  if (!error) {
    return 'Unknown error'
  }
  const data = error.data
  if (!data) {
    return error.name || 'Unknown error'
  }
  const parts: string[] = []
  if (data.message) {
    parts.push(data.message)
  }
  if (data.statusCode) {
    parts.push(`(${data.statusCode})`)
  }
  if (data.providerID) {
    parts.push(`[${data.providerID}]`)
  }
  return parts.length > 0 ? parts.join(' ') : error.name || 'Unknown error'
}
