// OpenCode session lifecycle manager.
// Creates, maintains, and sends prompts to OpenCode sessions from Discord threads.
// Handles streaming events, permissions, abort signals, and message queuing.
//
// Migration note: Phase 1 introduces the ThreadSessionRuntime skeleton
// (thread-session-runtime.ts) and runtime state (thread-runtime-state.ts).
// This file keeps the old per-message flow. Phase 3 will add a routing
// adapter here to delegate to the runtime. See:
//   docs/event-listener-runtime-migration-plan.md

import type {
  Part,
  PermissionRequest,
  QuestionRequest,
} from '@opencode-ai/sdk/v2'
import type { DiscordFileAttachment } from './message-formatting.js'
import { ChannelType, type Message, type ThreadChannel } from 'discord.js'
import prettyMilliseconds from 'pretty-ms'
import fs from 'node:fs'
import path from 'node:path'
import { xdgState } from 'xdg-basedir'
import {
  getSessionAgent,
  getSessionModel,
  getVariantCascade,
  getChannelAgent,
  setSessionAgent,
  getThreadWorktree,
  getChannelVerbosity,
  getThreadSession,
  setThreadSession,
  getPartMessageIds,
  setPartMessage,
  getChannelDirectory,
  setSessionStartSource,
  type ScheduledTaskScheduleKind,
} from './database.js'
import {
  ensureSessionPreferencesSnapshot,
  getCurrentModelInfo,
} from './commands/model.js'
import {
  initializeOpencodeForDirectory,
  getOpencodeServers,
  getOpencodeClient,
} from './opencode.js'
import {
  sendThreadMessage,
  resolveWorkingDirectory,
  NOTIFY_MESSAGE_FLAGS,
  SILENT_MESSAGE_FLAGS,
} from './discord-utils.js'
import { formatPart } from './message-formatting.js'
import {
  getOpencodeSystemMessage,
  type AgentInfo,
  type WorktreeInfo,
} from './system-message.js'
import { createLogger, LogPrefix } from './logger.js'
import { isAbortError } from './utils.js'
import { SessionAbortError } from './errors.js'
import { notifyError } from './sentry.js'
import {
  showAskUserQuestionDropdowns,
  cancelPendingQuestion,
  pendingQuestionContexts,
} from './commands/ask-question.js'
import {
  showPermissionButtons,
  cleanupPermissionContext,
  addPermissionRequestToContext,
  arePatternsCoveredBy,
} from './commands/permissions.js'
import { cancelPendingFileUpload } from './commands/file-upload.js'
import {
  cancelPendingActionButtons,
  showActionButtons,
  waitForQueuedActionButtonsRequest,
} from './commands/action-buttons.js'
import {
  getThinkingValuesForModel,
  matchThinkingValue,
} from './thinking-utils.js'
import { execAsync } from './worktree-utils.js'
import * as errore from 'errore'
import * as sessionRunState from './session-handler/state.js'

const sessionLogger = createLogger(LogPrefix.SESSION)
const voiceLogger = createLogger(LogPrefix.VOICE)
const discordLogger = createLogger(LogPrefix.DISCORD)

export const abortControllers = new Map<string, AbortController>()

/** Format opencode session error with status, provider, and response body for debugging. */
function formatSessionError(error?: {
  data?: {
    message?: string
    statusCode?: number
    providerID?: string
    isRetryable?: boolean
    responseBody?: string
  }
  name?: string
  message?: string
}): string {
  const name = error?.name || 'Error'
  // Prefer data.message (SDK shape), fall back to error.message (plain Error)
  const message =
    error?.data?.message ||
    error?.message ||
    'Unknown error'
  const details: string[] = []
  if (error?.data?.statusCode !== undefined) {
    details.push(`status=${error.data.statusCode}`)
  }
  if (error?.data?.providerID) {
    details.push(`provider=${error.data.providerID}`)
  }
  if (typeof error?.data?.isRetryable === 'boolean') {
    details.push(error.data.isRetryable ? 'retryable' : 'non-retryable')
  }
  const responseBody =
    typeof error?.data?.responseBody === 'string'
      ? error.data.responseBody.trim()
      : ''
  if (responseBody) {
    details.push(`body=${responseBody.slice(0, 180)}`)
  }
  const suffix = details.length > 0 ? ` (${details.join(', ')})` : ''
  return `${name}: ${message}${suffix}`
}

export function signalThreadInterrupt({
  threadId,
  serverDirectory,
  sdkDirectory,
}: {
  threadId: string
  serverDirectory?: string
  sdkDirectory?: string
}): void {
  void (async () => {
    const sessionId = await getThreadSession(threadId)
    if (!sessionId) {
      return
    }

    const controller = abortControllers.get(sessionId)
    if (!controller || controller.signal.aborted) {
      return
    }

    sessionLogger.log(
      `[ABORT] reason=queued-message sessionId=${sessionId} threadId=${threadId} - new message queued, aborting running session immediately`,
    )
    controller.abort(new SessionAbortError({ reason: 'new-request' }))

    if (!serverDirectory || !sdkDirectory) {
      return
    }

    const client = getOpencodeClient(serverDirectory)
    if (!client) {
      sessionLogger.log(
        `[ABORT-API] reason=queued-message sessionId=${sessionId} - no OpenCode client found for directory ${serverDirectory}`,
      )
      return
    }

    const abortResult = await errore.tryAsync(() => {
      return client.session.abort({
        sessionID: sessionId,
        directory: sdkDirectory,
      })
    })
    if (abortResult instanceof Error) {
      sessionLogger.log(
        `[ABORT-API] reason=queued-message sessionId=${sessionId} - API abort failed (may already be done):`,
        abortResult,
      )
    }
  })()
}

// Built-in tools that are hidden in text-and-essential-tools verbosity mode.
// Essential tools (edits, bash with side effects, todos, tasks, custom MCP tools) are shown; these navigation/read tools are hidden.
const NON_ESSENTIAL_TOOLS = new Set([
  'read',
  'list',
  'glob',
  'grep',
  'todoread',
  'question',
  'kimaki_action_buttons',
  'webfetch',
])

function isEssentialToolName(toolName: string): boolean {
  return !NON_ESSENTIAL_TOOLS.has(toolName)
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

// Track multiple pending permissions per thread (keyed by permission ID)
// OpenCode handles blocking/sequencing - we just need to track all pending permissions
// to avoid duplicates and properly clean up on auto-reject
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

async function removeBotErrorReaction({
  message,
}: {
  message: Message
}): Promise<void> {
  const botUserId = message.client.user?.id
  if (!botUserId) {
    return
  }
  const errorReaction = message.reactions.cache.find((reaction) => {
    return reaction.emoji.name === '❌'
  })
  if (!errorReaction) {
    return
  }
  await errorReaction.users.remove(botUserId)
}

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

// Re-export QueuedMessage for backward compatibility.
// New code should import from './session-handler/thread-runtime-state.js' instead.
export type { QueuedMessage } from './session-handler/thread-runtime-state.js'
import type { QueuedMessage } from './session-handler/thread-runtime-state.js'

// Queue of messages waiting to be sent after current response finishes
// Key is threadId, value is array of queued messages
export const messageQueue = new Map<string, QueuedMessage[]>()

const activeEventHandlers = new Map<string, Promise<void>>()

export function addToQueue({
  threadId,
  message,
}: {
  threadId: string
  message: QueuedMessage
}): number {
  const queue = messageQueue.get(threadId) || []
  queue.push(message)
  messageQueue.set(threadId, queue)
  return queue.length
}

export function getQueueLength(threadId: string): number {
  return messageQueue.get(threadId)?.length || 0
}

export function clearQueue(threadId: string): void {
  messageQueue.delete(threadId)
}

export type QueueOrSendResult =
  | { action: 'sent' }
  | { action: 'queued'; position: number }
  | { action: 'no-session' }
  | { action: 'no-directory' }

/**
 * Queue a message if there's an active in-progress request, otherwise send immediately.
 * Abstracts the "check active request → send or queue" pattern used by /queue command
 * and voice transcription queue detection.
 *
 * Checks active request BEFORE resolving directory so that queueing works even if
 * directory resolution would fail — the queued message only needs a directory later
 * when it's actually sent (the drain logic in handleOpencodeSession already has it).
 *
 * If there is no existing session or no project directory (on immediate-send path),
 * returns an error-like result so the caller can handle it.
 */
export async function queueOrSendMessage({
  thread,
  prompt,
  userId,
  username,
  appId,
  images,
  forceQueue,
}: {
  thread: ThreadChannel
  prompt: string
  userId: string
  username: string
  appId?: string
  images?: DiscordFileAttachment[]
  /** When true, queue the message even if no active request is detected right now.
   *  Used by voice transcription: the active request state is snapshotted at message
   *  arrival time (before the prev task finishes), because by the time transcription
   *  completes and this function runs, the previous session may have already finished. */
  forceQueue?: boolean
}): Promise<QueueOrSendResult> {
  const sessionId = await getThreadSession(thread.id)
  if (!sessionId) {
    return { action: 'no-session' }
  }

  // Check active request FIRST — queueing doesn't need directory resolution
  const existingController = abortControllers.get(sessionId)
  const hasActiveRequest = Boolean(
    existingController && !existingController.signal.aborted,
  )
  if (existingController && existingController.signal.aborted) {
    abortControllers.delete(sessionId)
  }

  if (hasActiveRequest || forceQueue) {
    // Active request — add to queue (no directory needed, drain logic has it)
    const position = addToQueue({
      threadId: thread.id,
      message: {
        prompt,
        userId,
        username,
        queuedAt: Date.now(),
        images,
        appId,
      },
    })

    sessionLogger.log(
      `[QUEUE] User ${username} queued message in thread ${thread.id} (position: ${position})`,
    )

    return { action: 'queued', position }
  }

  // No active request — send immediately (need directory for this path)
  const resolved = await resolveWorkingDirectory({ channel: thread })
  if (!resolved) {
    return { action: 'no-directory' }
  }

  sessionLogger.log(
    `[QUEUE] No active request, sending immediately in thread ${thread.id}`,
  )

  handleOpencodeSession({
    prompt,
    thread,
    projectDirectory: resolved.projectDirectory,
    channelId: thread.parentId || thread.id,
    images,
    username,
    userId,
    appId,
  }).catch(async (e) => {
    sessionLogger.error(`[QUEUE] Failed to send message:`, e)
    void notifyError(e, 'Queue: failed to send message')
    const errorMsg = e instanceof Error ? e.message : String(e)
    await sendThreadMessage(thread, `✗ Failed: ${errorMsg.slice(0, 200)}`)
  })

  return { action: 'sent' }
}

/**
 * Read user's recent models from OpenCode TUI's state file.
 * Uses same path as OpenCode: path.join(xdgState, "opencode", "model.json")
 * Returns all recent models so we can iterate until finding a valid one.
 * See: opensrc/repos/github.com/sst/opencode/packages/opencode/src/global/index.ts
 */
function getRecentModelsFromTuiState(): Array<{
  providerID: string
  modelID: string
}> {
  if (!xdgState) {
    return []
  }
  // Same path as OpenCode TUI: path.join(Global.Path.state, "model.json")
  const modelJsonPath = path.join(xdgState, 'opencode', 'model.json')

  const result = errore.tryFn(() => {
    const content = fs.readFileSync(modelJsonPath, 'utf-8')
    const data = JSON.parse(content) as {
      recent?: Array<{ providerID: string; modelID: string }>
    }
    return data.recent ?? []
  })

  if (result instanceof Error) {
    // File doesn't exist or is invalid - this is normal for fresh installs
    return []
  }

  return result
}

/**
 * Parse a model string in format "provider/model" into providerID and modelID.
 */
function parseModelString(
  model: string,
): { providerID: string; modelID: string } | undefined {
  const [providerID, ...modelParts] = model.split('/')
  const modelID = modelParts.join('/')
  if (!providerID || !modelID) {
    return undefined
  }
  return { providerID, modelID }
}

/**
 * Validate that a model is available (provider connected + model exists).
 */
function isModelValid(
  model: { providerID: string; modelID: string },
  connected: string[],
  providers: Array<{ id: string; models?: Record<string, unknown> }>,
): boolean {
  const isConnected = connected.includes(model.providerID)
  const provider = providers.find((p) => p.id === model.providerID)
  const modelExists = provider?.models && model.modelID in provider.models
  return isConnected && !!modelExists
}

export async function resolveValidatedAgentPreference({
  agent,
  sessionId,
  channelId,
  getClient,
}: {
  agent?: string
  sessionId: string
  channelId?: string
  getClient: Awaited<ReturnType<typeof initializeOpencodeForDirectory>>
}): Promise<{ agentPreference?: string; agents: AgentInfo[] }> {
  const agentPreference = await (async (): Promise<string | undefined> => {
    if (agent) {
      return agent
    }

    const sessionAgent = await getSessionAgent(sessionId)
    if (sessionAgent) {
      return sessionAgent
    }

    const sessionModel = await getSessionModel(sessionId)
    if (sessionModel) {
      return undefined
    }

    if (!channelId) {
      return undefined
    }
    return getChannelAgent(channelId)
  })()

  if (getClient instanceof Error) {
    return { agentPreference: agentPreference || undefined, agents: [] }
  }

  const agentsResponse = await errore.tryAsync(() => {
    return getClient().app.agents({})
  })
  if (agentsResponse instanceof Error) {
    if (agentPreference) {
      throw new Error(`Failed to validate agent "${agentPreference}"`, {
        cause: agentsResponse,
      })
    }
    return { agentPreference: undefined, agents: [] }
  }

  const availableAgents = agentsResponse.data || []
  // Non-hidden primary/all agents for system message context
  const agents: AgentInfo[] = availableAgents
    .filter((a) => {
      return (
        (a.mode === 'primary' || a.mode === 'all') &&
        !a.hidden
      )
    })
    .map((a) => {
      return { name: a.name, description: a.description }
    })

  if (!agentPreference) {
    return { agentPreference: undefined, agents }
  }

  const hasAgent = availableAgents.some((availableAgent) => {
    return availableAgent.name === agentPreference
  })
  if (hasAgent) {
    return { agentPreference, agents }
  }

  const availableAgentNames = availableAgents
    .map((availableAgent) => {
      return availableAgent.name
    })
    .slice(0, 20)
  const availableAgentsMessage =
    availableAgentNames.length > 0
      ? `Available agents: ${availableAgentNames.join(', ')}`
      : 'No agents are available in this project.'
  throw new Error(
    `Agent "${agentPreference}" not found. ${availableAgentsMessage} Use /agent to choose a valid one.`,
  )
}

export type DefaultModelSource =
  | 'opencode-config'
  | 'opencode-recent'
  | 'opencode-provider-default'

export type SessionStartSourceContext = {
  scheduleKind: ScheduledTaskScheduleKind
  scheduledTaskId?: number
}

/**
 * Get the default model from OpenCode when no user preference is set.
 * Priority (matches OpenCode TUI behavior):
 * 1. OpenCode config.model setting
 * 2. User's recent models from TUI state (~/.local/state/opencode/model.json)
 * 3. First connected provider's default model from API
 * Returns the model and its source.
 */
export async function getDefaultModel({
  getClient,
}: {
  getClient: Awaited<ReturnType<typeof initializeOpencodeForDirectory>>
}): Promise<
  | { providerID: string; modelID: string; source: DefaultModelSource }
  | undefined
> {
  if (getClient instanceof Error) {
    return undefined
  }

  // Fetch connected providers to validate any model we return
  const providersResponse = await errore.tryAsync(() => {
    return getClient().provider.list({})
  })
  if (providersResponse instanceof Error) {
    sessionLogger.log(
      `[MODEL] Failed to fetch providers for default model:`,
      providersResponse.message,
    )
    return undefined
  }
  if (!providersResponse.data) {
    return undefined
  }

  const {
    connected,
    default: defaults,
    all: providers,
  } = providersResponse.data
  if (connected.length === 0) {
    sessionLogger.log(`[MODEL] No connected providers found`)
    return undefined
  }

  // 1. Check OpenCode config.model setting (highest priority after user preference)
  const configResponse = await errore.tryAsync(() => {
    return getClient().config.get({})
  })
  if (!(configResponse instanceof Error) && configResponse.data?.model) {
    const configModel = parseModelString(configResponse.data.model)
    if (configModel && isModelValid(configModel, connected, providers)) {
      sessionLogger.log(
        `[MODEL] Using config model: ${configModel.providerID}/${configModel.modelID}`,
      )
      return { ...configModel, source: 'opencode-config' }
    }
    if (configModel) {
      sessionLogger.log(
        `[MODEL] Config model ${configResponse.data.model} not available, checking recent`,
      )
    }
  }

  // 2. Try to use user's recent models from TUI state (iterate until finding valid one)
  const recentModels = getRecentModelsFromTuiState()
  for (const recentModel of recentModels) {
    if (isModelValid(recentModel, connected, providers)) {
      sessionLogger.log(
        `[MODEL] Using recent TUI model: ${recentModel.providerID}/${recentModel.modelID}`,
      )
      return { ...recentModel, source: 'opencode-recent' }
    }
  }
  if (recentModels.length > 0) {
    sessionLogger.log(`[MODEL] No valid recent TUI models found`)
  }

  // 3. Fall back to first connected provider's default model
  const firstConnected = connected[0]
  if (!firstConnected) {
    return undefined
  }
  const defaultModelId = defaults[firstConnected]
  if (!defaultModelId) {
    sessionLogger.log(`[MODEL] No default model for provider ${firstConnected}`)
    return undefined
  }

  sessionLogger.log(
    `[MODEL] Using provider default: ${firstConnected}/${defaultModelId}`,
  )
  return {
    providerID: firstConnected,
    modelID: defaultModelId,
    source: 'opencode-provider-default',
  }
}

/**
 * Abort a running session and retry with the last user message.
 * Used when model preference changes mid-request.
 * Fetches last user message from OpenCode API instead of tracking in memory.
 * @returns true if aborted and retry scheduled, false if no active request
 */
export async function abortAndRetrySession({
  sessionId,
  thread,
  projectDirectory,
  appId,
  channelId,
}: {
  sessionId: string
  thread: ThreadChannel
  projectDirectory: string
  appId?: string
  channelId?: string
}): Promise<boolean> {
  const controller = abortControllers.get(sessionId)

  if (!controller) {
    sessionLogger.log(
      `[ABORT+RETRY] No active request for session ${sessionId}`,
    )
    return false
  }

  sessionLogger.log(
    `[ABORT+RETRY] Aborting session ${sessionId} for model change`,
  )

  // Abort with special reason so we don't show "completed" message
  sessionLogger.log(
    `[ABORT] reason=model-change sessionId=${sessionId} - user changed model mid-request, will retry with new model`,
  )
  controller.abort(new SessionAbortError({ reason: 'model-change' }))

  // Also call the API abort endpoint
  const getClient = await initializeOpencodeForDirectory(projectDirectory, {
    channelId,
  })
  if (getClient instanceof Error) {
    sessionLogger.error(
      `[ABORT+RETRY] Failed to initialize OpenCode client:`,
      getClient.message,
    )
    return false
  }
  sessionLogger.log(
    `[ABORT-API] reason=model-change sessionId=${sessionId} - sending API abort for model change retry`,
  )
  const abortResult = await errore.tryAsync(() => {
    return getClient().session.abort({ sessionID: sessionId })
  })
  if (abortResult instanceof Error) {
    sessionLogger.log(
      `[ABORT-API] API abort call failed (may already be done):`,
      abortResult,
    )
  }

  // Small delay to let the abort propagate
  await new Promise((resolve) => {
    setTimeout(resolve, 300)
  })

  // Fetch last user message from API
  sessionLogger.log(
    `[ABORT+RETRY] Fetching last user message for session ${sessionId}`,
  )
  const messagesResponse = await getClient().session.messages({
    sessionID: sessionId,
  })
  const messages = messagesResponse.data || []
  const lastUserMessage = [...messages]
    .reverse()
    .find((m) => m.info.role === 'user')

  if (!lastUserMessage) {
    sessionLogger.log(
      `[ABORT+RETRY] No user message found in session ${sessionId}`,
    )
    return false
  }

  // Extract text and images from parts (skip synthetic parts like branch context)
  const textPart = lastUserMessage.parts.find(
    (p) => p.type === 'text' && !p.synthetic,
  ) as { type: 'text'; text: string } | undefined
  const prompt = textPart?.text || ''
  const images = lastUserMessage.parts.filter(
    (p) => p.type === 'file',
  ) as DiscordFileAttachment[]

  sessionLogger.log(
    `[ABORT+RETRY] Re-triggering session ${sessionId} with new model`,
  )

  // Use setImmediate to avoid blocking
  setImmediate(() => {
    void errore
      .tryAsync(async () => {
        return handleOpencodeSession({
          prompt,
          thread,
          projectDirectory,
          images,
          appId,
          channelId,
        })
      })
      .then(async (result) => {
        if (!(result instanceof Error)) {
          return
        }
        sessionLogger.error(`[ABORT+RETRY] Failed to retry:`, result)
        void notifyError(result, 'Abort+retry session failed')
        await sendThreadMessage(
          thread,
          `✗ Failed to retry with new model: ${result.message.slice(0, 200)}`,
        )
      })
  })

  return true
}

export async function handleOpencodeSession({
  prompt,
  thread,
  projectDirectory,
  originalMessage,
  images = [],
  channelId,
  command,
  agent,
  model,
  username,
  userId,
  appId,
  sessionStartSource,
}: {
  prompt: string
  thread: ThreadChannel
  projectDirectory?: string
  originalMessage?: Message
  images?: DiscordFileAttachment[]
  channelId?: string
  /** If set, uses session.command API instead of session.prompt */
  command?: { name: string; arguments: string }
  /** Agent to use for this session */
  agent?: string
  /** Model override (format: provider/model) */
  model?: string
  /** Discord username for synthetic context (not shown in TUI) */
  username?: string
  /** Discord user ID for system prompt examples */
  userId?: string
  appId?: string
  /** Metadata for sessions started by scheduled tasks */
  sessionStartSource?: SessionStartSourceContext
}): Promise<{ sessionID: string; result: any; port?: number } | undefined> {
  voiceLogger.log(
    `[OPENCODE SESSION] Starting for thread ${thread.id} with prompt: "${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}"`,
  )

  const sessionStartTime = Date.now()

  const directory = projectDirectory || process.cwd()
  sessionLogger.log(`Using directory: ${directory}`)

  // Fire DB lookups in parallel - they're independent and we need both before proceeding.
  // initializeOpencodeForDirectory is NOT included here because it needs worktree info
  // to set originalRepoDirectory permissions on the spawned server (reuse check means
  // a second call with different options won't fix a server already spawned without them).
  const [worktreeInfo, existingSessionId] = await Promise.all([
    getThreadWorktree(thread.id),
    getThreadSession(thread.id),
  ])

  const worktreeDirectory =
    worktreeInfo?.status === 'ready' && worktreeInfo.worktree_directory
      ? worktreeInfo.worktree_directory
      : undefined
  const sdkDirectory = worktreeDirectory || directory
  if (worktreeDirectory) {
    sessionLogger.log(
      `Using worktree directory for SDK calls: ${worktreeDirectory}`,
    )
  }

  const originalRepoDirectory = worktreeDirectory
    ? worktreeInfo?.project_directory
    : undefined
  const getClient = await initializeOpencodeForDirectory(directory, {
    originalRepoDirectory,
    channelId,
  })
  if (getClient instanceof Error) {
    await sendThreadMessage(thread, `✗ ${getClient.message}`)
    return
  }

  const serverEntry = getOpencodeServers().get(directory)
  const port = serverEntry?.port

  let sessionId = existingSessionId
  let session
  let createdNewSession = false

  if (sessionId) {
    sessionLogger.log(`Attempting to reuse existing session ${sessionId}`)
    const sessionResponse = await errore.tryAsync(() => {
      return getClient().session.get({
        sessionID: sessionId,
        directory: sdkDirectory,
      })
    })
    if (sessionResponse instanceof Error) {
      voiceLogger.log(
        `[SESSION] Session ${sessionId} not found, will create new one`,
      )
    } else {
      session = sessionResponse.data
      sessionLogger.log(`Successfully reused session ${sessionId}`)
    }
  }

  if (!session) {
    const sessionTitle =
      prompt.length > 80 ? prompt.slice(0, 77) + '...' : prompt.slice(0, 80)
    voiceLogger.log(
      `[SESSION] Creating new session with title: "${sessionTitle}"`,
    )
    const sessionResponse = await getClient().session.create({
      title: sessionTitle,
      directory: sdkDirectory,
    })
    session = sessionResponse.data
    createdNewSession = true
    sessionLogger.log(`Created new session ${session?.id}`)
  }

  if (!session) {
    throw new Error('Failed to create or get session')
  }

  await setThreadSession(thread.id, session.id)
  sessionLogger.log(`Stored session ${session.id} for thread ${thread.id}`)

  const channelInfo = channelId
    ? await getChannelDirectory(channelId)
    : undefined
  const resolvedAppId = channelInfo?.appId ?? appId

  if (createdNewSession && sessionStartSource) {
    const saveStartSourceResult = await errore.tryAsync(() => {
      return setSessionStartSource({
        sessionId: session.id,
        scheduleKind: sessionStartSource.scheduleKind,
        scheduledTaskId: sessionStartSource.scheduledTaskId,
      })
    })
    if (saveStartSourceResult instanceof Error) {
      sessionLogger.warn(
        `[SESSION] Failed to store start source for session ${session.id}: ${saveStartSourceResult.message}`,
      )
    }
  }

  // Store agent preference if provided
  if (agent) {
    await setSessionAgent(session.id, agent)
    sessionLogger.log(
      `Set agent preference for session ${session.id}: ${agent}`,
    )
  }

  await ensureSessionPreferencesSnapshot({
    sessionId: session.id,
    channelId,
    appId: resolvedAppId,
    getClient,
    agentOverride: agent,
    modelOverride: model,
    force: createdNewSession,
  })

  const existingController = abortControllers.get(session.id)
  if (existingController) {
    voiceLogger.log(
      `[ABORT] Cancelling existing request for session: ${session.id}`,
    )
    sessionLogger.log(
      `[ABORT] reason=new-request sessionId=${session.id} threadId=${thread.id} - new user message arrived while previous request was still running`,
    )
    existingController.abort(new SessionAbortError({ reason: 'new-request' }))
    sessionLogger.log(
      `[ABORT-API] reason=new-request sessionId=${session.id} - sending API abort because new message arrived`,
    )
    const abortResult = await errore.tryAsync(() => {
      return getClient().session.abort({
        sessionID: session.id,
        directory: sdkDirectory,
      })
    })
    if (abortResult instanceof Error) {
      sessionLogger.log(
        `[ABORT-API] Server abort failed (may be already done):`,
        abortResult,
      )
    }
  }

  // Auto-reject ALL pending permissions for this thread
  const threadPermissions = pendingPermissions.get(thread.id)
  if (threadPermissions && threadPermissions.size > 0) {
    const permClient = getOpencodeClient(directory)
    for (const [permId, pendingPerm] of threadPermissions) {
      sessionLogger.log(
        `[PERMISSION] Auto-rejecting permission ${permId} due to new message`,
      )
      // Remove the permission buttons from the Discord message
      const removeButtonsResult = await errore.tryAsync(async () => {
        const msg = await thread.messages.fetch(pendingPerm.messageId)
        await msg.edit({ components: [] })
      })
      if (removeButtonsResult instanceof Error) {
        sessionLogger.log(
          `[PERMISSION] Failed to remove buttons for ${permId}:`,
          removeButtonsResult,
        )
      }
      if (!permClient) {
        sessionLogger.log(
          `[PERMISSION] OpenCode client unavailable for permission ${permId}`,
        )
        cleanupPermissionContext(pendingPerm.contextHash)
        continue
      }
      const rejectResult = await errore.tryAsync(() => {
        return permClient.permission.reply({
          requestID: permId,
          directory: pendingPerm.permissionDirectory,
          reply: 'reject',
        })
      })
      if (rejectResult instanceof Error) {
        sessionLogger.log(
          `[PERMISSION] Failed to auto-reject permission ${permId}:`,
          rejectResult,
        )
      }
      cleanupPermissionContext(pendingPerm.contextHash)
    }
    pendingPermissions.delete(thread.id)
  }

  // Answer any pending question tool with the user's message (silently, no thread message)
  const questionAnswered = await cancelPendingQuestion(thread.id, prompt)
  if (questionAnswered) {
    sessionLogger.log(`[QUESTION] Answered pending question with user message`)
  }

  // Cancel any pending file upload (resolves with empty array so plugin tool unblocks)
  const fileUploadCancelled = await cancelPendingFileUpload(thread.id)
  if (fileUploadCancelled) {
    sessionLogger.log(
      `[FILE-UPLOAD] Cancelled pending file upload due to new message`,
    )
  }

  // Dismiss any pending action buttons (user sent a new message instead of clicking)
  const actionButtonsDismissed = cancelPendingActionButtons(thread.id)
  if (actionButtonsDismissed) {
    sessionLogger.log(
      `[ACTION] Dismissed pending action buttons due to new message`,
    )
  }

  // Snapshot model+agent early so user changes (e.g. /agent) during the async gap
  // (debounce, previous handler wait, event subscribe) don't affect this request.
  const earlyAgentResult = await errore.tryAsync(() => {
    return resolveValidatedAgentPreference({
      agent,
      sessionId: session.id,
      channelId,
      getClient,
    })
  })
  if (earlyAgentResult instanceof Error) {
    await sendThreadMessage(
      thread,
      `Failed to resolve agent: ${earlyAgentResult.message}`,
    )
    return
  }
  const earlyAgentPreference = earlyAgentResult.agentPreference
  const earlyAvailableAgents = earlyAgentResult.agents
  if (earlyAgentPreference) {
    sessionLogger.log(
      `[AGENT] Resolved agent preference early: ${earlyAgentPreference}`,
    )
  }

  // Model resolution and variant cascade are independent - run in parallel.
  // Variant cascade only needs resolvedAppId (available now). Variant validation
  // against the model happens after both complete.
  const [earlyModelResult, preferredVariant] = await Promise.all([
    errore.tryAsync(async () => {
      if (model) {
        const [providerID, ...modelParts] = model.split('/')
        const modelID = modelParts.join('/')
        if (providerID && modelID) {
          sessionLogger.log(`[MODEL] Using explicit model (early): ${model}`)
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
        sessionLogger.log(`[MODEL] No model available (early resolution)`)
        return undefined
      }
      sessionLogger.log(
        `[MODEL] Resolved ${modelInfo.type} early: ${modelInfo.model}`,
      )
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
      thread,
      `Failed to resolve model: ${earlyModelResult.message}`,
    )
    return
  }
  const earlyModelParam = earlyModelResult
  if (!earlyModelParam) {
    await sendThreadMessage(
      thread,
      'No AI provider connected. Configure a provider in OpenCode with `/connect` command.',
    )
    return
  }

  // Validate the preferred variant against the current model's available variants.
  // preferredVariant was already fetched in parallel above.
  const earlyThinkingValue = await (async (): Promise<string | undefined> => {
    if (!preferredVariant) {
      return undefined
    }
    const providersResponse = await errore.tryAsync(() => {
      return getClient().provider.list({ directory: sdkDirectory })
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
      sessionLogger.log(
        `[THINK] Model ${earlyModelParam.providerID}/${earlyModelParam.modelID} has no variants, ignoring preference`,
      )
      return undefined
    }
    const matched = matchThinkingValue({
      requestedValue: preferredVariant,
      availableValues,
    })
    if (!matched) {
      sessionLogger.log(
        `[THINK] Preference "${preferredVariant}" invalid for current model, ignoring`,
      )
      return undefined
    }
    sessionLogger.log(`[THINK] Using variant: ${matched}`)
    return matched
  })()

  const abortController = new AbortController()
  abortControllers.set(session.id, abortController)

  if (existingController) {
    await new Promise((resolve) => {
      setTimeout(resolve, 200)
    })
    if (abortController.signal.aborted) {
      sessionLogger.log(
        `[DEBOUNCE] Request was superseded during wait, exiting`,
      )
      return
    }
  }

  if (abortController.signal.aborted) {
    sessionLogger.log(`[DEBOUNCE] Aborted before subscribe, exiting`)
    return
  }

  const previousHandler = activeEventHandlers.get(thread.id)
  if (previousHandler) {
    sessionLogger.log(`[EVENT] Waiting for previous handler to finish`)
    const previousHandlerResult = await errore.tryAsync(() => {
      return previousHandler
    })
    if (previousHandlerResult instanceof Error) {
      sessionLogger.warn(
        `[EVENT] Previous handler exited with error while waiting: ${previousHandlerResult.message}`,
      )
    }
  }

  const eventClient = getOpencodeClient(directory)
  if (!eventClient) {
    throw new Error(`OpenCode client not found for directory: ${directory}`)
  }
  const eventsResult = await eventClient.event.subscribe(
    { directory: sdkDirectory },
    { signal: abortController.signal },
  )

  if (abortController.signal.aborted) {
    sessionLogger.log(`[DEBOUNCE] Aborted during subscribe, exiting`)
    return
  }

  const events = eventsResult.stream
  sessionLogger.log(`Subscribed to OpenCode events`)

  const existingPartIds = await getPartMessageIds(thread.id)
  const sentPartIds = new Set<string>(existingPartIds)

  const partBuffer = new Map<string, Map<string, Part>>()
  let usedModel: string | undefined = earlyModelParam.modelID
  let usedProviderID: string | undefined = earlyModelParam.providerID
  let usedAgent: string | undefined
  let tokensUsedInSession = 0
  let lastDisplayedContextPercentage = 0
  let lastRateLimitDisplayTime = 0
  let modelContextLimit: number | undefined
  let modelContextLimitKey: string | undefined
  let assistantMessageId: string | undefined
  let handlerPromise: Promise<void> | null = null

  let typingInterval: NodeJS.Timeout | null = null
  let typingRestartTimeout: NodeJS.Timeout | null = null
  let handlerClosed = false
  let hasSentParts = false
  const mainRunStore = sessionRunState.createMainRunStore()

  const finishMainSessionFromIdle = (): void => {
    if (abortController.signal.aborted) {
      return
    }
    sessionRunState.markFinished({ store: mainRunStore })
    sessionLogger.log(
      `[SESSION IDLE] Session ${session.id} is idle, ending stream`,
    )
    sessionLogger.log(
      `[ABORT] reason=finished sessionId=${session.id} threadId=${thread.id} - session completed normally, received idle event after prompt resolved`,
    )
    abortController.abort(new SessionAbortError({ reason: 'finished' }))
  }

  function clearTypingInterval(): void {
    if (!typingInterval) {
      return
    }
    clearInterval(typingInterval)
    typingInterval = null
  }

  function clearTypingRestartTimeout(): void {
    if (!typingRestartTimeout) {
      return
    }
    clearTimeout(typingRestartTimeout)
    typingRestartTimeout = null
  }

  function stopTyping(): void {
    clearTypingInterval()
    clearTypingRestartTimeout()
  }

  function startTyping(): void {
    if (abortController.signal.aborted || handlerClosed) {
      discordLogger.log(`Not starting typing, handler already closing`)
      return
    }

    clearTypingRestartTimeout()
    clearTypingInterval()

    void errore
      .tryAsync(() => thread.sendTyping())
      .then((result) => {
        if (result instanceof Error) {
          discordLogger.log(`Failed to send initial typing: ${result}`)
        }
      })

    typingInterval = setInterval(() => {
      if (abortController.signal.aborted || handlerClosed) {
        clearTypingInterval()
        return
      }
      void errore
        .tryAsync(() => thread.sendTyping())
        .then((result) => {
          if (result instanceof Error) {
            discordLogger.log(`Failed to send periodic typing: ${result}`)
          }
        })
    }, 8000)
  }

  function scheduleTypingRestart(): void {
    clearTypingRestartTimeout()
    if (abortController.signal.aborted || handlerClosed) {
      return
    }

    typingRestartTimeout = setTimeout(() => {
      typingRestartTimeout = null
      if (abortController.signal.aborted || handlerClosed) {
        return
      }
      const hasPendingQuestion = [...pendingQuestionContexts.values()].some(
        (ctx) => {
          return ctx.thread.id === thread.id
        },
      )
      const hasPendingPermission =
        (pendingPermissions.get(thread.id)?.size ?? 0) > 0
      if (hasPendingQuestion || hasPendingPermission) {
        return
      }
      startTyping()
    }, 300)
  }

  if (!abortController.signal.aborted) {
    abortController.signal.addEventListener(
      'abort',
      () => {
        stopTyping()
      },
      { once: true },
    )
  }

  // Read verbosity dynamically so mid-session /verbosity changes take effect immediately
  const verbosityChannelId = channelId || thread.parentId || thread.id
  const getVerbosity = async () => {
    return getChannelVerbosity(verbosityChannelId)
  }

  const sendPartMessage = async (part: Part) => {
    const verbosity = await getVerbosity()
    // In text-only mode, only send text parts (the ⬥ diamond messages)
    if (verbosity === 'text-only' && part.type !== 'text') {
      return
    }
    // In text-and-essential-tools mode, show text + essential tools (edits, custom MCP tools)
    if (verbosity === 'text-and-essential-tools') {
      if (part.type === 'text') {
        // text is always shown
      } else if (part.type === 'tool' && isEssentialToolPart(part)) {
        // essential tools are shown
      } else {
        return
      }
    }

    const content = formatPart(part) + '\n\n'
    if (!content.trim() || content.length === 0) {
      // discordLogger.log(`SKIP: Part ${part.id} has no content`)
      return
    }

    if (sentPartIds.has(part.id)) {
      return
    }
    // Mark as sent BEFORE the async send to prevent concurrent flushes
    // (from message.updated, step-finish, finally block) from sending the
    // same part while this await is in-flight. If the send fails we remove
    // the id so a retry can pick it up.
    sentPartIds.add(part.id)

    const sendResult = await errore.tryAsync(() => {
      return sendThreadMessage(thread, content)
    })
    if (sendResult instanceof Error) {
      sentPartIds.delete(part.id)
      discordLogger.error(`ERROR: Failed to send part ${part.id}:`, sendResult)
      return
    }
    hasSentParts = true
    await setPartMessage(part.id, sendResult.id, thread.id)
  }

  const eventHandler = async () => {
    // Subtask tracking: child sessionId → { label, assistantMessageId }
    const subtaskSessions = new Map<
      string,
      { label: string; assistantMessageId?: string }
    >()
    // Counts spawned tasks per agent type: "explore" → 2
    const agentSpawnCounts: Record<string, number> = {}

    const storePart = (part: Part) => {
      const messageParts =
        partBuffer.get(part.messageID) || new Map<string, Part>()
      messageParts.set(part.id, part)
      partBuffer.set(part.messageID, messageParts)
    }

    const getBufferedParts = (messageID: string) => {
      return Array.from(partBuffer.get(messageID)?.values() ?? [])
    }

    const shouldSendPart = ({
      part,
      force,
    }: {
      part: Part
      force: boolean
    }) => {
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

    const flushBufferedParts = async ({
      messageID,
      force,
      skipPartId,
    }: {
      messageID: string
      force: boolean
      skipPartId?: string
    }) => {
      if (!messageID) {
        return
      }
      const parts = getBufferedParts(messageID)
      for (const part of parts) {
        if (skipPartId && part.id === skipPartId) {
          continue
        }
        if (!shouldSendPart({ part, force })) {
          continue
        }
        await sendPartMessage(part)
      }
    }

    const showInteractiveUi = async ({
      skipPartId,
      flushMessageId,
      show,
    }: {
      skipPartId?: string
      flushMessageId?: string
      show: () => Promise<void>
    }) => {
      stopTyping()
      const targetMessageId = flushMessageId || assistantMessageId
      if (targetMessageId) {
        await flushBufferedParts({
          messageID: targetMessageId,
          force: true,
          skipPartId,
        })
      }
      await show()
    }

    const ensureModelContextLimit = async () => {
      if (!usedProviderID || !usedModel) {
        return
      }

      const key = `${usedProviderID}/${usedModel}`
      if (modelContextLimit && modelContextLimitKey === key) {
        return
      }

      const providersResponse = await errore.tryAsync(() => {
        return getClient().provider.list({
          directory: sdkDirectory,
        })
      })
      if (providersResponse instanceof Error) {
        sessionLogger.error(
          'Failed to fetch provider info for context limit:',
          providersResponse,
        )
        return
      }

      const provider = providersResponse.data?.all?.find(
        (p) => p.id === usedProviderID,
      )
      const model = provider?.models?.[usedModel]
      if (!model?.limit?.context) {
        return
      }

      modelContextLimit = model.limit.context
      modelContextLimitKey = key
    }

    const handleMessageUpdated = async (msg: {
      id: string
      sessionID: string
      role: string
      modelID?: string
      providerID?: string
      mode?: string
      tokens?: {
        input: number
        output: number
        reasoning: number
        cache: { read: number; write: number }
      }
    }) => {
      const subtaskInfo = subtaskSessions.get(msg.sessionID)
      if (subtaskInfo && msg.role === 'assistant') {
        subtaskInfo.assistantMessageId = msg.id
      }

      if (msg.sessionID !== session.id) {
        return
      }
      if (msg.role !== 'assistant') {
        return
      }

      sessionRunState.markCurrentPromptEvidence({
        store: mainRunStore,
        messageId: msg.id,
      })

      if (msg.tokens) {
        const newTokensTotal =
          msg.tokens.input +
          msg.tokens.output +
          msg.tokens.reasoning +
          msg.tokens.cache.read +
          msg.tokens.cache.write
        if (newTokensTotal > 0) {
          tokensUsedInSession = newTokensTotal
        }
      }

      assistantMessageId = msg.id
      usedModel = msg.modelID
      usedProviderID = msg.providerID
      usedAgent = msg.mode

      await flushBufferedParts({
        messageID: assistantMessageId,
        force: false,
      })

      if (tokensUsedInSession === 0 || !usedProviderID || !usedModel) {
        return
      }

      await ensureModelContextLimit()

      if (!modelContextLimit) {
        return
      }

      const currentPercentage = Math.floor(
        (tokensUsedInSession / modelContextLimit) * 100,
      )
      const thresholdCrossed = Math.floor(currentPercentage / 10) * 10
      if (
        thresholdCrossed <= lastDisplayedContextPercentage ||
        thresholdCrossed < 10
      ) {
        return
      }
      lastDisplayedContextPercentage = thresholdCrossed
      const chunk = `⬦ context usage ${currentPercentage}%`
      await thread.send({ content: chunk, flags: SILENT_MESSAGE_FLAGS })
    }

    const handleMainPart = async (part: Part) => {
      const isActiveMessage = assistantMessageId
        ? part.messageID === assistantMessageId
        : false
      const allowEarlyProcessing =
        !assistantMessageId &&
        part.type === 'tool' &&
        part.state.status === 'running'
      if (!isActiveMessage && !allowEarlyProcessing) {
        if (part.type !== 'step-start') {
          return
        }
      }

      if (part.type === 'step-start') {
        const hasPendingQuestion = [...pendingQuestionContexts.values()].some(
          (ctx) => ctx.thread.id === thread.id,
        )
        const hasPendingPermission =
          (pendingPermissions.get(thread.id)?.size ?? 0) > 0
        if (!hasPendingQuestion && !hasPendingPermission) {
          startTyping()
        }
        return
      }

      if (part.type === 'tool' && part.state.status === 'running') {
        await flushBufferedParts({
          messageID: assistantMessageId || part.messageID,
          force: true,
          skipPartId: part.id,
        })
        await sendPartMessage(part)
        if (part.tool === 'task' && !sentPartIds.has(part.id)) {
          const description = (part.state.input?.description as string) || ''
          const agent = (part.state.input?.subagent_type as string) || 'task'
          const childSessionId =
            (part.state.metadata?.sessionId as string) || ''
          if (description && childSessionId) {
            agentSpawnCounts[agent] = (agentSpawnCounts[agent] || 0) + 1
            const label = `${agent}-${agentSpawnCounts[agent]}`
            subtaskSessions.set(childSessionId, {
              label,
              assistantMessageId: undefined,
            })
            // Show task messages in tools-and-text and text-and-essential-tools modes
            if ((await getVerbosity()) !== 'text-only') {
              const taskDisplay = `┣ task **${description}**${agent ? ` _${agent}_` : ''}`
              await sendThreadMessage(thread, taskDisplay + '\n\n')
            }
            sentPartIds.add(part.id)
          }
        }
        return
      }

      // Show large output notifications for tools that are visible in current verbosity mode
      if (part.type === 'tool' && part.state.status === 'completed') {
        if (part.tool.endsWith('kimaki_action_buttons')) {
          await showInteractiveUi({
            skipPartId: part.id,
            flushMessageId: assistantMessageId || part.messageID,
            show: async () => {
              const request = await waitForQueuedActionButtonsRequest({
                sessionId: session.id,
                timeoutMs: 1500,
              })
              if (!request) {
                sessionLogger.warn(
                  `[ACTION] No queued action-buttons request found for session ${session.id}`,
                )
                return
              }
              if (request.threadId !== thread.id) {
                sessionLogger.warn(
                  `[ACTION] Ignoring queued action-buttons for different thread (expected: ${thread.id}, got: ${request.threadId})`,
                )
                return
              }

              const showButtonsResult = await errore.tryAsync(() => {
                return showActionButtons({
                  thread,
                  sessionId: request.sessionId,
                  directory: request.directory,
                  buttons: request.buttons,
                })
              })
              if (!(showButtonsResult instanceof Error)) {
                return
              }

              sessionLogger.error(
                '[ACTION] Failed to show action buttons:',
                showButtonsResult,
              )
              await sendThreadMessage(
                thread,
                `Failed to show action buttons: ${showButtonsResult.message}`,
              )
            },
          })
          return
        }

        const showLargeOutput = await (async () => {
          const verbosity = await getVerbosity()
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
            await ensureModelContextLimit()
            const formattedTokens =
              outputTokens >= 1000
                ? `${(outputTokens / 1000).toFixed(1)}k`
                : String(outputTokens)
            const percentageSuffix = (() => {
              if (!modelContextLimit) {
                return ''
              }
              const pct = (outputTokens / modelContextLimit) * 100
              if (pct < 1) {
                return ''
              }
              return ` (${pct.toFixed(1)}%)`
            })()
            const chunk = `⬦ ${part.tool} returned ${formattedTokens} tokens${percentageSuffix}`
            await thread.send({ content: chunk, flags: SILENT_MESSAGE_FLAGS })
          }
        }
      }

      if (part.type === 'reasoning') {
        await sendPartMessage(part)
        return
      }

      if (part.type === 'text' && part.time?.end) {
        await sendPartMessage(part)
        return
      }

      if (part.type === 'step-finish') {
        await flushBufferedParts({
          messageID: assistantMessageId || part.messageID,
          force: true,
        })
        scheduleTypingRestart()
      }
    }

    const handleSubtaskPart = async (
      part: Part,
      subtaskInfo: { label: string; assistantMessageId?: string },
    ) => {
      const verbosity = await getVerbosity()
      // In text-only mode, skip all subtask output (they're tool-related)
      if (verbosity === 'text-only') {
        return
      }
      // In text-and-essential-tools mode, only show essential tools from subtasks
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
      if (!content.trim() || sentPartIds.has(part.id)) {
        return
      }
      const sendResult = await errore.tryAsync(() => {
        return sendThreadMessage(thread, content + '\n\n')
      })
      if (sendResult instanceof Error) {
        discordLogger.error(
          `ERROR: Failed to send subtask part ${part.id}:`,
          sendResult,
        )
        return
      }
      sentPartIds.add(part.id)
      await setPartMessage(part.id, sendResult.id, thread.id)
    }

    const handlePartUpdated = async (part: Part) => {
      storePart(part)

      const subtaskInfo = subtaskSessions.get(part.sessionID)
      const isSubtaskEvent = Boolean(subtaskInfo)

      if (part.sessionID !== session.id && !isSubtaskEvent) {
        return
      }

      if (part.sessionID === session.id) {
        sessionRunState.markCurrentPromptEvidence({
          store: mainRunStore,
          messageId: part.messageID,
        })
      }

      if (isSubtaskEvent && subtaskInfo) {
        await handleSubtaskPart(part, subtaskInfo)
        return
      }

      await handleMainPart(part)
    }

    const handleSessionError = async ({
      sessionID,
      error,
    }: {
      sessionID?: string
      error?: {
        data?: {
          message?: string
          statusCode?: number
          providerID?: string
          isRetryable?: boolean
          responseBody?: string
        }
        name?: string
      }
    }) => {
      if (!sessionID || sessionID !== session.id) {
        sessionLogger.log(
          `Ignoring error for different session (expected: ${session.id}, got: ${sessionID})`,
        )
        return
      }

      // Skip abort errors from the server — these are expected when operations
      // are cancelled. Checks server error name and the local abort signal.
      if (
        error?.name === 'MessageAbortedError' ||
        abortController.signal.aborted
      ) {
        sessionLogger.log(`Operation aborted (expected)`)
        return
      }
      const errorMessage = formatSessionError(error)
      sessionLogger.error(`Sending error to thread: ${errorMessage}`)
      const errorPayload = (() => {
        try {
          return JSON.stringify(error)
        } catch {
          return '[unserializable error payload]'
        }
      })()
      sessionLogger.error(`Session error payload:`, errorPayload)
      await sendThreadMessage(
        thread,
        `✗ opencode session error: ${errorMessage}`,
      )

      if (!originalMessage) {
        return
      }
      const reactionResult = await errore.tryAsync(async () => {
        await originalMessage.react('❌')
      })
      if (reactionResult instanceof Error) {
        discordLogger.log(`Could not update reaction:`, reactionResult)
      } else {
        voiceLogger.log(`[REACTION] Added error reaction due to session error`)
      }
    }

    const handlePermissionAsked = async (permission: PermissionRequest) => {
      const isMainSession = permission.sessionID === session.id
      const isSubtaskSession = subtaskSessions.has(permission.sessionID)

      if (!isMainSession && !isSubtaskSession) {
        voiceLogger.log(
          `[PERMISSION IGNORED] Permission for unknown session (expected: ${session.id} or subtask, got: ${permission.sessionID})`,
        )
        return
      }

      const subtaskLabel = isSubtaskSession
        ? subtaskSessions.get(permission.sessionID)?.label
        : undefined

      const dedupeKey = buildPermissionDedupeKey({ permission, directory })
      const threadPermissions = pendingPermissions.get(thread.id)
      const existingPending = threadPermissions
        ? Array.from(threadPermissions.values()).find((pending) => {
            if (pending.dedupeKey === dedupeKey) {
              return true
            }
            if (pending.directory !== directory) {
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
        sessionLogger.log(
          `[PERMISSION] Deduped permission ${permission.id} (matches pending ${existingPending.permission.id})`,
        )
        stopTyping()
        if (!pendingPermissions.has(thread.id)) {
          pendingPermissions.set(thread.id, new Map())
        }
        pendingPermissions.get(thread.id)!.set(permission.id, {
          permission,
          messageId: existingPending.messageId,
          directory,
          permissionDirectory: existingPending.permissionDirectory,
          contextHash: existingPending.contextHash,
          dedupeKey,
        })
        const added = addPermissionRequestToContext({
          contextHash: existingPending.contextHash,
          requestId: permission.id,
        })
        if (!added) {
          sessionLogger.log(
            `[PERMISSION] Failed to attach duplicate request ${permission.id} to context`,
          )
        }
        return
      }

      sessionLogger.log(
        `Permission requested: permission=${permission.permission}, patterns=${permission.patterns.join(', ')}${subtaskLabel ? `, subtask=${subtaskLabel}` : ''}`,
      )

      stopTyping()

      const { messageId, contextHash } = await showPermissionButtons({
        thread,
        permission,
        directory,
        permissionDirectory: sdkDirectory,
        subtaskLabel,
      })

      if (!pendingPermissions.has(thread.id)) {
        pendingPermissions.set(thread.id, new Map())
      }
      pendingPermissions.get(thread.id)!.set(permission.id, {
        permission,
        messageId,
        directory,
        permissionDirectory: sdkDirectory,
        contextHash,
        dedupeKey,
      })
    }

    const handlePermissionReplied = ({
      requestID,
      reply,
      sessionID,
    }: {
      requestID: string
      reply: string
      sessionID: string
    }) => {
      const isMainSession = sessionID === session.id
      const isSubtaskSession = subtaskSessions.has(sessionID)

      if (!isMainSession && !isSubtaskSession) {
        return
      }

      sessionLogger.log(`Permission ${requestID} replied with: ${reply}`)

      const threadPermissions = pendingPermissions.get(thread.id)
      if (!threadPermissions) {
        return
      }
      const pending = threadPermissions.get(requestID)
      if (!pending) {
        return
      }
      cleanupPermissionContext(pending.contextHash)
      threadPermissions.delete(requestID)
      if (threadPermissions.size === 0) {
        pendingPermissions.delete(thread.id)
      }
    }

    const handleQuestionAsked = async (questionRequest: QuestionRequest) => {
      if (questionRequest.sessionID !== session.id) {
        sessionLogger.log(
          `[QUESTION IGNORED] Question for different session (expected: ${session.id}, got: ${questionRequest.sessionID})`,
        )
        return
      }

      sessionLogger.log(
        `Question requested: id=${questionRequest.id}, questions=${questionRequest.questions.length}`,
      )

      await showInteractiveUi({
        flushMessageId: assistantMessageId,
        show: async () => {
          await showAskUserQuestionDropdowns({
            thread,
            sessionId: session.id,
            directory,
            requestId: questionRequest.id,
            input: { questions: questionRequest.questions },
          })
        },
      })

      const queue = messageQueue.get(thread.id)
      if (!queue || queue.length === 0) {
        return
      }

      const nextMessage = queue.shift()!
      if (queue.length === 0) {
        messageQueue.delete(thread.id)
      }

      sessionLogger.log(
        `[QUEUE] Question shown but queue has messages, processing from ${nextMessage.username}`,
      )

      const displayText = nextMessage.command
        ? `/${nextMessage.command.name}`
        : `${nextMessage.prompt.slice(0, 150)}${nextMessage.prompt.length > 150 ? '...' : ''}`
      await sendThreadMessage(
        thread,
        `» **${nextMessage.username}:** ${displayText}`,
      )

      setImmediate(() => {
        void errore
          .tryAsync(async () => {
            return handleOpencodeSession({
              prompt: nextMessage.prompt,
              thread,
              projectDirectory: directory,
              images: nextMessage.images,
              channelId,
              username: nextMessage.username,
              appId: nextMessage.appId,
              command: nextMessage.command,
            })
          })
          .then(async (result) => {
            if (!(result instanceof Error)) {
              return
            }
            sessionLogger.error(
              `[QUEUE] Failed to process queued message:`,
              result,
            )
            await sendThreadMessage(
              thread,
              `✗ Queued message failed: ${result.message.slice(0, 200)}`,
            )
          })
      })
    }

    const handleSessionStatus = async (properties: {
      sessionID: string
      status:
        | { type: 'idle' }
        | { type: 'retry'; attempt: number; message: string; next: number }
        | { type: 'busy' }
    }) => {
      if (properties.sessionID !== session.id) {
        return
      }
      if (properties.status.type !== 'retry') {
        return
      }
      // Throttle to once per 10 seconds
      const now = Date.now()
      if (now - lastRateLimitDisplayTime < 10_000) {
        return
      }
      lastRateLimitDisplayTime = now

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
      await thread.send({ content: chunk, flags: SILENT_MESSAGE_FLAGS })
    }

    const handleTuiToast = async (properties: {
      title?: string
      message: string
      variant: 'info' | 'success' | 'warning' | 'error'
      duration?: number
    }) => {
      if (properties.variant === 'warning') {
        return
      }
      const message = properties.message.trim()
      if (!message) {
        return
      }
      const titlePrefix = properties.title ? `${properties.title.trim()}: ` : ''
      const chunk = `⬦ ${properties.variant}: ${titlePrefix}${message}`
      await thread.send({ content: chunk, flags: SILENT_MESSAGE_FLAGS })
    }

    const handleSessionIdle = (idleSessionId: string) => {
      if (idleSessionId === session.id) {
        const idleDecision = sessionRunState.handleMainSessionIdle({
          store: mainRunStore,
        })
        if (idleDecision === 'deferred') {
          sessionLogger.log(
            `[SESSION IDLE] Deferring idle event for ${session.id} until prompt resolves`,
          )
          return
        }

        if (idleDecision === 'ignore-no-evidence') {
          sessionLogger.log(
            `[SESSION IDLE] Ignoring idle event for ${session.id} (no current-prompt events yet)`,
          )
          return
        }

        finishMainSessionFromIdle()
        return
      }

      if (!subtaskSessions.has(idleSessionId)) {
        return
      }
      const subtask = subtaskSessions.get(idleSessionId)
      sessionLogger.log(`[SUBTASK IDLE] Subtask "${subtask?.label}" completed`)
      subtaskSessions.delete(idleSessionId)
    }

    try {
      for await (const event of events) {
        switch (event.type) {
          case 'message.updated':
            await handleMessageUpdated(event.properties.info)
            break
          case 'message.part.updated':
            await handlePartUpdated(event.properties.part)
            break
          case 'session.error':
            await handleSessionError(event.properties)
            break
          case 'permission.asked':
            await handlePermissionAsked(event.properties)
            break
          case 'permission.replied':
            handlePermissionReplied(event.properties)
            break
          case 'question.asked':
            await handleQuestionAsked(event.properties)
            break
          case 'session.idle':
            handleSessionIdle(event.properties.sessionID)
            break
          case 'session.status':
            await handleSessionStatus(event.properties)
            break
          case 'tui.toast.show':
            await handleTuiToast(event.properties)
            break
          default:
            break
        }
      }
    } catch (e) {
      if (isAbortError(e)) {
        sessionLogger.log(
          'AbortController aborted event handling (normal exit)',
        )
        return
      }
      sessionLogger.error(`Unexpected error in event handling code`, e)
      throw e
    } finally {
      handlerClosed = true
      const activeController = abortControllers.get(session.id)
      if (activeController === abortController) {
        abortControllers.delete(session.id)
      }
      const abortReason =
        abortController.signal.reason instanceof SessionAbortError
          ? abortController.signal.reason.reason
          : undefined
      if (
        abortController.signal.aborted &&
        mainRunStore.getState().phase !== 'finished'
      ) {
        sessionRunState.markAborted({ store: mainRunStore })
      }
      const shouldFlushFinalParts =
        !abortController.signal.aborted || abortReason === 'finished'
      if (shouldFlushFinalParts) {
        const finalMessageId = assistantMessageId
        if (finalMessageId) {
          const parts = getBufferedParts(finalMessageId)
          for (const part of parts) {
            if (!sentPartIds.has(part.id)) {
              await sendPartMessage(part)
            }
          }
        }
      }

      stopTyping()

      if (!abortController.signal.aborted || abortReason === 'finished') {
        const sessionDuration = prettyMilliseconds(
          Date.now() - sessionStartTime,
          {
            secondsDecimalDigits: 0,
          },
        )
        const modelInfo = usedModel ? ` ⋅ ${usedModel}` : ''
        const agentInfo =
          usedAgent && usedAgent.toLowerCase() !== 'build'
            ? ` ⋅ **${usedAgent}**`
            : ''
        let contextInfo = ''
        const folderName = path.basename(sdkDirectory)

        // Run git branch, token fetch, and provider list in parallel to
        // minimize footer latency (matters for archive-thread 5s delay race)
        const [branchResult, contextResult] = await Promise.all([
          errore.tryAsync(() => {
            return execAsync('git symbolic-ref --short HEAD', {
              cwd: sdkDirectory,
            })
          }),
          errore.tryAsync(async () => {
            // Fetch final token count from API since message.updated events can arrive
            // after session.idle due to race conditions in event ordering
            const [messagesResult, providersResult] = await Promise.all([
              tokensUsedInSession === 0
                ? errore.tryAsync(() => {
                    return getClient().session.messages({
                      sessionID: session.id,
                      directory: sdkDirectory,
                    })
                  })
                : null,
              errore.tryAsync(() => {
                return getClient().provider.list({
                  directory: sdkDirectory,
                })
              }),
            ])

            if (messagesResult && !(messagesResult instanceof Error)) {
              const messages = messagesResult.data || []
              const lastAssistant = [...messages]
                .reverse()
                .find((m) => m.info.role === 'assistant')
              if (lastAssistant && 'tokens' in lastAssistant.info) {
                const tokens = lastAssistant.info.tokens as {
                  input: number
                  output: number
                  reasoning: number
                  cache: { read: number; write: number }
                }
                tokensUsedInSession =
                  tokens.input +
                  tokens.output +
                  tokens.reasoning +
                  tokens.cache.read +
                  tokens.cache.write
              }
            }

            if (providersResult && !(providersResult instanceof Error)) {
              const provider = providersResult.data?.all?.find(
                (p) => p.id === usedProviderID,
              )
              const model = provider?.models?.[usedModel || '']
              if (model?.limit?.context) {
                const percentage = Math.round(
                  (tokensUsedInSession / model.limit.context) * 100,
                )
                contextInfo = ` ⋅ ${percentage}%`
              }
            }
          }),
        ])
        const branchName =
          branchResult instanceof Error ? '' : branchResult.stdout.trim()
        if (contextResult instanceof Error) {
          sessionLogger.error(
            'Failed to fetch provider info for context percentage:',
            contextResult,
          )
        }

        const projectInfo = branchName
          ? `${folderName} ⋅ ${branchName} ⋅ `
          : `${folderName} ⋅ `
        await sendThreadMessage(
          thread,
          `*${projectInfo}${sessionDuration}${contextInfo}${modelInfo}${agentInfo}*`,
          { flags: NOTIFY_MESSAGE_FLAGS },
        )
        sessionLogger.log(
          `DURATION: Session completed in ${sessionDuration}, port ${port}, model ${usedModel}, tokens ${tokensUsedInSession}`,
        )

        // Process queued messages after completion
        const queue = messageQueue.get(thread.id)
        if (queue && queue.length > 0) {
          const nextMessage = queue.shift()!
          if (queue.length === 0) {
            messageQueue.delete(thread.id)
          }

          sessionLogger.log(
            `[QUEUE] Processing queued message from ${nextMessage.username}`,
          )

          // Show that queued message is being sent
          const displayText = nextMessage.command
            ? `/${nextMessage.command.name}`
            : `${nextMessage.prompt.slice(0, 150)}${nextMessage.prompt.length > 150 ? '...' : ''}`
          await sendThreadMessage(
            thread,
            `» **${nextMessage.username}:** ${displayText}`,
          )

          // Send the queued message as a new prompt (recursive call)
          // Use setImmediate to avoid blocking and allow this finally to complete
          setImmediate(() => {
            handleOpencodeSession({
              prompt: nextMessage.prompt,
              thread,
              projectDirectory,
              images: nextMessage.images,
              channelId,
              username: nextMessage.username,
              appId: nextMessage.appId,
              command: nextMessage.command,
            }).catch(async (e) => {
              sessionLogger.error(
                `[QUEUE] Failed to process queued message:`,
                e,
              )
              void notifyError(e, 'Queued message processing failed')
              const errorMsg = e instanceof Error ? e.message : String(e)
              await sendThreadMessage(
                thread,
                `✗ Queued message failed: ${errorMsg.slice(0, 200)}`,
              )
            })
          })
        }
      } else {
        sessionLogger.log(
          `Session was aborted (reason: ${abortReason}), skipping duration message`,
        )
      }
    }
  }

  const promptResult:
    | Error
    | { sessionID: string; result: any; port?: number }
    | undefined = await errore.tryAsync(async () => {
    const newHandlerPromise = eventHandler().finally(() => {
      if (activeEventHandlers.get(thread.id) === newHandlerPromise) {
        activeEventHandlers.delete(thread.id)
      }
    })
    activeEventHandlers.set(thread.id, newHandlerPromise)
    handlerPromise = newHandlerPromise

    if (abortController.signal.aborted) {
      sessionLogger.log(`[DEBOUNCE] Aborted before prompt, exiting`)
      return
    }

    startTyping()

    voiceLogger.log(
      `[PROMPT] Sending prompt to session ${session.id}: "${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}"`,
    )
    const promptWithImagePaths = (() => {
      if (images.length === 0) {
        return prompt
      }
      sessionLogger.log(
        `[PROMPT] Sending ${images.length} image(s):`,
        images.map((img) => ({
          mime: img.mime,
          filename: img.filename,
          sourceUrl: img.sourceUrl,
        })),
      )
      // List source URLs and clarify these images are already in context (not paths to read)
      const imageList = images
        .map((img) => `- ${img.sourceUrl || img.filename}`)
        .join('\n')
      return `${prompt}\n\n**The following images are already included in this message as inline content (do not use Read tool on these):**\n${imageList}`
    })()

    // Synthetic context for the model (hidden in TUI)
    let syntheticContext = ''
    if (username) {
      syntheticContext += `<discord-user name="${username}" />`
    }
    const parts = [
      { type: 'text' as const, text: promptWithImagePaths },
      { type: 'text' as const, text: syntheticContext, synthetic: true },
      ...images,
    ]
    sessionLogger.log(`[PROMPT] Parts to send:`, parts.length)

    // Use model+agent snapshotted at message arrival (before debounce/subscribe gap)
    const agentPreference = earlyAgentPreference
    const modelParam = earlyModelParam

    // Build worktree info for system message (worktreeInfo was fetched at the start)
    const worktree: WorktreeInfo | undefined =
      worktreeInfo?.status === 'ready' && worktreeInfo.worktree_directory
        ? {
            worktreeDirectory: worktreeInfo.worktree_directory,
            branch: worktreeInfo.worktree_name,
            mainRepoDirectory: worktreeInfo.project_directory,
          }
        : undefined

    const channelTopic = await (async () => {
      if (thread.parent?.type === ChannelType.GuildText) {
        return thread.parent.topic?.trim() || undefined
      }
      if (!channelId) {
        return undefined
      }
      const fetched = await errore.tryAsync(() => {
        return thread.guild.channels.fetch(channelId)
      })
      if (fetched instanceof Error || !fetched) {
        return undefined
      }
      if (fetched.type !== ChannelType.GuildText) {
        return undefined
      }
      return fetched.topic?.trim() || undefined
    })()

    hasSentParts = false
    sessionRunState.beginPromptCycle({ store: mainRunStore })
    const messagesBeforePromptResult = await errore.tryAsync(() => {
      return getClient().session.messages({
        sessionID: session.id,
        directory: sdkDirectory,
      })
    })
    if (messagesBeforePromptResult instanceof Error) {
      sessionLogger.log(
        `[SESSION IDLE] Could not snapshot pre-prompt assistant message for ${session.id}: ${messagesBeforePromptResult.message}`,
      )
    } else {
      const messagesBeforePrompt = messagesBeforePromptResult.data || []
      const baselineAssistantIds = new Set(
        messagesBeforePrompt
          .filter((message) => message.info.role === 'assistant')
          .map((message) => message.info.id),
      )
      sessionRunState.setBaselineAssistantIds({
        store: mainRunStore,
        messageIds: baselineAssistantIds,
      })
    }

    // variant is accepted by the server API but not yet in the v1 SDK types
    const variantField = earlyThinkingValue
      ? { variant: earlyThinkingValue }
      : {}

    sessionRunState.markDispatching({ store: mainRunStore })

    const response = command
      ? await getClient().session.command(
          {
            sessionID: session.id,
            directory: sdkDirectory,
            command: command.name,
            arguments: command.arguments,
            agent: agentPreference,
            ...variantField,
          },
          { signal: abortController.signal },
        )
      : await getClient().session.prompt(
          {
            sessionID: session.id,
            directory: sdkDirectory,
            parts,
            system: getOpencodeSystemMessage({
              sessionId: session.id,
              channelId,
              guildId: thread.guildId,
              threadId: thread.id,
              worktree,
              channelTopic,
              username,
              userId,
              agents: earlyAvailableAgents,
            }),
            model: modelParam,
            agent: agentPreference,
            ...variantField,
          },
          { signal: abortController.signal },
        )

    if (response.error) {
      const errorMessage = (() => {
        const err = response.error
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

      const responseStatus = (() => {
        const httpStatus = response.response?.status
        if (typeof httpStatus === 'number') {
          return String(httpStatus)
        }

        const err = response.error
        if (!err || typeof err !== 'object' || !('data' in err)) {
          return 'unknown'
        }

        const data = err.data
        if (
          !data ||
          typeof data !== 'object' ||
          !('statusCode' in data) ||
          typeof data.statusCode !== 'number'
        ) {
          return 'unknown'
        }

        return String(data.statusCode)
      })()

      throw new Error(
        `OpenCode API error (${responseStatus}): ${errorMessage}`,
      )
    }

    const deferredIdleDecision =
      sessionRunState.markPromptResolvedAndConsumeDeferredIdle({
        store: mainRunStore,
      })
    if (deferredIdleDecision === 'ignore-no-evidence') {
      sessionLogger.log(
        `[SESSION IDLE] Ignoring deferred idle for ${session.id} because no current-prompt events were observed`,
      )
    } else if (deferredIdleDecision === 'ignore-before-evidence') {
      sessionLogger.log(
        `[SESSION IDLE] Ignoring deferred idle for ${session.id} because it arrived before current-prompt evidence`,
      )
    } else if (deferredIdleDecision === 'process') {
      sessionLogger.log(
        `[SESSION IDLE] Processing deferred idle for ${session.id} after prompt resolved`,
      )
      finishMainSessionFromIdle()
    }

    sessionLogger.log(`Successfully sent prompt, got response`)

    if (originalMessage) {
      const reactionResult = await errore.tryAsync(async () => {
        await removeBotErrorReaction({ message: originalMessage })
      })
      if (reactionResult instanceof Error) {
        discordLogger.log(`Could not update reactions:`, reactionResult)
      }
    }

    return { sessionID: session.id, result: response.data, port }
  })

  if (handlerPromise) {
    await Promise.race([
      handlerPromise,
      new Promise((resolve) => {
        setTimeout(resolve, 1000)
      }),
    ])
  }

  if (!errore.isError(promptResult)) {
    return promptResult
  }

  const promptError: Error =
    promptResult instanceof Error ? promptResult : new Error('Unknown error')
  if (isAbortError(promptError)) {
    return
  }

  sessionLogger.error(
    `ERROR: Failed to send prompt: ${(promptError as Error).message}`,
  )
  void notifyError(promptError, 'Failed to send prompt to OpenCode')
  sessionLogger.log(
    `[ABORT] reason=error sessionId=${session.id} threadId=${thread.id} - prompt failed with error: ${(promptError as Error).message}`,
  )
  sessionRunState.markAborted({ store: mainRunStore })
  abortController.abort(new SessionAbortError({ reason: 'error' }))

  if (originalMessage) {
    const reactionResult = await errore.tryAsync(async () => {
      await originalMessage.react('❌')
    })
    if (reactionResult instanceof Error) {
      discordLogger.log(`Could not update reaction:`, reactionResult)
    } else {
      discordLogger.log(`Added error reaction to message`)
    }
  }
  const errorDisplay = (() => {
    const promptErrorValue = promptError as unknown as Error
    const name = promptErrorValue.name || 'Error'
    const message = promptErrorValue.stack || promptErrorValue.message
    return `[${name}]\n${message}`
  })()
  await sendThreadMessage(thread, `✗ Unexpected bot Error: ${errorDisplay}`)
}
