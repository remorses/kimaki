// ThreadSessionRuntime — one per active thread.
// Owns resource handles (listener controller, typing timers, part buffer).
// Delegates all state to the global store via thread-runtime-state.ts transitions.
//
// This is the sole session orchestrator. Discord handlers and slash commands
// call runtime APIs (enqueueIncoming, abortActiveRun, etc.) without inspecting
// run internals.

import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { ChannelType, type Client, type ThreadChannel } from 'discord.js'
import type {
  QuestionRequest,
  Message as OpenCodeMessage,
} from '@opencode-ai/sdk/v2'
import type { PermissionRequest, V2Event } from '@opencode/client'
import path from 'node:path'
import prettyMilliseconds from 'pretty-ms'
import * as errore from 'errore'
import * as threadState from './thread-runtime-state.js'
import type { QueuedMessage } from './thread-runtime-state.js'
import type { OpencodeClient } from '../opencode.js'

type OpenCodeEvent = V2Event
import {
  getOpencodeClient,
  initializeOpencodeForDirectory,
  buildSessionPermissions,
  parsePermissionRules,
  writeInjectionGuardConfig,
  extractSdkErrorMessage,
} from '../opencode.js'
import { isAbortError } from '../utils.js'
import {
  registerEventListener,
  unregisterEventListener,
  waitForGlobalEventListener,
} from './global-event-listener.js'
import { createLogger, LogPrefix } from '../logger.js'
import {
  sendThreadMessage,
  sendSessionPartMessage,
  SILENT_MESSAGE_FLAGS,
  NOTIFY_MESSAGE_FLAGS,
  raceDiscordRename,
  DISCORD_THREAD_RENAME_TIMEOUT_MS,
  resolveThreadFooterMentionUserId,
  resolveWorkingDirectory,
} from '../discord-utils.js'
import type {
  DiscordFileAttachment,
  DiscordSessionPart,
  SessionPartKind,
} from '../message-formatting.js'
import {
  asDiscordQuote,
  discordReasoningPartId,
  discordTextPartId,
  discordToolPartId,
  formatPart,
  formatTaskToolTitle,
  planAssistantTurnFlush,
  QUEUE_PREFIX,
  sessionPartContent,
  sessionPartKind,
  shouldLeadWithBlankLine,
  shouldQuoteIntermediateTextPart,
  STATUS_PREFIX,
  WORKTREE_PREFIX,
  type AssistantTurnFlushMode,
} from '../message-formatting.js'
import {
  getChannelVerbosity,
  getPartMessageIds,
  getDb,
  setPartMessage,
  getThreadSession,
  setThreadSession,
  getThreadParentSessionId,
  setThreadParentSessionId,
  getThreadWorktreeOrWorkspace,
  setSessionAgent,
  setSessionModel,
  clearSessionModel,
  getVariantCascade,
  setSessionStartSource,
  getSessionStartSource,
  getScheduledTask,
  completeScheduledTaskRunsForSession,
  failScheduledTaskRunsForSession,
  startScheduledTaskRunSession,
  appendSessionEventsSinceLastTimestamp,
  getSessionEventSnapshot,
  cancelSessionSleepForThread,
} from '../database.js'
import * as orm from 'drizzle-orm'
import * as schema from '../schema.js'
import {
  showPermissionButtons,
  addPermissionRequestToContext,
  canGroupPermissionRequests,
  pendingPermissionContexts,
} from '../commands/permissions.js'
import {
  showAskUserQuestionDropdowns,
  pendingQuestionContexts,
  cancelPendingQuestion,
  findPendingQuestionContextForRequest,
  type AskUserQuestionInput,
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
  displayedModelLabel,
  resolveDisplayedModelName,
  validateModelId,
} from './model-utils.js'
import {
  getOpencodePromptContext,
  getOpencodeSystemMessage,
  KIMAKI_INSTRUCTION_ENTRY_KEY,
  type AgentInfo,
  type RepliedMessageContext,
  type WorktreeInfo,
  type ScheduledTaskSystemContext,
} from '../system-message.js'
import { getDataDir } from '../config.js'
import { countSystemPromptDiffLines } from '../cache-rewrite.js'
import { store } from '../store.js'
import {
  trackEvent,
  type AnalyticsIngressMode,
  type AnalyticsProps,
  type AnalyticsTurnInputKind,
  type AnalyticsTurnSource,
} from '../analytics.js'
import { resolveValidatedAgentPreference } from './agent-utils.js'
import {
  appendOpencodeSessionEventLog,
  getOpencodeEventSessionId,
  isOpencodeSessionEventLogEnabled,
} from './opencode-session-event-log.js'
import {
  doesLatestUserTurnHaveNaturalCompletion,
  didLatestUserTurnUseSleepTool,
  didQuestionQueueHandoffSinceLatestQuestionAsked,
  deriveLatestUnansweredQuestion,
  getAssistantMessageIdsForLatestUserTurn,
  getCurrentTurnStartTime,
  isSessionBusy,
  getLatestRunInfo,
  getPromptCacheClear,
  formatPromptCacheClearMessage,
  getIdleTokenUsageDelta,
  getDerivedSubtaskLabel,
  getTokenUsageSessionIdsForIdle,
  isDerivedChildSession,
  getLatestAssistantMessageIdForLatestUserTurn,
  getAssistantMessageKind,
  hasAssistantMessageCompletedBefore,
  hasVisibleV2OutputSinceExecutionStart,
  isAssistantMessageInLatestUserTurn,
  isAssistantMessageNaturalCompletion,
  shouldBufferSessionEvent,
  shouldRetainSessionEvent,
  trimEventBuffer,
  type EventBufferEvent,
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
      contextHash: string
    }
  > // permissionId -> data
>()
import {
  getThinkingValuesForModel,
  matchThinkingValue,
  thinkingProvidersFromListedModels,
} from '../thinking-utils.js'
import { execAsync } from '../worktrees.js'
import {
  DiscordOperationError,
  OpenCodeSdkError,
  FilesystemOperationError,
} from '../errors.js'

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

function isEphemeralV2StreamEvent(event: { type: string }) {
  return (
    event.type === 'session.text.delta'
    || event.type === 'session.reasoning.delta'
    || event.type === 'session.tool.input.delta'
    || event.type === 'session.tool.progress'
    || event.type === 'session.compaction.delta'
  )
}

function isSessionSettledEvent({
  event,
  sessionId,
}: {
  event: EventBufferEvent
  sessionId: string
}) {
  if (getOpencodeEventSessionId(event) !== sessionId) return false
  return (
    event.type === 'session.idle'
    || event.type === 'session.execution.interrupted'
    || event.type === 'session.execution.succeeded'
    || event.type === 'session.execution.failed'
  )
}

const shouldLogSessionEvents =
  process.env['KIMAKI_LOG_SESSION_EVENTS'] === '1' ||
  process.env['KIMAKI_VITEST'] === '1'

// ── Registry ─────────────────────────────────────────────────────
// Runtime instances are kept in a plain Map (not Zustand — the Map
// is not reactive state, just a lookup for resource handles).

const runtimes = new Map<string, ThreadSessionRuntime>()

// Per-thread FIFO for Discord arrival order of one-shot slash calls vs messages.
// Covers /plan-agent (no prompt) and /foo-cmd /foo-skill. OpenCode already
// queues session.prompt. /model, /agent, and /compact are not on this queue.
const threadIngressChains = new Map<string, Promise<void>>()
const threadIngressSlotAls = new AsyncLocalStorage<ThreadIngressSlot | undefined>()

export type ThreadIngressSlot = {
  wait: Promise<void>
  release: () => void
}

export function reserveThreadIngress(threadId: string): ThreadIngressSlot {
  const previous = threadIngressChains.get(threadId) ?? Promise.resolve()
  let released = false
  let releaseHeld = () => {}
  const held = new Promise<void>((resolve) => {
    releaseHeld = resolve
  })
  threadIngressChains.set(
    threadId,
    previous.then(() => held),
  )
  return {
    wait: previous,
    release: () => {
      if (released) {
        return
      }
      released = true
      releaseHeld()
    },
  }
}

export async function runInThreadIngressSlot<T>(
  slot: ThreadIngressSlot | undefined,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await threadIngressSlotAls.run(slot, run)
  } finally {
    slot?.release()
  }
}

export async function waitForCurrentThreadIngress(): Promise<void> {
  const slot = threadIngressSlotAls.getStore()
  if (!slot) {
    return
  }
  await slot.wait
}

export function releaseCurrentThreadIngress(): void {
  threadIngressSlotAls.getStore()?.release()
}

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
  sessionId?: string
}

export function getOrCreateRuntime(
  opts: RuntimeOptions,
): ThreadSessionRuntime {
  const existing = runtimes.get(opts.threadId)
  if (existing) {
    if (existing.sdkDirectory !== opts.sdkDirectory) {
      logger.warn(
        `[RUNTIME] Ignoring sdkDirectory change for existing thread ${opts.threadId}: ${existing.sdkDirectory} → ${opts.sdkDirectory}`,
      )
    }
    if (opts.sessionId && !existing.state?.sessionId) {
      threadState.setSessionId(opts.threadId, opts.sessionId)
    }
    return existing
  }
  threadState.ensureThread(opts.threadId) // add to global store
  if (opts.sessionId) {
    threadState.setSessionId(opts.threadId, opts.sessionId)
  }
  const runtime = new ThreadSessionRuntime(opts)
  runtimes.set(opts.threadId, runtime)
  return runtime
}

function groupQueueRowsByThread(
  rows: Array<{ thread_id: string; queue_id: string; payload_json: string }>,
): Map<string, QueuedMessage[]> {
  const byThread = new Map<string, QueuedMessage[]>()
  for (const row of rows) {
    const parsed = parseQueuedMessagePayload({
      queueId: row.queue_id,
      payloadJson: row.payload_json,
    })
    if (parsed instanceof Error) {
      logger.warn(
        `[QUEUE] Skipping invalid queue row ${row.queue_id} in thread ${row.thread_id}: ${parsed.message}`,
      )
      continue
    }
    const items = byThread.get(row.thread_id) ?? []
    items.push(parsed)
    byThread.set(row.thread_id, items)
  }
  return byThread
}

export async function restorePersistedLocalQueues({
  discordClient,
  appId,
}: {
  discordClient: Client
  appId?: string
}): Promise<void> {
  const rows = await listAllThreadQueueItems()
  if (rows.length === 0) {
    return
  }

  const byThread = groupQueueRowsByThread(rows)
  for (const [threadId, items] of byThread) {
    if (items.length === 0) {
      continue
    }
    let runtime = runtimes.get(threadId)
    if (!runtime) {
      const fetched = await discordClient.channels.fetch(threadId).catch((error) => {
        logger.warn(
          `[QUEUE] Failed to fetch thread ${threadId} for restored queue: ${error instanceof Error ? error.message : String(error)}`,
        )
        return null
      })
      if (!fetched?.isThread()) {
        logger.warn(`[QUEUE] Skipping restored queue for missing thread ${threadId}`)
        continue
      }

      const resolved = await resolveWorkingDirectory({ channel: fetched })
      if (!resolved) {
        logger.warn(`[QUEUE] Skipping restored queue for thread ${threadId}: no project directory`)
        continue
      }

      const sessionId = await getThreadSession(threadId)
      runtime = getOrCreateRuntime({
        threadId,
        thread: fetched,
        projectDirectory: resolved.projectDirectory,
        sdkDirectory: resolved.workingDirectory,
        channelId: fetched.parentId || fetched.id,
        appId,
        sessionId,
      })
    }
    await runtime.dispatchAction(() => {
      return runtime.mergeRestoredQueueAndDrain(items)
    })
  }
}

export function disposeRuntime(
  threadId: string,
  { abortActiveRun = false }: { abortActiveRun?: boolean } = {},
): void {
  const runtime = runtimes.get(threadId)
  if (!runtime) {
    return
  }
  if (abortActiveRun) {
    runtime.abortDeletedDiscordResource()
  }
  runtime.dispose()
  runtimes.delete(threadId)
  threadState.removeThread(threadId) // remove from global store
  threadIngressChains.delete(threadId)
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
    threadIngressChains.delete(threadId)
    count++
  }
  return count
}

export function getRuntimeThreadIdsForChannel(channelId: string): string[] {
  return Array.from(runtimes.entries())
    .filter(([, runtime]) => runtime.channelId === channelId)
    .map(([threadId]) => threadId)
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
    threadIngressChains.delete(threadId)
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
                sessionID: ctx.permission.sessionID,
                requestID: requestId,
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
  const snowflakeIdResult = errore.try(
    () => {
      return BigInt(snowflake)
    },
    () => {
      return new Error('Invalid Discord snowflake')
    },
  )
  if (snowflakeIdResult instanceof Error) return undefined
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

/**
 * Built-in read-only tools that are hidden in default verbosity mode.
 * Any tool NOT in this list is considered "essential" and shown,
 * which means custom tools, MCP tools, and plugin tools are visible by default.
 */
const HIDDEN_READONLY_TOOLS = [
  'read',
  'glob',
  'grep',
  'describe-media',
  'todoread',
]

/** Check if a tool part is "essential" (shown in text-and-essential-tools mode). */
export function isEssentialToolName(toolName: string): boolean {
  // Hide known read-only built-in tools; show everything else
  // (custom tools, MCP tools, plugin tools are visible by default)
  return !HIDDEN_READONLY_TOOLS.some((name) => {
    return toolName === name || toolName.endsWith(`_${name}`)
  })
}

export function isShellToolName(toolName: string): boolean {
  return toolName === 'shell' || toolName === 'bash'
}

export function isEssentialToolPart(part: DiscordSessionPart): boolean {
  if (part.type !== 'tool') {
    return false
  }
  if (!isEssentialToolName(part.tool)) {
    return false
  }
  if (isShellToolName(part.tool)) {
    const hasSideEffect = part.state.input?.hasSideEffect
    return hasSideEffect !== false
  }
  return true
}

// ── Thread title derivation ──────────────────────────────────────

const DISCORD_THREAD_NAME_MAX = 100
const PRESERVED_THREAD_PREFIXES: string[] = [
  WORKTREE_PREFIX,
  'btw: ',
  'Fork: ',
]

function stripPreservedThreadPrefix(name: string) {
  const matchedPrefix = PRESERVED_THREAD_PREFIXES.find((prefix) => {
    return name.startsWith(prefix)
  })
  if (!matchedPrefix) return name
  return name.slice(matchedPrefix.length).trim()
}

function getThreadNameCandidateFromSessionTitle({
  sessionTitle,
  currentName,
}: {
  sessionTitle: string | undefined | null
  currentName: string
}) {
  const trimmed = sessionTitle
    ?.replace(/<\/?callout\b[^>]*>/gi, '')
    .trim()
  if (!trimmed) {
    return null
  }
  const withoutCopiedPrefix = stripPreservedThreadPrefix(trimmed)
  if (!withoutCopiedPrefix) {
    return null
  }
  if (/^new session\s*-/i.test(withoutCopiedPrefix)) {
    return null
  }
  const matchedPrefix =
    PRESERVED_THREAD_PREFIXES.find((p) => {
      return currentName.startsWith(p)
    }) ?? ''
  return `${matchedPrefix}${withoutCopiedPrefix}`.slice(0, DISCORD_THREAD_NAME_MAX)
}

export function deriveThreadNameFromSessionTitle({
  sessionTitle,
  currentName,
}: {
  sessionTitle: string | undefined | null
  currentName: string
}): string | undefined {
  const candidate = getThreadNameCandidateFromSessionTitle({
    sessionTitle,
    currentName,
  })
  if (candidate === null) {
    return undefined
  }
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
  /** Stable queue entry id. Set when the item was placed in the local queue. */
  queueId?: string
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
   * `opencode` (default): send via session.prompt and let opencode
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
   * Thinking-level variant from `/xxx-agent variant:`. Applied after
   * agent/model snapshot so it wins over cascade for this turn.
   */
  variant?: string
  /**
   * Raw permission rule strings from --permission flag ("tool:action" or
   * "tool:pattern:action"). Parsed into PermissionRuleset entries by
   * parsePermissionRules() and appended after buildSessionPermissions()
   * so they win via opencode's findLast() evaluation. Explicit input also
   * replaces existing session rules; omitted input preserves them.
   */
  permissions?: string[]
  injectionGuardPatterns?: string[]
  /**
   * Parent OpenCode session ID from explicit `kimaki send --parent-session` only.
   * Stored once on first ingress and injected into the child system message.
   * Never set for /btw, /fork, or task/subagent children (keeps system prompt cache).
   */
  parentSessionId?: string
  sessionStartSource?: { scheduleKind: 'at' | 'cron'; scheduledTaskId?: number; scheduledTaskRunId?: number }
  /** Optional guard for retries: skip enqueue when session has changed. */
  expectedSessionId?: string
  /**
   * When true, the message is added to the session context without triggering
   * the AI agent loop. Used for messages that should be visible to the model
   * on the next real turn but should not cause a response on their own
   * (e.g. user-to-user replies in a thread).
   */
  noReply?: boolean
  /**
   * True only for the wake prompt posted by the kimaki_sleep task runner.
   * Every other ingress cancels a pending sleep; this one must not, because it
   * is delivering that sleep rather than superseding it.
   */
  isSleepWake?: boolean
  /**
   * Product-analytics turn source. Defaults to discord. Set retry/cli/scheduled
   * at the ingress site so DAU queries can exclude non-user activity.
   */
  analyticsSource?: AnalyticsTurnSource
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

function resolveTurnSource(input: {
  analyticsSource?: AnalyticsTurnSource
  sessionStartSource?: { scheduleKind: 'at' | 'cron'; scheduledTaskId?: number; scheduledTaskRunId?: number }
  sessionStartScheduleKind?: 'at' | 'cron'
}): AnalyticsTurnSource {
  if (input.analyticsSource) return input.analyticsSource
  if (input.sessionStartSource || input.sessionStartScheduleKind) {
    return 'scheduled'
  }
  return 'discord'
}

function trackTurnStarted({
  inputKind,
  ingressMode,
  source,
  agent,
}: {
  inputKind: AnalyticsTurnInputKind
  ingressMode: AnalyticsIngressMode
  source: AnalyticsTurnSource
  agent?: string
}) {
  trackEvent('turn_started', {
    input_kind: inputKind,
    ingress_mode: ingressMode,
    source,
    uses_custom_agent: Boolean(agent && agent !== 'build'),
  })
}

function parseQueuedMessagePayload({
  queueId,
  payloadJson,
}: {
  queueId: string
  payloadJson: string
}): QueuedMessage | Error {
  return errore.try(
    () => {
      const parsed = JSON.parse(payloadJson) as QueuedMessage
      if (!parsed || typeof parsed !== 'object') {
        return new Error('Queued message payload is not an object')
      }
      if (typeof parsed.prompt !== 'string') {
        return new Error('Queued message payload is missing prompt')
      }
      if (typeof parsed.userId !== 'string') {
        return new Error('Queued message payload is missing userId')
      }
      if (typeof parsed.username !== 'string') {
        return new Error('Queued message payload is missing username')
      }
      return { ...parsed, queueId }
    },
    (error) => {
      return new Error('Failed to parse queued message payload', { cause: error })
    },
  )
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
  readonly sdkDirectory: string
  readonly channelId: string | undefined
  readonly appId: string | undefined
  readonly thread: ThreadChannel

  // ── Resource handles (mechanisms, not domain state) ──

  // Set to true by dispose(). Guards against queued work running after cleanup.
  private disposed = false
  private dispatchingQueueId: string | undefined

  // Typing indicator scheduler handles.
  // `typingKeepaliveTimeout` is the 7s keepalive loop while a run stays busy.
  // `typingRepulseDebounce` collapses clustered immediate re-pulses after bot
  // messages into one last pulse, because Discord hides typing on the next bot
  // message and showing multiple back-to-back POSTs is wasteful.
  private typingKeepaliveTimeout: ReturnType<typeof setTimeout> | null = null
  private readonly typingRepulseDebounce: ReturnType<typeof createDebouncedTimeout>
  private readonly deferredQuestionShow: ReturnType<typeof createDebouncedTimeout>

  private static TYPING_REPULSE_DEBOUNCE_MS = 500
  private static DEFERRED_QUESTION_SHOW_MS = 1000

  // Notification throttles for retry/context notices.
  private lastDisplayedContextPercentage = 0
  private lastRateLimitDisplayTime = 0
  private userSystemByMessageId = new Map<string, string>()

  // Last OpenCode session title we applied to Discord. Dedupes session.updated
  // so we only call setName once per distinct title. Not persisted.
  private appliedOpencodeTitle: string | undefined

  // Part output buffering (write-side cache, not domain state)
  private partBuffer = new Map<string, Map<string, DiscordSessionPart>>()
  private shownQuestionRequestIds = new Set<string>()
  private v2ToolNames = new Map<string, string>()
  private v2InboxItems = new Map<string, { delivery: string; text: string }>
  private v2VisibleOutput = false
  private abortInFlight: Promise<void> | null = null
  private v2ExecutionStartedAt = new Map<string, number>()
  private v2OpenTextMessageIds = new Set<string>()
  private pendingV2Question:
    | {
        formId: string
        sessionId: string
        messageId?: string
        questions: AskUserQuestionInput['questions']
      }
    | undefined

  // Derivable cache (perf optimization for provider.list API call)
  private modelContextLimit: number | undefined
  private modelContextLimitKey: string | undefined
  private lastPromptWorktreeKey: string | null | undefined
  private lastSentPartKind: SessionPartKind | undefined

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
  private readonly sentPartIdsBootstrap: Promise<void>

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
    this.sentPartIdsBootstrap = this.bootstrapSentPartIds().catch((error) => {
      logger.warn(
        `[PART BOOTSTRAP] Failed to load sent part ids for thread ${this.threadId}:`,
        error,
      )
    })
    // Register with the single global SSE listener. Events for this
    // directory are demuxed and dispatched through our action queue.
    registerEventListener(this.threadId, (event) => {
      if (this.disposed) return
      if (!isEphemeralV2StreamEvent(event)) {
        this.appendEventToBuffer(event)
      }
      void this.dispatchAction(async () => {
        await this.sentPartIdsBootstrap
        await this.handleEvent(event)
      })
    })
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
    this.deferredQuestionShow = createDebouncedTimeout({
      delayMs: ThreadSessionRuntime.DEFERRED_QUESTION_SHOW_MS,
      callback: () => {
        if (this.disposed) {
          return
        }
        void this.dispatchAction(async () => {
          await this.tryShowPendingQuestion({ ignoreUnfinishedText: true })
        })
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
    return this.isBusy() ? 'running' : 'idle'
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
    if (this.isBusy()) {
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
      const eventResult = errore.try(
        () => {
          return JSON.parse(row.event_json) as EventBufferEvent
        },
        (error) => {
          return new Error('Failed to parse persisted session event JSON', {
            cause: error,
          })
        },
      )
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

    this.eventBuffer = trimEventBuffer({
      events: hydratedEvents,
      mainSessionId: sessionId,
      max: ThreadSessionRuntime.EVENT_BUFFER_MAX,
      isKnownChildSession: (candidateSessionId) => {
        return isDerivedChildSession({
          events: hydratedEvents,
          mainSessionId: sessionId,
          candidateSessionId,
        })
      },
    })
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
      const eventSessionId = entry.event.type === 'queue.question-handoff-started'
        ? entry.event.properties.sessionID
        : getOpencodeEventSessionId(entry.event)
      if (eventSessionId !== sessionId) {
        return []
      }
      return [
        {
          session_id: sessionId,
          thread_id: this.threadId,
          timestamp: entry.timestamp,
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

  /** Whether the main session currently has an active run (derived from events). */
  isBusy(): boolean {
    const sessionId = this.state?.sessionId
    if (!sessionId) {
      return false
    }
    return isSessionBusy({ events: this.eventBuffer, sessionId })
  }

  private async persistIngressVariant({
    sessionId,
    channelId,
    appId,
    agentPreference,
    getClient,
    variant,
  }: {
    sessionId: string
    channelId?: string
    appId?: string
    agentPreference?: string
    getClient: Awaited<ReturnType<typeof initializeOpencodeForDirectory>>
    variant?: string
  }) {
    if (!variant) return
    if (getClient instanceof Error) return
    const variantModelInfo = await getCurrentModelInfo({
      sessionId,
      channelId,
      appId,
      agentPreference,
      getClient,
      directory: this.sdkDirectory,
    })
    if (variantModelInfo.type === 'none') return
    const modelsResponse = await getClient()
      .model.list({ location: { directory: this.sdkDirectory } })
      .catch((e) => new OpenCodeSdkError({ operation: 'model.list', cause: e }))
    if (modelsResponse instanceof Error || !modelsResponse.data) return
    const matchedVariant = matchThinkingValue({
      requestedValue: variant,
      availableValues: getThinkingValuesForModel({
        providers: thinkingProvidersFromListedModels({ models: [...modelsResponse.data] }),
        providerId: variantModelInfo.providerID,
        modelId: variantModelInfo.modelID,
      }),
    })
    if (!matchedVariant) return
    await setSessionModel({
      sessionId,
      modelId: variantModelInfo.model,
      variant: matchedVariant,
    })
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
    if (!isDerivedChildSession({
      events: this.eventBuffer,
      mainSessionId,
      candidateSessionId,
    })) {
      return undefined
    }

    const label = getDerivedSubtaskLabel({
      events: this.eventBuffer,
      mainSessionId,
      candidateSessionId,
    })
    if (!label) return undefined
    const assistantMessageId = this.getLatestAssistantMessageIdForCurrentTurn({
      sessionId: candidateSessionId,
    })
    return { label, assistantMessageId }
  }

  // ── Lifecycle ────────────────────────────────────────────────

  abortDeletedDiscordResource(): void {
    if (this.getDerivedPhase() === 'running') {
      void this.abortActiveRunInternal({
        reason: 'discord-resource-deleted',
      }).apiAbortPromise
    }
  }

  dispose(): void {
    this.disposed = true
    unregisterEventListener(this.threadId)
    void this.persistEventBufferDebounced.dispose()
    this.deferredQuestionShow.clear()
    this.stopTyping()

    // Release large internal buffers so GC can reclaim memory immediately
    // instead of waiting for the runtime object itself to become unreachable.
    this.eventBuffer = []
    this.nextEventIndex = 0
    this.partBuffer.clear()
    this.shownQuestionRequestIds.clear()
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
    event: EventBufferEvent,
  ): EventBufferEvent {
    this.pruneLargeStringsForEventBuffer(event, new WeakSet<object>())
    return event
  }

  private compactEventForEventBuffer(
    event: EventBufferEvent,
  ): EventBufferEvent | undefined {
    if (event.type === 'queue.question-handoff-started') {
      return this.finalizeCompactedEventForEventBuffer(structuredClone(event))
    }

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
      if (info.role === 'user' && typeof info.id === 'string' && typeof info.system === 'string') {
        this.userSystemByMessageId.set(info.id, info.system)
      }
      delete info.system
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

  private appendEventToBuffer(event: EventBufferEvent): void {
    const compactedEvent = this.compactEventForEventBuffer(event)
    if (!compactedEvent) {
      return
    }
    if (!shouldRetainSessionEvent({
      event: compactedEvent,
      mainSessionId: this.state?.sessionId,
      isKnownChildSession: (candidateSessionId) => {
        return Boolean(this.getSubtaskInfoForSession(candidateSessionId))
      },
    })) {
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
    this.eventBuffer = trimEventBuffer({
      events: this.eventBuffer,
      mainSessionId: this.state?.sessionId,
      max: ThreadSessionRuntime.EVENT_BUFFER_MAX,
      isKnownChildSession: (candidateSessionId) => {
        return Boolean(this.getSubtaskInfoForSession(candidateSessionId))
      },
    })
    this.persistEventBufferDebounced.trigger()
  }

  // Queue-dispatch lifecycle markers are synthetic buffer-only events.
  // They are not fed into handleEvent(), so they do not emit Discord messages;
  // they only stabilize event-derived busy/idle gating for local queue drains.
  private markQueueDispatchBusy(sessionId: string): void {
    this.appendEventToBuffer({
      id: `synthetic-${crypto.randomUUID()}`,
      type: 'session.status',
      properties: {
        sessionID: sessionId,
        status: { type: 'busy' },
      },
    })
    this.ensureTypingNow()
  }

  private markQueueDispatchIdle(sessionId: string): void {
    this.appendEventToBuffer({
      id: `synthetic-${crypto.randomUUID()}`,
      type: 'session.idle',
      properties: {
        sessionID: sessionId,
      },
    })
  }

  private markQuestionQueueHandoffStarted(sessionId: string): void {
    this.appendEventToBuffer({
      type: 'queue.question-handoff-started',
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
    predicate: (event: EventBufferEvent) => boolean
    sinceTimestamp: number
    timeoutMs: number
    pollMs?: number
  }): Promise<EventBufferEvent | undefined> {
    const { predicate, sinceTimestamp, timeoutMs, pollMs = 50 } = opts
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      if (this.disposed) {
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

  // ── Session Demux Guard ─────────────────────────────────────
  // Events scoped to a session must match the current session.
  // Global events (tui.toast.show) bypass the guard.
  // Subtask sessions also bypass — they're tracked in subtaskSessions.

  private async handleEvent(event: OpenCodeEvent): Promise<void> {
    // session.diff can carry repeated full-file before/after snapshots and is
    // not used by event-derived runtime state, queueing, typing, or UI routing.
    const sessionId = this.state?.sessionId
    const eventSessionId = getOpencodeEventSessionId(event)
    const toastSessionId = event.type === 'tui.toast.show'
      ? extractToastSessionId({
          message: event.data.message,
        })
      : undefined
    const isGlobalEvent = event.type === 'tui.toast.show'
    const isScopedToastEvent = Boolean(toastSessionId)

    if (shouldLogSessionEvents) {
      logger.log(
        `[EVENT] type=${event.type} eventSessionId=${eventSessionId || 'none'} activeSessionId=${sessionId || 'none'} ${this.formatRunStateForLog()}`,
      )
    }

    if (!isGlobalEvent && eventSessionId && eventSessionId !== sessionId) {
      if (!this.getSubtaskInfoForSession(eventSessionId)) {
        return
      }
    }
    if (isScopedToastEvent && toastSessionId !== sessionId) {
      if (!this.getSubtaskInfoForSession(toastSessionId!)) {
        return
      }
    }

    if (event.type === 'session.text.delta') {
      this.applyV2TextDelta(event)
      return
    }
    if (event.type === 'session.reasoning.delta') {
      this.applyV2ReasoningDelta(event)
      return
    }
    if (isEphemeralV2StreamEvent(event)) {
      return
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
      case 'session.renamed':
        await this.handleSessionRenamed(event.data)
        break
      case 'session.text.started':
        this.handleV2TextStarted(event)
        break
      case 'session.text.ended':
        await this.handleV2TextEnded(event)
        break
      case 'session.reasoning.started':
        this.handleV2ReasoningStarted(event)
        break
      case 'session.reasoning.ended':
        await this.handleV2ReasoningEnded(event)
        break
      case 'session.tool.input.started':
        this.v2ToolNames.set(
          discordToolPartId({
            messageID: event.data.assistantMessageID,
            toolId: event.data.id,
          }),
          event.data.name,
        )
        break
      case 'session.tool.called':
        await this.handleV2ToolCalled(event)
        break
      case 'session.tool.success':
        await this.handleV2ToolSuccess(event)
        break
      case 'session.tool.failed':
        await this.handleV2ToolFailed(event)
        break
      case 'session.execution.succeeded':
        await completeScheduledTaskRunsForSession(event.data.sessionID)
        await this.handleV2ExecutionSucceeded(event)
        break
      case 'session.execution.interrupted':
        await this.handleV2ExecutionInterrupted(event)
        break
      case 'session.execution.failed':
        await failScheduledTaskRunsForSession({
          sessionId: event.data.sessionID,
          error: 'Session failed',
        })
        await this.handleV2ExecutionFailed(event)
        break
      case 'session.status':
        await this.handleSessionStatus({
          sessionID: event.data.sessionID,
          status: event.data.status,
        })
        break
      case 'session.step.started':
        if (event.data.sessionID === this.state?.sessionId) {
          this.restartTypingKeepalive({ sendNow: true })
          await this.showContextUsageNotice(event.data.sessionID)
        }
        break
      case 'permission.asked':
        await this.handlePermissionAsked(event.data)
        break
      case 'permission.replied':
        this.handlePermissionReplied({
          sessionID: event.data.sessionID,
          requestID: event.data.requestID,
          reply: event.data.reply,
        })
        break
      case 'form.created':
        await this.handleV2FormCreated(event)
        break
      case 'session.inbox.enqueued':
        this.v2InboxItems.set(event.data.inboxID, {
          delivery: event.data.item.delivery,
          text: 'payload' in event.data.item && event.data.item.payload && 'text' in event.data.item.payload
            ? String(event.data.item.payload.text ?? '')
            : '',
        })
        break
      case 'session.inbox.cancelled':
        this.v2InboxItems.delete(event.data.inboxID)
        break
      case 'session.inbox.delivered':
        await this.handleV2InboxDelivered(event)
        break
      case 'session.execution.started':
        this.v2ExecutionStartedAt.set(event.data.sessionID, Date.now())
        if (event.data.sessionID === this.state?.sessionId) {
          this.ensureTypingNow()
        }
        break
      case 'tui.toast.show':
        await this.handleTuiToast({
          message: event.data.message,
          variant: event.data.variant,
          title: event.data.title,
          duration: event.data.duration,
        })
        break
      default:
        break
    }
  }

  private handleV2TextStarted(event: Extract<V2Event, { type: 'session.text.started' }>): void {
    this.v2OpenTextMessageIds.add(event.data.assistantMessageID)
    this.storePart({
      id: discordTextPartId({
        messageID: event.data.assistantMessageID,
        ordinal: event.data.ordinal,
      }),
      type: 'text',
      sessionID: event.data.sessionID,
      messageID: event.data.assistantMessageID,
      text: '',
      time: { start: Date.now() },
    })
  }

  private applyV2TextDelta(event: Extract<V2Event, { type: 'session.text.delta' }>): void {
    const partId = discordTextPartId({
      messageID: event.data.assistantMessageID,
      ordinal: event.data.ordinal,
    })
    const existing = this.partBuffer.get(event.data.assistantMessageID)?.get(partId)
    if (!existing || existing.type !== 'text') {
      this.v2OpenTextMessageIds.add(event.data.assistantMessageID)
      this.storePart({
        id: partId,
        type: 'text',
        sessionID: event.data.sessionID,
        messageID: event.data.assistantMessageID,
        text: event.data.delta,
        time: { start: Date.now() },
      })
      return
    }
    this.storePart({
      ...existing,
      text: `${existing.text || ''}${event.data.delta}`,
    })
  }

  private async handleV2TextEnded(event: Extract<V2Event, { type: 'session.text.ended' }>): Promise<void> {
    this.v2OpenTextMessageIds.delete(event.data.assistantMessageID)
    const part: DiscordSessionPart = {
      id: discordTextPartId({
        messageID: event.data.assistantMessageID,
        ordinal: event.data.ordinal,
      }),
      type: 'text',
      sessionID: event.data.sessionID,
      messageID: event.data.assistantMessageID,
      text: event.data.text,
      time: { start: Date.now(), end: Date.now() },
    }
    this.storePart(part)
    await this.routeFoldedPart(part)
    await this.tryShowPendingV2Question()
  }

  private handleV2ReasoningStarted(event: Extract<V2Event, { type: 'session.reasoning.started' }>): void {
    this.storePart({
      id: discordReasoningPartId({
        messageID: event.data.assistantMessageID,
        ordinal: event.data.ordinal,
      }),
      type: 'reasoning',
      sessionID: event.data.sessionID,
      messageID: event.data.assistantMessageID,
      text: '',
      time: { start: Date.now() },
    })
  }

  private applyV2ReasoningDelta(event: Extract<V2Event, { type: 'session.reasoning.delta' }>): void {
    const partId = discordReasoningPartId({
      messageID: event.data.assistantMessageID,
      ordinal: event.data.ordinal,
    })
    const existing = this.partBuffer.get(event.data.assistantMessageID)?.get(partId)
    if (!existing || existing.type !== 'reasoning') {
      this.storePart({
        id: partId,
        type: 'reasoning',
        sessionID: event.data.sessionID,
        messageID: event.data.assistantMessageID,
        text: event.data.delta,
        time: { start: Date.now() },
      })
      return
    }
    this.storePart({
      ...existing,
      text: `${existing.text || ''}${event.data.delta}`,
    })
  }

  private async handleV2ReasoningEnded(event: Extract<V2Event, { type: 'session.reasoning.ended' }>): Promise<void> {
    const part: DiscordSessionPart = {
      id: discordReasoningPartId({
        messageID: event.data.assistantMessageID,
        ordinal: event.data.ordinal,
      }),
      type: 'reasoning',
      sessionID: event.data.sessionID,
      messageID: event.data.assistantMessageID,
      text: event.data.text,
      time: { start: Date.now(), end: Date.now() },
    }
    this.storePart(part)
    await this.routeFoldedPart(part)
  }

  private toolPartId(event: { data: { id: string; assistantMessageID: string } }) {
    return discordToolPartId({
      messageID: event.data.assistantMessageID,
      toolId: event.data.id,
    })
  }

  private async handleV2ToolCalled(event: Extract<V2Event, { type: 'session.tool.called' }>): Promise<void> {
    const partId = this.toolPartId(event)
    const toolName = this.v2ToolNames.get(partId) || 'tool'
    const part: DiscordSessionPart = {
      id: partId,
      type: 'tool',
      sessionID: event.data.sessionID,
      messageID: event.data.assistantMessageID,
      tool: toolName,
      state: {
        status: 'running',
        input: event.data.input as Record<string, unknown>,
        raw: '',
      },
    }
    this.storePart(part)
    await this.routeFoldedPart(part)
  }

  private async handleV2ToolSuccess(event: Extract<V2Event, { type: 'session.tool.success' }>): Promise<void> {
    const partId = this.toolPartId(event)
    const existing = this.partBuffer.get(event.data.assistantMessageID)?.get(partId)
    const toolName = existing && existing.type === 'tool'
      ? existing.tool
      : this.v2ToolNames.get(partId) || 'tool'
    const output = event.data.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n')
    const part: DiscordSessionPart = {
      id: partId,
      type: 'tool',
      sessionID: event.data.sessionID,
      messageID: event.data.assistantMessageID,
      tool: toolName,
      state: {
        status: 'completed',
        input: existing && existing.type === 'tool' ? existing.state.input : {},
        output,
        metadata: event.data.metadata ?? {},
        time: { start: Date.now(), end: Date.now() },
      },
    }
    this.storePart(part)
    await this.routeFoldedPart(part)
  }

  private async handleV2ToolFailed(event: Extract<V2Event, { type: 'session.tool.failed' }>): Promise<void> {
    const partId = this.toolPartId(event)
    const existing = this.partBuffer.get(event.data.assistantMessageID)?.get(partId)
    const toolName = existing && existing.type === 'tool'
      ? existing.tool
      : this.v2ToolNames.get(partId) || 'tool'
    const part: DiscordSessionPart = {
      id: partId,
      type: 'tool',
      sessionID: event.data.sessionID,
      messageID: event.data.assistantMessageID,
      tool: toolName,
      state: {
        status: 'error',
        input: existing && existing.type === 'tool' ? existing.state.input : {},
        error: event.data.error.message || 'Tool failed',
        time: { start: Date.now(), end: Date.now() },
      },
    }
    this.storePart(part)
    await this.routeFoldedPart(part)
  }

  private async routeFoldedPart(part: DiscordSessionPart): Promise<void> {
    const subtaskInfo = this.getSubtaskInfoForSession(part.sessionID)
    if (subtaskInfo) {
      await this.handleSubtaskPart(part, subtaskInfo)
      return
    }
    await this.handleMainPart(part)
  }

  private async handleV2ExecutionSucceeded(event: Extract<V2Event, { type: 'session.execution.succeeded' }>): Promise<void> {
    const sessionId = event.data.sessionID
    if (sessionId !== this.state?.sessionId) {
      return
    }
    this.stopTyping()
    await this.flushCurrentTurnParts({ mode: 'final', repulseTyping: false })
    if (hasVisibleV2OutputSinceExecutionStart({
      events: this.eventBuffer,
      sessionId,
    })) {
      const runStartTime = this.v2ExecutionStartedAt.get(sessionId) ?? Date.now()
      await this.emitFooter({
        completedAt: Date.now(),
        runStartTime,
      })
    }
    this.resetPerRunState()
    await this.tryDrainQueue({ showIndicator: true })
  }

  private async handleV2ExecutionInterrupted(event: Extract<V2Event, { type: 'session.execution.interrupted' }>): Promise<void> {
    if (event.data.sessionID !== this.state?.sessionId) {
      return
    }
    this.stopTyping()
    this.resetPerRunState()
  }

  private async handleV2ExecutionFailed(event: Extract<V2Event, { type: 'session.execution.failed' }>): Promise<void> {
    if (event.data.sessionID !== this.state?.sessionId) {
      return
    }
    this.stopTyping()
    const errorMessage = event.data.error.message.trim() || 'Session failed'
    const sendResult = await sendThreadMessage(
      this.thread,
      `✗ ${errorMessage}`,
      { flags: NOTIFY_MESSAGE_FLAGS },
    ).catch((e) => new DiscordOperationError({ operation: 'sendMessage', cause: e }))
    if (sendResult instanceof Error) {
      discordLogger.error('Failed to send execution error:', sendResult)
    }
    this.resetPerRunState()
    await this.tryDrainQueue({ showIndicator: true })
  }

  private async handleV2InboxDelivered(event: Extract<V2Event, { type: 'session.inbox.delivered' }>): Promise<void> {
    const item = this.v2InboxItems.get(event.data.inboxID)
    this.v2InboxItems.delete(event.data.inboxID)
    if (!item || item.delivery !== 'queue') {
      return
    }
    if (!item.text.trim()) {
      return
    }
    const username = this.state?.sessionUsername || 'user'
    await sendThreadMessage(this.thread, `» **${username}:** ${item.text}`, {
      flags: SILENT_MESSAGE_FLAGS,
    }).catch((e) => new DiscordOperationError({ operation: 'sendMessage', cause: e }))
  }

  private async handleV2FormCreated(event: Extract<V2Event, { type: 'form.created' }>): Promise<void> {
    const form = event.data.form
    const metadata = form.metadata
    if (!metadata || metadata.kind !== 'question') {
      return
    }
    const sessionId = this.state?.sessionId
    if (!sessionId || form.sessionID !== sessionId) {
      return
    }
    const questions = form.fields.flatMap((field) => {
      if (field.type !== 'string' && field.type !== 'multiselect') {
        return []
      }
      const options = (field.options ?? []).map((option) => {
        return {
          label: option.label,
          description: option.description || '',
          value: option.value,
        }
      })
      return [{
        question: field.description || field.title || field.key,
        header: field.title || field.key,
        key: field.key,
        options,
        multiple: field.type === 'multiselect',
      }]
    })
    if (questions.length === 0) {
      return
    }
    const tool = metadata.tool
    const messageId = (() => {
      if (!tool || typeof tool !== 'object') return undefined
      const value = Reflect.get(tool, 'messageID')
      if (typeof value !== 'string') return undefined
      return value
    })()
    this.pendingV2Question = {
      formId: form.id,
      sessionId,
      messageId,
      questions,
    }
    await this.tryShowPendingV2Question()
  }

  // form.created can arrive while session.text is still open. Wait so Discord
  // posts the plan text before the question dropdown.
  private async tryShowPendingV2Question(): Promise<void> {
    const pending = this.pendingV2Question
    if (!pending) {
      return
    }
    if (pending.messageId && this.v2OpenTextMessageIds.has(pending.messageId)) {
      return
    }
    if (!pending.messageId && this.v2OpenTextMessageIds.size > 0) {
      return
    }
    if (this.shownQuestionRequestIds.has(pending.formId)) {
      this.pendingV2Question = undefined
      return
    }
    this.shownQuestionRequestIds.add(pending.formId)
    this.pendingV2Question = undefined
    await this.showInteractiveUi({
      flushMessageId: pending.messageId,
      show: async () => {
        await showAskUserQuestionDropdowns({
          thread: this.thread,
          sessionId: pending.sessionId,
          directory: this.sdkDirectory,
          requestId: pending.formId,
          input: { questions: pending.questions },
          silent: this.getQueueLength() > 0,
        })
      },
    })
    this.maybeHandoffQueuedItemForPendingQuestion({
      sessionId: pending.sessionId,
      reason: 'question-shown',
    })
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
        const result = await action().catch((e) => new OpenCodeSdkError({ operation: 'dispatchAction', cause: e }))
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
        // Each queued action already wraps itself with .catch()
        // and calls resolve/reject, so this should not throw. But if it
        // does, the try/finally ensures we don't deadlock.
        const result = await next().catch((e) => new OpenCodeSdkError({ operation: 'processAction', cause: e }))
        if (result instanceof Error) {
          logger.error('[ACTION QUEUE] Unexpected action failure:', result)
        }
      }
    } finally {
      this.processingAction = false
    }
  }

  // ── Typing Indicator Management ─────────────────────────────

  private hasPendingQuestionUi(): boolean {
    return [...pendingQuestionContexts.values()].some((ctx) => {
      return ctx.thread.id === this.thread.id
    })
  }

  private hasPendingInteractiveUi(): boolean {
    if (this.hasPendingQuestionUi()) {
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
    if (this.disposed) {
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
    const result = await this.thread.sendTyping()
      .catch((e) => new DiscordOperationError({ operation: 'sendTyping', cause: e }))
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

  private storePart(part: DiscordSessionPart): void {
    const messageParts =
      this.partBuffer.get(part.messageID) || new Map<string, DiscordSessionPart>()
    messageParts.set(part.id, part)
    this.partBuffer.set(part.messageID, messageParts)
  }

  private getBufferedParts(messageID: string): DiscordSessionPart[] {
    return Array.from(this.partBuffer.get(messageID)?.values() ?? [])
  }

  private clearBufferedPartsForMessages(messageIDs: ReadonlyArray<string>): void {
    const uniqueMessageIDs = new Set(messageIDs)
    uniqueMessageIDs.forEach((messageID) => {
      this.partBuffer.delete(messageID)
    })
  }

  private shouldSendPlannedPart({
    part,
    mode,
  }: {
    part: DiscordSessionPart
    mode: AssistantTurnFlushMode
  }): boolean {
    if (part.type === 'tool' && part.state.status === 'pending') {
      return false
    }
    if (part.type === 'text' && !part.time?.end && mode === 'progress') {
      return false
    }
    if (part.type === 'text' && part.synthetic === true) {
      return false
    }
    return true
  }

  private getCurrentTurnParts(): DiscordSessionPart[] {
    const sessionId = this.state?.sessionId
    // V2 parts are folded by native identity and cleared at execution settlement.
    return [...this.partBuffer.values()].flatMap((parts) => {
      return [...parts.values()].filter((part) => part.sessionID === sessionId)
    })
  }

  private async unquoteFinalTextPart(): Promise<void> {
    const parts = this.getCurrentTurnParts()
    const finalPart = parts.findLast((part) => part.type === 'text' || part.type === 'tool')
    if (!finalPart || finalPart.type !== 'text') return
    const last = finalPart
    const db = await getDb()
    const row = await db.query.part_messages.findFirst({
      where: { part_id: last.id },
      columns: { message_id: true },
    }).catch((e) => new DiscordOperationError({ operation: 'getPartMessage', cause: e }))
    if (row instanceof Error) {
      discordLogger.error(`Failed to find Discord message for ${last.id}:`, row)
      return
    }
    const messageId = row?.message_id
    if (!messageId) return
    const message = await this.thread.messages.fetch(messageId)
      .catch((e) => new DiscordOperationError({ operation: 'fetchMessage', cause: e }))
    if (message instanceof Error) {
      discordLogger.error(`Failed to fetch Discord message for ${last.id}:`, message)
      return
    }
    const formatted = formatPart(last)
    const leadWithBlankLine = message.content.startsWith('\n')
    const quoted = sessionPartContent({
      content: asDiscordQuote(formatted),
      leadWithBlankLine,
    })
    if (message.content !== quoted) return
    const plain = sessionPartContent({
      content: formatted,
      leadWithBlankLine,
    })
    const edited = await message.edit({ content: plain })
      .catch((e) => new DiscordOperationError({ operation: 'editMessage', cause: e }))
    if (edited instanceof Error) {
      discordLogger.error(`ERROR: Failed to unquote final text ${last.id}:`, edited)
    }
  }

  private async flushCurrentTurnParts({
    mode,
    throughPartId,
    skipPartId,
    repulseTyping = true,
  }: {
    mode: AssistantTurnFlushMode
    throughPartId?: string
    skipPartId?: string
    repulseTyping?: boolean
  }): Promise<void> {
    const parts = this.getCurrentTurnParts()
    const planned = planAssistantTurnFlush({
      parts,
      mode,
      throughPartId,
    })
    for (const { part, quoteText } of planned.sendParts) {
      if (this.state?.sentPartIds.has(part.id)) {
        continue
      }
      if (skipPartId && part.id === skipPartId) {
        continue
      }
      if (!this.shouldSendPlannedPart({ part, mode })) {
        continue
      }
      if (part.type === 'tool' && part.tool === 'task') {
        continue
      }
      const pulseTyping =
        part.type === 'text' && part.ignored === true
          ? false
          : repulseTyping
      await this.sendPartMessage({
        part,
        quoteText,
        repulseTyping: pulseTyping,
      })
    }
  }

  private async sendPartMessage({
    part,
    repulseTyping = true,
    quoteText = false,
  }: {
    part: DiscordSessionPart
    repulseTyping?: boolean
    quoteText?: boolean
  }): Promise<void> {
    // A successful terminal fact must not repeat an already displayed live tool.
    if (part.type === 'tool' && part.state.status === 'completed'
      && this.state?.sentPartIds.has(`${part.id}:running`)) return
    const verbosity = await this.getVerbosity()
    if (verbosity === 'text_only' && part.type !== 'text') {
      return
    }
    if (verbosity === 'text_and_essential_tools') {
      if (part.type !== 'text' && !(part.type === 'tool' && isEssentialToolPart(part))) {
        return
      }
    }

    const formatted = formatPart(part)
    const quote =
      quoteText
      && shouldQuoteIntermediateTextPart({
        part,
        isLastInTurn: false,
      })
    const content = quote ? asDiscordQuote(formatted) : formatted
    if (!content.trim() || content.length === 0) {
      return
    }
    const deliveryId = part.type === 'tool'
      ? `${part.id}:${part.state.status}`
      : part.id
    if (this.state?.sentPartIds.has(deliveryId)) {
      return
    }
    // Mark as sent BEFORE the async send to prevent concurrent flushes
    // from sending the same part while this await is in-flight.
    threadState.updateThread(this.threadId, (t) => {
      const newIds = new Set(t.sentPartIds)
      newIds.add(deliveryId)
      return { ...t, sentPartIds: newIds }
    })

    const kind = sessionPartKind(part)
    const sendResult = await sendSessionPartMessage(this.thread, content, {
      leadWithBlankLine: shouldLeadWithBlankLine({
        previousKind: this.lastSentPartKind,
        nextKind: kind,
      }),
    })
      .catch((e) => new DiscordOperationError({ operation: 'sendMessage', cause: e }))
    if (sendResult instanceof Error) {
      threadState.updateThread(this.threadId, (t) => {
        const newIds = new Set(t.sentPartIds)
        newIds.delete(deliveryId)
        return { ...t, sentPartIds: newIds }
      })
      discordLogger.error(
        `ERROR: Failed to send part ${deliveryId}:`,
        sendResult,
      )
      return
    }
    this.lastSentPartKind = kind
    await setPartMessage({ partId: deliveryId, messageId: sendResult.id, threadId: this.thread.id })
    if (repulseTyping) {
      this.requestTypingRepulse()
    }
  }

  private async showInteractiveUi({
    skipPartId,
    show,
  }: {
    skipPartId?: string
    flushMessageId?: string
    show: () => Promise<void>
  }): Promise<void> {
    this.stopTyping()
    await this.flushCurrentTurnParts({
      mode: 'interactive',
      throughPartId: skipPartId,
      skipPartId,
    })
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
    const client = getOpencodeClient(this.sdkDirectory)
    if (!client) {
      return
    }
    const modelsResponse = await client.model.list({
      location: { directory: this.sdkDirectory },
    })
      .catch((e) => new OpenCodeSdkError({ operation: 'model.list', cause: e }))
    if (modelsResponse instanceof Error) {
      logger.error(
        'Failed to fetch provider info for context limit:',
        modelsResponse,
      )
      return
    }
    const model = modelsResponse.data.find((candidate) => {
      return candidate.providerID === providerID && candidate.modelID === modelID
    })
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

    if (msg.role !== 'assistant') {
      return
    }
    if (msg.summary === true) {
      this.clearBufferedPartsForMessages([msg.id])
      logger.info(`[SKIP] message.updated for compaction summary ${msg.id}`)
      return
    }
    if (msg.sessionID !== sessionId) {
      const subtaskInfo = this.getSubtaskInfoForSession(msg.sessionID)
      if (subtaskInfo) {
        for (const part of this.getBufferedParts(msg.id)) {
          await this.handleSubtaskPart(part, subtaskInfo)
        }
      }
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
      this.clearBufferedPartsForMessages([msg.id])
      logger.info(`[SKIP] message.updated for old assistant message ${msg.id}, not in latest user turn`)
      return
    }

    const knownMessage = this.partBuffer.has(msg.id)

    // Seed the part buffer from message.parts when we have not seen per-part
    // events for this message.
    if (!knownMessage) {
      const messageParts = (() => {
        const candidate: { parts?: unknown } = msg as { parts?: unknown }
        if (!Array.isArray(candidate.parts)) {
          return [] as DiscordSessionPart[]
        }
        return candidate.parts.filter((part): part is DiscordSessionPart => {
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

    await this.flushCurrentTurnParts({
      mode: 'progress',
    })

    const wasAlreadyCompleted = hasAssistantMessageCompletedBefore({
      events: this.eventBuffer,
      sessionId,
      messageId: msg.id,
      upToIndex: this.eventBuffer.length - 2,
    })
    const completedAt = msg.time.completed
    if (!wasAlreadyCompleted && typeof completedAt === 'number') {
      if (isAssistantMessageNaturalCompletion({ message: msg })) {
        await this.handleNaturalAssistantCompletion({
          completedMessageId: msg.id,
          completedAt,
        })
        return
      }
      await this.maybeNotifyPromptCacheClear({ sessionId, messageId: msg.id })
    }

    await this.showContextUsageNotice(sessionId)
  }

  // Show prior-step usage at the next V2 step, not immediately above the footer.
  private async showContextUsageNotice(sessionId: string): Promise<void> {
    if (!isSessionBusy({
      events: this.eventBuffer,
      sessionId,
    })) {
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
    const chunk = asSubtext(`context usage ${currentPercentage}%`)
    const sendResult = await this.thread.send({ content: chunk, flags: SILENT_MESSAGE_FLAGS })
      .catch((e) => new DiscordOperationError({ operation: 'sendMessage', cause: e }))
    if (sendResult instanceof Error) {
      discordLogger.error('Failed to send context usage notice:', sendResult)
    }
  }

  private async handlePartUpdated(part: DiscordSessionPart): Promise<void> {
    const sessionId = this.state?.sessionId
    const messageKind = getAssistantMessageKind({
      events: this.eventBuffer,
      sessionId: part.sessionID,
      messageId: part.messageID,
    })

    if (messageKind === 'summary') {
      this.clearBufferedPartsForMessages([part.messageID])
      logger.info(`[SKIP] message.part.updated for compaction summary ${part.messageID}`)
      return
    }

    if (part.type === 'text' && part.synthetic === true) {
      return
    }

    if (part.type === 'text' && part.ignored === true) {
      await this.sendPartMessage({ part, repulseTyping: false })
      return
    }

    this.storePart(part)

    if (messageKind === 'unknown') {
      return
    }

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

  private async handleMainPart(part: DiscordSessionPart): Promise<void> {
    const sessionId = this.state?.sessionId

    if (part.type === 'tool' && part.state.status === 'running') {
      await this.flushCurrentTurnParts({
        mode: 'progress',
      })
      const held = planAssistantTurnFlush({
        parts: this.getCurrentTurnParts(),
        mode: 'progress',
      }).hold.some((entry) => entry.id === part.id)
      if (held) {
        return
      }
      if (!this.state?.sentPartIds.has(part.id) && part.tool !== 'task') {
        await this.sendPartMessage({ part })
      }

      if (part.tool === 'task' && !this.state?.sentPartIds.has(`${part.id}:running`)) {
        const taskDisplay = formatTaskToolTitle(part)
        if (taskDisplay && (await this.getVerbosity()) !== 'text_only') {
          threadState.updateThread(this.threadId, (t) => {
            const newIds = new Set(t.sentPartIds)
            newIds.add(`${part.id}:running`)
            return { ...t, sentPartIds: newIds }
          })
          const sendResult = await sendSessionPartMessage(this.thread, taskDisplay, {
            leadWithBlankLine: shouldLeadWithBlankLine({
              previousKind: this.lastSentPartKind,
              nextKind: 'tool',
            }),
          })
            .catch((e) => new DiscordOperationError({ operation: 'sendMessage', cause: e }))
          if (sendResult instanceof Error) {
            threadState.updateThread(this.threadId, (t) => {
              const newIds = new Set(t.sentPartIds)
              newIds.delete(`${part.id}:running`)
              return { ...t, sentPartIds: newIds }
            })
            discordLogger.error(
              `ERROR: Failed to send task part ${part.id}:`,
              sendResult,
            )
            return
          }
          this.lastSentPartKind = 'tool'
          await setPartMessage({ partId: `${part.id}:running`, messageId: sendResult.id, threadId: this.thread.id })
        }
      }
      return
    }

    if (part.type === 'tool' && part.state.status === 'error') {
      await this.sendPartMessage({ part, repulseTyping: true })
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
          const showResult = await showActionButtons({
            thread: this.thread,
            sessionId: request.sessionId,
            directory: request.directory,
            buttons: request.buttons,
            silent: this.getQueueLength() > 0,
          }).catch((e) => new DiscordOperationError({ operation: 'showActionButtons', cause: e }))
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
          const chunk = asSubtext(`${STATUS_PREFIX}${part.tool} returned ${formattedTokens} tokens${percentageSuffix}`)
          const largeOutputResult = await this.thread.send({
            content: chunk,
            flags: SILENT_MESSAGE_FLAGS,
          }).catch((e) => new DiscordOperationError({ operation: 'sendMessage', cause: e }))
          if (largeOutputResult instanceof Error) {
            discordLogger.error('Failed to send large output notice:', largeOutputResult)
          }
        }
      }
    }

    if (part.type === 'reasoning') {
      await this.flushCurrentTurnParts({ mode: 'progress' })
      return
    }

    if (part.type === 'text') {
      await this.flushCurrentTurnParts({ mode: 'progress' })
      if (part.time?.end) {
        await this.tryShowPendingQuestion()
      }
      return
    }

  }

  private async handleSubtaskPart(
    part: DiscordSessionPart,
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
    const kind = sessionPartKind(part)
    const sendResult = await sendSessionPartMessage(this.thread, content, {
      leadWithBlankLine: shouldLeadWithBlankLine({
        previousKind: this.lastSentPartKind,
        nextKind: kind,
      }),
    })
      .catch((e) => new DiscordOperationError({ operation: 'sendMessage', cause: e }))
    if (sendResult instanceof Error) {
      discordLogger.error(
        `ERROR: Failed to send subtask part ${part.id}:`,
        sendResult,
      )
      return
    }
    this.lastSentPartKind = kind
    threadState.updateThread(this.threadId, (t) => {
      const newIds = new Set(t.sentPartIds)
      newIds.add(part.id)
      return { ...t, sentPartIds: newIds }
    })
    await setPartMessage({ partId: part.id, messageId: sendResult.id, threadId: this.thread.id })
    this.requestTypingRepulse()
  }

  private trackIdleTokenUsage({
    sessionId,
    idleEventIndex,
  }: {
    sessionId: string
    idleEventIndex: number
  }): void {
    const usage = getIdleTokenUsageDelta({
      events: this.eventBuffer,
      sessionId,
      idleEventIndex,
    })
    if (!usage) {
      return
    }

    const properties: AnalyticsProps = {
      tokens_input: usage.input,
      tokens_output: usage.output,
      tokens_reasoning: usage.reasoning,
      tokens_cache_read: usage.cacheRead,
      tokens_cache_write: usage.cacheWrite,
      tokens_total: usage.total,
      cost: usage.cost,
      assistant_message_count: usage.assistantMessageCount,
      is_subagent: Boolean(this.getSubtaskInfoForSession(sessionId)),
    }
    if (usage.model) {
      properties.model = usage.model
    }
    if (usage.providerID) {
      properties.provider = usage.providerID
    }
    trackEvent('tokens_used', properties)
  }

  private trackIdleTokenUsageForSessionTree(idleSessionId: string): void {
    let idleEventIndex: number | undefined
    for (let i = this.eventBuffer.length - 1; i >= 0; i--) {
      const event = this.eventBuffer[i]?.event
      if (event?.type === 'session.idle' && getOpencodeEventSessionId(event) === idleSessionId) {
        idleEventIndex = i
        break
      }
    }
    if (idleEventIndex === undefined) {
      return
    }
    const mainSessionId = this.state?.sessionId
    const sessionIds = mainSessionId
      ? getTokenUsageSessionIdsForIdle({
        events: this.eventBuffer,
        mainSessionId,
        idleSessionId,
        upToIndex: idleEventIndex,
      })
      : [idleSessionId]
    for (const sessionId of sessionIds) {
      this.trackIdleTokenUsage({
        sessionId,
        idleEventIndex,
      })
    }
  }

  private async handleSessionIdle(idleSessionId: string): Promise<void> {
    this.trackIdleTokenUsageForSessionTree(idleSessionId)

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

    await this.flushCurrentTurnParts({
      mode: 'final',
      repulseTyping: false,
    })
    await this.unquoteFinalTextPart()

    await this.maybeNotifyPromptCacheClear({
      sessionId,
      messageId: completedMessageId,
    })

    // Skip footer if model produced no visible output (no text, no tool calls,
    // just step-start/step-finish lifecycle parts). This happens when the model
    // decides not to respond.
    const hasVisibleOutput = assistantMessageIds.some((msgId) => {
      return this.getBufferedParts(msgId).length > 0
    })
    if (!hasVisibleOutput) {
      this.stopTyping()
      this.resetPerRunState()
      this.clearBufferedPartsForMessages(assistantMessageIds)
      logger.log(
        `[ASSISTANT COMPLETED] no visible output, skipping footer for message ${completedMessageId} sessionId=${sessionId}`,
      )
      return
    }

    this.stopTyping()

    const turnStartTime = getCurrentTurnStartTime({
      events: this.eventBuffer,
      sessionId,
    })
    if (turnStartTime !== undefined) {
      // Track before Discord footer side effects so successful turns are
      // counted even when footer delivery fails.
      const durationSec = Math.max(
        0,
        Math.round((completedAt - turnStartTime) / 1000),
      )
      trackEvent('turn_completed', {
        duration_sec: durationSec,
      })
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

    const errorMessage = truncateSessionErrorMessage(
      formatSessionErrorFromProps(properties.error),
    )
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

    const threadPermissions = pendingPermissions.get(this.thread.id)
    const existingPending = threadPermissions
      ? Array.from(threadPermissions.values()).find((pending) => {
          if (pending.directory !== this.sdkDirectory) {
            return false
          }
          return canGroupPermissionRequests({ permission, existing: pending.permission })
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
        directory: this.sdkDirectory,
        contextHash: existingPending.contextHash,
      })
      const added = addPermissionRequestToContext({
        contextHash: existingPending.contextHash,
        permission,
      })
      if (!added) {
        logger.log(
          `[PERMISSION] Failed to attach duplicate request ${permission.id} to context`,
        )
      }
      return
    }

    logger.log(
      `Permission requested: action=${permission.action}, resources=${permission.resources.join(', ')}${subtaskLabel ? `, subtask=${subtaskLabel}` : ''}`,
    )

    this.stopTyping()

    const { messageId, contextHash } = await showPermissionButtons({
      thread: this.thread,
      permission,
      directory: this.sdkDirectory,
      subtaskLabel,
    })

    if (!pendingPermissions.has(this.thread.id)) {
      pendingPermissions.set(this.thread.id, new Map())
    }
    pendingPermissions.get(this.thread.id)!.set(permission.id, {
      permission,
      messageId,
      directory: this.sdkDirectory,
      contextHash,
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
    pendingPermissionContexts.delete(pending.contextHash)
    threadPermissions.delete(properties.requestID)
    if (threadPermissions.size === 0) {
      pendingPermissions.delete(this.thread.id)
    }
    this.onInteractiveUiStateChanged()
  }

  private hasUnfinishedTextPart(messageID: string): boolean {
    return this.getBufferedParts(messageID).some((part) => {
      return part.type === 'text' && !part.time?.end
    })
  }

  // OpenCode emits question.asked when the tool starts, often before the
  // preceding text part gets time.end. Showing the dropdown on that event
  // holds the action queue while Discord posts, so the later text-end cannot
  // send and dumps after the queued » user: indicator. Wait for text-end.
  private async tryShowPendingQuestion({
    ignoreUnfinishedText = false,
  } = {}): Promise<boolean> {
    const sessionId = this.state?.sessionId
    if (!sessionId) {
      return false
    }

    const request = deriveLatestUnansweredQuestion({
      events: this.eventBuffer,
      sessionId,
    })
    if (!request) {
      this.deferredQuestionShow.clear()
      return false
    }
    if (
      this.shownQuestionRequestIds.has(request.id)
      || findPendingQuestionContextForRequest({
        threadId: this.thread.id,
        requestId: request.id,
      })
    ) {
      this.deferredQuestionShow.clear()
      return true
    }

    const messageId = request.tool?.messageID
    if (!ignoreUnfinishedText && messageId && this.hasUnfinishedTextPart(messageId)) {
      return false
    }

    this.shownQuestionRequestIds.add(request.id)
    await this.showInteractiveUi({
      flushMessageId: messageId,
      show: async () => {
        await showAskUserQuestionDropdowns({
          thread: this.thread,
          sessionId,
          directory: this.sdkDirectory,
          requestId: request.id,
          input: { questions: request.questions },
          silent: this.getQueueLength() > 0,
        })
      },
    })
    this.deferredQuestionShow.clear()
    this.maybeHandoffQueuedItemForPendingQuestion({
      sessionId,
      reason: 'question-shown',
    })
    return true
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

    const shown = await this.tryShowPendingQuestion()
    if (!shown) {
      this.deferredQuestionShow.trigger()
    }
  }

  private handleQuestionReplied(properties: { sessionID: string }): void {
    const sessionId = this.state?.sessionId
    if (properties.sessionID !== sessionId) {
      return
    }
    this.deferredQuestionShow.clear()
    this.onInteractiveUiStateChanged()

    // When a question is answered and the local queue has items, the model may
    // continue the same run without ever reaching the local-queue idle gate.
    // Hand off only the next queued item to OpenCode immediately so the queue
    // resumes, but keep later items local so their `» user:` indicators still
    // appear one-by-one when they actually become active.
    this.maybeHandoffQueuedItemForPendingQuestion({
      sessionId,
      reason: 'question-replied',
    })
  }

  // Detached helper promise for the "question blocks while local queue has
  // items" flow. Prevents overlapping single-item handoffs when the question is
  // shown, answered, and new /queue items arrive close together.
  private questionQueueHandoffPromise: Promise<void> | null = null

  private maybeHandoffQueuedItemForPendingQuestion({
    sessionId,
    reason,
  }: {
    sessionId: string | undefined
    reason: 'question-shown' | 'question-replied' | 'queue-added-during-question'
  }): void {
    if (!sessionId) {
      return
    }
    if (didQuestionQueueHandoffSinceLatestQuestionAsked({
      events: this.eventBuffer,
      sessionId,
    })) {
      return
    }
    if (this.getQueueLength() === 0) {
      return
    }
    if (this.questionQueueHandoffPromise) {
      return
    }
    logger.log(
      `[QUESTION QUEUE HANDOFF] Queue has ${this.getQueueLength()} items, handing off first item (${reason})`,
    )
    this.questionQueueHandoffPromise = this.handoffQueuedItemForPendingQuestion({
      sessionId,
    }).catch((error) => {
      logger.error('[QUESTION QUEUE HANDOFF] Failed to hand off queued message:', error)
      if (error instanceof Error) {
        void notifyError(error, 'Failed to hand off queued message during pending question')
      }
    }).finally(() => {
      this.questionQueueHandoffPromise = null
    })
  }

  private async handoffQueuedItemForPendingQuestion({
    sessionId,
  }: {
    sessionId: string
  }): Promise<void> {
    if (this.disposed) {
      return
    }
    if (this.state?.sessionId !== sessionId) {
      logger.log(
        `[QUESTION QUEUE HANDOFF] Session changed before queue handoff for thread ${this.threadId}`,
      )
      return
    }

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
        `${QUEUE_PREFIX}**${next.username}:** ${displayText}`,
      )
    }

    this.markQuestionQueueHandoffStarted(sessionId)
    await this.submitViaOpencodeQueue(next)
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

    const chunk = asSubtext(`${message} - retrying in ${duration} (attempt #${attempt})`)
    const retryResult = await this.thread.send({ content: chunk, flags: SILENT_MESSAGE_FLAGS })
      .catch((e) => new DiscordOperationError({ operation: 'sendMessage', cause: e }))
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
  private async handleSessionRenamed(info: Extract<V2Event, { type: 'session.renamed' }>['data']): Promise<void> {
    // Only act on the main session for this thread
    if (info.sessionID !== this.state?.sessionId) {
      return
    }
    const normalizedTitle = info.title.trim()
    if (this.appliedOpencodeTitle === normalizedTitle) {
      return
    }
    const desiredName = deriveThreadNameFromSessionTitle({
      sessionTitle: info.title,
      currentName: this.thread.name,
    })
    // Mark before setName so concurrent session.renamed events don't stack
    // renames. Keep the mark on failure — retry is almost always a rate limit.
    this.appliedOpencodeTitle = normalizedTitle
    if (!desiredName) {
      return
    }

    const renameResult = await raceDiscordRename({
      rename: this.thread.setName(desiredName)
        .catch((e) =>
          new Error('Failed to rename thread from OpenCode title', {
            cause: e,
          }),
        ),
    })

    if (renameResult === 'timeout') {
      logger.warn(
        `[TITLE] setName timed out after ${DISCORD_THREAD_RENAME_TIMEOUT_MS}ms for thread ${this.threadId} (likely rate-limited)`,
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
    const toastSessionId = extractToastSessionId({ message: properties.message })
    if (!toastSessionId) {
      return
    }
    const toastMessage = stripToastSessionId({ message: properties.message }).trim()
    if (!toastMessage) {
      return
    }
    const titlePrefix = properties.title
      ? `${properties.title.trim()}: `
      : ''
    const chunk = asSubtext(`${properties.variant}: ${titlePrefix}${toastMessage}`)
    const toastResult = await this.thread.send({ content: chunk, flags: SILENT_MESSAGE_FLAGS })
      .catch((e) => new DiscordOperationError({ operation: 'sendMessage', cause: e }))
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
   * recovery so that session.prompt receives the same agent/model/variant/system
   * fields that the local-queue path provides.
   */
  private async submitViaOpencodeQueue(input: IngressInput): Promise<EnqueueResult> {
    await this.supersedePendingSleep(input)
    if (this.abortInFlight) {
      await this.abortInFlight
      const sessionId = this.state?.sessionId
      if (sessionId) {
        await this.waitForEvent({
          predicate: (event) => isSessionSettledEvent({ event, sessionId }),
          sinceTimestamp: Date.now() - 10_000,
          timeoutMs: 2_000,
        })
      }
    }
    let skippedBySessionGuard = false

    await this.dispatchAction(async () => {
      if (
        input.expectedSessionId &&
        this.state?.sessionId !== input.expectedSessionId
      ) {
        logger.log(
          `[ENQUEUE] Skipping stale session.prompt enqueue for thread ${this.threadId}: expected session ${input.expectedSessionId}, current session ${this.state?.sessionId || 'none'}`,
        )
        skippedBySessionGuard = true
        return
      }

      // Context-only messages (noReply) should not create a new session.
      // If there is no existing session, silently skip.
      if (input.noReply) {
        const existingSessionId = this.state?.sessionId || await getThreadSession(this.thread.id) || undefined
        if (!existingSessionId) {
          logger.log(
            `[INGRESS] Skipping noReply message for thread ${this.threadId}: no existing session`,
          )
          return
        }
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

      // ── Resolve model + agent preferences (mirrors dispatchPrompt) ──
      const channelId = this.channelId
      const resolvedAppId = input.appId

      // Explicit agent prompts (for example /plan-agent <prompt>) must update
      // the session preference before dispatch. Otherwise the model can resolve
      // from the requested agent while OpenCode keeps running the old agent.
      if (input.agent) {
        await setSessionAgent(session.id, input.agent)
        await clearSessionModel(session.id)
      }

      if (input.model) {
        const validatedModel = await validateModelId({
          model: input.model,
          getClient,
          directory: this.sdkDirectory,
        })
        if (validatedModel instanceof Error) {
          await cleanupOnError(`Failed to resolve model: ${validatedModel.message}`)
          return
        }
      }

      await ensureSessionPreferencesSnapshot({
        sessionId: session.id,
        channelId,
        appId: resolvedAppId,
        getClient,
        directory: this.sdkDirectory,
        agentOverride: input.agent,
        modelOverride: input.model,
        force: createdNewSession,
      })

      const agentResult = await resolveValidatedAgentPreference({
        agent: input.agent,
        sessionId: session.id,
        channelId,
        getClient,
        directory: this.sdkDirectory,
      }).catch((e) => new OpenCodeSdkError({ operation: 'resolveAgent', cause: e }))
      if (agentResult instanceof Error) {
        await cleanupOnError(`Failed to resolve agent: ${agentResult.message}`)
        return
      }
      const resolvedAgent = agentResult.agentPreference
      const availableAgents = agentResult.agents
      const systemWriteResult = await this.persistSessionSystemInstructions({
        client: getClient(),
        sessionId: session.id,
        agents: availableAgents,
      })
      if (systemWriteResult instanceof Error) {
        await cleanupOnError(
          `✗ Failed to prepare session system prompt: ${systemWriteResult.message}`,
        )
        return
      }
      releaseCurrentThreadIngress()

      await this.persistIngressVariant({
        sessionId: session.id,
        channelId,
        appId: resolvedAppId,
        agentPreference: resolvedAgent,
        getClient,
        variant: input.variant,
      })

      const [modelResult, preferredVariant] = await Promise.all([
        (async () => {
          if (input.model) {
            return validateModelId({
              model: input.model,
              getClient,
              directory: this.sdkDirectory,
            })
          }
          const modelInfo = await getCurrentModelInfo({
            sessionId: session.id,
            channelId,
            appId: resolvedAppId,
            agentPreference: resolvedAgent,
            getClient,
            directory: this.sdkDirectory,
          })
          if (modelInfo.type === 'none') {
            return undefined
          }
          return { providerID: modelInfo.providerID, modelID: modelInfo.modelID }
        })().catch((e) => new OpenCodeSdkError({ operation: 'resolveModelPreference', cause: e })),
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
        const modelsResponse = await getClient().model.list({
          location: { directory: this.sdkDirectory },
        })
          .catch((e) => new OpenCodeSdkError({ operation: 'model.list', cause: e }))
        if (modelsResponse instanceof Error || !modelsResponse.data) {
          return undefined
        }
        const availableValues = getThinkingValuesForModel({
          providers: thinkingProvidersFromListedModels({ models: [...modelsResponse.data] }),
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

      await this.sendNewSessionModelInfo({
        createdNewSession,
        model: modelField,
        agent: resolvedAgent,
      })

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
      const worktreeInfoForPrompt = await getThreadWorktreeOrWorkspace(this.thread.id)
      const worktree: WorktreeInfo | undefined =
        worktreeInfoForPrompt?.status === 'ready' && worktreeInfoForPrompt.workspace_directory
          ? {
              worktreeDirectory: worktreeInfoForPrompt.workspace_directory,
              branch: worktreeInfoForPrompt.workspace_name,
              mainRepoDirectory: worktreeInfoForPrompt.project_directory,
            }
          : undefined

      const channelTopic = await (async () => {
        if (this.thread.parent?.type === ChannelType.GuildText) {
          return this.thread.parent.topic?.trim() || undefined
        }
        if (!channelId) {
          return undefined
        }
        const fetched = await this.thread.guild.channels.fetch(channelId)
          .catch((e) => new DiscordOperationError({ operation: 'fetchChannel', cause: e }))
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
        sessionId: session.id,
        threadId: this.thread.id,
        username: input.username,
        userId: input.userId,
        sourceMessageId: input.sourceMessageId,
        sourceThreadId: input.sourceThreadId || this.thread.id,
        threadName: this.thread.name || undefined,
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

      // TODO(anomalyco/opencode#48356): Pass agent/model/variant on prompt instead of switching session-wide selection here.
      if (resolvedAgent) {
        await getClient().session.switchAgent({
          sessionID: session.id,
          agent: resolvedAgent,
        }).catch((e) => new OpenCodeSdkError({ operation: 'session.switchAgent', cause: e }))
      }
      if (modelField) {
        await getClient().session.switchModel({
          sessionID: session.id,
          model: {
            providerID: modelField.providerID,
            id: modelField.modelID,
            ...('variant' in variantField ? { variant: variantField.variant } : {}),
          },
        }).catch((e) => new OpenCodeSdkError({ operation: 'session.switchModel', cause: e }))
      }
      const promptText = parts
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
      const files = images.map((image) => ({
        uri: image.url || image.sourceUrl || '',
        name: image.filename,
      })).filter((file) => file.uri)
      await waitForGlobalEventListener()
      const delivery = input.mode === 'local-queue' ? 'queue' : 'steer'
      const wasBusy = this.isMainSessionBusy()
      // Mark busy before prompt() so a fast v2 drain cannot finish first and
      // leave a synthetic busy event after execution.succeeded.
      if (!input.noReply) {
        this.markQueueDispatchBusy(session.id)
      }
      const promptResult = await getClient().session.prompt({
        sessionID: session.id,
        text: promptText,
        ...(files.length > 0 ? { files } : {}),
        delivery,
      }).catch((e) => new OpenCodeSdkError({ operation: 'session.prompt', cause: e }))
      // V2 steer admits the prompt but does not always wake a busy drain.
      // interrupt(continue) forces the current step to yield so the new steer
      // can run. Queue-interrupt e2e fails without this.
      if (
        !(promptResult instanceof Error) &&
        delivery === 'steer' &&
        wasBusy
      ) {
        const interruptResult = await getClient().session.interrupt({
          sessionID: session.id,
          continue: true,
        }).catch((e) => new OpenCodeSdkError({ operation: 'session.interrupt', cause: e }))
        if (interruptResult instanceof Error) {
          logger.warn(
            `[INGRESS] session.interrupt continue failed sessionId=${session.id} message=${interruptResult.message}`,
          )
        }
      }
      if (promptResult instanceof Error) {
        if (!input.noReply) {
          this.markQueueDispatchIdle(session.id)
        }
        void notifyError(promptResult, 'session.prompt failed in submitViaOpencodeQueue')
        await cleanupOnError(`✗ OpenCode API error: ${promptResult.message}`)
        return
      }

      if (input.sessionStartSource?.scheduledTaskRunId) {
        await startScheduledTaskRunSession({
          runId: input.sessionStartSource.scheduledTaskRunId,
          sessionId: session.id,
          projectDirectory: this.sdkDirectory,
        })
      }

      logger.log(
        `[INGRESS] session.prompt accepted by opencode queue sessionId=${session.id} threadId=${this.threadId}`,
      )

      if (!input.noReply) {
        trackTurnStarted({
          inputKind: input.command ? 'command' : 'prompt',
          ingressMode: 'direct',
          source: resolveTurnSource(input),
          agent: resolvedAgent,
        })
      }
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
  /**
   * A new turn supersedes a pending sleep.
   *
   * Called from the two terminal routers rather than from the top of
   * enqueueIncoming: arrival order is only fixed once a message reaches the
   * preprocessChain link, so awaiting anything before that lets two rapid
   * messages swap places. By here the order is already committed.
   *
   * Awaited rather than fire-and-forget so it cannot race the task runner and
   * let a stale wake land after the user took the conversation back.
   */
  private async supersedePendingSleep(input: IngressInput): Promise<void> {
    if (input.isSleepWake) return
    await cancelSessionSleepForThread({ threadId: this.threadId }).catch(
      (error) => {
        logger.error('[SLEEP] failed to cancel pending sleep:', error)
      },
    )
  }

  private async enqueueViaLocalQueue(input: IngressInput): Promise<EnqueueResult> {
    await this.supersedePendingSleep(input)
    const queueId = crypto.randomBytes(8).toString('hex')
    const queuedMessage: QueuedMessage = {
      queueId,
      prompt: input.prompt,
      userId: input.userId,
      username: input.username,
      images: input.images,
      appId: input.appId,
      command: input.command,
      agent: input.agent,
      model: input.model,
      variant: input.variant,
      permissions: input.permissions,
      injectionGuardPatterns: input.injectionGuardPatterns,
      parentSessionId: input.parentSessionId,
      sourceMessageId: input.sourceMessageId,
      sourceThreadId: input.sourceThreadId,
      repliedMessage: input.repliedMessage,
      sessionStartScheduleKind: input.sessionStartSource?.scheduleKind,
      sessionStartScheduledTaskId: input.sessionStartSource?.scheduledTaskId,
      analyticsSource: resolveTurnSource(input),
    }

    let result: EnqueueResult = { queued: false, queueId }

    await this.dispatchAction(async () => {
      const persistResult = await insertThreadQueueItem({
        queueId,
        threadId: this.threadId,
        payloadJson: JSON.stringify(queuedMessage),
      }).catch((error) => {
        return new Error('Failed to persist queued message', { cause: error })
      })
      if (persistResult instanceof Error) {
        logger.error(
          `[QUEUE] Failed to persist queued message ${queueId} in thread ${this.threadId}: ${persistResult.message}`,
        )
        throw persistResult
      }
      threadState.enqueueItem(this.threadId, queuedMessage)

      // Determine if the message is genuinely waiting in queue
      const stateAfterEnqueue = threadState.getThreadState(this.threadId)
      const position = stateAfterEnqueue?.queueItems.length ?? 0
      const willDrainNow = stateAfterEnqueue
        ? (
          stateAfterEnqueue.queueItems.length > 0
          && !this.isBusy()
          && !this.hasPendingQuestionUi()
          && (pendingPermissions.get(this.thread.id)?.size ?? 0) === 0
        )
        : false
      result = !willDrainNow && position > 0
        ? { queued: true, position, queueId }
        : { queued: false, queueId }

      if (this.hasPendingQuestionUi()) {
        this.maybeHandoffQueuedItemForPendingQuestion({
          sessionId: stateAfterEnqueue?.sessionId || this.state?.sessionId,
          reason: 'queue-added-during-question',
        })
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
    await waitForCurrentThreadIngress()
    threadState.setSessionUsername(this.threadId, input.username)
    const botUserId = this.thread.client.user?.id
    if (input.userId && input.userId !== botUserId) {
      threadState.setSessionUserId(this.threadId, input.userId)
    }
    await this.ensureParentSessionId({
      parentSessionId: input.parentSessionId,
    })

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
   * Resolve parent session ID for child system prompts.
   * Prefer in-memory state, then SQLite, then the ingress marker.
   * Persist once so multi-turn child sessions keep the parent after restart.
   */
  private async ensureParentSessionId({
    parentSessionId,
  }: {
    parentSessionId?: string
  }) {
    if (this.state?.parentSessionId) {
      return
    }

    const storedParentSessionId = await getThreadParentSessionId(this.threadId)
    if (storedParentSessionId) {
      threadState.setParentSessionId(this.threadId, storedParentSessionId)
      return
    }

    if (!parentSessionId) {
      return
    }

    threadState.setParentSessionId(this.threadId, parentSessionId)
    // Row may not exist yet on first ingress before ensureSession creates it.
    // Best-effort write; ensureSession path also persists after setThreadSession.
    await setThreadParentSessionId({
      threadId: this.threadId,
      parentSessionId,
    }).catch((error) => {
      logger.warn(
        `[PARENT SESSION] Failed to persist parent session for thread ${this.threadId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
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
        // noReply messages always go through the opencode path so the flag
        // reaches session.prompt; local queue doesn't support noReply.
        const enqueueResult = resolvedInput.noReply
          ? await this.submitViaOpencodeQueue({
              ...resolvedInput,
              mode: 'opencode',
              command: undefined,
            })
          : (resolvedInput.mode === 'local-queue' || resolvedInput.command)
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
    * Calls session.interrupt best-effort and lets event-stream idle settle the run.
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
    const client = getOpencodeClient(this.sdkDirectory)
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
    const abortResult = await client.session.interrupt({
      sessionID: sessionId,
    }).catch((e) => new OpenCodeSdkError({ operation: 'session.interrupt', cause: e }))
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
    const sessionIsBusy = this.isBusy()

    logger.log(
      `[ABORT] id=${abortId} reason=${reason} threadId=${this.threadId} sessionId=${sessionId || 'none'} queueLength=${state.queueItems.length} ${this.formatRunStateForLog()} sessionBusy=${sessionIsBusy}`,
    )

    this.stopTyping()
    this.deferredQuestionShow.clear()
    this.pendingV2Question = undefined

    // The aborted run owns the question request, so the dropdown dies with it.
    // Questions have no TTL, so this is the only thing that clears them here.
    void cancelPendingQuestion(this.threadId)

    const apiAbortPromise = sessionId
      ? this.abortSessionViaApi({ abortId, reason, sessionId })
      : undefined
    this.abortInFlight = apiAbortPromise ?? null
    if (apiAbortPromise) {
      void apiAbortPromise.finally(() => {
        if (this.abortInFlight === apiAbortPromise) {
          this.abortInFlight = null
        }
      })
    }

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
    void this.dispatchAction(async () => {
      await this.flushCurrentTurnParts({ mode: 'interactive', repulseTyping: false })
      this.v2OpenTextMessageIds.clear()
      return this.tryDrainQueue({ showIndicator: true })
    })
    return cleared
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
    const abortResult = await this.dispatchAction(async () => {
      needsIdleWait = this.isBusy()
      const outcome = this.abortActiveRunInternal({ reason })
      if (outcome.apiAbortPromise) {
        void outcome.apiAbortPromise
      }
    }).catch((e) => new OpenCodeSdkError({ operation: 'abortSession', cause: e }))
    if (abortResult instanceof Error) {
      logger.error(`[ABORT WAIT] Failed to abort active run: ${abortResult.message}`)
      return
    }
    if (!needsIdleWait) {
      return
    }
    await this.waitForEvent({
      predicate: (event) => isSessionSettledEvent({ event, sessionId }),
      sinceTimestamp: waitSinceTimestamp,
      timeoutMs,
    })
  }

  /** Number of messages waiting in the queue. */
  getQueueLength(): number {
    return this.state?.queueItems.length ?? 0
  }

  /** Clear all queued messages. Returns the removed items. */
  async clearQueue(): Promise<threadState.QueuedMessage[]> {
    let cleared: threadState.QueuedMessage[] = []
    await this.dispatchAction(async () => {
      cleared = await this.clearQueueNow()
    })
    return cleared
  }

  // Must run inside dispatchAction.
  private async clearQueueNow(): Promise<threadState.QueuedMessage[]> {
    const persistResult = await deleteThreadQueueItems(this.threadId).catch((error) => {
      return new Error('Failed to clear persisted queue', { cause: error })
    })
    if (persistResult instanceof Error) {
      logger.error(
        `[QUEUE] Failed to clear persisted queue for thread ${this.threadId}: ${persistResult.message}`,
      )
      return []
    }
    return threadState.clearQueueItems(this.threadId)
  }

  /** Remove a queued message by its 1-based position. */
  async removeQueuePosition(position: number): Promise<threadState.QueuedMessage | undefined> {
    let removed: threadState.QueuedMessage | undefined
    await this.dispatchAction(async () => {
      const current = this.state?.queueItems[position - 1]
      if (!current) {
        return
      }
      if (current.queueId) {
        const persistResult = await deleteThreadQueueItem(current.queueId).catch((error) => {
          return new Error('Failed to delete persisted queue item', { cause: error })
        })
        if (persistResult instanceof Error) {
          logger.error(
            `[QUEUE] Failed to delete persisted queue item ${current.queueId}: ${persistResult.message}`,
          )
          return
        }
      }
      removed = threadState.removeQueueItemAtPosition(this.threadId, position)
    })
    return removed
  }

  /** Remove a queued message by stable queue id. */
  async removeQueueItemById(queueId: string): Promise<threadState.QueuedMessage | undefined> {
    let removed: threadState.QueuedMessage | undefined
    await this.dispatchAction(async () => {
      const persistResult = await deleteThreadQueueItem(queueId).catch((error) => {
        return new Error('Failed to delete persisted queue item', { cause: error })
      })
      if (persistResult instanceof Error) {
        logger.error(
          `[QUEUE] Failed to delete persisted queue item ${queueId}: ${persistResult.message}`,
        )
        return
      }
      removed = threadState.removeQueueItemById(this.threadId, queueId)
      if (!removed && persistResult) {
        const parsed = parseQueuedMessagePayload({
          queueId: persistResult.queue_id,
          payloadJson: persistResult.payload_json,
        })
        if (!(parsed instanceof Error)) {
          removed = parsed
        }
      }
    })
    return removed
  }

  /**
   * Update a queued message identified by its Discord source message ID.
   * If newPrompt is empty, the item is removed from the queue.
   * Returns { found: true, removed } if the item was in the queue,
   * or { found: false } if it was already dispatched or never queued.
   */
  async updateQueuedMessage(
    sourceMessageId: string,
    newPrompt: string,
  ): Promise<{ found: boolean; removed: boolean }> {
    let result: { found: boolean; removed: boolean } = { found: false, removed: false }
    await this.dispatchAction(async () => {
      const trimmed = newPrompt.trim()
      const original = this.state?.queueItems.find((item) => {
        return item.sourceMessageId === sourceMessageId
      })
      if (!original) {
        result = { found: false, removed: false }
        return
      }
      const queueId = original.queueId
      if (queueId) {
        const persistResult = trimmed
          ? await updateThreadQueueItemPayload({
            queueId,
            payloadJson: JSON.stringify({ ...original, prompt: trimmed }),
          }).catch((error) => {
            return new Error('Failed to update persisted queue item', { cause: error })
          })
          : await deleteThreadQueueItem(queueId).catch((error) => {
            return new Error('Failed to delete persisted queue item', { cause: error })
          })
        if (persistResult instanceof Error) {
          logger.error(
            `[QUEUE] Failed to persist queue update for ${queueId}: ${persistResult.message}`,
          )
          result = { found: true, removed: false }
          return
        }
      }
      threadState.updateQueueItemBySourceMessageId(
        this.threadId,
        sourceMessageId,
        (item) => {
          if (!trimmed) return null
          return { ...item, prompt: trimmed }
        },
      )
      result = trimmed
        ? { found: true, removed: false }
        : { found: true, removed: true }
    })
    return result
  }

  /** Remove a queued message identified by its Discord source message ID. */
  async removeQueuedMessage(
    sourceMessageId: string,
  ): Promise<threadState.QueuedMessage | undefined> {
    let removed: threadState.QueuedMessage | undefined
    await this.dispatchAction(async () => {
      const current = this.state?.queueItems.find((item) => {
        return item.sourceMessageId === sourceMessageId
      })
      if (!current) {
        return
      }
      if (current.queueId) {
        const persistResult = await deleteThreadQueueItem(current.queueId).catch((error) => {
          return new Error('Failed to delete persisted queue item', { cause: error })
        })
        if (persistResult instanceof Error) {
          logger.error(
            `[QUEUE] Failed to delete persisted queue item ${current.queueId}: ${persistResult.message}`,
          )
          return
        }
      }
      removed = threadState.updateQueueItemBySourceMessageId(
        this.threadId,
        sourceMessageId,
        () => null,
      )
    })
    return removed
  }

  async mergeRestoredQueueAndDrain(items: QueuedMessage[]): Promise<void> {
    const current = this.state?.queueItems ?? []
    const currentIds = new Set(current.flatMap((item) => item.queueId ? [item.queueId] : []))
    threadState.replaceQueueItems(this.threadId, [
      ...items.filter((item) => item.queueId && !currentIds.has(item.queueId)),
      ...current,
    ])
    const liveStatus = await this.hydrateLiveSessionStatus()
    if (liveStatus === 'unavailable') {
      return
    }
    await this.tryDrainQueue({ showIndicator: true })
  }

  private async hydrateLiveSessionStatus(): Promise<'idle' | 'busy' | 'unavailable'> {
    const sessionId = this.state?.sessionId
    if (!sessionId) {
      return 'idle'
    }
    await this.hydrateSessionEventsFromDatabase({ sessionId })
    const getClient = await initializeOpencodeForDirectory(this.sdkDirectory)
    if (getClient instanceof Error) {
      logger.warn(
        `[QUEUE] OpenCode unavailable while restoring queue for ${this.threadId}: ${getClient.message}`,
      )
      return 'unavailable'
    }
    const statusResponse = await getClient().session.status({
      directory: this.sdkDirectory,
    }).catch((error) => {
      logger.warn(
        `[QUEUE] Failed to read session status while restoring queue for ${this.threadId}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    })
    if (!statusResponse || statusResponse.error) {
      return 'unavailable'
    }
    const sessionStatus = statusResponse.data?.[sessionId]
    if (!sessionStatus || sessionStatus.type === 'idle') {
      this.markQueueDispatchIdle(sessionId)
      return 'idle'
    }
    this.markQueueDispatchBusy(sessionId)
    return 'busy'
  }

  private async acknowledgeAcceptedQueueItem(item: QueuedMessage): Promise<void> {
    if (!item.queueId) {
      return
    }
    await this.dispatchAction(async () => {
      const persistResult = await deleteThreadQueueItem(item.queueId!).catch((error) => {
        return new Error('Failed to delete persisted queue item', { cause: error })
      })
      if (persistResult instanceof Error) {
        logger.error(
          `[QUEUE] Failed to persist accept of ${item.queueId}: ${persistResult.message}`,
        )
        return
      }
      threadState.removeQueueItemById(this.threadId, item.queueId!)
    })
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
    // v2 forms/permissions can leave the session idle while Discord UI is
    // still pending. Do not drain the local queue until the user answers or
    // the UI is dismissed. Action buttons stay fire-and-forget.
    if (this.hasPendingQuestionUi()) {
      return
    }
    if ((pendingPermissions.get(this.thread.id)?.size ?? 0) > 0) {
      return
    }

    const sessionBusy = thread.sessionId
      ? isSessionBusy({ events: this.eventBuffer, sessionId: thread.sessionId })
      : false
    if (sessionBusy) {
      return
    }

    const next = thread.queueItems.find((item) => item.queueId !== this.dispatchingQueueId)
    if (!next) {
      return
    }
    this.dispatchingQueueId = next.queueId

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
          `${QUEUE_PREFIX}**${next.username}:** ${displayText}`,
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
    let accepted = false
    void this.dispatchPrompt(next).then(async (ok) => {
      accepted = ok
      if (ok) {
        await this.acknowledgeAcceptedQueueItem(next)
      }
    }).catch(async (err) => {
      logger.error('[DISPATCH] Prompt dispatch failed:', err)
      void notifyError(err, 'Runtime prompt dispatch failed')
      if (dispatchSessionId) {
        this.markQueueDispatchIdle(dispatchSessionId)
      }
    }).finally(() => {
      this.dispatchingQueueId = undefined
      if (!accepted) {
        return
      }
      void this.dispatchAction(() => {
        return this.tryDrainQueue({ showIndicator: true })
      })
    })
  }

  // ── Prompt Dispatch ─────────────────────────────────────────
  // Resolve session, build system message, send to OpenCode.
  // The listener is already running, so this only handles
  // session ensure + model/agent + SDK call + state.

  private async dispatchPrompt(input: QueuedMessage): Promise<boolean> {
    this.lastDisplayedContextPercentage = 0
    this.lastRateLimitDisplayTime = 0
    this.lastSentPartKind = undefined

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
      return false
    }
    const { session, getClient, createdNewSession } = sessionResult

    // ── Resolve model + agent preferences ─────────────────────
    const channelId = this.channelId
    const resolvedAppId = input.appId

    // Explicit agent prompts (for example /plan-agent <prompt>) must update
    // the session preference before dispatch. Otherwise the model can resolve
    // from the requested agent while OpenCode keeps running the old agent.
    if (input.agent) {
      await setSessionAgent(session.id, input.agent)
      await clearSessionModel(session.id)
    }

    if (input.model) {
      const validatedModel = await validateModelId({
        model: input.model,
        getClient,
        directory: this.sdkDirectory,
      })
      if (validatedModel instanceof Error) {
        this.stopTyping()
        await sendThreadMessage(
          this.thread,
          `Failed to resolve model: ${validatedModel.message}`,
          { flags: NOTIFY_MESSAGE_FLAGS },
        )
        return false
      }
    }

    await ensureSessionPreferencesSnapshot({
      sessionId: session.id,
      channelId,
      appId: resolvedAppId,
      getClient,
      directory: this.sdkDirectory,
      agentOverride: input.agent,
      modelOverride: input.model,
      force: createdNewSession,
    })

    const earlyAgentResult = await resolveValidatedAgentPreference({
      agent: input.agent,
      sessionId: session.id,
      channelId,
      getClient,
      directory: this.sdkDirectory,
    }).catch((e) => new OpenCodeSdkError({ operation: 'resolveAgent', cause: e }))
    if (earlyAgentResult instanceof Error) {
      this.stopTyping()
      await sendThreadMessage(
        this.thread,
        `Failed to resolve agent: ${earlyAgentResult.message}`,
        { flags: NOTIFY_MESSAGE_FLAGS },
      )
      return false
    }
    const earlyAgentPreference = earlyAgentResult.agentPreference
    const earlyAvailableAgents = earlyAgentResult.agents

    await this.persistIngressVariant({
      sessionId: session.id,
      channelId,
      appId: resolvedAppId,
      agentPreference: earlyAgentPreference,
      getClient,
      variant: input.variant,
    })

    const [earlyModelResult, preferredVariant] = await Promise.all([
      (async () => {
        if (input.model) {
          return validateModelId({
            model: input.model,
            getClient,
            directory: this.sdkDirectory,
          })
        }
        const modelInfo = await getCurrentModelInfo({
          sessionId: session.id,
          channelId,
          appId: resolvedAppId,
          agentPreference: earlyAgentPreference,
          getClient,
          directory: this.sdkDirectory,
        })
        if (modelInfo.type === 'none') {
          return undefined
        }
        return { providerID: modelInfo.providerID, modelID: modelInfo.modelID }
      })().catch((e) => new OpenCodeSdkError({ operation: 'resolveModelPreference', cause: e })),
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
      return false
    }
    const earlyModelParam = earlyModelResult
    if (!earlyModelParam) {
      this.stopTyping()
      await sendThreadMessage(
        this.thread,
        'No AI provider connected. Configure a provider in OpenCode with `/connect` command.',
      )
      return false
    }

    // Resolve thinking variant
    const earlyThinkingValue = await (async (): Promise<string | undefined> => {
      if (!preferredVariant) {
        return undefined
      }
      const modelsResponse = await getClient().model.list({
        location: { directory: this.sdkDirectory },
      })
        .catch((e) => new OpenCodeSdkError({ operation: 'model.list', cause: e }))
      if (modelsResponse instanceof Error || !modelsResponse.data) {
        return undefined
      }
      const availableValues = getThinkingValuesForModel({
        providers: thinkingProvidersFromListedModels({ models: [...modelsResponse.data] }),
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

    await this.sendNewSessionModelInfo({
      createdNewSession,
      model: earlyModelParam,
      agent: earlyAgentPreference,
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
    const worktreeInfoForPrompt = await getThreadWorktreeOrWorkspace(this.thread.id)
    const worktree: WorktreeInfo | undefined =
      worktreeInfoForPrompt?.status === 'ready' && worktreeInfoForPrompt.workspace_directory
        ? {
            worktreeDirectory: worktreeInfoForPrompt.workspace_directory,
            branch: worktreeInfoForPrompt.workspace_name,
            mainRepoDirectory: worktreeInfoForPrompt.project_directory,
          }
        : undefined

    const channelTopic = await (async () => {
      if (this.thread.parent?.type === ChannelType.GuildText) {
        return this.thread.parent.topic?.trim() || undefined
      }
      if (!channelId) {
        return undefined
      }
      const fetched = await this.thread.guild.channels.fetch(channelId)
        .catch((e) => new DiscordOperationError({ operation: 'fetchChannel', cause: e }))
      if (fetched instanceof Error || !fetched) {
        return undefined
      }
      if (fetched.type !== ChannelType.GuildText) {
        return undefined
      }
      return fetched.topic?.trim() || undefined
    })()
    const systemWriteResult = await this.persistSessionSystemInstructions({
      client: getClient(),
      sessionId: session.id,
      agents: earlyAvailableAgents,
      channelTopic,
    })
    if (systemWriteResult instanceof Error) {
      logger.error(
        `[DISPATCH] Failed to persist system instructions for session ${session.id}: ${systemWriteResult.message}`,
      )
      void notifyError(
        systemWriteResult,
        'Failed to persist system instructions before prompt',
      )
      this.stopTyping()
      await sendThreadMessage(
        this.thread,
        `✗ Failed to prepare session system prompt: ${systemWriteResult.message}`,
        { flags: NOTIFY_MESSAGE_FLAGS },
      )
      await this.dispatchAction(() => {
        return this.tryDrainQueue({ showIndicator: true })
      })
      return
    }
    const worktreeChanged = this.consumeWorktreePromptChange(worktree)
    const syntheticContext = getOpencodePromptContext({
      sessionId: session.id,
      threadId: this.thread.id,
      username: input.username,
      userId: input.userId,
      sourceMessageId: input.sourceMessageId,
      sourceThreadId: input.sourceThreadId || this.thread.id,
      threadName: this.thread.name || undefined,
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
      // detect this message came from Discord (same tag as session.prompt).
      const discordTag = getOpencodePromptContext({
        sessionId: session.id,
        threadId: this.thread.id,
        username: input.username,
        userId: input.userId,
        sourceMessageId: input.sourceMessageId,
        sourceThreadId: input.sourceThreadId || this.thread.id,
        threadName: this.thread.name || undefined,
        repliedMessage: input.repliedMessage,
      })
      const commandResponse = await getClient().session.command(
        {
          sessionID: session.id,
          command: queuedCommand.name,
          text: queuedCommand.arguments + (discordTag ? `\n${discordTag}` : ''),
        },
        { signal: commandSignal },
      ).catch((e) => new OpenCodeSdkError({ operation: 'session.command', cause: e }))

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
          return false
        }

        const commandErrorForAbortCheck: unknown = commandResponse
        if (isAbortError(commandErrorForAbortCheck)) {
          logger.log(
            `[DISPATCH] Command aborted (expected) sessionId=${session.id}`,
          )
          this.stopTyping()
          return true
        }

        const commandCause = commandResponse.cause
        const commandNotFoundName = (() => {
          const parsed = parseOpenCodeErrorMessage(commandCause)
          if (parsed.includes('Command not found')) {
            if (commandCause && typeof commandCause === 'object' && 'command' in commandCause && typeof commandCause.command === 'string') {
              return commandCause.command
            }
            return queuedCommand.name
          }
          if (!commandCause || typeof commandCause !== 'object') return undefined
          const tag = ('_tag' in commandCause && commandCause._tag) || ('name' in commandCause && commandCause.name)
          if (tag !== 'CommandNotFoundError') return undefined
          if ('command' in commandCause && typeof commandCause.command === 'string') {
            return commandCause.command
          }
          return queuedCommand.name
        })()
        if (commandNotFoundName) {
          this.stopTyping()
          await sendThreadMessage(
            this.thread,
            `Command not found: "${commandNotFoundName}"`,
            { flags: NOTIFY_MESSAGE_FLAGS },
          )
          await this.dispatchAction(() => {
            return this.tryDrainQueue({ showIndicator: true })
          })
          return
        }

        logger.error(
          `[DISPATCH] Command SDK call failed: ${commandResponse.message}`,
        )
        void notifyError(commandResponse, 'Failed to send command to OpenCode')
        this.stopTyping()
        await sendThreadMessage(
          this.thread,
          `✗ Unexpected bot Error: ${parseOpenCodeErrorMessage(commandCause) || commandResponse.message}`,
          { flags: NOTIFY_MESSAGE_FLAGS },
        )
        return false
      }

      logger.log(`[DISPATCH] Successfully ran command for session ${session.id}`)
      trackTurnStarted({
        inputKind: 'command',
        ingressMode: 'local_queue',
        source: resolveTurnSource(input),
        agent: earlyAgentPreference,
      })
      return true
    }

    await waitForGlobalEventListener()
    const promptText = parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    // TODO(anomalyco/opencode#48356): Share prompt-option submission with direct ingress once selection is bound to queued input.
    const promptResponse = await getClient().session.prompt({
      sessionID: session.id,
      text: promptText,
      delivery: 'steer',
    }).catch((e) => new OpenCodeSdkError({ operation: 'session.prompt', cause: e }))

    if (promptResponse instanceof Error) {
      const errorMessage = promptResponse.message
      const errorObject = promptResponse instanceof Error
        ? promptResponse
        : new Error(errorMessage)
      logger.error(`[DISPATCH] Prompt API call failed: ${errorMessage}`)
      void notifyError(errorObject, 'OpenCode API error during local queue prompt')
      this.stopTyping()
      await sendThreadMessage(this.thread, `✗ OpenCode API error: ${errorMessage}`, {
        flags: NOTIFY_MESSAGE_FLAGS,
      })
      return false
    }

    logger.log(
      `[DISPATCH] session.prompt accepted by opencode queue sessionId=${session.id} threadId=${this.threadId}`,
    )
    trackTurnStarted({
      inputKind: 'prompt',
      ingressMode: 'local_queue',
      source: resolveTurnSource(input),
      agent: earlyAgentPreference,
    })
    return true
  }

  // ── Session Ensure ──────────────────────────────────────────
  // Creates or reuses the OpenCode session for this thread.

  /** Session IDs that already have the Kimaki instruction entry. */
  private sessionSystemInstructionsWritten = new Set<string>()

  /** Cached per-session scheduled task info for the system message. */
  private scheduledTaskContextCache = new Map<
    string,
    ScheduledTaskSystemContext | undefined
  >()

  /**
   * Resolve the scheduled-task context for the system message, once per
   * session. The row in session_start_sources is immutable, so caching the
   * result keeps the system prompt identical across turns (prompt-cache safe).
   * One-shot 'at' tasks are deleted after their run, so only schedule_kind
   * survives for them.
   */
  private async resolveScheduledTaskContext(
    sessionId: string,
  ): Promise<ScheduledTaskSystemContext | undefined> {
    const cache = this.scheduledTaskContextCache
    if (cache.has(sessionId)) {
      return cache.get(sessionId)
    }
    const context = await (async (): Promise<
      ScheduledTaskSystemContext | undefined
    > => {
      const source = await getSessionStartSource({ sessionId })
      if (!source) {
        return undefined
      }
      const task = source.scheduled_task_id
        ? await getScheduledTask(source.scheduled_task_id)
        : null
      return {
        taskId: source.scheduled_task_id ?? undefined,
        scheduleKind: source.schedule_kind,
        cronExpr: task?.cron_expr,
        timezone: task?.timezone,
      }
    })().catch((error) => {
      logger.warn(
        `[SCHEDULED TASK CONTEXT] Failed to resolve for session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return undefined
    })
    cache.set(sessionId, context)
    return context
  }

  private async persistSessionSystemInstructions({
    client,
    sessionId,
    agents,
    channelTopic,
  }: {
    client: OpencodeClient
    sessionId: string
    agents: AgentInfo[]
    channelTopic?: string
  }) {
    if (this.sessionSystemInstructionsWritten.has(sessionId)) return null
    const topic = channelTopic ?? await (async () => {
      if (this.thread.parent?.type === ChannelType.GuildText) {
        return this.thread.parent.topic?.trim() || undefined
      }
      return undefined
    })()
    const value = getOpencodeSystemMessage({
      sessionId,
      channelId: this.channelId,
      guildId: this.thread.guildId,
      threadId: this.thread.id,
      channelTopic: topic,
      agents,
      userId: this.state?.sessionUserId,
      parentSessionId: this.state?.parentSessionId,
      scheduledTask: await this.resolveScheduledTaskContext(sessionId),
      dataDir: getDataDir(),
      critiqueEnabled: store.getState().critiqueEnabled,
    })
    const result = await client.session.instructions.entry.put({
      sessionID: sessionId,
      key: KIMAKI_INSTRUCTION_ENTRY_KEY,
      value,
    }).catch((cause) => new OpenCodeSdkError({
      operation: 'session.instructions.entry.put',
      cause,
    }))
    if (result instanceof Error) {
      logger.warn(
        `[SYSTEM INSTRUCTIONS] Failed to persist for session ${sessionId}: ${result.message}`,
      )
      return result
    }
    this.sessionSystemInstructionsWritten.add(sessionId)
    return result
  }

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
    const directory = this.sdkDirectory

    // Resolve worktree info for server initialization
    const workspaceInfo = await getThreadWorktreeOrWorkspace(this.thread.id)
    const worktreeDirectory =
      workspaceInfo?.status === 'ready' && workspaceInfo.workspace_directory
        ? workspaceInfo.workspace_directory
        : undefined
    const originalRepoDirectory = worktreeDirectory
      ? workspaceInfo?.project_directory
      : undefined

    const getClientResult = await initializeOpencodeForDirectory(directory, {
      originalRepoDirectory,
      channelId: this.channelId,
    })
    if (getClientResult instanceof Error) return getClientResult
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
      const sessionResponse = await getClient().session.get({
        sessionID: sessionId,
      }).catch((e) => new OpenCodeSdkError({ operation: 'session.get', cause: e }))
      if (sessionResponse instanceof Error) {
        logger.warn(
          `[ENSURE SESSION] Failed to get existing session ${sessionId}: ${sessionResponse.message}`,
        )
      } else if (sessionResponse.id) {
        session = sessionResponse
      } else {
        const sdkMessage = extractSdkErrorMessage(sessionResponse.error)
        logger.warn(
          `[ENSURE SESSION] session.get returned no data for ${sessionId}: ${sdkMessage}, response=${JSON.stringify(sessionResponse)}`,
        )
      }
    }

    const sessionPermissions = [
      ...buildSessionPermissions({ directory: this.sdkDirectory, originalRepoDirectory }),
      ...parsePermissionRules(permissions ?? []),
    ]
    // Omitted permissions preserve existing/forked rules; explicit input replaces them.
    if (session && permissions !== undefined) {
      const result = await getClient().permission.rules({
        sessionID: session.id,
        permissions: sessionPermissions,
      }).catch((cause: unknown) => new OpenCodeSdkError({ operation: 'permission.rules', cause }))
      if (result instanceof Error) return result
    }
    if (!session) {
      // Omit title so OpenCode auto-generates a summary from the conversation
      const createResult = await getClient().session.create({
        location: { directory: this.sdkDirectory },
        permissions: sessionPermissions,
      }).catch((e) => new OpenCodeSdkError({ operation: 'session.create', cause: e }))
      if (createResult instanceof Error) {
        const causeMessage = createResult.cause instanceof Error
          ? createResult.cause.message
          : String(createResult.cause ?? '')
        logger.error(
          `[ENSURE SESSION] session.create failed: ${createResult.message} cause=${causeMessage}`,
        )
        return new Error(
          `Failed to create session: ${createResult.message} ${causeMessage}, threadId=${this.thread.id}, directory=${this.sdkDirectory}`,
          { cause: createResult },
        )
      }
      session = createResult
      if (!session) {
        logger.warn(
          `[ENSURE SESSION] session.create returned no data, threadId=${this.thread.id}, directory=${this.sdkDirectory}, response=${JSON.stringify(createResult)}`,
        )
      }
      session = createResult.data
      // Insert DB row immediately so the external-sync poller sees
      // source='kimaki' before the next poll tick and skips this session.
      // The upsert at the end of ensureSession is kept for the reuse path.
      await setThreadSession(this.thread.id, session.id)
      if (injectionGuardPatterns?.length) {
        writeInjectionGuardConfig({
          sessionId: session.id,
          scanPatterns: injectionGuardPatterns,
        })
      }
      const worktree = await getThreadWorktreeOrWorkspace(this.thread.id)
      trackEvent('session_created', {
        has_worktree: Boolean(worktree),
        source: sessionStartScheduleKind ? 'scheduled' : 'discord',
      })
      createdNewSession = true
    }

    if (!session) {
      return new Error(
        `Failed to create or get session: threadId=${this.thread.id}, channelId=${this.channelId}, directory=${directory}, sdkDirectory=${this.sdkDirectory}, existingSessionId=${sessionId ?? 'none'}, createdNewSession=${createdNewSession}`,
      )
    }

    // Store session in DB and thread state
    await setThreadSession(this.thread.id, session.id)
    threadState.setSessionId(this.threadId, session.id)
    // Parent may have been set on ingress before the thread_sessions row
    // existed; write it now that the row is guaranteed.
    const parentSessionId = this.state?.parentSessionId
    if (parentSessionId) {
      await setThreadParentSessionId({
        threadId: this.thread.id,
        parentSessionId,
      }).catch((error) => {
        logger.warn(
          `[PARENT SESSION] Failed to persist parent session for thread ${this.threadId}: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
    }
    await this.hydrateSessionEventsFromDatabase({ sessionId: session.id })

    // Store session start source for scheduled tasks
    if (createdNewSession && sessionStartScheduleKind) {
      const sessionStartSourceResult = await setSessionStartSource({
        sessionId: session.id,
        scheduleKind: sessionStartScheduleKind,
        scheduledTaskId: sessionStartScheduledTaskId,
      }).catch((e) =>
        new OpenCodeSdkError({ operation: 'setSessionStartSource', cause: e }),
      )
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
   * Emit the model + agent banner once, before the first prompt or OpenCode
   * command can produce visible output in a newly-created session thread.
   */
  private async sendNewSessionModelInfo({
    createdNewSession,
    model,
    agent,
  }: {
    createdNewSession: boolean
    model: { providerID: string; modelID: string }
    agent?: string
  }): Promise<void> {
    if (!createdNewSession) {
      return
    }

    const modelLabel = `${model.providerID}/${model.modelID}`
    const agentLabel = agent && agent.toLowerCase() !== 'build'
      ? ` ⋅ ${agent}`
      : ''
    const result = await sendThreadMessage(
      this.thread,
      asSubtext(`*using ${modelLabel}${agentLabel}*`),
      { flags: SILENT_MESSAGE_FLAGS },
    ).catch((e) => new DiscordOperationError({ operation: 'sendMessage', cause: e }))
    if (result instanceof Error) {
      logger.warn(`[SESSION INFO] Failed to send model info: ${result.message}`)
    }
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
    const agentInfo =
      runInfo.agent && runInfo.agent.toLowerCase() !== 'build'
        ? ` ⋅ **${runInfo.agent}**`
        : ''
    let contextInfo = ''
    const folderName = path.basename(this.sdkDirectory)

    const client = getOpencodeClient(this.sdkDirectory)

    // Run git branch and token fetch in parallel (fast, no external CLI)
    const [branchResult, contextResult] = await Promise.all([
      execAsync('git symbolic-ref --short HEAD', {
        cwd: this.sdkDirectory,
      }).catch((e) => new FilesystemOperationError({ operation: 'gitBranch', cause: e })),
      (async () => {
        if (!client || !sessionId) {
          return []
        }
        let tokensUsed = runInfo.tokensUsed
        // Fetch final token count from API
        const [messagesResult, modelsResult] = await Promise.all([
          tokensUsed === 0
            ? client.message.list({
                sessionID: sessionId,
                limit: 50,
                order: 'desc',
              }).catch((e) => new OpenCodeSdkError({ operation: 'message.list', cause: e }))
            : null,
          client.model.list({
            location: { directory: this.sdkDirectory },
          }).catch((e) => new OpenCodeSdkError({ operation: 'model.list', cause: e })),
        ])

        if (messagesResult && !(messagesResult instanceof Error)) {
          const lastAssistant = messagesResult.data.find((message) => {
            if (message.type !== 'assistant' || !message.tokens) {
              return false
            }
            return getTokenTotal(message.tokens) > 0
          })
          if (lastAssistant && lastAssistant.type === 'assistant' && lastAssistant.tokens) {
            tokensUsed = getTokenTotal(lastAssistant.tokens)
          }
        }

        const fallbackLimit = runInfo.providerID
          ? getFallbackContextLimit({
              providerID: runInfo.providerID,
            })
          : undefined

        const listedModels = modelsResult && !(modelsResult instanceof Error)
          ? modelsResult.data
          : []
        let contextLimit = fallbackLimit
        const listedModel = listedModels.find((candidate) => {
          return candidate.providerID === runInfo.providerID && candidate.modelID === runInfo.model
        })
        if (listedModel?.limit?.context) {
          contextLimit = listedModel.limit.context
        }

        if (contextLimit) {
          const percentage = Math.round(
            (tokensUsed / contextLimit) * 100,
          )
          contextInfo = ` ⋅ ${percentage}%`
        }
        return thinkingProvidersFromListedModels({ models: [...listedModels] })
      })().catch((e) => new OpenCodeSdkError({ operation: 'resolveModelPreference', cause: e })),
    ])
    const branchName =
      branchResult instanceof Error ? '' : branchResult.stdout.trim()
    if (contextResult instanceof Error) {
      logger.error(
        'Failed to fetch provider info for context percentage:',
        contextResult,
      )
    }
    const providers = contextResult instanceof Error ? [] : (contextResult ?? [])
    const modelLabel = runInfo.model
      ? displayedModelLabel({
          modelID: runInfo.model,
          name: await resolveDisplayedModelName({
            providers,
            providerID: runInfo.providerID,
            modelID: runInfo.model,
            sessionID: sessionId,
          }),
        })
      : undefined
    const modelInfo = modelLabel ? ` ⋅ ${modelLabel}` : ''

    const truncate = (s: string, max: number) => {
      return s.length > max ? s.slice(0, max - 1) + '\u2026' : s
    }
    const truncatedFolder = truncate(folderName, 30)
    const truncatedBranch = truncate(branchName, 30)
    const projectInfo = truncatedBranch
      ? `${truncatedFolder} ⋅ ${truncatedBranch} ⋅ `
      : `${truncatedFolder} ⋅ `
    const hasQueuedMessage = this.getQueueLength() > 0
    const didUseSleepTool = sessionId
      ? didLatestUserTurnUseSleepTool({ events: this.eventBuffer, sessionId })
      : false
    const shouldNotifyUser = !hasQueuedMessage && !didUseSleepTool
    const mentionUserId = store.getState().footerMentionsEnabled && shouldNotifyUser
      ? await resolveThreadFooterMentionUserId({
          sessionUserId: this.state?.sessionUserId,
          thread: this.thread,
        })
      : undefined
    const mention = mentionUserId ? ` <@${mentionUserId}>` : ''
    const footerText = asSubtext(
      `*${projectInfo}${sessionDuration}${contextInfo}${modelInfo}${agentInfo}*${mention}`,
    )
    this.stopTyping()

    await sendThreadMessage(this.thread, footerText, {
      flags: shouldNotifyUser ? NOTIFY_MESSAGE_FLAGS : SILENT_MESSAGE_FLAGS,
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
    this.lastSentPartKind = undefined
    this.v2OpenTextMessageIds.clear()
    this.partBuffer.clear()
    this.v2ToolNames.clear()
  }

  private async maybeNotifyPromptCacheClear({
    sessionId,
    messageId,
  }: {
    sessionId: string
    messageId: string
  }): Promise<void> {
    // Only the first reply after a user prompt can show a cold cache. Later steps re-read the turn's own writes.
    const [firstAssistantId] = this.getAssistantMessageIdsForCurrentTurn({ sessionId })
    if (firstAssistantId !== messageId) {
      return
    }
    const cacheClear = getPromptCacheClear({
      events: this.eventBuffer,
      sessionId,
      currentMessageId: messageId,
    })
    if (!cacheClear) {
      return
    }
    const systemDiff = await this.getSystemPromptDiffForCacheClear({
      sessionId,
      previousMessageId: cacheClear.previousMessageId,
      currentMessageId: cacheClear.currentMessageId,
    })
    const chunk = asSubtext(formatPromptCacheClearMessage(cacheClear, systemDiff))
    const sendResult = await this.thread.send({ content: chunk, flags: SILENT_MESSAGE_FLAGS })
      .catch((e) => new DiscordOperationError({ operation: 'sendMessage', cause: e }))
    if (sendResult instanceof Error) {
      discordLogger.error('Failed to send prompt cache notice:', sendResult)
    }
  }

  private async getSystemPromptDiffForCacheClear({
    sessionId,
    previousMessageId,
    currentMessageId,
  }: {
    sessionId: string
    previousMessageId: string
    currentMessageId: string
  }): Promise<{ additions: number; deletions: number } | undefined> {
    const previousParentId = this.getAssistantParentId({ sessionId, messageId: previousMessageId })
    const currentParentId = this.getAssistantParentId({ sessionId, messageId: currentMessageId })
    if (!previousParentId || !currentParentId) {
      return undefined
    }
    const beforeText = this.userSystemByMessageId.get(previousParentId)
    const afterText = this.userSystemByMessageId.get(currentParentId)
    if (beforeText === undefined || afterText === undefined || beforeText === afterText) {
      return undefined
    }
    return countSystemPromptDiffLines({ beforeText, afterText })
  }

  private getAssistantParentId({
    sessionId,
    messageId,
  }: {
    sessionId: string
    messageId: string
  }): string | undefined {
    for (let i = this.eventBuffer.length - 1; i >= 0; i--) {
      const event = this.eventBuffer[i]?.event
      if (event?.type !== 'message.updated') {
        continue
      }
      const info = event.properties.info
      if (info.sessionID !== sessionId || info.role !== 'assistant' || info.id !== messageId) {
        continue
      }
      return info.parentID
    }
    return undefined
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
    const abortResult = await this.dispatchAction(async () => {
      needsIdleWait = this.isBusy()
      const outcome = this.abortActiveRunInternal({
        reason: 'model-change',
      })
      if (outcome.apiAbortPromise) {
        void outcome.apiAbortPromise
      }
    }).catch((e) => new OpenCodeSdkError({ operation: 'abortSession', cause: e }))
    if (abortResult instanceof Error) {
      logger.error('[RETRY] Failed to abort active run before retry:', abortResult)
      return false
    }

    if (needsIdleWait) {
      await this.waitForEvent({
        predicate: (event) => isSessionSettledEvent({ event, sessionId }),
        sinceTimestamp: waitSinceTimestamp,
        timeoutMs: 2000,
      })
    }

    if (this.disposed) {
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
      analyticsSource: 'retry',
    })

    if (this.state?.sessionId !== sessionId) {
      logger.log(
        `[RETRY] Session changed while retry was enqueued for thread ${this.threadId}`,
      )
      return false
    }

    return true
  }

  /**
   * Resume an idle session by sending `text` as a new user turn.
   *
   * Used when a question is answered after its run was aborted elsewhere:
   * the original run is dead, so question.reply is a no-op. We instead feed
   * the answer back as a fresh prompt so opencode continues from history.
   */
  async resumeWithText({ text }: { text: string }): Promise<boolean> {
    const sessionId = this.state?.sessionId
    if (!sessionId || this.disposed) {
      logger.log(`[RESUME] No session for thread ${this.threadId}`)
      return false
    }
    await this.enqueueIncoming({
      prompt: text,
      userId: '',
      username: '',
      appId: this.appId,
      mode: 'opencode',
      resetAssistantForNewRun: true,
      expectedSessionId: sessionId,
    })
    return true
  }
}

// ── Module-level helpers ──────────────────────────────────────────

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

function truncateSessionErrorMessage(message: string): string {
  const maxLength = 400
  if (message.length <= maxLength) {
    return message
  }
  return `${message.slice(0, maxLength - 1)}…`
}
