// One runtime owns the resources and event effects for one Discord thread.

import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { ChannelType, ComponentType, type ThreadChannel } from 'discord.js'
import type {
  PermissionRequest,
  V2Event,
} from '@opencode/client'
import path from 'node:path'
import prettyMilliseconds from 'pretty-ms'
import * as errore from 'errore'
import * as threadState from './thread-runtime-state.js'
import type { QueuedMessage } from './thread-runtime-state.js'
import type { OpencodeClient } from '../opencode.js'
import {
  getOpencodeClient,
  initializeOpencodeForDirectory,
  buildSessionPermissions,
  parsePermissionRules,
  writeInjectionGuardConfig,
  extractSdkErrorMessage,
} from '../opencode.js'
import { isAbortError } from '../utils.js'
import { listAllSessions } from '../opencode-pagination.js'
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
} from '../message-formatting.js'
import {
  asDiscordQuote,
  QUEUE_PREFIX,
  STATUS_PREFIX,
  WORKTREE_PREFIX,
  LEGACY_WORKTREE_PREFIX,
} from '../message-formatting.js'
export {
  isEssentialToolName,
  isEssentialToolPart,
  isShellToolName,
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
  didQuestionQueueHandoffSinceLatestQuestionAsked,
  getContextUsageNoticePercentage,
  getAssistantMessageIdsForLatestExecution,
  isSessionBusy,
  getLatestRunInfo,
  getDerivedSubtaskIndex,
  getDerivedSubtaskAgentType,
  isDerivedChildSession,
  isEventForSessionTree,
  shouldShowRetryNotice,
  getLatestAssistantMessageIdForLatestExecution,
  getLatestExecutionStartedTimestamp,
  getEventBufferSessionId,
  hasSeenNativeDurableEvent,
  compactSubagentRoutingEvidence,
  type EventBufferEvent,
  type EventBufferEntry,
} from './event-stream-state.js'
import {
  applyDiscordProjectionActions,
  createDiscordProjectionState,
  projectDiscordActions,
  projectDiscordFlushActions,
  type DiscordAction,
  type DiscordProjectionState,
  type ProjectedForm,
  type TerminalAnalytics,
} from './discord-event-projection.js'

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
  if (getEventBufferSessionId(event) !== sessionId) return false
  return (
    event.type === 'kimaki.queue-dispatch.settled'
    || event.type === 'session.idle'
    || event.type === 'session.execution.interrupted'
    || event.type === 'session.execution.succeeded'
    || event.type === 'session.execution.failed'
  )
}

const shouldLogSessionEvents =
  process.env['KIMAKI_LOG_SESSION_EVENTS'] === '1' ||
  process.env['KIMAKI_VITEST'] === '1'

type NativeDurableV2Event = Extract<V2Event, { durable: object }>

export function orderNativeRecoveryEvents(
  events: readonly NativeDurableV2Event[],
): NativeDurableV2Event[] {
  return [...events].sort((left, right) => {
    if (left.created !== right.created) return left.created - right.created
    if (left.durable.aggregateID !== right.durable.aggregateID) {
      return left.durable.aggregateID.localeCompare(right.durable.aggregateID)
    }
    return left.durable.seq - right.durable.seq
  })
}

const runtimes = new Map<string, ThreadSessionRuntime>()

// Preserve arrival order between one-shot slash calls and messages.
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

function cleanupPendingUiForThread(threadId: string): void {
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

  void cancelPendingQuestion(threadId)
  cancelPendingActionButtons(threadId)
  void cancelPendingFileUpload(threadId)
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

export type EnqueueResult = {
  queued: boolean
  position?: number
  queueId?: string
}

export type PreprocessResult = {
  prompt: string
  images?: DiscordFileAttachment[]
  repliedMessage?: RepliedMessageContext
  mode: 'opencode' | 'local-queue'
  skip?: boolean
  agent?: string
}

export type IngressInput = {
  prompt: string
  userId: string
  username: string
  sourceMessageId?: string
  sourceThreadId?: string
  repliedMessage?: RepliedMessageContext
  images?: DiscordFileAttachment[]
  appId?: string
  command?: { name: string; arguments: string }
  mode?: 'opencode' | 'local-queue'
  agent?: string
  model?: string
  variant?: string
  permissions?: string[]
  injectionGuardPatterns?: string[]
  parentSessionId?: string
  sessionStartSource?: { scheduleKind: 'at' | 'cron'; scheduledTaskId?: number; scheduledTaskRunId?: number }
  expectedSessionId?: string
  noReply?: boolean
  isSleepWake?: boolean
  analyticsSource?: AnalyticsTurnSource
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

export type PreparedAdmission = {
  client: OpencodeClient
  sessionId: string
  text: string
  images: DiscordFileAttachment[]
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
  delivery: 'steer' | 'queue'
  inputKind: 'prompt' | 'command'
  source: AnalyticsTurnSource
  ingressMode: AnalyticsIngressMode
  command?: { name: string; arguments: string }
  noReply?: boolean
  scheduledTaskRunId?: number
}

export function buildPreparedAdmissionValue<TClient>({
  prompt,
  syntheticContext,
  ...admission
}: Omit<PreparedAdmission, 'client' | 'text'> & {
  client: TClient
  prompt: string
  syntheticContext: string
}) {
  const imageList = admission.images.map((image) => {
    return `- ${image.sourceUrl || image.filename}`
  }).join('\n')
  const promptWithImages = imageList
    ? `${prompt}\n\n**The following images are already included in this message as inline content (do not use Read tool on these):**\n${imageList}`
    : prompt
  return {
    ...admission,
    client: admission.client,
    text: admission.inputKind === 'command'
      ? syntheticContext
      : [promptWithImages, syntheticContext].filter(Boolean).join('\n'),
  }
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

  private typingKeepaliveTimeout: ReturnType<typeof setTimeout> | null = null
  private readonly typingRepulseDebounce: ReturnType<typeof createDebouncedTimeout>

  private static readonly TYPING_REPULSE_DEBOUNCE_MS = 500

  // Discord rename failures are usually rate limits, so do not retry one title.
  private appliedOpencodeTitle: string | undefined

  private abortInFlight: Promise<void> | null = null
  private discordProjection: DiscordProjectionState = createDiscordProjectionState()

  // Derivable cache (perf optimization for provider.list API call)
  private modelContextLimit: number | undefined
  private modelContextLimitKey: string | undefined
  private lastPromptWorktreeKey: string | null | undefined

  private static readonly EVENT_BUFFER_MAX = 1000
  private static readonly EVENT_BUFFER_DB_FLUSH_MS = 2_000
  private static readonly EVENT_BUFFER_TEXT_MAX_CHARS = 512
  private eventBuffer: EventBufferEntry[] = []
  private nextEventIndex = 0
  private persistEventBufferDebounced: ReturnType<
    typeof createDebouncedProcessFlush
  >
  private readonly sentPartIdsBootstrap: Promise<void>

  private actionQueue: Array<() => Promise<void>> = []
  private processingAction = false

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
    registerEventListener(this.threadId, (event, context) => {
      if (this.disposed) return
      void this.dispatchAction(async () => {
        await this.sentPartIdsBootstrap
        if (context.reconnected) {
          await this.reconcileAfterReconnect()
        }
        await this.ingestEvent(event)
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
  }

  private consumeWorktreePromptChange(
    worktree: WorktreeInfo | undefined,
  ): boolean {
    const nextKey = getWorktreePromptKey(worktree)
    const changed = this.lastPromptWorktreeKey !== nextKey
    this.lastPromptWorktreeKey = nextKey
    return changed
  }

  get state(): threadState.ThreadRunState | undefined {
    return threadState.getThreadState(this.threadId)
  }

  getDerivedPhase(): 'idle' | 'running' {
    return this.isBusy() ? 'running' : 'idle'
  }

  private getLastRuntimeActivityTimestamp(): number {
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
    const lastActivityTimestamp = this.getLastRuntimeActivityTimestamp()
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
      const eventSessionId = getEventBufferSessionId(entry.event)
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

  private getAssistantMessageIdsForCurrentTurn({
    sessionId,
    upToIndex,
  }: {
    sessionId: string
    upToIndex?: number
  }): Set<string> {
    const normalizedIndex = upToIndex === undefined ? undefined : upToIndex - 1
    return getAssistantMessageIdsForLatestExecution({
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
    return getLatestAssistantMessageIdForLatestExecution({
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
    if (!subtaskIndex) return undefined
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
    this.stopTyping()

    // Release large internal buffers so GC can reclaim memory immediately
    // instead of waiting for the runtime object itself to become unreachable.
    this.eventBuffer = []
    this.nextEventIndex = 0
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
    if (event.type.startsWith('kimaki.')) {
      return this.finalizeCompactedEventForEventBuffer(structuredClone(event))
    }

    const compacted = structuredClone(event)

    if (compacted.type === 'session.text.ended') {
      compacted.data.text = this.compactTextForEventBuffer(compacted.data.text)
      return this.finalizeCompactedEventForEventBuffer(compacted)
    }

    if (compacted.type === 'session.reasoning.ended') {
      compacted.data.text = this.compactTextForEventBuffer(compacted.data.text)
      return this.finalizeCompactedEventForEventBuffer(compacted)
    }

    return this.finalizeCompactedEventForEventBuffer(compacted)
  }

  // One ingress for live SSE and session.log replay. Durable identity
  // drops reconnect overlap before Discord effects; ephemeral deltas pass.
  private async ingestEvent(event: V2Event): Promise<void> {
    const sessionId = this.state?.sessionId
    const inSessionTree = Boolean(
      sessionId
      && isEventForSessionTree({
        events: this.eventBuffer,
        event,
        mainSessionId: sessionId,
      }),
    )
    if (inSessionTree && hasSeenNativeDurableEvent({
      events: this.eventBuffer,
      event,
    })) {
      return
    }
    if (event.type === 'session.tool.progress') {
      const evidence = compactSubagentRoutingEvidence(event)
      if (evidence && sessionId && inSessionTree) {
        const alreadyBuffered = this.eventBuffer.some((entry) => {
          const buffered = entry.event
          return buffered.type === 'kimaki.subagent.routing'
            && buffered.data.sessionID === evidence.data.sessionID
            && buffered.data.assistantMessageID === evidence.data.assistantMessageID
            && buffered.data.id === evidence.data.id
            && buffered.data.childSessionID === evidence.data.childSessionID
        })
        if (!alreadyBuffered) this.appendEventToBuffer(evidence)
      }
    } else if (sessionId && !isEphemeralV2StreamEvent(event) && inSessionTree) {
      this.appendEventToBuffer(event)
    }
    await this.handleEvent(event)
  }

  private appendEventToBuffer(event: EventBufferEvent): void {
    const compactedEvent = this.compactEventForEventBuffer(event)
    if (!compactedEvent) {
      return
    }

    const timestamp = compactedEvent.type === 'kimaki.queue-dispatch.started'
      || compactedEvent.type === 'kimaki.queue-dispatch.settled'
      || compactedEvent.type === 'kimaki.question-queue-handoff.started'
      || compactedEvent.type === 'kimaki.subagent.routing'
      || compactedEvent.type === 'server.connected'
      ? Date.now()
      : compactedEvent.created
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

  // Native busy arrives after admission, so this marker closes the queue drain race.
  private markQueueDispatchBusy(sessionId: string): void {
    this.appendEventToBuffer({
      type: 'kimaki.queue-dispatch.started',
      data: {
        sessionID: sessionId,
      },
    })
    this.ensureTypingNow()
  }

  private markQueueDispatchIdle(sessionId: string): void {
    this.appendEventToBuffer({
      type: 'kimaki.queue-dispatch.settled',
      data: {
        sessionID: sessionId,
      },
    })
  }

  private markQuestionQueueHandoffStarted({
    sessionId,
    requestId,
  }: {
    sessionId: string
    requestId?: string
  }): void {
    this.appendEventToBuffer({
      type: 'kimaki.question-queue-handoff.started',
      data: {
        sessionID: sessionId,
        requestID: requestId,
      },
    })
  }

  /**
   * Generic event waiter: polls the event buffer until a matching event
   * appears (with timestamp >= sinceTimestamp), or timeout/abort.
   *
   * This has zero coupling to specific event handlers. It scans
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
  // Session events must belong to the current event-derived session tree.
  // Global events such as tui.toast.show bypass this guard.

  private async handleEvent(event: V2Event): Promise<void> {
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

    if (!isGlobalEvent && sessionId && eventSessionId && eventSessionId !== sessionId) {
      if (!isDerivedChildSession({
        events: this.eventBuffer,
        mainSessionId: sessionId,
        candidateSessionId: eventSessionId,
      })) {
        return
      }
    }
    if (isScopedToastEvent && sessionId && toastSessionId && toastSessionId !== sessionId) {
      if (!isDerivedChildSession({
        events: this.eventBuffer,
        mainSessionId: sessionId,
        candidateSessionId: toastSessionId,
      })) {
        return
      }
    }

    if (sessionId) {
      if (
        event.type === 'session.tool.success'
        && event.data.sessionID === sessionId
        && !this.modelContextLimit
      ) {
        const runInfo = getLatestRunInfo({ events: this.eventBuffer, sessionId })
        if (runInfo.providerID && runInfo.model) {
          await this.ensureModelContextLimit({
            providerID: runInfo.providerID,
            modelID: runInfo.model,
          })
        }
      }
      const verbosity = await this.getVerbosity()
      const actions = projectDiscordActions({
        event,
        events: this.eventBuffer,
        projectedParts: this.discordProjection.parts,
        pendingForms: this.discordProjection.pendingForms,
        shownFormIds: this.discordProjection.shownFormIds,
        mainSessionId: sessionId,
        verbosity,
        deliveredPartIds: new Set(this.state?.sentPartIds),
        largeOutputThresholdTokens: 3_000,
        modelContextLimit: this.modelContextLimit,
      })
      await this.executeDiscordActions(actions)
    }
    if (isEphemeralV2StreamEvent(event)) {
      return
    }

    if (isOpencodeSessionEventLogEnabled()) {
      const eventLogResult = await appendOpencodeSessionEventLog(event)
      if (eventLogResult instanceof Error) {
        logger.error(
          '[SESSION EVENT JSONL] Failed to write session event log:',
          eventLogResult,
        )
      }
    }

    // Control-plane events keep named handlers; they do not render assistant output.
    switch (event.type) {
      case 'session.renamed':
        await this.handleSessionRenamed(event.data)
        break
      case 'session.text.started':
      case 'session.text.ended':
      case 'session.reasoning.started':
      case 'session.reasoning.ended':
      case 'session.tool.input.started':
      case 'session.tool.called':
      case 'session.tool.success':
      case 'session.tool.failed':
      case 'session.execution.succeeded':
      case 'session.execution.interrupted':
      case 'session.execution.failed':
        break
      case 'session.status':
        await this.handleSessionStatus(event)
        break
      case 'session.step.started':
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
      case 'form.replied':
      case 'form.cancelled':
        break
      case 'session.inbox.enqueued':
      case 'session.inbox.cancelled':
      case 'session.inbox.delivered':
        break
      case 'session.execution.started':
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

  private async executeDiscordActions(actions: readonly DiscordAction[]): Promise<void> {
    for (const action of actions) {
      this.discordProjection = applyDiscordProjectionActions({
        state: this.discordProjection,
        actions: [action],
      })
      if (action.type === 'store-part') {
        continue
      }
      if (action.type === 'render-part') {
        await this.renderProjectedPart(action)
        continue
      }
      if (action.type === 'hold-part' || action.type === 'skip-part') {
        continue
      }
      if (action.type === 'show-large-output') {
        const result = await this.thread.send({
          content: `${STATUS_PREFIX}${action.content}`,
          flags: SILENT_MESSAGE_FLAGS,
        }).catch((cause) => new DiscordOperationError({ operation: 'sendMessage', cause }))
        if (result instanceof Error) discordLogger.error('Failed to send large output notice:', result)
        continue
      }
      if (action.type === 'show-action-buttons') {
        await this.showProjectedActionButtons(action.sessionId)
        continue
      }
      if (action.type === 'show-form') {
        await this.showProjectedForm(action.form)
        continue
      }
      if (action.type === 'settle-form') {
        await this.settleV2Form({
          sessionId: action.sessionId,
          formId: action.formId,
        })
        continue
      }
      if (action.type === 'start-typing') {
        if (action.immediate) this.restartTypingKeepalive({ sendNow: true })
        else this.ensureTypingNow()
        continue
      }
      if (action.type === 'stop-typing') {
        this.stopTyping()
        continue
      }
      if (action.type === 'show-context-usage') {
        await this.showContextUsageNotice(action.sessionId)
        continue
      }
      if (action.type === 'send-footer') {
        const result = await this.emitFooter({
          completedAt: action.completedAt,
          runStartTime: action.startedAt,
        }).catch((cause) => new DiscordOperationError({ operation: 'sendFooter', cause }))
        if (result instanceof Error) discordLogger.error('Failed to send v2 execution footer:', result)
        continue
      }
      if (action.type === 'send-error') {
        const result = await sendThreadMessage(
          this.thread,
          `✗ ${action.message}`,
          { flags: NOTIFY_MESSAGE_FLAGS },
        ).catch((cause) => new DiscordOperationError({ operation: 'sendMessage', cause }))
        if (result instanceof Error) discordLogger.error('Failed to send execution error:', result)
        continue
      }
      if (action.type === 'record-terminal-analytics') {
        this.recordTerminalAnalytics(action.analytics)
        continue
      }
      if (action.type === 'complete-scheduled-task') {
        await completeScheduledTaskRunsForSession(action.sessionId)
        continue
      }
      if (action.type === 'fail-scheduled-task') {
        await failScheduledTaskRunsForSession({
          sessionId: action.sessionId,
          error: action.error,
        })
        continue
      }
      if (action.type === 'reset-run') {
        this.resetPerRunState()
        continue
      }
      if (action.type === 'drain-queue') {
        await this.tryDrainQueue({ showIndicator: true })
      }
    }
  }

  private async renderProjectedPart(
    action: Extract<DiscordAction, { type: 'render-part' }>,
  ): Promise<void> {
    threadState.updateThread(this.threadId, (thread) => {
      const sentPartIds = new Set(thread.sentPartIds)
      sentPartIds.add(action.deliveryId)
      return { ...thread, sentPartIds }
    })
    const result = await sendSessionPartMessage(this.thread, action.content, {
      leadWithBlankLine: action.leadWithBlankLine,
    }).catch((cause) => new DiscordOperationError({ operation: 'sendMessage', cause }))
    if (result instanceof Error) {
      threadState.updateThread(this.threadId, (thread) => {
        const sentPartIds = new Set(thread.sentPartIds)
        sentPartIds.delete(action.deliveryId)
        return { ...thread, sentPartIds }
      })
      discordLogger.error(`Failed to render ${action.destination.label} part ${action.deliveryId}:`, result)
      return
    }
    await setPartMessage({
      partId: action.deliveryId,
      messageId: result.id,
      threadId: this.thread.id,
    })
    if (action.repulseTyping) this.requestTypingRepulse()
  }

  private async showProjectedActionButtons(sessionId: string): Promise<void> {
    this.stopTyping()
    const request = await waitForQueuedActionButtonsRequest({ sessionId, timeoutMs: 1_500 })
    if (!request) {
      logger.warn(`[ACTION] No queued action-buttons request found for session ${sessionId}`)
      return
    }
    if (request.threadId !== this.thread.id) {
      logger.warn('[ACTION] Ignoring queued action-buttons for different thread')
      return
    }
    const result = await showActionButtons({
      thread: this.thread,
      sessionId: request.sessionId,
      directory: request.directory,
      buttons: request.buttons,
      silent: this.getQueueLength() > 0,
    }).catch((cause) => new DiscordOperationError({ operation: 'showActionButtons', cause }))
    if (!(result instanceof Error)) return
    logger.error('[ACTION] Failed to show action buttons:', result)
    await sendThreadMessage(this.thread, `Failed to show action buttons: ${result.message}`, {
      flags: NOTIFY_MESSAGE_FLAGS,
    })
  }

  private recordTerminalAnalytics(analytics: TerminalAnalytics): void {
    const usageProperties = {
      tokens_input: analytics.usage.input,
      tokens_output: analytics.usage.output,
      tokens_reasoning: analytics.usage.reasoning,
      tokens_cache_read: analytics.usage.cacheRead,
      tokens_cache_write: analytics.usage.cacheWrite,
      tokens_total: analytics.usage.total,
      cost: analytics.usage.cost,
      assistant_message_count: analytics.usage.assistantMessageCount,
      is_subagent: analytics.isSubagent,
    } satisfies AnalyticsProps
    trackEvent('tokens_used', Object.assign(
      usageProperties,
      analytics.usage.model ? { model: analytics.usage.model } : null,
      analytics.usage.providerID ? { provider: analytics.usage.providerID } : null,
    ))
    if (!analytics.isMainSession) return
    trackEvent('turn_completed', {
      duration_sec: analytics.durationSec,
      outcome: analytics.outcome,
    })
  }

  private async reconcileAfterReconnect(): Promise<void> {
    const sessionId = this.state?.sessionId
    const client = getOpencodeClient(this.sdkDirectory)
    if (!sessionId || !client) return

    const [sessionIdsResult, formsResult] = await Promise.all([
      this.listNativeSessionTree({ client, mainSessionId: sessionId }),
      client.form.list({ sessionID: sessionId }).catch((cause) => {
        return new OpenCodeSdkError({ operation: 'form.list.reconcile', cause })
      }),
    ])

    if (sessionIdsResult instanceof Error) {
      logger.warn('[RECONNECT] Failed to list native session tree:', sessionIdsResult)
    } else {
      const logResults = await Promise.all(sessionIdsResult.map((replaySessionId) => {
        return this.readNativeSessionLog({ client, sessionId: replaySessionId })
      }))
      const replayEvents: NativeDurableV2Event[] = []
      for (const result of logResults) {
        if (result instanceof Error) {
          logger.warn('[RECONNECT] Failed to read native session log:', result)
          continue
        }
        replayEvents.push(...result)
      }
      for (const event of orderNativeRecoveryEvents(replayEvents)) {
        await this.ingestEvent(event)
      }
    }

    if (formsResult instanceof Error) {
      logger.warn('[RECONNECT] Failed to reconcile forms:', formsResult)
      return
    }
    for (const form of formsResult) {
      const stateResult = await client.form.state({
        sessionID: sessionId,
        formID: form.id,
      }).catch((cause) => new OpenCodeSdkError({
        operation: 'form.state.reconcile',
        cause,
      }))
      if (stateResult instanceof Error) {
        logger.warn(`[RECONNECT] Failed to read form ${form.id} state:`, stateResult)
        continue
      }
      if (stateResult.status === 'pending') {
        const fields = form.fields.flatMap((field): Array<Extract<
          V2Event,
          { type: 'form.created' }
        >['data']['form']['fields'][number]> => {
          if (field.type === 'string') return [{
            key: field.key,
            type: 'string' as const,
            title: field.title,
            description: field.description,
            options: field.options,
          }]
          if (field.type === 'multiselect') return [{
            key: field.key,
            type: 'multiselect' as const,
            title: field.title,
            description: field.description,
            options: field.options,
          }]
          return []
        })
        const [firstField, ...remainingFields] = fields
        if (!firstField) continue
        const formEvent: Extract<V2Event, { type: 'form.created' }> = {
          id: `reconnect-form-created:${form.id}`,
          created: Date.now(),
          type: 'form.created',
          data: {
            form: {
              id: form.id,
              sessionID: form.sessionID,
              title: form.title,
              metadata: form.metadata,
              fields: [firstField, ...remainingFields],
            },
          },
        }
        await this.handleEvent(formEvent)
        continue
      }
      const settledEvent: Extract<V2Event, { type: 'form.cancelled' }> = {
        id: `reconnect-form-settled:${form.id}`,
        created: Date.now(),
        type: 'form.cancelled',
        data: { sessionID: sessionId, id: form.id },
      }
      await this.handleEvent(settledEvent)
    }
  }

  private latestRecoverySequence(sessionId: string): number {
    for (let i = this.eventBuffer.length - 1; i >= 0; i--) {
      const event = this.eventBuffer[i]?.event
      if (!event || getEventBufferSessionId(event) !== sessionId) continue
      switch (event.type) {
        case 'session.execution.started':
        case 'session.execution.succeeded':
        case 'session.execution.failed':
        case 'session.execution.interrupted':
        case 'session.step.started':
        case 'session.step.streamed':
        case 'session.step.ended':
        case 'session.step.failed':
        case 'session.text.started':
        case 'session.text.ended':
        case 'session.reasoning.started':
        case 'session.reasoning.ended':
        case 'session.tool.input.started':
        case 'session.tool.input.ended':
        case 'session.tool.called':
        case 'session.tool.success':
        case 'session.tool.failed':
        case 'session.retry.scheduled':
        case 'session.compaction.started':
        case 'session.compaction.ended':
        case 'session.compaction.failed':
        case 'session.inbox.enqueued':
        case 'session.inbox.cancelled':
        case 'session.inbox.delivered':
        case 'session.inbox.delivery.changed':
          return event.durable.seq
        default:
          continue
      }
    }
    return 0
  }

  private async readNativeSessionLog({
    client,
    sessionId,
  }: {
    client: OpencodeClient
    sessionId: string
  }): Promise<NativeDurableV2Event[] | Error> {
    const events: NativeDurableV2Event[] = []
    const result = await (async () => {
      for await (const item of client.session.log({
        sessionID: sessionId,
        after: this.latestRecoverySequence(sessionId),
      })) {
        if (
          item.type === 'log.synced'
          || item.type === 'session.usage.recorded'
          || item.type === 'session.message.content.updated'
        ) {
          continue
        }
        events.push(item)
      }
    })().catch((cause) => new OpenCodeSdkError({
      operation: `session.log.reconcile.${sessionId}`,
      cause,
    }))
    if (result instanceof Error) return result
    return events
  }

  private async listNativeSessionTree({
    client,
    mainSessionId,
  }: {
    client: OpencodeClient
    mainSessionId: string
  }): Promise<string[] | Error> {
    const sessionIds = [mainSessionId]
    for (let parentIndex = 0; parentIndex < sessionIds.length; parentIndex++) {
      const parentID = sessionIds[parentIndex]!
      const children = await listAllSessions({
        client,
        parentId: parentID,
        order: 'asc',
      })
      if (children instanceof Error) return children
      sessionIds.push(...children.map((session) => session.id))
    }
    return sessionIds
  }

  private async settleV2Form({
    sessionId,
    formId,
  }: {
    sessionId: string
    formId: string
  }): Promise<void> {
    if (sessionId !== this.state?.sessionId) return
    const contexts = [...pendingQuestionContexts.entries()].filter(([, context]) => {
      return context.thread.id === this.thread.id && context.requestId === formId
    })
    const contextHashes = new Set(contexts.map(([contextHash]) => contextHash))
    if (contextHashes.size > 0) {
      const messages = await this.thread.messages.fetch({ limit: 100 }).catch((cause) => {
        return new DiscordOperationError({ operation: 'fetchQuestionMessages', cause })
      })
      if (messages instanceof Error) {
        discordLogger.error('Failed to fetch settled form messages:', messages)
      } else {
        for (const message of messages.values()) {
          const hasFormControl = message.components.some((row) => {
            if (row.type !== ComponentType.ActionRow) return false
            return row.components.some((component) => {
              if (typeof component.customId !== 'string') return false
              const [prefix, contextHash] = component.customId.split(':')
              return prefix === 'ask_question' && contextHashes.has(contextHash || '')
            })
          })
          if (!hasFormControl) continue
          const editResult = await message.edit({ components: [] }).catch((cause) => {
            return new DiscordOperationError({ operation: 'disableQuestionControls', cause })
          })
          if (editResult instanceof Error) {
            discordLogger.error('Failed to disable settled form controls:', editResult)
          }
        }
      }
    }
    for (const [contextHash] of contexts) pendingQuestionContexts.delete(contextHash)
    this.onInteractiveUiStateChanged()
  }

  private async showProjectedForm(form: ProjectedForm): Promise<void> {
    this.stopTyping()
    await showAskUserQuestionDropdowns({
      thread: this.thread,
      sessionId: form.sessionId,
      directory: this.sdkDirectory,
      requestId: form.formId,
      input: { questions: form.questions },
      silent: this.getQueueLength() > 0,
    })
    this.maybeHandoffQueuedItemForPendingQuestion({
      sessionId: form.sessionId,
      requestId: form.formId,
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

  private async flushCurrentTurnParts({
    mode,
    repulseTyping = true,
  }: {
    mode: 'progress' | 'interactive' | 'final'
    repulseTyping?: boolean
  }): Promise<void> {
    const sessionId = this.state?.sessionId
    if (!sessionId) return
    const actions = projectDiscordFlushActions({
      parts: this.discordProjection.parts,
      mainSessionId: sessionId,
      mode,
      repulseTyping,
      verbosity: await this.getVerbosity(),
      deliveredPartIds: new Set(this.state?.sentPartIds),
    })
    await this.executeDiscordActions(actions)
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
    if (!this.modelContextLimit) return
    const currentPercentage = getContextUsageNoticePercentage({
      events: this.eventBuffer,
      sessionId,
      contextLimit: this.modelContextLimit,
    })
    if (currentPercentage === undefined) return
    const chunk = `${STATUS_PREFIX}context usage ${currentPercentage}%`
    const sendResult = await this.thread.send({ content: chunk, flags: SILENT_MESSAGE_FLAGS })
      .catch((e) => new DiscordOperationError({ operation: 'sendMessage', cause: e }))
    if (sendResult instanceof Error) {
      discordLogger.error('Failed to send context usage notice:', sendResult)
    }
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

  private maybeHandoffQueuedItemForPendingQuestion({
    sessionId,
    requestId,
    reason,
  }: {
    sessionId: string | undefined
    requestId?: string
    reason: 'question-shown' | 'queue-added-during-question'
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
    logger.log(
      `[QUESTION QUEUE HANDOFF] Queue has ${this.getQueueLength()} items, handing off first item (${reason})`,
    )
    // Mark before detached work so repeated form events cannot hand off twice.
    this.markQuestionQueueHandoffStarted({ sessionId, requestId })
    void this.handoffQueuedItemForPendingQuestion({
      sessionId,
    }).catch((error) => {
      logger.error('[QUESTION QUEUE HANDOFF] Failed to hand off queued message:', error)
      if (error instanceof Error) {
        void notifyError(error, 'Failed to hand off queued message during pending question')
      }
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

    // Native queue delivery waits behind the open form. Steer would abort it.
    await this.submitViaOpencodeQueue({
      ...next,
      mode: 'local-queue',
    })
  }

  private async handleSessionStatus(
    event: Extract<V2Event, { type: 'session.status' }>,
  ): Promise<void> {
    const properties = event.data
    const sessionId = this.state?.sessionId
    if (properties.sessionID !== sessionId) return
    if (properties.status.type !== 'retry') return
    if (!shouldShowRetryNotice({ events: this.eventBuffer, event })) return
    const now = Date.now()
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

  private async applyNativeSessionSelection({
    client,
    sessionId,
    agent,
    model,
    variant,
  }: {
    client: OpencodeClient
    sessionId: string
    agent?: string
    model: { providerID: string; modelID: string }
    variant?: string
  }): Promise<Error | null> {
    if (agent) {
      const agentResult = await client.session.switchAgent({
        sessionID: sessionId,
        agent,
      }).catch((cause) => new OpenCodeSdkError({
        operation: 'session.switchAgent',
        cause,
      }))
      if (agentResult instanceof Error) return agentResult
    }
    const modelResult = await client.session.switchModel({
      sessionID: sessionId,
      model: {
        providerID: model.providerID,
        id: model.modelID,
        variant,
      },
    }).catch((cause) => new OpenCodeSdkError({
      operation: 'session.switchModel',
      cause,
    }))
    if (modelResult instanceof Error) return modelResult
    return null
  }

  private async submitNativeAdmission({
    client,
    sessionId,
    text,
    images,
    delivery,
    noReply,
  }: {
    client: OpencodeClient
    sessionId: string
    text: string
    images: DiscordFileAttachment[]
    delivery: 'steer' | 'queue'
    noReply?: boolean
  }): Promise<Error | null> {
    if (noReply) {
      const result = await client.session.synthetic({
        sessionID: sessionId,
        text,
        description: 'Discord context',
        delivery,
        resume: false,
      }).catch((cause) => new OpenCodeSdkError({
        operation: 'session.synthetic',
        cause,
      }))
      return result instanceof Error ? result : null
    }

    const files = images.map((image) => ({
      uri: image.url || image.sourceUrl || '',
      name: image.filename,
    })).filter((file) => file.uri)
    const result = await client.session.prompt({
      sessionID: sessionId,
      text,
      files: files.length > 0 ? files : undefined,
      delivery,
    }).catch((cause) => new OpenCodeSdkError({
      operation: 'session.prompt',
      cause,
    }))
    return result instanceof Error ? result : null
  }

  private async handleAdmissionError(error: Error): Promise<void> {
    this.stopTyping()
    await sendThreadMessage(this.thread, `✗ ${error.message}`, {
      flags: NOTIFY_MESSAGE_FLAGS,
    })
  }

  private async prepareAdmission({
    input,
    delivery,
    ingressMode,
  }: {
    input: IngressInput & {
      sessionStartScheduleKind?: 'at' | 'cron'
      sessionStartScheduledTaskId?: number
      sessionStartScheduledTaskRunId?: number
    }
    delivery: 'steer' | 'queue'
    ingressMode: AnalyticsIngressMode
  }): Promise<PreparedAdmission | Error> {
    const sessionStartSource = input.sessionStartSource
      ?? (input.sessionStartScheduleKind
        ? {
            scheduleKind: input.sessionStartScheduleKind,
            scheduledTaskId: input.sessionStartScheduledTaskId,
            scheduledTaskRunId: input.sessionStartScheduledTaskRunId,
          }
        : undefined)
    const sessionResult = await this.ensureSession({
      agent: input.agent,
      createIfMissing: !input.noReply,
      permissions: input.permissions,
      injectionGuardPatterns: input.injectionGuardPatterns,
      sessionStartScheduleKind: sessionStartSource?.scheduleKind,
      sessionStartScheduledTaskId: sessionStartSource?.scheduledTaskId,
    })
    if (sessionResult instanceof Error) return sessionResult

    const { session, getClient, createdNewSession } = sessionResult
    if (input.agent) {
      await setSessionAgent(session.id, input.agent)
      await clearSessionModel(session.id)
    }
    await ensureSessionPreferencesSnapshot({
      sessionId: session.id,
      channelId: this.channelId,
      appId: input.appId,
      getClient,
      directory: this.sdkDirectory,
      agentOverride: input.agent,
      modelOverride: input.model,
      force: createdNewSession,
    })
    const agentResult = await resolveValidatedAgentPreference({
      agent: input.agent,
      sessionId: session.id,
      channelId: this.channelId,
      getClient,
      directory: this.sdkDirectory,
    }).catch((cause) => new OpenCodeSdkError({ operation: 'resolveAgent', cause }))
    if (agentResult instanceof Error) return agentResult
    const agent = agentResult.agentPreference || 'build'
    const [modelResult, preferredVariant] = await Promise.all([
      input.model
        ? validateModelId({ model: input.model, getClient, directory: this.sdkDirectory })
        : getCurrentModelInfo({
            sessionId: session.id,
            channelId: this.channelId,
            appId: input.appId,
            agentPreference: agent,
            getClient,
            directory: this.sdkDirectory,
          }).then((modelInfo) => {
            if (modelInfo.type === 'none') return undefined
            return { providerID: modelInfo.providerID, modelID: modelInfo.modelID }
          }).catch((cause) => new OpenCodeSdkError({
            operation: 'resolveModelPreference',
            cause,
          })),
      getVariantCascade({
        sessionId: session.id,
        channelId: this.channelId,
        appId: input.appId,
      }),
    ])
    if (modelResult instanceof Error) return modelResult
    if (!modelResult) {
      return new Error(
        'No AI provider connected. Configure a provider in OpenCode with `/connect` command.',
      )
    }
    const modelsResponse = await getClient().model.list({
      location: { directory: this.sdkDirectory },
    }).catch((cause) => new OpenCodeSdkError({ operation: 'model.list', cause }))
    const models = modelsResponse instanceof Error ? [] : modelsResponse.data
    const variantRequest = input.variant || preferredVariant
    const variant = variantRequest
      ? matchThinkingValue({
          requestedValue: variantRequest,
          availableValues: getThinkingValuesForModel({
            providers: thinkingProvidersFromListedModels({ models: [...models] }),
            providerId: modelResult.providerID,
            modelId: modelResult.modelID,
          }),
        }) || undefined
      : undefined
    if (input.variant && variant) {
      await setSessionModel({
        sessionId: session.id,
        modelId: `${modelResult.providerID}/${modelResult.modelID}`,
        variant,
      })
    }
    const listedModel = models.find((candidate) => {
      return candidate.providerID === modelResult.providerID
        && candidate.modelID === modelResult.modelID
    })
    this.modelContextLimit = listedModel?.limit?.context
      || getFallbackContextLimit({ providerID: modelResult.providerID })
    this.modelContextLimitKey = `${modelResult.providerID}/${modelResult.modelID}`
    const worktreeInfo = await getThreadWorktreeOrWorkspace(this.thread.id)
    const worktree: WorktreeInfo | undefined =
      worktreeInfo?.status === 'ready' && worktreeInfo.workspace_directory
        ? {
            worktreeDirectory: worktreeInfo.workspace_directory,
            branch: worktreeInfo.workspace_name,
            mainRepoDirectory: worktreeInfo.project_directory,
          }
        : undefined
    const channelTopic = await (async () => {
      if (this.thread.parent?.type === ChannelType.GuildText) {
        return this.thread.parent.topic?.trim() || undefined
      }
      if (!this.channelId) return undefined
      const fetched = await this.thread.guild.channels.fetch(this.channelId)
        .catch((cause) => new DiscordOperationError({ operation: 'fetchChannel', cause }))
      if (fetched instanceof Error || !fetched || fetched.type !== ChannelType.GuildText) {
        return undefined
      }
      return fetched.topic?.trim() || undefined
    })()
    const instructionsResult = await this.persistSessionSystemInstructions({
      client: getClient(),
      sessionId: session.id,
      agents: agentResult.agents,
      channelTopic,
    })
    if (instructionsResult instanceof Error) return instructionsResult
    releaseCurrentThreadIngress()
    await this.sendNewSessionModelInfo({
      createdNewSession,
      model: modelResult,
      agent,
    })
    return buildPreparedAdmissionValue({
      client: getClient(),
      sessionId: session.id,
      prompt: input.prompt,
      syntheticContext: getOpencodePromptContext({
        username: input.username,
        userId: input.userId,
        sourceMessageId: input.sourceMessageId,
        sourceThreadId: input.sourceThreadId || this.thread.id,
        threadName: this.thread.name || undefined,
        repliedMessage: input.repliedMessage,
        worktree,
        currentAgent: agent,
        worktreeChanged: this.consumeWorktreePromptChange(worktree),
      }),
      images: input.images || [],
      agent,
      model: modelResult,
      variant,
      delivery,
      inputKind: input.command ? 'command' : 'prompt',
      source: resolveTurnSource(input),
      ingressMode,
      command: input.command,
      noReply: input.noReply,
      scheduledTaskRunId: sessionStartSource?.scheduledTaskRunId,
    })
  }

  private async submitPreparedAdmission(
    admission: PreparedAdmission,
  ): Promise<Error | null> {
    await waitForGlobalEventListener()
    const selectionResult = await this.applyNativeSessionSelection({
      client: admission.client,
      sessionId: admission.sessionId,
      agent: admission.agent,
      model: admission.model,
      variant: admission.variant,
    })
    if (selectionResult instanceof Error) return selectionResult
    const wasBusy = this.isMainSessionBusy()
    if (!admission.noReply && !wasBusy) {
      this.markQueueDispatchBusy(admission.sessionId)
    }
    const result = await this.submitNativeAdmission({
      client: admission.client,
      sessionId: admission.sessionId,
      text: admission.text,
      images: admission.images,
      delivery: admission.delivery,
      noReply: admission.noReply,
    })
    if (result instanceof Error) {
      if (!admission.noReply) this.markQueueDispatchIdle(admission.sessionId)
      return result
    }
    if (!admission.noReply && admission.delivery === 'steer' && wasBusy) {
      // Busy v2 steer needs a continue interrupt to yield the current step.
      const interruptResult = await admission.client.session.interrupt({
        sessionID: admission.sessionId,
        continue: true,
      }).catch((cause) => new OpenCodeSdkError({ operation: 'session.interrupt', cause }))
      if (interruptResult instanceof Error) {
        logger.warn(
          `[INGRESS] session.interrupt continue failed sessionId=${admission.sessionId} message=${interruptResult.message}`,
        )
      }
    }
    if (admission.scheduledTaskRunId) {
      await startScheduledTaskRunSession({
        runId: admission.scheduledTaskRunId,
        sessionId: admission.sessionId,
        projectDirectory: this.sdkDirectory,
      })
    }
    if (!admission.noReply) {
      trackTurnStarted({
        inputKind: admission.inputKind,
        ingressMode: admission.ingressMode,
        source: admission.source,
        agent: admission.agent,
      })
    }
    return null
  }

  private async submitViaOpencodeQueue(input: IngressInput): Promise<EnqueueResult> {
    await this.supersedePendingSleep(input)
    if (this.abortInFlight) await this.abortInFlight
    await this.dispatchAction(async () => {
      if (input.expectedSessionId && this.state?.sessionId !== input.expectedSessionId) {
        logger.log(
          `[ENQUEUE] Skipping stale session.prompt enqueue for thread ${this.threadId}: expected session ${input.expectedSessionId}, current session ${this.state?.sessionId || 'none'}`,
        )
        return
      }
      if (input.noReply) {
        const existingSessionId = this.state?.sessionId || await getThreadSession(this.thread.id)
        if (!existingSessionId) {
          logger.log(
            `[INGRESS] Skipping noReply message for thread ${this.threadId}: no existing session`,
          )
          return
        }
      }
      const admission = await this.prepareAdmission({
        input,
        delivery: input.mode === 'local-queue' ? 'queue' : 'steer',
        ingressMode: 'direct',
      })
      if (admission instanceof Error) {
        await this.handleAdmissionError(admission)
        await this.tryDrainQueue({ showIndicator: true })
        return
      }
      const result = await this.submitPreparedAdmission(admission)
      if (result instanceof Error) {
        void notifyError(result, 'Direct OpenCode admission failed')
        await this.handleAdmissionError(result)
        await this.tryDrainQueue({ showIndicator: true })
        return
      }
      logger.log(
        `[INGRESS] session.prompt accepted sessionId=${admission.sessionId} threadId=${this.threadId}`,
      )
    })
    return { queued: false }
  }

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
      sessionStartScheduledTaskRunId: input.sessionStartSource?.scheduledTaskRunId,
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
        const pending = [...pendingQuestionContexts.values()].find((context) => {
          return context.thread.id === this.thread.id
        })
        this.maybeHandoffQueuedItemForPendingQuestion({
          sessionId: stateAfterEnqueue?.sessionId || this.state?.sessionId,
          requestId: pending?.requestId,
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

  /** Abort the active run without stopping the event listener. */
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

    // The aborted run owns the question request, so the dropdown dies with it.
    // Questions have no TTL, so this is the only thing that clears them here.
    const pendingFormIds = new Set(
      this.discordProjection.pendingForms.map((form) => form.formId),
    )
    for (const context of pendingQuestionContexts.values()) {
      if (context.thread.id === this.thread.id) pendingFormIds.add(context.requestId)
    }
    for (const formId of pendingFormIds) {
      void this.executeDiscordActions([{
        type: 'settle-form',
        sessionId: sessionId || '',
        formId,
      }])
    }
    void cancelPendingQuestion(this.threadId)

    const apiAbortPromise = sessionId
      ? this.abortSessionViaApi({ abortId, reason, sessionId })
      : undefined
    const abortInFlight = sessionId && apiAbortPromise
      ? apiAbortPromise.then(async () => {
        if (!this.isMainSessionBusy()) return
        await this.waitForEvent({
          predicate: (event) => isSessionSettledEvent({ event, sessionId }),
          sinceTimestamp: getLatestExecutionStartedTimestamp({
            events: this.eventBuffer,
            sessionId,
          }) ?? Date.now(),
          timeoutMs: 2_000,
        })
      })
      : apiAbortPromise
    this.abortInFlight = abortInFlight ?? null
    if (abortInFlight) {
      void abortInFlight.finally(() => {
        if (this.abortInFlight === abortInFlight) {
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
      await this.executeDiscordActions([{ type: 'discard-open-text' }])
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

    // Start dispatch detached so native events can continue through the action queue.
    const dispatchSessionId = thread.sessionId
    if (dispatchSessionId) this.markQueueDispatchBusy(dispatchSessionId)
    void this.dispatchPrompt(next).catch(async (err) => {
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

  private async dispatchPrompt(input: QueuedMessage): Promise<void> {
    const admission = await this.prepareAdmission({
      input,
      delivery: 'queue',
      ingressMode: 'local_queue',
    })
    if (admission instanceof Error) {
      const sessionId = this.state?.sessionId
      if (sessionId) this.markQueueDispatchIdle(sessionId)
      await this.handleAdmissionError(admission)
      return
    }
    if (!admission.command) {
      const result = await this.submitPreparedAdmission(admission)
      if (result instanceof Error) {
        void notifyError(result, 'Local queue OpenCode admission failed')
        await this.handleAdmissionError(result)
      }
      return
    }
    await this.submitPreparedCommand(admission)
  }

  private async submitPreparedCommand(admission: PreparedAdmission): Promise<void> {
    const command = admission.command
    if (!command) return
    const settleDispatch = () => this.markQueueDispatchIdle(admission.sessionId)
    const selectionResult = await this.applyNativeSessionSelection({
      client: admission.client,
      sessionId: admission.sessionId,
      agent: admission.agent,
      model: admission.model,
      variant: admission.variant,
    })
    if (selectionResult instanceof Error) {
      settleDispatch()
      await this.handleAdmissionError(selectionResult)
      return
    }
    const signal = AbortSignal.timeout(30_000)
    const result = await admission.client.session.command({
      sessionID: admission.sessionId,
      command: command.name,
      text: command.arguments + (admission.text ? `\n${admission.text}` : ''),
    }, { signal }).then(() => null).catch((cause) => ({
      error: new OpenCodeSdkError({ operation: 'session.command', cause }),
      message: extractSdkErrorMessage(cause),
    }))
    if (result === null) {
      trackTurnStarted({
        inputKind: 'command',
        ingressMode: admission.ingressMode,
        source: admission.source,
        agent: admission.agent,
      })
      return
    }
    const response = result.error
    if (signal.aborted) {
      settleDispatch()
      await this.handleAdmissionError(
        new Error('Command timed out after 30 seconds. Try a shorter command or run it with /run-shell-command.'),
      )
      return
    }
    const wasAborted: boolean = isAbortError(response)
    if (wasAborted) {
      settleDispatch()
      this.stopTyping()
      return
    }
    const causeMessage = result.message
    // Native command errors have route-dependent shapes, so match normalized text.
    if (causeMessage.includes('Command not found')) {
      settleDispatch()
      await this.handleAdmissionError(new Error(`Command not found: "${command.name}"`))
      return
    }
    settleDispatch()
    void notifyError(response, 'Failed to send command to OpenCode')
    await this.handleAdmissionError(
      new Error(`Unexpected bot Error: ${causeMessage || response.message}`, { cause: response }),
    )
  }

  // ── Session Ensure ──────────────────────────────────────────
  // Creates or reuses the OpenCode session for this thread.

  /** Session IDs with instructions already persisted by this runtime. */
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
    return null
  }

  private async ensureSession({
    agent,
    createIfMissing = true,
    permissions,
    injectionGuardPatterns,
    sessionStartScheduleKind,
    sessionStartScheduledTaskId,
  }: {
    agent?: string
    createIfMissing?: boolean
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
    if (!session && !createIfMissing) {
      return new Error(`Existing session ${sessionId || 'unknown'} is unavailable`)
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
   * Triggered by native execution completion so it follows assistant output.
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
