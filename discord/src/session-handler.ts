// OpenCode session lifecycle manager.
// Creates, maintains, and sends prompts to OpenCode sessions from Discord threads.
// Handles streaming events, permissions, abort signals, and message queuing.

import type { Part, PermissionRequest, QuestionRequest } from '@opencode-ai/sdk/v2'
import type { DiscordFileAttachment } from './message-formatting.js'
import { ChannelType, type Message, type ThreadChannel } from 'discord.js'
import prettyMilliseconds from 'pretty-ms'
import fs from 'node:fs'
import path from 'node:path'
import { xdgState } from 'xdg-basedir'
import {
  getSessionAgent,
  getChannelAgent,
  setSessionAgent,
  getThreadWorktree,
  getChannelVerbosity,
  getThreadSession,
  setThreadSession,
  getPartMessageIds,
  setPartMessage,
  getChannelDirectory,
} from './database.js'
import { getCurrentModelInfo } from './commands/model.js'
import {
  initializeOpencodeForDirectory,
  getOpencodeServers,
  getOpencodeClientV2,
} from './opencode.js'
import { sendThreadMessage, NOTIFY_MESSAGE_FLAGS, SILENT_MESSAGE_FLAGS } from './discord-utils.js'
import { formatPart } from './message-formatting.js'
import { getOpencodeSystemMessage, type WorktreeInfo } from './system-message.js'
import { createLogger, LogPrefix } from './logger.js'
import { isAbortError } from './utils.js'
import {
  showAskUserQuestionDropdowns,
  cancelPendingQuestion,
  pendingQuestionContexts,
} from './commands/ask-question.js'
import {
  showPermissionDropdown,
  cleanupPermissionContext,
  addPermissionRequestToContext,
} from './commands/permissions.js'
import * as errore from 'errore'

const sessionLogger = createLogger(LogPrefix.SESSION)
const voiceLogger = createLogger(LogPrefix.VOICE)
const discordLogger = createLogger(LogPrefix.DISCORD)

export const abortControllers = new Map<string, AbortController>()

// Built-in tools that are hidden in text-and-essential-tools verbosity mode.
// Essential tools (edits, bash with side effects, todos, tasks, custom MCP tools) are shown; these navigation/read tools are hidden.
const NON_ESSENTIAL_TOOLS = new Set([
  'read',
  'list',
  'glob',
  'grep',
  'todoread',
  'skill',
  'question',
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
      contextHash: string
      dedupeKey: string
    }
  > // permissionId -> data
>()

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

export type QueuedMessage = {
  prompt: string
  userId: string
  username: string
  queuedAt: number
  images?: DiscordFileAttachment[]
  appId?: string
}

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

/**
 * Read user's recent models from OpenCode TUI's state file.
 * Uses same path as OpenCode: path.join(xdgState, "opencode", "model.json")
 * Returns all recent models so we can iterate until finding a valid one.
 * See: opensrc/repos/github.com/sst/opencode/packages/opencode/src/global/index.ts
 */
function getRecentModelsFromTuiState(): Array<{ providerID: string; modelID: string }> {
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
function parseModelString(model: string): { providerID: string; modelID: string } | undefined {
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

export type DefaultModelSource = 'opencode-config' | 'opencode-recent' | 'opencode-provider-default'

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
}): Promise<{ providerID: string; modelID: string; source: DefaultModelSource } | undefined> {
  if (getClient instanceof Error) {
    return undefined
  }

  // Fetch connected providers to validate any model we return
  const providersResponse = await errore.tryAsync(() => {
    return getClient().provider.list({})
  })
  if (providersResponse instanceof Error) {
    sessionLogger.log(`[MODEL] Failed to fetch providers for default model:`, providersResponse.message)
    return undefined
  }
  if (!providersResponse.data) {
    return undefined
  }

  const { connected, default: defaults, all: providers } = providersResponse.data
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
      sessionLogger.log(`[MODEL] Using config model: ${configModel.providerID}/${configModel.modelID}`)
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

  sessionLogger.log(`[MODEL] Using provider default: ${firstConnected}/${defaultModelId}`)
  return { providerID: firstConnected, modelID: defaultModelId, source: 'opencode-provider-default' }
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
}: {
  sessionId: string
  thread: ThreadChannel
  projectDirectory: string
  appId?: string
}): Promise<boolean> {
  const controller = abortControllers.get(sessionId)

  if (!controller) {
    sessionLogger.log(`[ABORT+RETRY] No active request for session ${sessionId}`)
    return false
  }

  sessionLogger.log(`[ABORT+RETRY] Aborting session ${sessionId} for model change`)

  // Abort with special reason so we don't show "completed" message
  sessionLogger.log(`[ABORT] reason=model-change sessionId=${sessionId} - user changed model mid-request, will retry with new model`)
  controller.abort(new Error('model-change'))

  // Also call the API abort endpoint
  const getClient = await initializeOpencodeForDirectory(projectDirectory)
  if (getClient instanceof Error) {
    sessionLogger.error(`[ABORT+RETRY] Failed to initialize OpenCode client:`, getClient.message)
    return false
  }
  sessionLogger.log(`[ABORT-API] reason=model-change sessionId=${sessionId} - sending API abort for model change retry`)
  const abortResult = await errore.tryAsync(() => {
    return getClient().session.abort({ path: { id: sessionId } })
  })
  if (abortResult instanceof Error) {
    sessionLogger.log(`[ABORT-API] API abort call failed (may already be done):`, abortResult)
  }

  // Small delay to let the abort propagate
  await new Promise((resolve) => {
    setTimeout(resolve, 300)
  })

  // Fetch last user message from API
  sessionLogger.log(`[ABORT+RETRY] Fetching last user message for session ${sessionId}`)
  const messagesResponse = await getClient().session.messages({ path: { id: sessionId } })
  const messages = messagesResponse.data || []
  const lastUserMessage = [...messages].reverse().find((m) => m.info.role === 'user')

  if (!lastUserMessage) {
    sessionLogger.log(`[ABORT+RETRY] No user message found in session ${sessionId}`)
    return false
  }

  // Extract text and images from parts
  const textPart = lastUserMessage.parts.find((p) => p.type === 'text') as
    | { type: 'text'; text: string }
    | undefined
  const prompt = textPart?.text || ''
  const images = lastUserMessage.parts.filter((p) => p.type === 'file') as DiscordFileAttachment[]

  sessionLogger.log(`[ABORT+RETRY] Re-triggering session ${sessionId} with new model`)

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
        })
      })
      .then(async (result) => {
        if (!(result instanceof Error)) {
          return
        }
        sessionLogger.error(`[ABORT+RETRY] Failed to retry:`, result)
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
}): Promise<{ sessionID: string; result: any; port?: number } | undefined> {
  voiceLogger.log(
    `[OPENCODE SESSION] Starting for thread ${thread.id} with prompt: "${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}"`,
  )

  const sessionStartTime = Date.now()

  const directory = projectDirectory || process.cwd()
  sessionLogger.log(`Using directory: ${directory}`)

  // Get worktree info early so we can use the correct directory for events and prompts
  const worktreeInfo = await getThreadWorktree(thread.id)
  const worktreeDirectory =
    worktreeInfo?.status === 'ready' && worktreeInfo.worktree_directory
      ? worktreeInfo.worktree_directory
      : undefined
  // Use worktree directory for SDK calls if available, otherwise project directory
  const sdkDirectory = worktreeDirectory || directory
  if (worktreeDirectory) {
    sessionLogger.log(`Using worktree directory for SDK calls: ${worktreeDirectory}`)
  }

  // When in worktree, pass original repo directory so AI can access files there
  const originalRepoDirectory = worktreeDirectory ? worktreeInfo?.project_directory : undefined
  const getClient = await initializeOpencodeForDirectory(directory, { originalRepoDirectory })
  if (getClient instanceof Error) {
    await sendThreadMessage(thread, `✗ ${getClient.message}`)
    return
  }

  const serverEntry = getOpencodeServers().get(directory)
  const port = serverEntry?.port

  let sessionId = await getThreadSession(thread.id)
  let session

  if (sessionId) {
    sessionLogger.log(`Attempting to reuse existing session ${sessionId}`)
    const sessionResponse = await errore.tryAsync(() => {
      return getClient().session.get({
        path: { id: sessionId },
        query: { directory: sdkDirectory },
      })
    })
    if (sessionResponse instanceof Error) {
      voiceLogger.log(`[SESSION] Session ${sessionId} not found, will create new one`)
    } else {
      session = sessionResponse.data
      sessionLogger.log(`Successfully reused session ${sessionId}`)
    }
  }

  if (!session) {
    const sessionTitle = prompt.length > 80 ? prompt.slice(0, 77) + '...' : prompt.slice(0, 80)
    voiceLogger.log(`[SESSION] Creating new session with title: "${sessionTitle}"`)
    const sessionResponse = await getClient().session.create({
      body: { title: sessionTitle },
      query: { directory: sdkDirectory },
    })
    session = sessionResponse.data
    sessionLogger.log(`Created new session ${session?.id}`)
  }

  if (!session) {
    throw new Error('Failed to create or get session')
  }

  await setThreadSession(thread.id, session.id)
  sessionLogger.log(`Stored session ${session.id} for thread ${thread.id}`)

  // Store agent preference if provided
  if (agent) {
    await setSessionAgent(session.id, agent)
    sessionLogger.log(`Set agent preference for session ${session.id}: ${agent}`)
  }

  const existingController = abortControllers.get(session.id)
  if (existingController) {
    voiceLogger.log(`[ABORT] Cancelling existing request for session: ${session.id}`)
    sessionLogger.log(`[ABORT] reason=new-request sessionId=${session.id} threadId=${thread.id} - new user message arrived while previous request was still running`)
    existingController.abort(new Error('New request started'))
    sessionLogger.log(`[ABORT-API] reason=new-request sessionId=${session.id} - sending API abort because new message arrived`)
    const abortResult = await errore.tryAsync(() => {
      return getClient().session.abort({
        path: { id: session.id },
        query: { directory: sdkDirectory },
      })
    })
    if (abortResult instanceof Error) {
      sessionLogger.log(`[ABORT-API] Server abort failed (may be already done):`, abortResult)
    }
  }

  // Auto-reject ALL pending permissions for this thread
  const threadPermissions = pendingPermissions.get(thread.id)
  if (threadPermissions && threadPermissions.size > 0) {
    const clientV2 = getOpencodeClientV2(directory)
    let rejectedCount = 0
    for (const [permId, pendingPerm] of threadPermissions) {
      sessionLogger.log(`[PERMISSION] Auto-rejecting permission ${permId} due to new message`)
      if (!clientV2) {
        sessionLogger.log(`[PERMISSION] OpenCode v2 client unavailable for permission ${permId}`)
        cleanupPermissionContext(pendingPerm.contextHash)
        rejectedCount++
        continue
      }
      const rejectResult = await errore.tryAsync(() => {
        return clientV2.permission.reply({
          requestID: permId,
          reply: 'reject',
        })
      })
      if (rejectResult instanceof Error) {
        sessionLogger.log(`[PERMISSION] Failed to auto-reject permission ${permId}:`, rejectResult)
      } else {
        rejectedCount++
      }
      cleanupPermissionContext(pendingPerm.contextHash)
    }
    pendingPermissions.delete(thread.id)
    if (rejectedCount > 0) {
      const plural = rejectedCount > 1 ? 's' : ''
      await sendThreadMessage(
        thread,
        `⚠️ ${rejectedCount} pending permission request${plural} auto-rejected due to new message`,
      )
    }
  }

  // Answer any pending question tool with the user's message (silently, no thread message)
  const questionAnswered = await cancelPendingQuestion(thread.id, prompt)
  if (questionAnswered) {
    sessionLogger.log(`[QUESTION] Answered pending question with user message`)
  }

  const abortController = new AbortController()
  abortControllers.set(session.id, abortController)

  if (existingController) {
    await new Promise((resolve) => {
      setTimeout(resolve, 200)
    })
    if (abortController.signal.aborted) {
      sessionLogger.log(`[DEBOUNCE] Request was superseded during wait, exiting`)
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
    await Promise.race([
      previousHandler,
      new Promise((resolve) => {
        setTimeout(resolve, 1000)
      }),
    ])
  }

  // Use v2 client for event subscription (has proper types for question.asked events)
  const clientV2 = getOpencodeClientV2(directory)
  if (!clientV2) {
    throw new Error(`OpenCode v2 client not found for directory: ${directory}`)
  }
  const eventsResult = await clientV2.event.subscribe(
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
  let stopTyping: (() => void) | null = null
  let usedModel: string | undefined
  let usedProviderID: string | undefined
  let usedAgent: string | undefined
  let tokensUsedInSession = 0
  let lastDisplayedContextPercentage = 0
  let lastRateLimitDisplayTime = 0
  let modelContextLimit: number | undefined
  let assistantMessageId: string | undefined
  let handlerPromise: Promise<void> | null = null

  let typingInterval: NodeJS.Timeout | null = null
  let hasSentParts = false
  let promptResolved = false
  let hasReceivedEvent = false

  function startTyping(): () => void {
    if (abortController.signal.aborted) {
      discordLogger.log(`Not starting typing, already aborted`)
      return () => {}
    }
    if (typingInterval) {
      clearInterval(typingInterval)
      typingInterval = null
    }

    void errore.tryAsync(() => thread.sendTyping()).then((result) => {
      if (result instanceof Error) {
        discordLogger.log(`Failed to send initial typing: ${result}`)
      }
    })

    typingInterval = setInterval(() => {
      void errore.tryAsync(() => thread.sendTyping()).then((result) => {
        if (result instanceof Error) {
          discordLogger.log(`Failed to send periodic typing: ${result}`)
        }
      })
    }, 8000)

    if (!abortController.signal.aborted) {
      abortController.signal.addEventListener(
        'abort',
        () => {
          if (typingInterval) {
            clearInterval(typingInterval)
            typingInterval = null
          }
        },
        { once: true },
      )
    }

    return () => {
      if (typingInterval) {
        clearInterval(typingInterval)
        typingInterval = null
      }
    }
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

    const sendResult = await errore.tryAsync(() => {
      return sendThreadMessage(thread, content)
    })
    if (sendResult instanceof Error) {
      discordLogger.error(`ERROR: Failed to send part ${part.id}:`, sendResult)
      return
    }
    hasSentParts = true
    sentPartIds.add(part.id)

    await setPartMessage(part.id, sendResult.id, thread.id)
  }

  const eventHandler = async () => {
    // Subtask tracking: child sessionId → { label, assistantMessageId }
    const subtaskSessions = new Map<string, { label: string; assistantMessageId?: string }>()
    // Counts spawned tasks per agent type: "explore" → 2
    const agentSpawnCounts: Record<string, number> = {}

    const storePart = (part: Part) => {
      const messageParts = partBuffer.get(part.messageID) || new Map<string, Part>()
      messageParts.set(part.id, part)
      partBuffer.set(part.messageID, messageParts)
    }

    const getBufferedParts = (messageID: string) => {
      return Array.from(partBuffer.get(messageID)?.values() ?? [])
    }

    const shouldSendPart = ({ part, force }: { part: Part; force: boolean }) => {
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
      hasReceivedEvent = true

      if (msg.role !== 'assistant') {
        return
      }

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

      if (!modelContextLimit) {
        const providersResponse = await errore.tryAsync(() => {
          return getClient().provider.list({
            query: { directory: sdkDirectory },
          })
        })
        if (providersResponse instanceof Error) {
          sessionLogger.error('Failed to fetch provider info for context limit:', providersResponse)
        } else {
          const provider = providersResponse.data?.all?.find((p) => p.id === usedProviderID)
          const model = provider?.models?.[usedModel]
          if (model?.limit?.context) {
            modelContextLimit = model.limit.context
          }
        }
      }

      if (!modelContextLimit) {
        return
      }

      const currentPercentage = Math.floor((tokensUsedInSession / modelContextLimit) * 100)
      const thresholdCrossed = Math.floor(currentPercentage / 10) * 10
      if (thresholdCrossed <= lastDisplayedContextPercentage || thresholdCrossed < 10) {
        return
      }
      lastDisplayedContextPercentage = thresholdCrossed
      const chunk = `⬦ context usage ${currentPercentage}%`
      await thread.send({ content: chunk, flags: SILENT_MESSAGE_FLAGS })
    }

    const handleMainPart = async (part: Part) => {
      const isActiveMessage = assistantMessageId ? part.messageID === assistantMessageId : false
      const allowEarlyProcessing =
        !assistantMessageId && part.type === 'tool' && part.state.status === 'running'
      if (!isActiveMessage && !allowEarlyProcessing) {
        if (part.type !== 'step-start') {
          return
        }
      }

      if (part.type === 'step-start') {
        const hasPendingQuestion = [...pendingQuestionContexts.values()].some(
          (ctx) => ctx.thread.id === thread.id,
        )
        const hasPendingPermission = (pendingPermissions.get(thread.id)?.size ?? 0) > 0
        if (!hasPendingQuestion && !hasPendingPermission) {
          stopTyping = startTyping()
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
          const childSessionId = (part.state.metadata?.sessionId as string) || ''
          if (description && childSessionId) {
            agentSpawnCounts[agent] = (agentSpawnCounts[agent] || 0) + 1
            const label = `${agent}-${agentSpawnCounts[agent]}`
            subtaskSessions.set(childSessionId, { label, assistantMessageId: undefined })
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
            const formattedTokens =
              outputTokens >= 1000 ? `${(outputTokens / 1000).toFixed(1)}k` : String(outputTokens)
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
        setTimeout(() => {
          if (abortController.signal.aborted) return
          const hasPendingQuestion = [...pendingQuestionContexts.values()].some(
            (ctx) => ctx.thread.id === thread.id,
          )
          const hasPendingPermission = (pendingPermissions.get(thread.id)?.size ?? 0) > 0
          if (hasPendingQuestion || hasPendingPermission) return
          stopTyping = startTyping()
        }, 300)
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
      if (!subtaskInfo.assistantMessageId || part.messageID !== subtaskInfo.assistantMessageId) {
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
        discordLogger.error(`ERROR: Failed to send subtask part ${part.id}:`, sendResult)
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
      error?: { data?: { message?: string } }
    }) => {
      if (!sessionID || sessionID !== session.id) {
        voiceLogger.log(
          `[SESSION ERROR IGNORED] Error for different session (expected: ${session.id}, got: ${sessionID})`,
        )
        return
      }

      const errorMessage = error?.data?.message || 'Unknown error'
      sessionLogger.error(`Sending error to thread: ${errorMessage}`)
      await sendThreadMessage(thread, `✗ opencode session error: ${errorMessage}`)

      if (!originalMessage) {
        return
      }
      const reactionResult = await errore.tryAsync(async () => {
        await originalMessage.reactions.removeAll()
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
            return pending.dedupeKey === dedupeKey
          })
        : undefined

      if (existingPending) {
        sessionLogger.log(
          `[PERMISSION] Deduped permission ${permission.id} (matches pending ${existingPending.permission.id})`,
        )
        if (stopTyping) {
          stopTyping()
          stopTyping = null
        }
        if (!pendingPermissions.has(thread.id)) {
          pendingPermissions.set(thread.id, new Map())
        }
        pendingPermissions.get(thread.id)!.set(permission.id, {
          permission,
          messageId: existingPending.messageId,
          directory,
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

      if (stopTyping) {
        stopTyping()
        stopTyping = null
      }

      const { messageId, contextHash } = await showPermissionDropdown({
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

      if (stopTyping) {
        stopTyping()
        stopTyping = null
      }

      await flushBufferedParts({
        messageID: assistantMessageId || '',
        force: true,
      })

      await showAskUserQuestionDropdowns({
        thread,
        sessionId: session.id,
        directory,
        requestId: questionRequest.id,
        input: { questions: questionRequest.questions },
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

      await sendThreadMessage(
        thread,
        `» **${nextMessage.username}:** ${nextMessage.prompt.slice(0, 150)}${nextMessage.prompt.length > 150 ? '...' : ''}`,
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
            })
          })
          .then(async (result) => {
            if (!(result instanceof Error)) {
              return
            }
            sessionLogger.error(`[QUEUE] Failed to process queued message:`, result)
            await sendThreadMessage(
              thread,
              `✗ Queued message failed: ${result.message.slice(0, 200)}`,
            )
          })
      })
    }

    const handleSessionStatus = async (properties: {
      sessionID: string
      status: { type: 'idle' } | { type: 'retry'; attempt: number; message: string; next: number } | { type: 'busy' }
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

    const handleSessionIdle = (idleSessionId: string) => {
      if (idleSessionId === session.id) {
        if (!promptResolved || !hasReceivedEvent) {
          sessionLogger.log(
            `[SESSION IDLE] Ignoring idle event for ${session.id} (prompt not resolved or no events yet)`,
          )
          return
        }
        if (!assistantMessageId) {
          sessionLogger.log(
            `[SESSION IDLE] Ignoring idle event for ${session.id} (no assistant output yet)`,
          )
          return
        }
        sessionLogger.log(`[SESSION IDLE] Session ${session.id} is idle, ending stream`)
        sessionLogger.log(`[ABORT] reason=finished sessionId=${session.id} threadId=${thread.id} - session completed normally, received idle event after prompt resolved`)
        abortController.abort(new Error('finished'))
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
            sessionLogger.error(`ERROR:`, event.properties)
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
          default:
            break
        }
      }
    } catch (e) {
      if (isAbortError(e, abortController.signal)) {
        sessionLogger.log('AbortController aborted event handling (normal exit)')
        return
      }
      sessionLogger.error(`Unexpected error in event handling code`, e)
      throw e
    } finally {
      abortControllers.delete(session.id)
      const finalMessageId = assistantMessageId
      if (finalMessageId) {
        const parts = getBufferedParts(finalMessageId)
        for (const part of parts) {
          if (!sentPartIds.has(part.id)) {
            await sendPartMessage(part)
          }
        }
      }

      if (stopTyping) {
        stopTyping()
        stopTyping = null
      }

      const abortReason = (abortController.signal.reason as Error)?.message
      if (!abortController.signal.aborted || abortReason === 'finished') {
        const sessionDuration = prettyMilliseconds(Date.now() - sessionStartTime)
        const attachCommand = port ? ` ⋅ ${session.id}` : ''
        const modelInfo = usedModel ? ` ⋅ ${usedModel}` : ''
        const agentInfo =
          usedAgent && usedAgent.toLowerCase() !== 'build' ? ` ⋅ **${usedAgent}**` : ''
        let contextInfo = ''

        const contextResult = await errore.tryAsync(async () => {
          // Fetch final token count from API since message.updated events can arrive
          // after session.idle due to race conditions in event ordering
          if (tokensUsedInSession === 0) {
            const messagesResponse = await getClient().session.messages({
              path: { id: session.id },
              query: { directory: sdkDirectory },
            })
            const messages = messagesResponse.data || []
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

          const providersResponse = await getClient().provider.list({ query: { directory: sdkDirectory } })
          const provider = providersResponse.data?.all?.find((p) => p.id === usedProviderID)
          const model = provider?.models?.[usedModel || '']
          if (model?.limit?.context) {
            const percentage = Math.round((tokensUsedInSession / model.limit.context) * 100)
            contextInfo = ` ⋅ ${percentage}%`
          }
        })
        if (contextResult instanceof Error) {
          sessionLogger.error('Failed to fetch provider info for context percentage:', contextResult)
        }

        await sendThreadMessage(
          thread,
          `_Completed in ${sessionDuration}${contextInfo}_${attachCommand}${modelInfo}${agentInfo}`,
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

          sessionLogger.log(`[QUEUE] Processing queued message from ${nextMessage.username}`)

          // Show that queued message is being sent
          await sendThreadMessage(
            thread,
            `» **${nextMessage.username}:** ${nextMessage.prompt.slice(0, 150)}${nextMessage.prompt.length > 150 ? '...' : ''}`,
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
            }).catch(async (e) => {
              sessionLogger.error(`[QUEUE] Failed to process queued message:`, e)
              const errorMsg = e instanceof Error ? e.message : String(e)
              await sendThreadMessage(thread, `✗ Queued message failed: ${errorMsg.slice(0, 200)}`)
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

  const promptResult: Error | { sessionID: string; result: any; port?: number } | undefined =
    await errore.tryAsync(async () => {
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

    stopTyping = startTyping()

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

    const agentPreference =
      agent || (await getSessionAgent(session.id)) || (channelId ? await getChannelAgent(channelId) : undefined)
    if (agentPreference) {
      sessionLogger.log(`[AGENT] Using agent preference: ${agentPreference}`)
    }

    // Model priority: explicit model param > session model > agent model > channel model > global model > default
    const modelParam = await (async (): Promise<{ providerID: string; modelID: string } | undefined> => {
      // Use explicit model override if provided
      if (model) {
        const [providerID, ...modelParts] = model.split('/')
        const modelID = modelParts.join('/')
        if (providerID && modelID) {
          sessionLogger.log(`[MODEL] Using explicit model: ${model}`)
          return { providerID, modelID }
        }
      }

      // Fall back to model info resolution
      const channelInfo = channelId ? await getChannelDirectory(channelId) : undefined
      const resolvedAppId = channelInfo?.appId ?? appId
      const modelInfo = await getCurrentModelInfo({
        sessionId: session.id,
        channelId,
        appId: resolvedAppId,
        agentPreference,
        getClient,
      })
      if (modelInfo.type === 'none') {
        sessionLogger.log(`[MODEL] No model available (no preference, no default)`)
        return undefined
      }
      sessionLogger.log(`[MODEL] Using ${modelInfo.type}: ${modelInfo.model}`)
      return { providerID: modelInfo.providerID, modelID: modelInfo.modelID }
    })()

    // Fail early if no model available
    if (!modelParam) {
      throw new Error(
        'No AI provider connected. Configure a provider in OpenCode with `/connect` command.',
      )
    }

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

    const response = command
      ? await getClient().session.command({
          path: { id: session.id },
          query: { directory: sdkDirectory },
          body: {
            command: command.name,
            arguments: command.arguments,
            agent: agentPreference,
          },
          signal: abortController.signal,
        })
      : await getClient().session.prompt({
          path: { id: session.id },
          query: { directory: sdkDirectory },
          body: {
            parts,
            system: getOpencodeSystemMessage({
              sessionId: session.id,
              channelId,
              guildId: thread.guildId,
              worktree,
              channelTopic,
              username,
              userId,
            }),
            model: modelParam,
            agent: agentPreference,
          },
          signal: abortController.signal,
        })

    if (response.error) {
      const errorMessage = (() => {
        const err = response.error
        if (err && typeof err === 'object') {
          if ('data' in err && err.data && typeof err.data === 'object' && 'message' in err.data) {
            return String(err.data.message)
          }
          if ('errors' in err && Array.isArray(err.errors) && err.errors.length > 0) {
            return JSON.stringify(err.errors)
          }
        }
        return JSON.stringify(err)
      })()
      throw new Error(`OpenCode API error (${response.response.status}): ${errorMessage}`)
    }

    promptResolved = true

    sessionLogger.log(`Successfully sent prompt, got response`)

    if (originalMessage) {
      const reactionResult = await errore.tryAsync(async () => {
        await originalMessage.reactions.removeAll()
        await originalMessage.react('✅')
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

  const promptError: Error = promptResult instanceof Error ? promptResult : new Error('Unknown error')
  if (isAbortError(promptError, abortController.signal)) {
    return
  }

  sessionLogger.error(`ERROR: Failed to send prompt:`, promptError)
  sessionLogger.log(`[ABORT] reason=error sessionId=${session.id} threadId=${thread.id} - prompt failed with error: ${(promptError as Error).message}`)
  abortController.abort(new Error('error'))

  if (originalMessage) {
    const reactionResult = await errore.tryAsync(async () => {
      await originalMessage.reactions.removeAll()
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
