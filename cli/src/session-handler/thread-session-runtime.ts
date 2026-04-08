// ThreadSessionRuntime — one per active thread.
// Owns resource handles (listener controller, typing timers, part buffer).
// Delegates all state to the global store via thread-runtime-state.ts transitions.
//
// This is the sole session orchestrator. Discord handlers and slash commands
// call runtime APIs (enqueueIncoming, abortActiveRun, etc.) without inspecting
// run internals.

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
  buildSessionPermissions,
  parsePermissionRules,
  subscribeOpencodeServerLifecycle,
  writeInjectionGuardConfig,
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
  setSessionAgent,
  getVariantCascade,
  setSessionStartSource,
  appendSessionEventsSinceLastTimestamp,
  getSessionEventSnapshot,
} from '../database.js'
import {
  showPermissionButtons,
  cleanupPermissionContext,
  addPermissionRequestToContext,
  arePatternsCoveredBy,
  pendingPermissionContexts,
} from '../commands/permissions.js'
import {
  showAskUserQuestionDropdowns,
  pendingQuestionContexts,
  cancelPendingQuestion,
} from '../commands/ask-question.js'
import {
  showActionButtons,
  waitForQueuedActionButtonsRequest,
  pendingActionButtonContexts,
  cancelPendingActionButtons,
} from '../commands/action-buttons.js'
import {
  pendingFileUploadContexts,
  cancelPendingFileUpload,
} from '../commands/file-upload.js'
import {
  getCurrentModelInfo,
  ensureSessionPreferencesSnapshot,
} from '../commands/model.js'
import {
  getOpencodePromptContext,
  getOpencodeSystemMessage,
  type AgentInfo,
  type RepliedMessageContext,
  type WorktreeInfo,
} from '../system-message.js'
import { resolveValidatedAgentPreference } from './agent-utils.js'
import {
  appendOpencodeSessionEventLog,
  getOpencodeEventSessionId,
  isOpencodeSessionEventLogEnabled,
} from './opencode-session-event-log.js'
import {
  doesLatestUserTurnHaveNaturalCompletion,
  getAssistantMessageIdsForLatestUserTurn,
  getCurrentTurnStartTime,
  isSessionBusy,
  getLatestRunInfo,
  getDerivedSubtaskIndex,
  getDerivedSubtaskAgentType,
  getLatestAssistantMessageIdForLatestUserTurn,
  hasAssistantMessageCompletedBefore,
  isAssistantMessageInLatestUserTurn,
  isAssistantMessageNaturalCompletion,
  type EventBufferEntry,
} from './event-stream-state.js'

// Track multiple pending permissions per thread (keyed by permission ID).
// OpenCode handles blocking/sequencing — we just need to track all pending
// permissions to avoid duplicates and properly clean up on reply/teardown.
// The runtime is the sole owner of pending permissions per thread.
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
import { execAsync } from '../worktrees.js'

import { notifyError } from '../sentry.js'
import { createDebouncedProcessFlush } from '../debounced-process-flush.js'
import { cancelHtmlActionsForThread } from '../html-actions.js'
import { createDebouncedTimeout } from '../debounce-timeout.js'
import { extractLeadingOpencodeCommand } from '../opencode-command-detection.js'

const logger = createLogger(LogPrefix.SESSION)
const discordLogger = createLogger(LogPrefix.DISCORD)
const DETERMINISTIC_CONTEXT_LIMIT = 100_000
const TOAST_SESSION_ID_REGEX = /\b(ses_[A-Za-z0-9]+)\b\s*$/u

function extractToastSessionId({ message }: { message: string }): string | undefined {
  const match = message.match(TOAST_SESSION_ID_REGEX)
  return match?.[1]
}

function stripToastSessionId({ message }: { message: string }): string {
  return message.replace(TOAST_SESSION_ID_REGEX, '').trimEnd()
}

const shouldLogSessionEvents =
  process.env['KIMAKI_LOG_SESSION_EVENTS'] === '1' ||
  process.env['KIMAKI_VITEST'] === '1'

// ── Registry ─────────────────────────────────────────────────────
// Runtime instances are kept in a plain Map (not Zustand — the Map
// is not reactive state, just a lookup for resource handles).

const runtimes = new Map<string, ThreadSessionRuntime>()

subscribeOpencodeServerLifecycle((event) => {
  if (event.type !== 'started') {
    return
  }
  for (const runtime of runtimes.values()) {
    runtime.handleSharedServerStarted({ port: event.port })
  }
})

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
      existing.handleDirectoryChanged({
        oldDirectory: existing.sdkDirectory,
        newDirectory: opts.sdkDirectory,
      })
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

export function disposeInactiveRuntimes({
  idleMs,
  nowMs = Date.now(),
}: {
  idleMs: number
  nowMs?: number
}): {
  disposedThreadIds: string[]
  disposedDirectories: string[]
} {
  const candidates = [...runtimes.entries()].filter(([, runtime]) => {
    return runtime.isIdleForInactivityTimeout({ idleMs, nowMs })
  })
  const disposedDirectories = new Set<string>()
  const disposedThreadIds: string[] = []

  for (const [threadId, runtime] of candidates) {
    runtime.dispose()
    runtimes.delete(threadId)
    threadState.removeThread(threadId)
    disposedThreadIds.push(threadId)
    disposedDirectories.add(runtime.projectDirectory)
  }

  return {
    disposedThreadIds,
    disposedDirectories: [...disposedDirectories],
  }
}

// ── Pending UI cleanup ───────────────────────────────────────────
// Clears all pending interactive UI state for a thread on dispose/delete.
// Uses existing cancel functions which handle upstream replies (so OpenCode
// doesn't hang waiting for answers that will never come).

function cleanupPendingUiForThread(threadId: string): void {
  // Permissions: reject each pending permission so OpenCode doesn't hang,
  // then delete the per-thread tracking map.
  const threadPerms = pendingPermissions.get(threadId)
  if (threadPerms) {
    for (const [, entry] of threadPerms) {
      const ctx = pendingPermissionContexts.get(entry.contextHash)
      if (ctx) {
        const client = getOpencodeClient(ctx.directory)
        if (client) {
          const requestIds: string[] = ctx.requestIds.length > 0
            ? ctx.requestIds
            : [ctx.permission.id]
          void Promise.all(
            requestIds.map((requestId) => {
              return client.permission.reply({
                requestID: requestId,
                directory: ctx.permissionDirectory,
                reply: 'reject',
              })
            }),
          ).catch(() => {})
        }
        pendingPermissionContexts.delete(entry.contextHash)
      }
    }
    pendingPermissions.delete(threadId)
  }

  // Questions: cancel deletes pending context without replying to OpenCode.
  void cancelPendingQuestion(threadId)

  // Action buttons: resolves context and clears timer.
  cancelPendingActionButtons(threadId)

  // File uploads: resolves with empty files so OpenCode unblocks.
  void cancelPendingFileUpload(threadId)

  // HTML actions: clears registered action callbacks for this thread.
  cancelHtmlActionsForThread(threadId)
}

// ── Helpers ──────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function getTimestampFromSnowflake(snowflake: string): number | undefined {
  const discordEpochMs = 1_420_070_400_000n
  const snowflakeIdResult = errore.try({
    try: () => {
      return BigInt(snowflake)
    },
    catch: () => {
      return new Error('Invalid Discord snowflake')
    },
  })
  if (snowflakeIdResult instanceof Error) {
    return undefined
  }
  const timestampBigInt = (snowflakeIdResult >> 22n) + discordEpochMs
  const timestampMs = Number(timestampBigInt)
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    return undefined
  }
  return timestampMs
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
export function isEssentialToolName(toolName: string): boolean {
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

export function isEssentialToolPart(part: Part): boolean {
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

// ── Thread title derivation ──────────────────────────────────────

const DISCORD_THREAD_NAME_MAX = 100
const WORKTREE_THREAD_PREFIX = '⬦ '

// Pure derivation: given an OpenCode session title and the current thread name,
// return the new thread name to apply, or undefined when no rename is needed.
// - Skips placeholder titles ("New Session - ...") to match external-sync.
// - Preserves worktree prefix when the current name carries it.
// - Returns undefined when the candidate matches currentName already.
export function deriveThreadNameFromSessionTitle({
  sessionTitle,
  currentName,
}: {
  sessionTitle: string | undefined | null
  currentName: string
}): string | undefined {
  const trimmed = sessionTitle?.trim()
  if (!trimmed) {
    return undefined
  }
  if (/^new session\s*-/i.test(trimmed)) {
    return undefined
  }
  const hasWorktreePrefix = currentName.startsWith(WORKTREE_THREAD_PREFIX)
  const prefix = hasWorktreePrefix ? WORKTREE_THREAD_PREFIX : ''
  const candidate = `${prefix}${trimmed}`.slice(0, DISCORD_THREAD_NAME_MAX)
  if (candidate === currentName) {
    return undefined
  }
  return candidate
}

// ── Ingress input type ───────────────────────────────────────────

export type EnqueueResult = {
  /** True if the message is waiting in queue behind an active run. */
  queued: boolean
  /** Queue position (1-based). Only set when queued is true. */
  position?: number
}

/**
 * Result of the preprocess callback. Returns the resolved prompt, images,
 * and mode after expensive async work (voice transcription, context fetch,
 * attachment download) completes.
 */
export type PreprocessResult = {
  prompt: string
  images?: DiscordFileAttachment[]
  repliedMessage?: RepliedMessageContext
  /** Resolved mode based on voice transcription result. */
  mode: 'opencode' | 'local-queue'
  /** When true, preprocessing determined the message should be silently dropped. */
  skip?: boolean
  /** Agent name extracted from voice transcription. Applied to the session if set. */
  agent?: string
}

export type IngressInput = {
  prompt: string
  userId: string
  username: string
  // Discord message ID and thread ID for the source message, embedded in
  // <discord-user> synthetic context so the external sync loop can detect
  // messages that originated from Discord and skip re-mirroring them.
  sourceMessageId?: string
  sourceThreadId?: string
  repliedMessage?: RepliedMessageContext
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
  /**
   * Raw permission rule strings from --permission flag ("tool:action" or
   * "tool:pattern:action"). Parsed into PermissionRuleset entries by
   * parsePermissionRules() and appended after buildSessionPermissions()
   * so they win via opencode's findLast() evaluation. Only used on
   * session creation (first dispatch).
   */
  permissions?: string[]
  injectionGuardPatterns?: string[]
  sessionStartSource?: { scheduleKind: 'at' | 'cron'; scheduledTaskId?: number }
  /** Optional guard for retries: skip enqueue when session has changed. */
  expectedSessionId?: string
  /**
   * Lazy preprocessing callback. When set, the runtime serializes it via a
   * lightweight promise chain (preprocessChain) to resolve prompt/images/mode
   * from the raw Discord message. This replaces the threadIngressQueue in
   * discord-bot.ts: expensive async work (voice transcription, context fetch,
   * attachment download) runs in arrival order but outside dispatchAction,
   * so SSE event handling and permission UI are not blocked.
   *
   * The closure captures Discord objects (Message, ThreadChannel) so the
   * runtime stays platform-agnostic — it just awaits the callback.
   */
  preprocess?: () => Promise<PreprocessResult>
}

// Rewrite `{ prompt: "/build foo" }` → `{ prompt: "", command: { name, arguments }, mode: "local-queue" }`
// when the prompt's leading token matches a registered opencode command.
// Skip if a command is already set or there's no prompt to inspect.
function maybeConvertLeadingCommand(input: IngressInput): IngressInput {
  if (input.command) return input
  if (!input.prompt) return input
  const extracted = extractLeadingOpencodeCommand(input.prompt)
  if (!extracted) return input
  return {
    ...input,
    prompt: '',
    command: extracted.command,
    mode: 'local-queue',
  }
}

type AbortRunOutcome = {
  abortId: string
  reason: string
  apiAbortPromise: Promise<void> | undefined
}

function getWorktreePromptKey(worktree: WorktreeInfo | undefined): string | null {
  if (!worktree) {
    return null
  }
  return [
    worktree.worktreeDirectory,
    worktree.branch,
    worktree.mainRepoDirectory,
  ].join('::')
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

  // Set to true by dispose(). Guards against queued work running after cleanup
  // and lets dispatchAction/startEventListener bail out early.
  private disposed = false

  // Typing indicator scheduler handles.
  // `typingKeepaliveTimeout` is the 7s keepalive loop while a run stays busy.
  // `typingRepulseDebounce` collapses clustered immediate re-pulses after bot
  // messages into one last pulse, because Discord hides typing on the next bot
  // message and showing multiple back-to-back POSTs is wasteful.
  private typingKeepaliveTimeout: ReturnType<typeof setTimeout> | null = null
  private readonly typingRepulseDebounce: ReturnType<typeof createDebouncedTimeout>

  private static TYPING_REPULSE_DEBOUNCE_MS = 500

  // Notification throttles for retry/context notices.
  private lastDisplayedContextPercentage = 0
  private lastRateLimitDisplayTime = 0

  // Last OpenCode-generated session title we successfully applied to the
  // Discord thread name. Used to dedupe repeated session.updated events so
  // we only call thread.setName() once per distinct title. Discord rate-limits
  // channel/thread renames to ~2 per 10 minutes per thread, so we must avoid
  // retrying. Not persisted — worst case on restart we re-apply the same title
  // once (which is a no-op via deriveThreadNameFromSessionTitle).
  private appliedOpencodeTitle: string | undefined

  // Part output buffering (write-side cache, not domain state)
  private partBuffer = new Map<string, Map<string, Part>>()

  // Derivable cache (perf optimization for provider.list API call)
  private modelContextLimit: number | undefined
  private modelContextLimitKey: string | undefined
  private lastPromptWorktreeKey: string | null | undefined

  // Bounded buffer of recent SSE events with timestamps.
  // Used by waitForEvent() to scan for specific events that arrived
  // after a given point in time (e.g. wait for session.idle after abort).
  // Generic: any future "wait for X event" can reuse this buffer.
  private static EVENT_BUFFER_MAX = 1000
  private static EVENT_BUFFER_DB_FLUSH_MS = 2_000
  private static EVENT_BUFFER_TEXT_MAX_CHARS = 512
  private eventBuffer: EventBufferEntry[] = []
  private nextEventIndex = 0
  private persistEventBufferDebounced: ReturnType<
    typeof createDebouncedProcessFlush
  >

  // Serialized action queue for per-thread runtime transitions.
  // Ingress and event handling both flow through this queue to keep ordering
  // deterministic and avoid interleaving shared mutable structures.
  private actionQueue: Array<() => Promise<void>> = []
  private processingAction = false

  // Lightweight promise chain for serializing preprocess callbacks.
  // Runs OUTSIDE dispatchAction so heavy work (voice transcription, context
  // fetch, attachment download) doesn't block SSE event handling, permission
  // UI, or queue drain. Only preprocess ordering is serialized here; the
  // resolved input is then routed through the normal enqueue paths which
  // use dispatchAction internally.
  private preprocessChain: Promise<void> = Promise.resolve()

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
    this.persistEventBufferDebounced = createDebouncedProcessFlush({
      waitMs: ThreadSessionRuntime.EVENT_BUFFER_DB_FLUSH_MS,
      callback: async () => {
        await this.persistSessionEventsToDatabase()
      },
      onError: (error) => {
        logger.error(
          `[SESSION EVENT DB] Debounced persistence failed for thread ${this.threadId}:`,
          error,
        )
      },
    })
    this.typingRepulseDebounce = createDebouncedTimeout({
      delayMs: ThreadSessionRuntime.TYPING_REPULSE_DEBOUNCE_MS,
      callback: () => {
        if (!this.shouldTypeNow()) {
          return
        }
        this.restartTypingKeepalive({ sendNow: true })
      },
    })
  }

  private consumeWorktreePromptChange(
    worktree: WorktreeInfo | undefined,
  ): boolean {
    const nextKey = getWorktreePromptKey(worktree)
    const changed = this.lastPromptWorktreeKey !== nextKey
    this.lastPromptWorktreeKey = nextKey
    return changed
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

  private getLastRuntimeActivityTimestamp({
    nowMs: _nowMs,
  }: {
    nowMs: number
  }): number {
    const lastEvent = this.eventBuffer[this.eventBuffer.length - 1]
    const lastEventTimestamp = lastEvent?.timestamp
    if (typeof lastEventTimestamp === 'number' && Number.isFinite(lastEventTimestamp)) {
      return lastEventTimestamp
    }
    const threadCreatedTimestamp = this.thread.createdTimestamp
    if (
      typeof threadCreatedTimestamp === 'number'
      && Number.isFinite(threadCreatedTimestamp)
      && threadCreatedTimestamp > 0
    ) {
      return threadCreatedTimestamp
    }
    const snowflakeTimestamp = getTimestampFromSnowflake(this.thread.id)
    if (snowflakeTimestamp) {
      return snowflakeTimestamp
    }
    return 0
  }

  private isIdleCandidateForInactivityCheck(): boolean {
    if (this.isMainSessionBusy()) {
      return false
    }
    if ((this.state?.queueItems.length ?? 0) > 0) {
      return false
    }
    if (this.hasPendingInteractiveUi()) {
      return false
    }
    if (this.processingAction || this.actionQueue.length > 0) {
      return false
    }
    return true
  }

  getInactivitySnapshot({
    nowMs,
  }: {
    nowMs: number
  }): {
    idleCandidate: boolean
    inactiveForMs: number
  } {
    const lastActivityTimestamp = this.getLastRuntimeActivityTimestamp({ nowMs })
    return {
      idleCandidate: this.isIdleCandidateForInactivityCheck(),
      inactiveForMs: Math.max(0, nowMs - lastActivityTimestamp),
    }
  }

  isIdleForInactivityTimeout({
    idleMs,
    nowMs,
  }: {
    idleMs: number
    nowMs: number
  }): boolean {
    const snapshot = this.getInactivitySnapshot({ nowMs })
    if (!snapshot.idleCandidate) {
      return false
    }
    return snapshot.inactiveForMs >= idleMs
  }

  private async hydrateSessionEventsFromDatabase({
    sessionId,
  }: {
    sessionId: string
  }): Promise<void> {
    if (this.eventBuffer.length > 0) {
      return
    }

    const rows = await getSessionEventSnapshot({ sessionId })
    if (rows.length === 0) {
      return
    }

    const hydratedEvents: EventBufferEntry[] = rows.flatMap((row) => {
      const eventResult = errore.try({
        try: () => {
          return JSON.parse(row.event_json) as OpenCodeEvent
        },
        catch: (error) => {
          return new Error('Failed to parse persisted session event JSON', {
            cause: error,
          })
        },
      })
      if (eventResult instanceof Error) {
        logger.warn(
          `[SESSION EVENT DB] Skipping invalid persisted event row for session ${sessionId}: ${eventResult.message}`,
        )
        return []
      }
      return [
        {
          event: eventResult,
          timestamp: Number(row.timestamp),
          eventIndex: Number(row.event_index),
        },
      ]
    })

    this.eventBuffer = hydratedEvents.slice(-ThreadSessionRuntime.EVENT_BUFFER_MAX)
    const lastHydratedEvent = this.eventBuffer[this.eventBuffer.length - 1]
    this.nextEventIndex = lastHydratedEvent
      ? Number(lastHydratedEvent.eventIndex || 0) + 1
      : 0
    logger.log(
      `[SESSION EVENT DB] Hydrated ${this.eventBuffer.length} events for session ${sessionId}`,
    )
  }

  private async persistSessionEventsToDatabase(): Promise<void> {
    const sessionId = this.state?.sessionId
    if (!sessionId) {
      return
    }

    const events = this.eventBuffer.flatMap((entry) => {
      const eventSessionId = getOpencodeEventSessionId(entry.event)
      if (eventSessionId !== sessionId) {
        return []
      }
      return [
        {
          session_id: sessionId,
          thread_id: this.threadId,
          timestamp: BigInt(entry.timestamp),
          event_index: entry.eventIndex || 0,
          event_json: JSON.stringify(entry.event),
        },
      ]
    })

    await appendSessionEventsSinceLastTimestamp({
      sessionId,
      events,
    })
  }

  private nextAbortId(reason: string): string {
    return `${reason}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  }

  private formatRunStateForLog(): string {
    const sessionId = this.state?.sessionId
    if (!sessionId) {
      return 'none'
    }
    const latestAssistant = this.getLatestAssistantMessageIdForCurrentTurn({
      sessionId,
    }) || 'none'
    const assistantCount = this.getAssistantMessageIdsForCurrentTurn({
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

  private getAssistantMessageIdsForCurrentTurn({
    sessionId,
    upToIndex,
  }: {
    sessionId: string
    upToIndex?: number
  }): Set<string> {
    const normalizedIndex = upToIndex === undefined ? undefined : upToIndex - 1
    return getAssistantMessageIdsForLatestUserTurn({
      events: this.eventBuffer,
      sessionId,
      upToIndex: normalizedIndex,
    })
  }

  private getLatestAssistantMessageIdForCurrentTurn({
    sessionId,
    upToIndex,
  }: {
    sessionId: string
    upToIndex?: number
  }): string | undefined {
    const normalizedIndex = upToIndex === undefined ? undefined : upToIndex - 1
    return getLatestAssistantMessageIdForLatestUserTurn({
      events: this.eventBuffer,
      sessionId,
      upToIndex: normalizedIndex,
    })
  }

  private getSubtaskInfoForSession(
    candidateSessionId: string,
  ): { label: string; assistantMessageId?: string } | undefined {
    const mainSessionId = this.state?.sessionId
    if (!mainSessionId || candidateSessionId === mainSessionId) {
      return undefined
    }
    const subtaskIndex = getDerivedSubtaskIndex({
      events: this.eventBuffer,
      mainSessionId,
      candidateSessionId,
    })
    if (!subtaskIndex) {
      return undefined
    }

    const agentType = getDerivedSubtaskAgentType({
      events: this.eventBuffer,
      mainSessionId,
      candidateSessionId,
    })
    const label = `${agentType || 'task'}-${subtaskIndex}`
    const assistantMessageId = this.getLatestAssistantMessageIdForCurrentTurn({
      sessionId: candidateSessionId,
    })
    return { label, assistantMessageId }
  }

  // ── Lifecycle ────────────────────────────────────────────────

  dispose(): void {
    this.disposed = true
    this.state?.listenerController?.abort()
    // waitForEvent loops check listenerAborted and exit naturally.
    threadState.updateThread(this.threadId, (t) => ({
      ...t,
      listenerController: undefined,
    }))
    void this.persistEventBufferDebounced.dispose()
    this.stopTyping()

    // Release large internal buffers so GC can reclaim memory immediately
    // instead of waiting for the runtime object itself to become unreachable.
    this.eventBuffer = []
    this.nextEventIndex = 0
    this.partBuffer.clear()
    this.preprocessChain = Promise.resolve()

    // Don't clear actionQueue here — queued closures own resolve/reject for
    // dispatchAction() promises. Dropping them would leave awaiting callers
    // hanging forever. Instead, drain them: each closure checks this.disposed
    // and resolves early without executing real work.
    void this.processActionQueue()

    // Clean up all pending UI state for this thread (permissions, questions,
    // action buttons, file uploads, html actions).
    cleanupPendingUiForThread(this.thread.id)
  }

  // Called when sdkDirectory changes (e.g. worktree becomes ready after
  // /new-worktree in an existing thread). The event listener was subscribed
  // to the old directory's Instance in opencode — events from the new
  // directory's Instance won't reach it. We must reconnect the listener
  // and clear the old session so ensureSession creates a fresh one under
  // the new Instance.
  handleDirectoryChanged({
    oldDirectory,
    newDirectory,
  }: {
    oldDirectory: string
    newDirectory: string
  }): void {
    logger.log(
      `[LISTENER] sdkDirectory changed for thread ${this.threadId}: ${oldDirectory} → ${newDirectory}`,
    )
    this.sdkDirectory = newDirectory

    // Clear cached session — it was created under the old directory's
    // opencode Instance and can't be reused from the new one.
    threadState.updateThread(this.threadId, (t) => ({
      ...t,
      sessionId: undefined,
    }))

    // Restart event listener to subscribe under the new directory.
    const currentController = this.state?.listenerController
    if (currentController) {
      currentController.abort(new Error('sdkDirectory changed'))
      threadState.updateThread(this.threadId, (t) => ({
        ...t,
        listenerController: new AbortController(),
      }))
      this.listenerLoopRunning = false
      void this.startEventListener()
    }
  }

  handleSharedServerStarted({
    port,
  }: {
    port: number
  }): void {
    const currentController = this.state?.listenerController
    if (!currentController) {
      return
    }
    logger.log(
      `[LISTENER] Refreshing listener for thread ${this.threadId} after shared server start on port ${port}`,
    )
    currentController.abort(new Error('Shared OpenCode server restarted'))
    threadState.updateThread(this.threadId, (t) => ({
      ...t,
      listenerController: new AbortController(),
    }))
    this.listenerLoopRunning = false
    void this.startEventListener()
  }

  private compactTextForEventBuffer(text: string): string {
    if (text.length <= ThreadSessionRuntime.EVENT_BUFFER_TEXT_MAX_CHARS) {
      return text
    }
    return `${text.slice(0, ThreadSessionRuntime.EVENT_BUFFER_TEXT_MAX_CHARS)}…`
  }

  private isDefinedEventBufferValue<T>(value: T | undefined): value is T {
    return value !== undefined
  }

  private pruneLargeStringsForEventBuffer(
    value: unknown,
    seen: WeakSet<object>,
  ): void {
    if (typeof value !== 'object' || value === null) {
      return
    }
    if (seen.has(value)) {
      return
    }
    seen.add(value)

    if (Array.isArray(value)) {
      const compactedItems = value
        .map((item) => {
          if (typeof item === 'string') {
            if (item.length > ThreadSessionRuntime.EVENT_BUFFER_TEXT_MAX_CHARS) {
              return undefined
            }
            return item
          }
          this.pruneLargeStringsForEventBuffer(item, seen)
          return item
        })
        .filter((item) => {
          return this.isDefinedEventBufferValue(item)
        })
      value.splice(0, value.length, ...compactedItems)
      return
    }

    const objectValue = value as Record<string, unknown>
    for (const [key, nestedValue] of Object.entries(objectValue)) {
      if (typeof nestedValue === 'string') {
        if (nestedValue.length > ThreadSessionRuntime.EVENT_BUFFER_TEXT_MAX_CHARS) {
          delete objectValue[key]
        }
        continue
      }
      this.pruneLargeStringsForEventBuffer(nestedValue, seen)
    }
  }

  private finalizeCompactedEventForEventBuffer(
    event: OpenCodeEvent,
  ): OpenCodeEvent {
    this.pruneLargeStringsForEventBuffer(event, new WeakSet<object>())
    return event
  }

  private compactEventForEventBuffer(
    event: OpenCodeEvent,
  ): OpenCodeEvent | undefined {
    if (event.type === 'session.diff') {
      return undefined
    }

    const compacted = structuredClone(event)

    if (compacted.type === 'message.updated') {
      // Strip heavy fields from ALL roles. Derivation only needs lightweight
      // metadata (id, role, sessionID, parentID, time, finish, error, modelID,
      // providerID, mode, tokens). The parts array on assistant messages grows
      // with every tool call and was the primary OOM vector — 1000 buffer entries
      // each carrying the full cumulative parts array reached 4GB+.
      const info = compacted.properties.info as Record<string, unknown>
      const partsSummary = Array.isArray(info.parts)
        ? info.parts.flatMap((part) => {
            if (!part || typeof part !== 'object') {
              return [] as Array<{ id: string; type: string }>
            }
            const candidate = part as { id?: unknown; type?: unknown }
            if (
              typeof candidate.id !== 'string'
              || typeof candidate.type !== 'string'
            ) {
              return [] as Array<{ id: string; type: string }>
            }
            return [{ id: candidate.id, type: candidate.type }]
          })
        : []
      delete info.system
      delete info.summary
      delete info.tools
      delete info.parts
      if (partsSummary.length > 0) {
        info.partsSummary = partsSummary
      }
      return this.finalizeCompactedEventForEventBuffer(compacted)
    }

    if (compacted.type !== 'message.part.updated') {
      return this.finalizeCompactedEventForEventBuffer(compacted)
    }

    const part = compacted.properties.part

    if (part.type === 'text') {
      part.text = this.compactTextForEventBuffer(part.text)
      return this.finalizeCompactedEventForEventBuffer(compacted)
    }

    if (part.type === 'reasoning') {
      part.text = this.compactTextForEventBuffer(part.text)
      return this.finalizeCompactedEventForEventBuffer(compacted)
    }

    if (part.type === 'snapshot') {
      part.snapshot = this.compactTextForEventBuffer(part.snapshot)
      return this.finalizeCompactedEventForEventBuffer(compacted)
    }

    if (part.type === 'step-start' && part.snapshot) {
      part.snapshot = this.compactTextForEventBuffer(part.snapshot)
      return this.finalizeCompactedEventForEventBuffer(compacted)
    }

    if (part.type !== 'tool') {
      return this.finalizeCompactedEventForEventBuffer(compacted)
    }

    const state = part.state
    // Preserve subagent_type for task tools so derivation can build labels
    // like "explore-1" instead of generic "task-1" after compaction strips input
    const taskSubagentType =
      part.tool === 'task' ? state.input?.subagent_type : undefined
    state.input = {}
    if (typeof taskSubagentType === 'string') {
      state.input.subagent_type = taskSubagentType
    }

    if (state.status === 'pending') {
      state.raw = this.compactTextForEventBuffer(state.raw)
      return this.finalizeCompactedEventForEventBuffer(compacted)
    }

    if (state.status === 'running') {
      return this.finalizeCompactedEventForEventBuffer(compacted)
    }

    if (state.status === 'completed') {
      state.output = this.compactTextForEventBuffer(state.output)
      delete state.attachments
      return this.finalizeCompactedEventForEventBuffer(compacted)
    }

    if (state.status === 'error') {
      state.error = this.compactTextForEventBuffer(state.error)
      return this.finalizeCompactedEventForEventBuffer(compacted)
    }

    return this.finalizeCompactedEventForEventBuffer(compacted)
  }

  private appendEventToBuffer(event: OpenCodeEvent): void {
    const compactedEvent = this.compactEventForEventBuffer(event)
    if (!compactedEvent) {
      return
    }

    const timestamp = Date.now()
    const eventIndex = this.nextEventIndex
    this.nextEventIndex += 1
    this.eventBuffer.push({
      event: compactedEvent,
      timestamp,
      eventIndex,
    })
    if (this.eventBuffer.length > ThreadSessionRuntime.EVENT_BUFFER_MAX) {
      this.eventBuffer.splice(0, this.eventBuffer.length - ThreadSessionRuntime.EVENT_BUFFER_MAX)
    }
    this.persistEventBufferDebounced.trigger()
  }

  // Queue-dispatch lifecycle markers are synthetic buffer-only events.
  // They are not fed into handleEvent(), so they do not emit Discord messages;
  // they only stabilize event-derived busy/idle gating for local queue drains.
  private markQueueDispatchBusy(sessionId: string): void {
    this.appendEventToBuffer({
      type: 'session.status',
      properties: {
        sessionID: sessionId,
        status: { type: 'busy' },
      },
    })
  }

  private markQueueDispatchIdle(sessionId: string): void {
    this.appendEventToBuffer({
      type: 'session.idle',
      properties: {
        sessionID: sessionId,
      },
    })
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
    if (this.listenerLoopRunning || this.disposed) {
      return
    }
    this.listenerLoopRunning = true

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
      const client = getOpencodeClient(this.projectDirectory)
      if (!client) {
        // This is expected during shared-server transitions: the listener can
        // outlive the current opencode process across cold start, explicit
        // restart, shutdown, or crash recovery. stopOpencodeServer()/exit clears
        // the cached per-directory clients immediately, so existing runtimes may
        // observe a brief no-client window before initialize/restart publishes
        // the next shared server and repopulates the client cache.
        logger.warn(
          `[LISTENER] No OpenCode client for thread ${this.threadId}, retrying in ${backoffMs}ms`,
        )
        await delay(backoffMs)
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
        continue
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
      // parts that arrived while we were disconnected.
      await this.bootstrapSentPartIds()

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
    // session.diff can carry repeated full-file before/after snapshots and is
    // not used by event-derived runtime state, queueing, typing, or UI routing.
    // Drop it at ingress so large diff payloads never hit memory buffers.
    if (event.type === 'session.diff') {
      return
    }

    // Skip message.part.delta from the event buffer — no derivation function
    // (isSessionBusy, doesLatestUserTurnHaveNaturalCompletion, waitForEvent,
    // etc.) uses them. During long streaming responses they flood the 1000-slot
    // buffer, evicting session.status busy events that isSessionBusy needs,
    // causing tryDrainQueue to drain the local queue while the session is
    // actually still busy. This was the root cause of "? queue" messages
    // interrupting instead of queuing.
    if (event.type !== 'message.part.delta') {
      this.appendEventToBuffer(event)
    }

    const sessionId = this.state?.sessionId

    const eventSessionId = getOpencodeEventSessionId(event)
    const toastSessionId = event.type === 'tui.toast.show'
      ? extractToastSessionId({ message: event.properties.message })
      : undefined

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
    const isScopedToastEvent = Boolean(toastSessionId)

    // Drop events that don't match current session (stale events from
    // previous sessions), unless it's a global event or a subtask session.
    if (!isGlobalEvent && eventSessionId && eventSessionId !== sessionId) {
      if (!this.getSubtaskInfoForSession(eventSessionId)) {
        return // stale event from previous session
      }
    }
    if (isScopedToastEvent && toastSessionId !== sessionId) {
      if (!this.getSubtaskInfoForSession(toastSessionId!)) {
        return
      }
    }

    if (isOpencodeSessionEventLogEnabled()) {
      const eventLogResult = await appendOpencodeSessionEventLog({
        threadId: this.threadId,
        projectDirectory: this.projectDirectory,
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
      case 'question.replied':
        this.handleQuestionReplied(event.properties)
        break
      case 'session.status':
        await this.handleSessionStatus(event.properties)
        break
      case 'session.updated':
        await this.handleSessionUpdated(event.properties.info)
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
    if (this.disposed) {
      return
    }
    return new Promise<void>((resolve, reject) => {
      this.actionQueue.push(async () => {
        if (this.disposed) {
          resolve()
          return
        }
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
    if (hasPendingQuestion) {
      return true
    }
    const hasPendingActionButtons = [...pendingActionButtonContexts.values()].some(
      (ctx) => {
        return ctx.thread.id === this.thread.id
      },
    )
    if (hasPendingActionButtons) {
      return true
    }
    const hasPendingFileUpload = [...pendingFileUploadContexts.values()].some(
      (ctx) => {
        return ctx.thread.id === this.thread.id
      },
    )
    if (hasPendingFileUpload) {
      return true
    }
    return (pendingPermissions.get(this.thread.id)?.size ?? 0) > 0
  }

  onInteractiveUiStateChanged(): void {
    this.ensureTypingNow()
    void this.dispatchAction(() => {
      return this.tryDrainQueue({ showIndicator: true })
    })
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

  private async sendTypingPulse(): Promise<void> {
    const result = await errore.tryAsync(() => {
      return this.thread.sendTyping()
    })
    if (result instanceof Error) {
      discordLogger.log(`Failed to send typing: ${result}`)
    }
  }

  private clearTypingKeepalive(): void {
    if (!this.typingKeepaliveTimeout) {
      return
    }
    clearTimeout(this.typingKeepaliveTimeout)
    this.typingKeepaliveTimeout = null
  }

  private armTypingKeepalive({
    delayMs,
  }: {
    delayMs: number
  }): void {
    this.typingKeepaliveTimeout = setTimeout(() => {
      const activeTimer = this.typingKeepaliveTimeout
      if (!activeTimer) {
        return
      }
      void (async () => {
        if (!this.shouldTypeNow()) {
          this.stopTyping()
          return
        }
        await this.sendTypingPulse()
        if (this.typingKeepaliveTimeout !== activeTimer) {
          return
        }
        if (!this.shouldTypeNow()) {
          this.stopTyping()
          return
        }
        this.armTypingKeepalive({ delayMs: 7000 })
      })()
    }, delayMs)
  }

  private restartTypingKeepalive({
    sendNow,
  }: {
    sendNow: boolean
  }): void {
    this.clearTypingKeepalive()
    this.armTypingKeepalive({ delayMs: sendNow ? 0 : 7000 })
  }

  private ensureTypingNow(): void {
    if (!this.shouldTypeNow()) {
      this.stopTyping()
      return
    }
    if (!this.typingKeepaliveTimeout && !this.typingRepulseDebounce.isPending()) {
      this.armTypingKeepalive({ delayMs: 0 })
      return
    }
    this.typingRepulseDebounce.trigger()
  }

  private ensureTypingKeepalive(): void {
    if (!this.shouldTypeNow()) {
      this.stopTyping()
      return
    }
    if (this.typingKeepaliveTimeout || this.typingRepulseDebounce.isPending()) {
      return
    }
    this.armTypingKeepalive({ delayMs: 7000 })
  }

  private stopTyping(): void {
    this.typingRepulseDebounce.clear()
    this.clearTypingKeepalive()
  }

  private requestTypingRepulse(): void {
    if (!this.shouldTypeNow()) {
      return
    }
    this.typingRepulseDebounce.trigger()
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

  private clearBufferedPartsForMessages(messageIDs: ReadonlyArray<string>): void {
    const uniqueMessageIDs = new Set(messageIDs)
    uniqueMessageIDs.forEach((messageID) => {
      this.partBuffer.delete(messageID)
    })
  }

  private hasBufferedStepFinish(messageID: string): boolean {
    return this.getBufferedParts(messageID).some((part) => {
      return part.type === 'step-finish'
    })
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

  private async sendPartMessage({
    part,
    repulseTyping = true,
  }: {
    part: Part
    repulseTyping?: boolean
  }): Promise<void> {
    const verbosity = await this.getVerbosity()
    if (verbosity === 'text_only' && part.type !== 'text') {
      return
    }
    if (verbosity === 'text_and_essential_tools') {
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
    if (repulseTyping) {
      this.requestTypingRepulse()
    }
  }

  private async flushBufferedParts({
    messageID,
    force,
    skipPartId,
    repulseTyping = true,
  }: {
    messageID: string | undefined
    force: boolean
    skipPartId?: string
    repulseTyping?: boolean
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
      await this.sendPartMessage({ part, repulseTyping })
    }
  }

  private async flushBufferedPartsForMessages({
    messageIDs,
    force,
    skipPartId,
    repulseTyping = true,
  }: {
    messageIDs: ReadonlyArray<string>
    force: boolean
    skipPartId?: string
    repulseTyping?: boolean
  }): Promise<void> {
    const uniqueMessageIDs = [...new Set(messageIDs)]
    for (const messageID of uniqueMessageIDs) {
      await this.flushBufferedParts({
        messageID,
        force,
        skipPartId,
        repulseTyping,
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
      return this.getLatestAssistantMessageIdForCurrentTurn({ sessionId })
    })()
    if (targetMessageId) {
      await this.flushBufferedParts({
        messageID: targetMessageId,
        force: true,
        skipPartId,
      })
    } else {
      const assistantMessageIds = sessionId
        ? [...this.getAssistantMessageIdsForCurrentTurn({ sessionId })]
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
    if (!sessionId) {
      return
    }
    if (!isAssistantMessageInLatestUserTurn({
      events: this.eventBuffer,
      sessionId,
      messageId: msg.id,
    })) {
      logger.info(`[SKIP] message.updated for old assistant message ${msg.id}, not in latest user turn`)
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

    const wasAlreadyCompleted = hasAssistantMessageCompletedBefore({
      events: this.eventBuffer,
      sessionId,
      messageId: msg.id,
      upToIndex: this.eventBuffer.length - 2,
    })
    const completedAt = msg.time.completed
    if (
      !wasAlreadyCompleted
      && typeof completedAt === 'number'
      && isAssistantMessageNaturalCompletion({ message: msg })
    ) {
      await this.handleNaturalAssistantCompletion({
        completedMessageId: msg.id,
        completedAt,
      })
      return
    }

    // Context usage notice.
    // Skip the final assistant update for a run: by the time the last
    // message.updated arrives, the final text part has already ended and the
    // buffered parts usually include step-finish, so a notice here would land
    // immediately above the footer and add noise.
    if (this.hasBufferedStepFinish(msg.id)) {
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
      this.ensureTypingNow()
      return
    }

    if (part.type === 'tool' && part.state.status === 'running') {
      await this.flushBufferedParts({
        messageID: part.messageID,
        force: true,
        skipPartId: part.id,
      })
      await this.sendPartMessage({ part })

      // Track task tool spawning subtask sessions
      if (part.tool === 'task' && !this.state?.sentPartIds.has(part.id)) {
        const description = (part.state.input?.description as string) || ''
        const agent = (part.state.input?.subagent_type as string) || 'task'
        const childSessionId = (part.state.metadata?.sessionId as string) || ''
        if (description && childSessionId) {
          if ((await this.getVerbosity()) !== 'text_only') {
            const taskDisplay = `┣ ${agent} **${description}**`
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
              silent: this.getQueueLength() > 0,
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
              { flags: NOTIFY_MESSAGE_FLAGS },
            )
          }
        },
      })
      return
    }

    // Large output notification for completed tools
    if (part.type === 'tool' && part.state.status === 'completed') {
      const sessionId = this.state?.sessionId
      if (sessionId) {
        const isCurrentRunMessage = isAssistantMessageInLatestUserTurn({
          events: this.eventBuffer,
          sessionId,
          messageId: part.messageID,
        })
        if (!isCurrentRunMessage) {
          logger.info(`[SKIP] tool part ${part.id} for old assistant message ${part.messageID}, not in latest user turn`)
          return
        }
      }
      const showLargeOutput = await (async () => {
        const verbosity = await this.getVerbosity()
        if (verbosity === 'text_only') {
          return false
        }
        if (verbosity === 'text_and_essential_tools') {
          return isEssentialToolPart(part)
        }
        return true
      })()
      if (showLargeOutput) {
        const output = part.state.output || ''
        const outputTokens = Math.ceil(output.length / 4)
        const largeOutputThreshold = 3000
        if (outputTokens >= largeOutputThreshold) {
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
      await this.sendPartMessage({ part })
      return
    }

    if (part.type === 'text' && part.time?.end) {
      await this.sendPartMessage({ part })
      return
    }

    if (part.type === 'step-finish') {
      await this.flushBufferedParts({
        messageID: part.messageID,
        force: true,
      })
      this.ensureTypingKeepalive()
    }
  }

  private async handleSubtaskPart(
    part: Part,
    subtaskInfo: { label: string; assistantMessageId?: string },
  ): Promise<void> {
    const verbosity = await this.getVerbosity()
    if (verbosity === 'text_only') {
      return
    }
    if (verbosity === 'text_and_essential_tools') {
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
    this.requestTypingRepulse()
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
      const shouldDrainQueuedMessages = doesLatestUserTurnHaveNaturalCompletion({
        events: this.eventBuffer,
        sessionId: idleSessionId,
      })

      logger.log(
        `[SESSION IDLE] session became idle sessionId=${sessionId} drainQueue=${shouldDrainQueuedMessages} ${this.formatRunStateForLog()}`,
      )
      await this.persistEventBufferDebounced.flush()

      if (!shouldDrainQueuedMessages) {
        return
      }
      // Drain any local-queue items that arrived while the session was busy
      // (e.g. slow voice transcription with queueMessage=true completing
      // during or just before idle). Same pattern as handleSessionError.
      await this.tryDrainQueue({ showIndicator: true })
      return
    }
  }

  private async handleNaturalAssistantCompletion({
    completedMessageId,
    completedAt,
  }: {
    completedMessageId: string
    completedAt: number
  }): Promise<void> {
    const sessionId = this.state?.sessionId
    if (!sessionId) {
      return
    }

    const assistantMessageIds = [
      ...this.getAssistantMessageIdsForCurrentTurn({ sessionId }),
    ]
    if (assistantMessageIds.length === 0) {
      return
    }

    await this.flushBufferedPartsForMessages({
      messageIDs: assistantMessageIds,
      force: true,
      repulseTyping: false,
    })

    this.stopTyping()

    const turnStartTime = getCurrentTurnStartTime({
      events: this.eventBuffer,
      sessionId,
    })
    if (turnStartTime !== undefined) {
      await this.emitFooter({
        completedAt,
        runStartTime: turnStartTime,
      })
    }

    this.resetPerRunState()
    this.clearBufferedPartsForMessages(assistantMessageIds)
    logger.log(
      `[ASSISTANT COMPLETED] footer emitted for message ${completedMessageId} sessionId=${sessionId} ${this.formatRunStateForLog()}`,
    )
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
        `[SESSION ERROR] Operation aborted (expected) sessionId=${sessionId} ${this.formatRunStateForLog()}`,
      )
      await this.persistEventBufferDebounced.flush()
      return
    }

    const errorMessage = formatSessionErrorFromProps(properties.error)
    logger.error(`Sending error to thread: ${errorMessage}`)
    await sendThreadMessage(
      this.thread,
      `✗ opencode session error: ${errorMessage}`,
      { flags: NOTIFY_MESSAGE_FLAGS },
    )
    await this.persistEventBufferDebounced.flush()

    // Inject synthetic idle so isSessionBusy() returns false and queued
    // messages can drain. Without this, a session error leaves the event
    // buffer in a "busy" state forever (no session.idle follows the error),
    // causing local-queue items to be stuck indefinitely. See #74.
    this.markQueueDispatchIdle(sessionId)
    await this.tryDrainQueue({ showIndicator: true })
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
    this.onInteractiveUiStateChanged()
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
          silent: this.getQueueLength() > 0,
        })
      },
    })

    // Queue drain is intentionally NOT done here — tryDrainQueue() already
    // blocks dispatch while interactive UI (question/permission) is pending.
  }

  private handleQuestionReplied(properties: { sessionID: string }): void {
    const sessionId = this.state?.sessionId
    if (properties.sessionID !== sessionId) {
      return
    }
    this.onInteractiveUiStateChanged()

    // When a question is answered and the local queue has items, the model may
    // continue the same run without ever reaching the local-queue idle gate.
    // Hand the queued items to OpenCode's own prompt queue immediately instead
    // of waiting for tryDrainQueue() to see an idle session.
    if (this.getQueueLength() > 0 && !this.questionReplyQueueHandoffPromise) {
      logger.log(
        `[QUESTION REPLIED] Queue has ${this.getQueueLength()} items, handing off to opencode queue`,
      )
      this.questionReplyQueueHandoffPromise = this.handoffQueuedItemsAfterQuestionReply({
        sessionId,
      }).catch((error) => {
        logger.error('[QUESTION REPLIED] Failed to hand off queued messages:', error)
        if (error instanceof Error) {
          void notifyError(error, 'Failed to hand off queued messages after question reply')
        }
      }).finally(() => {
        this.questionReplyQueueHandoffPromise = null
      })
    }
  }

  // Detached helper promise for the "question answered while local queue has
  // items" flow. Prevents starting two overlapping local->opencode queue
  // handoff sequences when multiple question replies land close together.
  private questionReplyQueueHandoffPromise: Promise<void> | null = null

  private async handoffQueuedItemsAfterQuestionReply({
    sessionId,
  }: {
    sessionId: string
  }): Promise<void> {
    if (this.listenerAborted) {
      return
    }
    if (this.state?.sessionId !== sessionId) {
      logger.log(
        `[QUESTION REPLIED] Session changed before queue handoff for thread ${this.threadId}`,
      )
      return
    }

    while (this.state?.sessionId === sessionId) {
      const next = threadState.dequeueItem(this.threadId)
      if (!next) {
        return
      }

      const displayText = next.command
        ? `/${next.command.name}`
        : `${next.prompt.slice(0, 150)}${next.prompt.length > 150 ? '...' : ''}`
      if (displayText.trim()) {
        await sendThreadMessage(
          this.thread,
          `» **${next.username}:** ${displayText}`,
        )
      }

      await this.submitViaOpencodeQueue(next)
    }
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
      this.stopTyping()
      return
    }

    if (properties.status.type === 'busy') {
      this.ensureTypingNow()
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

  // Rename the Discord thread to match the OpenCode-generated session title.
  //
  // Discord rate-limits channel/thread renames heavily — reported as ~2 per
  // 10 minutes per thread (discord/discord-api-docs#1900, discordjs/discord.js#6651)
  // and discord.js setName() can block silently on the 3rd attempt. We therefore:
  // - rename at most once per distinct title (deduped via appliedOpencodeTitle)
  // - race setName() against an AbortSignal.timeout() so a throttled call never
  //   blocks the event loop
  // - fail soft (log + continue) on timeout, 429, or any other error
  private async handleSessionUpdated(info: {
    id: string
    title: string
  }): Promise<void> {
    // Only act on the main session for this thread
    if (info.id !== this.state?.sessionId) {
      return
    }
    const desiredName = deriveThreadNameFromSessionTitle({
      sessionTitle: info.title,
      currentName: this.thread.name,
    })
    if (!desiredName) {
      return
    }
    const normalizedTitle = info.title.trim()
    if (this.appliedOpencodeTitle === normalizedTitle) {
      return
    }
    // Mark before the call so concurrent session.updated events don't stack
    // rename attempts. On failure we keep the mark — a retry won't help
    // because the failure is almost always a rate limit.
    this.appliedOpencodeTitle = normalizedTitle

    const RENAME_TIMEOUT_MS = 3000
    const timeoutSignal = AbortSignal.timeout(RENAME_TIMEOUT_MS)
    const renameResult = await Promise.race([
      errore.tryAsync({
        try: () => this.thread.setName(desiredName),
        catch: (e) =>
          new Error('Failed to rename thread from OpenCode title', {
            cause: e,
          }),
      }),
      new Promise<'timeout'>((resolve) => {
        timeoutSignal.addEventListener('abort', () => {
          resolve('timeout')
        })
      }),
    ])

    if (renameResult === 'timeout') {
      logger.warn(
        `[TITLE] setName timed out after ${RENAME_TIMEOUT_MS}ms for thread ${this.threadId} (likely rate-limited)`,
      )
      return
    }
    if (renameResult instanceof Error) {
      logger.warn(
        `[TITLE] Could not rename thread ${this.threadId}: ${renameResult.message}`,
      )
      return
    }
    logger.log(
      `[TITLE] Renamed thread ${this.threadId} to "${desiredName}" from OpenCode session title`,
    )
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
    const toastMessage = stripToastSessionId({ message: properties.message }).trim()
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

  // ── Ingress API ─────────────────────────────────────────────

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
        await sendThreadMessage(this.thread, errorMessage, {
          flags: NOTIFY_MESSAGE_FLAGS,
        })
        await this.tryDrainQueue({ showIndicator: true })
      }

      // ── Ensure session ──────────────────────────────────────
      const sessionResult = await this.ensureSession({
        prompt: input.prompt,
        agent: input.agent,
        permissions: input.permissions,
        injectionGuardPatterns: input.injectionGuardPatterns,
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
      const resolvedAppId = input.appId

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

      // ── Worktree + channel topic for per-turn prompt context ──
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
      const worktreeChanged = this.consumeWorktreePromptChange(worktree)
      const syntheticContext = getOpencodePromptContext({
        username: input.username,
        userId: input.userId,
        sourceMessageId: input.sourceMessageId,
        sourceThreadId: input.sourceThreadId,
        repliedMessage: input.repliedMessage,
        worktree,
        currentAgent: resolvedAgent,
        worktreeChanged,
      })
      const parts = [
        { type: 'text' as const, text: promptWithImagePaths },
        { type: 'text' as const, text: syntheticContext, synthetic: true },
        ...images,
      ]

      const request = {
        sessionID: session.id,
        directory: this.sdkDirectory,
        parts,
        system: getOpencodeSystemMessage({
          sessionId: session.id,
          channelId,
          guildId: this.thread.guildId,
          threadId: this.thread.id,
          channelTopic,
          agents: availableAgents,
          username: this.state?.sessionUsername || input.username,
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
      this.markQueueDispatchBusy(session.id)
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
      permissions: input.permissions,
      injectionGuardPatterns: input.injectionGuardPatterns,
      sourceMessageId: input.sourceMessageId,
      sourceThreadId: input.sourceThreadId,
      repliedMessage: input.repliedMessage,
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
   *
   * When input.preprocess is set, the preprocessor runs inside dispatchAction
   * (serialized) to resolve prompt/images/mode before routing. This replaces
   * the threadIngressQueue that previously serialized pre-enqueue work in
   * discord-bot.ts.
   */
  async enqueueIncoming(input: IngressInput): Promise<EnqueueResult> {
    threadState.setSessionUsername(this.threadId, input.username)

    // When a preprocessor is provided, we must resolve it inside
    // dispatchAction before we know the final mode for routing.
    if (input.preprocess) {
      return this.enqueueWithPreprocess(input)
    }
    // If the prompt starts with `/cmdname ...` (and no explicit command is
    // already set), rewrite it into a command invocation so it goes through
    // opencode's session.command API instead of being sent to the model as
    // plain text. Covers Discord chat messages, /new-session, /queue, CLI
    // `kimaki send --prompt`, and scheduled tasks — all funnel through here.
    input = maybeConvertLeadingCommand(input)
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
   * Serialize the preprocess callback via a lightweight promise chain, then
   * route the resolved input through the normal enqueue paths.
   *
   * The preprocess chain is separate from dispatchAction so heavy work
   * (voice transcription, context fetch, attachment download) doesn't
   * block SSE event handling, permission UI, or queue drain. Only the
   * preprocessing order is serialized here — the enqueue itself goes
   * through dispatchAction as usual.
   */
  private async enqueueWithPreprocess(input: IngressInput): Promise<EnqueueResult> {
    // Deferred result: the chain link resolves/rejects this promise.
    let resolveOuter!: (value: EnqueueResult | PromiseLike<EnqueueResult>) => void
    let rejectOuter!: (reason: unknown) => void
    const resultPromise = new Promise<EnqueueResult>((resolve, reject) => {
      resolveOuter = resolve
      rejectOuter = reject
    })

    // Chain preprocess + enqueue calls so they run in arrival order but
    // outside dispatchAction. The chain awaits the full enqueue (including
    // ensureSession / setThreadSession) before releasing to the next
    // message, so session-creation races on fresh threads are avoided.
    // The chain itself never rejects (catch + resolve via rejectOuter)
    // so the next link always runs.
    this.preprocessChain = this.preprocessChain.then(async () => {
      try {
        const result = await input.preprocess!()
        if (result.skip) {
          resolveOuter({ queued: false })
          return
        }
        const resolvedInput: IngressInput = maybeConvertLeadingCommand({
          ...input,
          prompt: result.prompt,
          images: result.images,
          mode: result.mode,
          // Voice transcription can extract an agent name — apply it only if
          // no explicit agent was already set (CLI --agent flag wins).
          agent: input.agent || result.agent,
          repliedMessage: result.repliedMessage,
          preprocess: undefined,
        })

        const hasPromptText = resolvedInput.prompt.trim().length > 0
        const hasImages = (resolvedInput.images?.length || 0) > 0
        if (!hasPromptText && !hasImages && !resolvedInput.command) {
          logger.warn(
            `[INGRESS] Skipping empty preprocessed input threadId=${this.threadId}`,
          )
          resolveOuter({ queued: false })
          return
        }

        // Route with the resolved mode through normal paths.
        // Await the enqueue so session state (ensureSession, setThreadSession)
        // is persisted before the next message's preprocessing reads it.
        const enqueueResult =
          resolvedInput.mode === 'local-queue' || resolvedInput.command
            ? await this.enqueueViaLocalQueue(resolvedInput)
            : await this.submitViaOpencodeQueue(resolvedInput)
        resolveOuter(enqueueResult)
      } catch (err) {
        rejectOuter(err)
      }
    })

    return resultPromise
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

  async abortActiveRunAndWait({
    reason,
    timeoutMs = 2_000,
  }: {
    reason: string
    timeoutMs?: number
  }): Promise<void> {
    const state = this.state
    const sessionId = state?.sessionId
    if (!sessionId) {
      return
    }

    let needsIdleWait = false
    const waitSinceTimestamp = Date.now()
    const abortResult = await errore.tryAsync(() => {
      return this.dispatchAction(async () => {
        needsIdleWait = this.isMainSessionBusy()
        const outcome = this.abortActiveRunInternal({ reason })
        if (outcome.apiAbortPromise) {
          void outcome.apiAbortPromise
        }
      })
    })
    if (abortResult instanceof Error) {
      logger.error(`[ABORT WAIT] Failed to abort active run: ${abortResult.message}`)
      return
    }
    if (!needsIdleWait) {
      return
    }
    await this.waitForEvent({
      predicate: (event) => {
        return event.type === 'session.idle'
          && (event.properties as { sessionID?: string }).sessionID === sessionId
      },
      sinceTimestamp: waitSinceTimestamp,
      timeoutMs,
    })
  }

  /** Number of messages waiting in the queue. */
  getQueueLength(): number {
    return this.state?.queueItems.length ?? 0
  }

  /** NOTIFY_MESSAGE_FLAGS unless queue has a next item, then SILENT.
   * Permissions should NOT use this — they always notify. */
  private getNotifyFlags(): number {
    return this.getQueueLength() > 0
      ? SILENT_MESSAGE_FLAGS
      : NOTIFY_MESSAGE_FLAGS
  }

  /** Clear all queued messages. */
  clearQueue(): void {
    threadState.clearQueueItems(this.threadId)
  }

  // ── Queue Drain ─────────────────────────────────────────────

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
    // Interactive UI (action buttons, questions, permissions) does NOT block
    // queue drain. The isSessionBusy check is sufficient: questions and
    // permissions keep the OpenCode session busy, so drain is naturally
    // blocked. Action buttons are fire-and-forget (session already idle),
    // so queued messages should dispatch immediately.

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
    // gating prevents concurrent local-queue dispatches. Mark busy now to
    // close the tiny window before the first session.status busy arrives.
    const dispatchSessionId = thread.sessionId
    if (dispatchSessionId) {
      this.markQueueDispatchBusy(dispatchSessionId)
    }
    void this.dispatchPrompt(next).catch(async (err) => {
      logger.error('[DISPATCH] Prompt dispatch failed:', err)
      void notifyError(err, 'Runtime prompt dispatch failed')
      if (dispatchSessionId) {
        this.markQueueDispatchIdle(dispatchSessionId)
      }
    }).finally(() => {
      void this.dispatchAction(() => {
        return this.tryDrainQueue({ showIndicator: true })
      })
    })
  }

  // ── Prompt Dispatch ─────────────────────────────────────────
  // Resolve session, build system message, send to OpenCode.
  // The listener is already running, so this only handles
  // session ensure + model/agent + SDK call + state.

  private async dispatchPrompt(input: QueuedMessage): Promise<void> {
    this.lastDisplayedContextPercentage = 0
    this.lastRateLimitDisplayTime = 0

    // ── Ensure session ────────────────────────────────────────
    const sessionResult = await this.ensureSession({
      prompt: input.prompt,
      agent: input.agent,
      permissions: input.permissions,
      injectionGuardPatterns: input.injectionGuardPatterns,
      sessionStartScheduleKind: input.sessionStartScheduleKind,
      sessionStartScheduledTaskId: input.sessionStartScheduledTaskId,
    })
    if (sessionResult instanceof Error) {
      this.stopTyping()
      await sendThreadMessage(
        this.thread,
        `✗ ${sessionResult.message}`,
        { flags: NOTIFY_MESSAGE_FLAGS },
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
    const resolvedAppId = input.appId

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
        { flags: NOTIFY_MESSAGE_FLAGS },
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
        { flags: NOTIFY_MESSAGE_FLAGS },
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

    // ── Worktree info for per-turn prompt context ─────────────
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
    const worktreeChanged = this.consumeWorktreePromptChange(worktree)
    const syntheticContext = getOpencodePromptContext({
      username: input.username,
      userId: input.userId,
      sourceMessageId: input.sourceMessageId,
      sourceThreadId: input.sourceThreadId,
      repliedMessage: input.repliedMessage,
      worktree,
      currentAgent: earlyAgentPreference,
      worktreeChanged,
    })
    const parts = [
      { type: 'text' as const, text: promptWithImagePaths },
      { type: 'text' as const, text: syntheticContext, synthetic: true },
      ...images,
    ]

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
      // session.command() only accepts FilePart in parts, not text parts.
      // Append <discord-user /> tag to arguments so external sync can
      // detect this message came from Discord (same tag as promptAsync).
      const discordTag = getOpencodePromptContext({
        username: input.username,
        userId: input.userId,
        sourceMessageId: input.sourceMessageId,
        sourceThreadId: input.sourceThreadId,
        repliedMessage: input.repliedMessage,
      })
      const commandResponse = await errore.tryAsync(() => {
        return getClient().session.command(
          {
            sessionID: session.id,

            directory: this.sdkDirectory,
            command: queuedCommand.name,
            arguments: queuedCommand.arguments + (discordTag ? `\n${discordTag}` : ''),
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
            { flags: NOTIFY_MESSAGE_FLAGS },
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
          { flags: NOTIFY_MESSAGE_FLAGS },
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
        await sendThreadMessage(this.thread, `✗ ${apiError.message}`, {
          flags: NOTIFY_MESSAGE_FLAGS,
        })
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
          channelTopic,
          agents: earlyAvailableAgents,
          username: this.state?.sessionUsername || input.username,
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
      await sendThreadMessage(this.thread, `✗ OpenCode API error: ${errorMessage}`, {
        flags: NOTIFY_MESSAGE_FLAGS,
      })
      await this.dispatchAction(() => {
        return this.tryDrainQueue({ showIndicator: true })
      })
      return
    }

    logger.log(
      `[DISPATCH] promptAsync accepted by opencode queue sessionId=${session.id} threadId=${this.threadId}`,
    )
  }

  // ── Session Ensure ──────────────────────────────────────────
  // Creates or reuses the OpenCode session for this thread.

  private async ensureSession({
    prompt,
    agent,
    permissions,
    injectionGuardPatterns,
    sessionStartScheduleKind,
    sessionStartScheduledTaskId,
  }: {
    prompt: string
    agent?: string
    /** Raw "tool:action" strings from --permission flag */
    permissions?: string[]
    injectionGuardPatterns?: string[]
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
      // Pass per-session external_directory permissions so this session can
      // access its own project directory (and worktree origin if applicable)
      // without prompts. These override the server-level 'ask' default via
      // opencode's findLast() rule evaluation.
      // CLI --permission rules are appended after base rules so they win
      // via opencode's findLast() evaluation.
      const sessionPermissions = [
        ...buildSessionPermissions({
          directory: this.sdkDirectory,
          originalRepoDirectory,
        }),
        ...parsePermissionRules(permissions ?? []),
      ]
      // Omit title so OpenCode auto-generates a summary from the conversation
      const sessionResponse = await getClient().session.create({
        directory: this.sdkDirectory,
        permission: sessionPermissions,
      })
      session = sessionResponse.data
      // Insert DB row immediately so the external-sync poller sees
      // source='kimaki' before the next poll tick and skips this session.
      // The upsert at the end of ensureSession is kept for the reuse path.
      if (session) {
        await setThreadSession(this.thread.id, session.id)
        if (injectionGuardPatterns?.length) {
          writeInjectionGuardConfig({
            sessionId: session.id,
            scanPatterns: injectionGuardPatterns,
          })
        }
      }
      createdNewSession = true
    }

    if (!session) {
      return new Error('Failed to create or get session')
    }

    // Store session in DB and thread state
    await setThreadSession(this.thread.id, session.id)
    threadState.setSessionId(this.threadId, session.id)
    await this.hydrateSessionEventsFromDatabase({ sessionId: session.id })

    // Store session start source for scheduled tasks
    if (createdNewSession && sessionStartScheduleKind) {
      const sessionStartSourceResult = await errore.tryAsync({
        try: () => {
          return setSessionStartSource({
            sessionId: session.id,
            scheduleKind: sessionStartScheduleKind,
            scheduledTaskId: sessionStartScheduledTaskId,
          })
        },
        catch: (e) =>
          new Error('Failed to persist scheduled session start source', {
            cause: e,
          }),
      })
      if (sessionStartSourceResult instanceof Error) {
        logger.warn(
          `[SESSION START SOURCE] ${sessionStartSourceResult.message}`,
        )
      }
    }

    // Store agent preference if provided
    if (agent && createdNewSession) {
      await setSessionAgent(session.id, agent)
    }

    return { session, getClient, createdNewSession }
  }

  /**
   * Emit the run footer: duration, model, context%, project info.
   * Triggered directly from the terminal assistant message.updated event so the
   * footer lands next to the assistant output instead of waiting for session.idle.
   */
  private async emitFooter({
    completedAt,
    runStartTime,
  }: {
    completedAt: number
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
    const elapsedMs = completedAt - runStartTime
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

    // Run git branch and token fetch in parallel (fast, no external CLI)
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
              if (!m.info.tokens) {
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

    const truncate = (s: string, max: number) => {
      return s.length > max ? s.slice(0, max - 1) + '\u2026' : s
    }
    const truncatedFolder = truncate(folderName, 30)
    const truncatedBranch = truncate(branchName, 30)
    const projectInfo = truncatedBranch
      ? `${truncatedFolder} ⋅ ${truncatedBranch} ⋅ `
      : `${truncatedFolder} ⋅ `
    const footerText = `*${projectInfo}${sessionDuration}${contextInfo}${modelInfo}${agentInfo}*`
    this.stopTyping()

    // Skip notification if there's a queued message next — the user only
    // needs to be notified when the entire queue finishes.
    await sendThreadMessage(this.thread, footerText, {
      flags: this.getNotifyFlags(),
    })
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

  // ── Retry Last User Prompt (for model-change flow) ──────────

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
