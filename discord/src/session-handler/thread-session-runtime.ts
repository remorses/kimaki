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
  pendingQuestionContexts,
} from '../commands/ask-question.js'
import {
  showActionButtons,
  waitForQueuedActionButtonsRequest,
} from '../commands/action-buttons.js'
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
import {
  appendOpencodeSessionEventLog,
  getOpencodeEventSessionId,
  isOpencodeSessionEventLogEnabled,
} from './opencode-session-event-log.js'
import {
  isSessionBusy,
  getLatestRunInfo,
  getRunStartTimeForIdle,
  isDerivedSubtaskSession,
  shouldEmitFooter,
} from './event-stream-state.js'

// Track multiple pending permissions per thread (keyed by permission ID).
// OpenCode handles blocking/sequencing — we just need to track all pending
// permissions to avoid duplicates and properly clean up on reply/teardown.
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
import { notifyError } from '../sentry.js'

const logger = createLogger(LogPrefix.SESSION)
const discordLogger = createLogger(LogPrefix.DISCORD)
const DETERMINISTIC_CONTEXT_LIMIT = 100_000
const shouldLogSessionEvents =
  process.env['KIMAKI_LOG_SESSION_EVENTS'] === '1' ||
  process.env['KIMAKI_VITEST'] === '1'

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
    'apply_patch',
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
  /**
   * `opencode` (default): send via session.promptAsync and let opencode
   * serialize pending user turns internally.
   * `local-queue`: keep in kimaki's local queue (used by /queue flows).
   */
  mode?: 'opencode' | 'local-queue'
  // Force a new assistant-part routing window by resetting run-state to
  // running before enqueue. Used by model-switch retry flows where old
  // assistant IDs can linger briefly after abort.
  resetAssistantForNewRun?: boolean
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

  // Typing indicator handle (single stateful mechanism).
  private typingInterval: ReturnType<typeof setInterval> | null = null

  // Notification throttles for retry/context notices.
  private lastDisplayedContextPercentage = 0
  private lastRateLimitDisplayTime = 0

  // Part output buffering (write-side cache, not domain state)
  private partBuffer = new Map<string, Map<string, Part>>()

  // Derivable cache (perf optimization for provider.list API call)
  private modelContextLimit: number | undefined
  private modelContextLimitKey: string | undefined

  // Bounded buffer of recent SSE events with timestamps.
  // Used by waitForEvent() to scan for specific events that arrived
  // after a given point in time (e.g. wait for session.idle after abort).
  // Generic: any future "wait for X event" can reuse this buffer.
  private static EVENT_BUFFER_MAX = 1000
  private eventBuffer: Array<{ event: OpenCodeEvent; timestamp: number }> = []

  // Serialized action queue for per-thread runtime transitions.
  // Ingress and event handling both flow through this queue to keep ordering
  // deterministic and avoid interleaving shared mutable structures.
  private actionQueue: Array<() => Promise<void>> = []
  private processingAction = false

  // Local-queue drain guards. These close the race window between local
  // dispatch acceptance and the first busy/idle lifecycle event.
  private localQueueDispatchInFlight = false
  private localQueueAwaitingSessionBusy = false

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

  getDerivedPhase(): 'idle' | 'running' {
    return this.isMainSessionBusy() ? 'running' : 'idle'
  }

  /** Whether the listener has been disposed. */
  private get listenerAborted(): boolean {
    return this.state?.listenerController?.signal.aborted ?? true
  }

  /** The listener AbortSignal, used to pass to SDK subscribe calls. */
  private get listenerSignal(): AbortSignal | undefined {
    return this.state?.listenerController?.signal
  }

  private nextAbortId(reason: string): string {
    return `${reason}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  }

  private formatRunStateForLog(): string {
    const sessionId = this.state?.sessionId
    if (!sessionId) {
      return 'none'
    }
    const latestAssistant = this.getLatestAssistantMessageIdForSession({
      sessionId,
    }) || 'none'
    const assistantCount = this.getAssistantMessageIdsForSession({
      sessionId,
    }).size
    const phase = this.getDerivedPhase()
    return `phase=${phase},assistant=${latestAssistant},assistantCount=${assistantCount}`
  }

  private isMainSessionBusy(): boolean {
    const sessionId = this.state?.sessionId
    if (!sessionId) {
      return false
    }
    return isSessionBusy({ events: this.eventBuffer, sessionId })
  }

  private getRunWindowStartIndexForSession({
    sessionId,
    upToIndex,
  }: {
    sessionId: string
    upToIndex?: number
  }): number {
    const end = upToIndex ?? this.eventBuffer.length
    for (let i = end - 1; i >= 0; i--) {
      const entry = this.eventBuffer[i]
      if (!entry) {
        continue
      }
      const event = entry.event
      const eventSessionId = getOpencodeEventSessionId(event)
      if (eventSessionId !== sessionId) {
        continue
      }
      if (event.type === 'session.idle') {
        return i + 1
      }
    }
    return 0
  }

  private getAssistantMessageIdsForSession({
    sessionId,
    upToIndex,
  }: {
    sessionId: string
    upToIndex?: number
  }): Set<string> {
    const end = upToIndex ?? this.eventBuffer.length
    const runWindowStart = this.getRunWindowStartIndexForSession({
      sessionId,
      upToIndex: end,
    })
    const assistantMessageIds = new Set<string>()
    for (let i = runWindowStart; i < end; i++) {
      const entry = this.eventBuffer[i]
      if (!entry) {
        continue
      }
      const event = entry.event
      if (event.type !== 'message.updated') {
        continue
      }
      const message = event.properties.info
      if (message.sessionID !== sessionId || message.role !== 'assistant') {
        continue
      }
      assistantMessageIds.add(message.id)
    }
    return assistantMessageIds
  }

  private getLatestAssistantMessageIdForSession({
    sessionId,
    upToIndex,
  }: {
    sessionId: string
    upToIndex?: number
  }): string | undefined {
    const end = upToIndex ?? this.eventBuffer.length
    const runWindowStart = this.getRunWindowStartIndexForSession({
      sessionId,
      upToIndex: end,
    })
    for (let i = end - 1; i >= runWindowStart; i--) {
      const entry = this.eventBuffer[i]
      if (!entry) {
        continue
      }
      const event = entry.event
      if (event.type !== 'message.updated') {
        continue
      }
      const message = event.properties.info
      if (message.sessionID !== sessionId || message.role !== 'assistant') {
        continue
      }
      return message.id
    }
    return undefined
  }

  private getSubtaskInfoForSession(
    candidateSessionId: string,
  ): { label: string; assistantMessageId?: string } | undefined {
    const mainSessionId = this.state?.sessionId
    if (!mainSessionId || candidateSessionId === mainSessionId) {
      return undefined
    }
    const derived = isDerivedSubtaskSession({
      events: this.eventBuffer,
      mainSessionId,
      candidateSessionId,
    })
    if (!derived) {
      return undefined
    }

    const label = `task-${candidateSessionId.slice(-4)}`
    const assistantMessageId = this.getLatestAssistantMessageIdForSession({
      sessionId: candidateSessionId,
    })
    return { label, assistantMessageId }
  }

  // ── Lifecycle ────────────────────────────────────────────────

  dispose(): void {
    this.state?.listenerController?.abort()
    // waitForEvent loops check listenerAborted and exit naturally.
    threadState.updateThread(this.threadId, (t) => ({
      ...t,
      listenerController: undefined,
    }))
    this.localQueueDispatchInFlight = false
    this.localQueueAwaitingSessionBusy = false
    this.stopTyping()
  }

  /**
   * Generic event waiter: polls the event buffer until a matching event
   * appears (with timestamp >= sinceTimestamp), or timeout/abort.
   *
   * Unlike the old idleWaiter (a promise wired into handleSessionIdle),
   * this has zero coupling to specific event handlers — it just scans
   * the buffer that handleEvent() fills. Works for any event type.
   */
  private async waitForEvent(opts: {
    predicate: (event: OpenCodeEvent) => boolean
    sinceTimestamp: number
    timeoutMs: number
    pollMs?: number
  }): Promise<OpenCodeEvent | undefined> {
    const { predicate, sinceTimestamp, timeoutMs, pollMs = 50 } = opts
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      if (this.listenerAborted) {
        return undefined
      }
      const match = this.eventBuffer.find((entry) => {
        return entry.timestamp >= sinceTimestamp && predicate(entry.event)
      })
      if (match) {
        return match.event
      }
      await delay(pollMs)
    }

    logger.warn(
      `[WAIT EVENT] Timeout after ${timeoutMs}ms for thread ${this.threadId}, proceeding`,
    )
    return undefined
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
    // Push into bounded event buffer for waitForEvent() consumers.
    this.eventBuffer.push({ event, timestamp: Date.now() })
    if (this.eventBuffer.length > ThreadSessionRuntime.EVENT_BUFFER_MAX) {
      this.eventBuffer.splice(0, this.eventBuffer.length - ThreadSessionRuntime.EVENT_BUFFER_MAX)
    }

    const sessionId = this.state?.sessionId

    const eventSessionId = getOpencodeEventSessionId(event)

    if (shouldLogSessionEvents) {
      const eventDetails = (() => {
        if (event.type === 'session.error') {
          const errorName = event.properties.error?.name || 'unknown'
          return ` error=${errorName}`
        }
        if (event.type === 'session.status') {
          const status = event.properties.status || 'unknown'
          return ` status=${status}`
        }
        if (event.type === 'message.updated') {
          return ` role=${event.properties.info.role} messageID=${event.properties.info.id}`
        }
        if (event.type === 'message.part.updated') {
          const partType = event.properties.part.type
          const partId = event.properties.part.id
          const messageId = event.properties.part.messageID
          const toolSuffix = partType === 'tool'
            ? ` tool=${event.properties.part.tool} status=${event.properties.part.state.status}`
            : ''
          return ` part=${partType} partID=${partId} messageID=${messageId}${toolSuffix}`
        }
        return ''
      })()
      logger.log(
        `[EVENT] type=${event.type} eventSessionId=${eventSessionId || 'none'} activeSessionId=${sessionId || 'none'} ${this.formatRunStateForLog()}${eventDetails}`,
      )
    }

    const isGlobalEvent = event.type === 'tui.toast.show'

    // Drop events that don't match current session (stale events from
    // previous sessions), unless it's a global event or a subtask session.
    if (!isGlobalEvent && eventSessionId && eventSessionId !== sessionId) {
      if (!this.getSubtaskInfoForSession(eventSessionId)) {
        return // stale event from previous session
      }
    }

    if (isOpencodeSessionEventLogEnabled()) {
      const derivedRunPhase = sessionId
        ? (this.isMainSessionBusy() ? 'running' : 'idle')
        : 'none'
      const derivedLatestAssistantMessageId = sessionId
        ? this.getLatestAssistantMessageIdForSession({ sessionId })
        : undefined
      const derivedAssistantMessageCount = sessionId
        ? this.getAssistantMessageIdsForSession({ sessionId }).size
        : 0
      const eventLogResult = await appendOpencodeSessionEventLog({
        threadId: this.threadId,
        projectDirectory: this.projectDirectory,
        sdkDirectory: this.sdkDirectory,
        activeSessionId: sessionId,
        eventSessionId,
        runPhase: derivedRunPhase,
        latestAssistantMessageId: derivedLatestAssistantMessageId,
        assistantMessageCount: derivedAssistantMessageCount,
        event,
      })
      if (eventLogResult instanceof Error) {
        logger.error(
          '[SESSION EVENT JSONL] Failed to write session event log:',
          eventLogResult,
        )
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
  // Serializes event handling + local-queue state mutations.

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

  private hasPendingInteractiveUi(): boolean {
    const hasPendingQuestion = [...pendingQuestionContexts.values()].some(
      (ctx) => {
        return ctx.thread.id === this.thread.id
      },
    )
    const hasPendingPermission =
      (pendingPermissions.get(this.thread.id)?.size ?? 0) > 0
    return hasPendingQuestion || hasPendingPermission
  }

  private shouldTypeNow(): boolean {
    if (this.listenerAborted) {
      return false
    }
    if (this.hasPendingInteractiveUi()) {
      return false
    }
    const sessionId = this.state?.sessionId
    if (!sessionId) {
      return false
    }
    return isSessionBusy({ events: this.eventBuffer, sessionId })
  }

  private sendTypingPulse(): void {
    void errore
      .tryAsync(() => {
        return this.thread.sendTyping()
      })
      .then((result) => {
        if (result instanceof Error) {
          discordLogger.log(`Failed to send typing: ${result}`)
        }
      })
  }

  private startTyping(): void {
    if (!this.shouldTypeNow()) {
      return
    }
    if (this.typingInterval) {
      return
    }
    this.sendTypingPulse()
    this.typingInterval = setInterval(() => {
      if (!this.shouldTypeNow()) {
        this.stopTyping()
        return
      }
      this.sendTypingPulse()
    }, 7000)
  }

  private stopTyping(): void {
    if (!this.typingInterval) {
      return
    }
    clearInterval(this.typingInterval)
    this.typingInterval = null
  }

  private reconcileTyping({
    sendImmediatePulse,
  }: {
    sendImmediatePulse: boolean
  }): void {
    if (!this.shouldTypeNow()) {
      this.stopTyping()
      return
    }
    this.startTyping()
    if (!sendImmediatePulse) {
      return
    }
    this.sendTypingPulse()
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

    const content = formatPart(part)
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

  private async flushBufferedPartsForMessages({
    messageIDs,
    force,
    skipPartId,
  }: {
    messageIDs: ReadonlyArray<string>
    force: boolean
    skipPartId?: string
  }): Promise<void> {
    const uniqueMessageIDs = [...new Set(messageIDs)]
    for (const messageID of uniqueMessageIDs) {
      await this.flushBufferedParts({
        messageID,
        force,
        skipPartId,
      })
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
    const sessionId = this.state?.sessionId
    const targetMessageId = (() => {
      if (flushMessageId) {
        return flushMessageId
      }
      if (!sessionId) {
        return undefined
      }
      return this.getLatestAssistantMessageIdForSession({ sessionId })
    })()
    if (targetMessageId) {
      await this.flushBufferedParts({
        messageID: targetMessageId,
        force: true,
        skipPartId,
      })
    } else {
      const assistantMessageIds = sessionId
        ? [...this.getAssistantMessageIdsForSession({ sessionId })]
        : []
      await this.flushBufferedPartsForMessages({
        messageIDs: assistantMessageIds,
        force: true,
        skipPartId,
      })
    }
    await show()
  }

  private async ensureModelContextLimit({
    providerID,
    modelID,
  }: {
    providerID: string
    modelID: string
  }): Promise<void> {
    const key = `${providerID}/${modelID}`
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
        return p.id === providerID
      },
    )
    const model = provider?.models?.[modelID]
    const contextLimit = model?.limit?.context || getFallbackContextLimit({
      providerID,
    })
    if (!contextLimit) {
      return
    }
    this.modelContextLimit = contextLimit
    this.modelContextLimitKey = key
  }

  // ── Event Handlers ──────────────────────────────────────────
  // Extracted from session-handler.ts eventHandler closure.
  // These operate on runtime instance state + global store transitions.

  private async handleMessageUpdated(msg: OpenCodeMessage): Promise<void> {
    const sessionId = this.state?.sessionId

    if (msg.sessionID !== sessionId) {
      return
    }
    if (msg.role !== 'assistant') {
      return
    }

    const knownMessage = this.partBuffer.has(msg.id)

    // promptAsync paths can deliver complete parts via message.updated even when
    // message.part.updated events are sparse or absent. Seed the part buffer
    // from message.parts when we have not seen per-part events for this message.
    if (!knownMessage) {
      const messageParts = (() => {
        const candidate: { parts?: unknown } = msg as { parts?: unknown }
        if (!Array.isArray(candidate.parts)) {
          return [] as Part[]
        }
        return candidate.parts.filter((part): part is Part => {
          if (!part || typeof part !== 'object') {
            return false
          }
          const maybePart = part as {
            id?: unknown
            type?: unknown
            messageID?: unknown
          }
          return (
            typeof maybePart.id === 'string' &&
            typeof maybePart.type === 'string' &&
            typeof maybePart.messageID === 'string'
          )
        })
      })()
      messageParts.forEach((part) => {
        this.storePart(part)
      })
    }

    await this.flushBufferedParts({
      messageID: msg.id,
      force: false,
    })

    // Context usage notice
    if (!sessionId) {
      return
    }
    const latestRunInfo = getLatestRunInfo({
      events: this.eventBuffer,
      sessionId,
    })
    if (
      latestRunInfo.tokensUsed === 0
      || !latestRunInfo.providerID
      || !latestRunInfo.model
    ) {
      return
    }
    await this.ensureModelContextLimit({
      providerID: latestRunInfo.providerID,
      modelID: latestRunInfo.model,
    })
    if (!this.modelContextLimit) {
      return
    }
    const currentPercentage = Math.floor(
      (latestRunInfo.tokensUsed / this.modelContextLimit) * 100,
    )
    const thresholdCrossed = Math.floor(currentPercentage / 10) * 10
    if (
      thresholdCrossed <= this.lastDisplayedContextPercentage ||
      thresholdCrossed < 10
    ) {
      return
    }
    this.lastDisplayedContextPercentage = thresholdCrossed
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

    const subtaskInfo = this.getSubtaskInfoForSession(part.sessionID)
    const isSubtaskEvent = Boolean(subtaskInfo)

    if (part.sessionID !== sessionId && !isSubtaskEvent) {
      return
    }

    if (isSubtaskEvent && subtaskInfo) {
      await this.handleSubtaskPart(part, subtaskInfo)
      return
    }

    await this.handleMainPart(part)
  }

  private async handleMainPart(part: Part): Promise<void> {
    if (part.type === 'step-start') {
      this.reconcileTyping({ sendImmediatePulse: true })
      return
    }

    if (part.type === 'tool' && part.state.status === 'running') {
      await this.flushBufferedParts({
        messageID: part.messageID,
        force: true,
        skipPartId: part.id,
      })
      await this.sendPartMessage(part)

      // Track task tool spawning subtask sessions
      if (part.tool === 'task' && !this.state?.sentPartIds.has(part.id)) {
        const description = (part.state.input?.description as string) || ''
        const agent = (part.state.input?.subagent_type as string) || 'task'
        const childSessionId = (part.state.metadata?.sessionId as string) || ''
        if (description && childSessionId) {
          if ((await this.getVerbosity()) !== 'text-only') {
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
        flushMessageId: part.messageID,
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
          const sessionId = this.state?.sessionId
          if (sessionId) {
            const latestRunInfo = getLatestRunInfo({
              events: this.eventBuffer,
              sessionId,
            })
            if (latestRunInfo.providerID && latestRunInfo.model) {
              await this.ensureModelContextLimit({
                providerID: latestRunInfo.providerID,
                modelID: latestRunInfo.model,
              })
            }
          }
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
      await this.flushBufferedParts({
        messageID: part.messageID,
        force: true,
      })
      this.reconcileTyping({ sendImmediatePulse: false })
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

    // ── Subtask idle ──────────────────────────────────────────
    const subtask = this.getSubtaskInfoForSession(idleSessionId)
    if (subtask) {
      logger.log(
        `[SUBTASK IDLE] Subtask "${subtask?.label}" completed`,
      )
      return
    }

    // ── Main session idle ─────────────────────────────────────
    // The event is also pushed into the event buffer by handleEvent(),
    // so waitForEvent() consumers (abort settlement) will see it too.
    if (idleSessionId === sessionId) {
      this.localQueueAwaitingSessionBusy = false
      const idleEventIndex = this.eventBuffer.length - 1

      // Suppress footer if the run was interrupted before completing.
      // Footer emission is derived from the current run window in the event
      // buffer (including interruption semantics) via shouldEmitFooter.
      const suppressFooter = !shouldEmitFooter({
        events: this.eventBuffer,
        sessionId: idleSessionId,
        idleEventIndex,
      })

      if (suppressFooter) {
        logger.log(
          `[SESSION IDLE] finishing run (no footer, unreplied user message) sessionId=${sessionId} ${this.formatRunStateForLog()}`,
        )
      } else {
        logger.log(
          `[SESSION IDLE] finishing run sessionId=${sessionId} ${this.formatRunStateForLog()}`,
        )
      }
      await this.finishRun({
        suppressFooter,
        idleEventIndex,
      })
      return
    }
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

    this.localQueueAwaitingSessionBusy = false

    // Skip abort errors — they are expected when operations are cancelled
    if (properties.error?.name === 'MessageAbortedError') {
      logger.log(
        `[SESSION ERROR] Operation aborted (expected) sessionId=${sessionId} ${this.formatRunStateForLog()}`,
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
    const subtaskInfo = this.getSubtaskInfoForSession(permission.sessionID)
    const isMainSession = permission.sessionID === sessionId
    const isSubtaskSession = Boolean(subtaskInfo)

    if (!isMainSession && !isSubtaskSession) {
      logger.log(
        `[PERMISSION IGNORED] Permission for unknown session (expected: ${sessionId} or subtask, got: ${permission.sessionID})`,
      )
      return
    }

    const subtaskLabel = subtaskInfo?.label

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
    const subtaskInfo = this.getSubtaskInfoForSession(properties.sessionID)
    const isMainSession = properties.sessionID === sessionId
    const isSubtaskSession = Boolean(subtaskInfo)

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

    if (properties.status.type === 'idle') {
      this.localQueueAwaitingSessionBusy = false
      this.reconcileTyping({ sendImmediatePulse: false })
      return
    }

    if (properties.status.type === 'busy') {
      this.localQueueAwaitingSessionBusy = false
      this.reconcileTyping({ sendImmediatePulse: true })
      return
    }

    if (properties.status.type !== 'retry') {
      return
    }

    // Throttle to once per 10 seconds
    const now = Date.now()
    if (now - this.lastRateLimitDisplayTime < 10_000) {
      return
    }
    this.lastRateLimitDisplayTime = now

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
   * Submit a user turn directly to opencode's internal session queue.
   * This is the default path for normal Discord messages.
   *
   * Mirrors dispatchPrompt's preference resolution, abort handling, and error
   * recovery so that promptAsync receives the same agent/model/variant/system
   * fields that the local-queue path provides.
   */
  private async submitViaOpencodeQueue(input: IngressInput): Promise<EnqueueResult> {
    let skippedBySessionGuard = false

    await this.dispatchAction(async () => {
      if (
        input.expectedSessionId &&
        this.state?.sessionId !== input.expectedSessionId
      ) {
        logger.log(
          `[ENQUEUE] Skipping stale promptAsync enqueue for thread ${this.threadId}: expected session ${input.expectedSessionId}, current session ${this.state?.sessionId || 'none'}`,
        )
        skippedBySessionGuard = true
        return
      }

      if (!this.listenerLoopRunning) {
        void this.startEventListener()
      }

      // Helper: stop typing and drain queued local messages on error.
      const cleanupOnError = async (errorMessage: string) => {
        this.stopTyping()
        await sendThreadMessage(this.thread, errorMessage)
        await this.tryDrainQueue({ showIndicator: true })
      }

      // ── Ensure session ──────────────────────────────────────
      const sessionResult = await this.ensureSession({
        prompt: input.prompt,
        agent: input.agent,
        sessionStartScheduleKind: input.sessionStartSource?.scheduleKind,
        sessionStartScheduledTaskId: input.sessionStartSource?.scheduledTaskId,
      })
      if (sessionResult instanceof Error) {
        await cleanupOnError(`✗ ${sessionResult.message}`)
        return
      }

      const { session, getClient, createdNewSession } = sessionResult

      // If listener startup happened before initializeOpencodeForDirectory(),
      // startEventListener may have exited early with "No OpenCode client".
      // Re-check after ensureSession so first promptAsync on a cold directory
      // still has an active SSE listener for message parts.
      if (!this.listenerLoopRunning) {
        void this.startEventListener()
      }

      // ── Resolve model + agent preferences (mirrors dispatchPrompt) ──
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

      const agentResult = await errore.tryAsync(() => {
        return resolveValidatedAgentPreference({
          agent: input.agent,
          sessionId: session.id,
          channelId,
          getClient,
        })
      })
      if (agentResult instanceof Error) {
        await cleanupOnError(`Failed to resolve agent: ${agentResult.message}`)
        return
      }
      const resolvedAgent = agentResult.agentPreference
      const availableAgents = agentResult.agents

      const [modelResult, preferredVariant] = await Promise.all([
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
            agentPreference: resolvedAgent,
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
      if (modelResult instanceof Error) {
        await cleanupOnError(`Failed to resolve model: ${modelResult.message}`)
        return
      }
      const modelField = modelResult
      if (!modelField) {
        await cleanupOnError(
          'No AI provider connected. Configure a provider in OpenCode with `/connect` command.',
        )
        return
      }

      // Resolve thinking variant
      const thinkingValue = await (async (): Promise<string | undefined> => {
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
          providerId: modelField.providerID,
          modelId: modelField.modelID,
        })
        if (availableValues.length === 0) {
          return undefined
        }
        return matchThinkingValue({
          requestedValue: preferredVariant,
          availableValues,
        }) || undefined
      })()

      const variantField = thinkingValue
        ? { variant: thinkingValue }
        : {}

      // ── Build prompt parts ──────────────────────────────────
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

      // ── Worktree + channel topic for system message ─────────
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

      const request = {
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
          agents: availableAgents,
        }),
        ...(resolvedAgent ? { agent: resolvedAgent } : {}),
        ...(modelField ? { model: modelField } : {}),
        ...variantField,
      }
      const promptResult = await errore.tryAsync(() => {
        return getClient().session.promptAsync(request)
      })
      if (promptResult instanceof Error || promptResult.error) {
        const errorMessage = (() => {
          if (promptResult instanceof Error) {
            return promptResult.message
          }
          const err = promptResult.error
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
          return 'Unknown OpenCode API error'
        })()
        const errObj = promptResult instanceof Error
          ? promptResult
          : new Error(errorMessage)
        void notifyError(errObj, 'promptAsync failed in submitViaOpencodeQueue')
        await cleanupOnError(`✗ OpenCode API error: ${errorMessage}`)
        return
      }

      logger.log(
        `[INGRESS] promptAsync accepted by opencode queue sessionId=${session.id} threadId=${this.threadId}`,
      )
    })

    if (skippedBySessionGuard) {
      return { queued: false }
    }
    return { queued: false }
  }

  /**
   * Enqueue in kimaki's local per-thread queue.
   * Used for explicit queue workflows (/queue, queueMessage=true).
   */
  private async enqueueViaLocalQueue(input: IngressInput): Promise<EnqueueResult> {
    const queuedMessage: QueuedMessage = {
      prompt: input.prompt,
      userId: input.userId,
      username: input.username,
      images: input.images,
      appId: input.appId,
      command: input.command,
      agent: input.agent,
      model: input.model,
      sessionStartScheduleKind: input.sessionStartSource?.scheduleKind,
      sessionStartScheduledTaskId: input.sessionStartSource?.scheduledTaskId,
    }

    let result: EnqueueResult = { queued: false }

    await this.dispatchAction(async () => {
      // Enqueue the message
      threadState.enqueueItem(this.threadId, queuedMessage)

      // Determine if the message is genuinely waiting in queue
      const stateAfterEnqueue = threadState.getThreadState(this.threadId)
      const position = stateAfterEnqueue?.queueItems.length ?? 0
      const willDrainNow = stateAfterEnqueue
        ? (
          stateAfterEnqueue.queueItems.length > 0
          && !threadState.hasBlockers(stateAfterEnqueue)
          && !this.localQueueDispatchInFlight
          && !this.localQueueAwaitingSessionBusy
          && !this.isMainSessionBusy()
        )
        : false
      result = !willDrainNow && position > 0
        ? { queued: true, position }
        : { queued: false }

      // Ensure listener is running
      if (!this.listenerLoopRunning) {
        void this.startEventListener()
      }

      await this.tryDrainQueue()
    })
    return result
  }

  /**
   * Ingress API for Discord handlers and commands.
   * Defaults to opencode queue mode; local queue mode is explicit.
   */
  async enqueueIncoming(input: IngressInput): Promise<EnqueueResult> {
    if (input.mode === 'local-queue') {
      return this.enqueueViaLocalQueue(input)
    }
    if (input.command) {
      // Commands keep using local queue so they still support /queue-command.
      return this.enqueueViaLocalQueue(input)
    }
    return this.submitViaOpencodeQueue(input)
  }

  /**
   * Abort the currently active run. Does NOT kill the listener.
   * Calls session.abort best-effort and lets event-stream idle settle the run.
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
  }: {
    reason: string
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

    const sessionId = state.sessionId
    const sessionIsBusy = this.isMainSessionBusy()

    logger.log(
      `[ABORT] id=${abortId} reason=${reason} threadId=${this.threadId} sessionId=${sessionId || 'none'} queueLength=${state.queueItems.length} ${this.formatRunStateForLog()} sessionBusy=${sessionIsBusy}`,
    )

    this.stopTyping()

    const apiAbortPromise = sessionId
      ? this.abortSessionViaApi({ abortId, reason, sessionId })
      : undefined

    logger.log(
      `[ABORT] id=${abortId} reason=${reason} threadId=${this.threadId} apiAbort=${Boolean(sessionId)} ${this.formatRunStateForLog()}`,
    )

    return {
      abortId,
      reason,
      apiAbortPromise,
    }
  }

  abortActiveRun(reason: string): void {
    const outcome = this.abortActiveRunInternal({
      reason,
    })
    if (outcome.apiAbortPromise) {
      void outcome.apiAbortPromise
    }
    // Drain local queued messages after explicit abort.
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
    if (!thread) {
      return
    }
    if (thread.queueItems.length === 0) {
      return
    }
    if (threadState.hasBlockers(thread)) {
      return
    }
    if (this.localQueueDispatchInFlight || this.localQueueAwaitingSessionBusy) {
      return
    }

    const sessionBusy = thread.sessionId
      ? isSessionBusy({ events: this.eventBuffer, sessionId: thread.sessionId })
      : false
    if (sessionBusy) {
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
    // the action queue while the SDK call is in-flight. Event-derived busy
    // gating prevents concurrent local-queue dispatches.
    this.localQueueDispatchInFlight = true
    void this.dispatchPrompt(next).catch(async (err) => {
      logger.error('[DISPATCH] Prompt dispatch failed:', err)
      void notifyError(err, 'Runtime prompt dispatch failed')
    }).finally(() => {
      this.localQueueDispatchInFlight = false
      void this.dispatchAction(() => {
        return this.tryDrainQueue({ showIndicator: true })
      })
    })
  }

  // ── Phase 3: Prompt Dispatch ─────────────────────────────────
  // Prompt dispatch: resolve session, build system message, send to OpenCode
  // (session-handler.ts lines 2384-2620). The listener is already running,
  // so this only handles session ensure + model/agent + SDK call + state.

  private async dispatchPrompt(input: QueuedMessage): Promise<void> {
    this.lastDisplayedContextPercentage = 0
    this.lastRateLimitDisplayTime = 0

    // ── Ensure session ────────────────────────────────────────
    const sessionResult = await this.ensureSession({
      prompt: input.prompt,
      agent: input.agent,
      sessionStartScheduleKind: input.sessionStartScheduleKind,
      sessionStartScheduledTaskId: input.sessionStartScheduledTaskId,
    })
    if (sessionResult instanceof Error) {
      this.stopTyping()
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
      this.stopTyping()
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
      this.stopTyping()
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
      this.stopTyping()
      await sendThreadMessage(
        this.thread,
        'No AI provider connected. Configure a provider in OpenCode with `/connect` command.',
      )
      // Show indicator: dispatch failed, next queued message was waiting.
      await this.tryDrainQueue({ showIndicator: true })
      return
    }

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

    await this.ensureModelContextLimit({
      providerID: earlyModelParam.providerID,
      modelID: earlyModelParam.modelID,
    })

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

    const variantField = earlyThinkingValue
      ? { variant: earlyThinkingValue }
      : {}

    const parseOpenCodeErrorMessage = (err: unknown): string => {
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
        if ('message' in err && typeof err.message === 'string') {
          return err.message
        }
      }
      return 'Unknown OpenCode API error'
    }

    if (input.command) {
      const queuedCommand = input.command
      const commandSignal = AbortSignal.timeout(30_000)
      const commandResponse = await errore.tryAsync(() => {
        return getClient().session.command(
          {
            sessionID: session.id,
            directory: this.sdkDirectory,
            command: queuedCommand.name,
            arguments: queuedCommand.arguments,
            agent: earlyAgentPreference,
            ...variantField,
          },
          { signal: commandSignal },
        )
      })

      if (commandResponse instanceof Error) {
        const timeoutReason = commandSignal.reason
        const timedOut =
          commandSignal.aborted &&
          timeoutReason instanceof Error &&
          timeoutReason.name === 'TimeoutError'
        if (timedOut) {
          logger.warn(
            `[DISPATCH] Command timed out after 30s sessionId=${session.id}`,
          )
          this.stopTyping()
          await sendThreadMessage(
            this.thread,
            '✗ Command timed out after 30 seconds. Try a shorter command or run it with /run-shell-command.',
          )
          await this.dispatchAction(() => {
            return this.tryDrainQueue({ showIndicator: true })
          })
          return
        }

        const commandErrorForAbortCheck: unknown = commandResponse
        if (isAbortError(commandErrorForAbortCheck)) {
          logger.log(
            `[DISPATCH] Command aborted (expected) sessionId=${session.id}`,
          )
          this.stopTyping()
          return
        }

        logger.error(
          `[DISPATCH] Command SDK call failed: ${commandResponse.message}`,
        )
        void notifyError(commandResponse, 'Failed to send command to OpenCode')
        this.stopTyping()
        await sendThreadMessage(
          this.thread,
          `✗ Unexpected bot Error: ${commandResponse.message}`,
        )
        await this.dispatchAction(() => {
          return this.tryDrainQueue({ showIndicator: true })
        })
        return
      }

      if (commandResponse.error) {
        const errorMessage = parseOpenCodeErrorMessage(commandResponse.error)
        if (errorMessage.includes('aborted')) {
          logger.log(
            `[DISPATCH] Command aborted (expected) sessionId=${session.id}`,
          )
          this.stopTyping()
          return
        }
        const apiError = new Error(`OpenCode API error: ${errorMessage}`)
        logger.error(`[DISPATCH] ${apiError.message}`)
        void notifyError(apiError, 'OpenCode API error during command')
        this.stopTyping()
        await sendThreadMessage(this.thread, `✗ ${apiError.message}`)
        await this.dispatchAction(() => {
          return this.tryDrainQueue({ showIndicator: true })
        })
        return
      }

      logger.log(`[DISPATCH] Successfully ran command for session ${session.id}`)
      return
    }

    const promptResponse = await errore.tryAsync(() => {
      return getClient().session.promptAsync({
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
      })
    })

    if (promptResponse instanceof Error || promptResponse.error) {
      const errorMessage = (() => {
        if (promptResponse instanceof Error) {
          return promptResponse.message
        }
        return parseOpenCodeErrorMessage(promptResponse.error)
      })()
      const errorObject = promptResponse instanceof Error
        ? promptResponse
        : new Error(errorMessage)
      logger.error(`[DISPATCH] Prompt API call failed: ${errorMessage}`)
      void notifyError(errorObject, 'OpenCode API error during local queue prompt')
      this.stopTyping()
      await sendThreadMessage(this.thread, `✗ OpenCode API error: ${errorMessage}`)
      await this.dispatchAction(() => {
        return this.tryDrainQueue({ showIndicator: true })
      })
      return
    }

    logger.log(
      `[DISPATCH] promptAsync accepted by opencode queue sessionId=${session.id} threadId=${this.threadId}`,
    )
    this.localQueueAwaitingSessionBusy = true
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
  private async finishRun({
    suppressFooter,
    idleEventIndex,
  }: {
    suppressFooter?: boolean
    idleEventIndex: number
  }): Promise<void> {
    const sessionId = this.state?.sessionId
    if (!sessionId) {
      return
    }

    const assistantMessageIds = [
      ...this.getAssistantMessageIdsForSession({
        sessionId,
        upToIndex: idleEventIndex,
      }),
    ]

    this.stopTyping()

    // Flush remaining buffered parts for all assistant messages observed during
    // this run. A single run can emit multiple assistant messages.
    await this.flushBufferedPartsForMessages({
      messageIDs: assistantMessageIds,
      force: true,
    })

    // Emit footer (skip when the run was interrupted with a pending user message)
    if (!suppressFooter) {
      const runStartTime = getRunStartTimeForIdle({
        events: this.eventBuffer,
        sessionId,
        idleEventIndex,
      })
      if (runStartTime !== undefined) {
        await this.emitFooter({ runStartTime })
      }
    }

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
  private async emitFooter({
    runStartTime,
  }: {
    runStartTime: number
  }): Promise<void> {
    const sessionId = this.state?.sessionId
    const runInfo = sessionId
      ? getLatestRunInfo({ events: this.eventBuffer, sessionId })
      : {
        model: undefined,
        providerID: undefined,
        agent: undefined,
        tokensUsed: 0,
      }
    const elapsedMs = Date.now() - runStartTime
    const sessionDuration =
      elapsedMs < 1000
        ? '<1s'
        : prettyMilliseconds(elapsedMs, { secondsDecimalDigits: 0 })
    const modelInfo = runInfo.model ? ` ⋅ ${runInfo.model}` : ''
    const agentInfo =
      runInfo.agent && runInfo.agent.toLowerCase() !== 'build'
        ? ` ⋅ **${runInfo.agent}**`
        : ''
    let contextInfo = ''
    const folderName = path.basename(this.sdkDirectory)

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
        let tokensUsed = runInfo.tokensUsed
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
          }
        }

        const fallbackLimit = runInfo.providerID
          ? getFallbackContextLimit({
              providerID: runInfo.providerID,
            })
          : undefined

        let contextLimit = fallbackLimit
        if (providersResult && !(providersResult instanceof Error)) {
          const provider = providersResult.data?.all?.find((p) => {
            return p.id === runInfo.providerID
          })
          const model = provider?.models?.[runInfo.model || '']
          contextLimit = model?.limit?.context || contextLimit
        }

        if (contextLimit) {
          const percentage = Math.round(
            (tokensUsed / contextLimit) * 100,
          )
          contextInfo = ` ⋅ ${percentage}%`
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
    this.stopTyping()
    await sendThreadMessage(
      this.thread,
      `*${projectInfo}${sessionDuration}${contextInfo}${modelInfo}${agentInfo}*`,
      { flags: NOTIFY_MESSAGE_FLAGS },
    )
    logger.log(
      `DURATION: Session completed in ${sessionDuration}, model ${runInfo.model}, tokens ${runInfo.tokensUsed}`,
    )
  }

  /** Reset per-run state for the next prompt dispatch. */
  private resetPerRunState(): void {
    this.modelContextLimit = undefined
    this.modelContextLimitKey = undefined
    this.lastDisplayedContextPercentage = 0
    this.lastRateLimitDisplayTime = 0
  }

  // ── Phase 4: Retry last user prompt (for model-change flow) ──

  /**
   * Abort the active run and immediately send an empty user prompt.
   *
   * Used by /model and /unset-model so opencode can restart from the
   * current session history with the updated model preference, without
   * replaying/fetching the last user message in kimaki.
   */
  async retryLastUserPrompt(): Promise<boolean> {
    const state = this.state
    if (!state?.sessionId) {
      logger.log(`[RETRY] No session for thread ${this.threadId}`)
      return false
    }

    const sessionId = state.sessionId

    // 1. Abort active run.
    let needsIdleWait = false
    const waitSinceTimestamp = Date.now()
    const abortResult = await errore.tryAsync(() => {
      return this.dispatchAction(async () => {
        needsIdleWait = this.isMainSessionBusy()
        const outcome = this.abortActiveRunInternal({
          reason: 'model-change',
        })
        if (outcome.apiAbortPromise) {
          void outcome.apiAbortPromise
        }
      })
    })
    if (abortResult instanceof Error) {
      logger.error('[RETRY] Failed to abort active run before retry:', abortResult)
      return false
    }

    if (needsIdleWait) {
      await this.waitForEvent({
        predicate: (event) => {
          return event.type === 'session.idle'
            && (event.properties as { sessionID?: string }).sessionID === sessionId
        },
        sinceTimestamp: waitSinceTimestamp,
        timeoutMs: 2000,
      })
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

    logger.log(
      `[RETRY] Re-submitting with empty prompt for session ${sessionId}`,
    )

    // 2. Re-submit with empty prompt so opencode continues from session history.
    await this.enqueueIncoming({
      prompt: '',
      userId: '',
      username: '',
      appId: this.appId,
      mode: 'opencode',
      resetAssistantForNewRun: true,
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

function getFallbackContextLimit({
  providerID,
}: {
  providerID: string
}): number | undefined {
  if (providerID === 'deterministic-provider') {
    return DETERMINISTIC_CONTEXT_LIMIT
  }
  return undefined
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
