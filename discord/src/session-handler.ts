// OpenCode session lifecycle manager.
// Creates, maintains, and sends prompts to OpenCode sessions from Discord threads.
// Handles streaming events, permissions, abort signals, and message queuing.

import type { Part, PermissionRequest, QuestionRequest } from '@opencode-ai/sdk/v2'
import type { FilePartInput } from '@opencode-ai/sdk'
import type { Message, ThreadChannel } from 'discord.js'
import prettyMilliseconds from 'pretty-ms'
import {
  getDatabase,
  getSessionModel,
  getChannelModel,
  getSessionAgent,
  getChannelAgent,
  setSessionAgent,
  getThreadWorktree,
} from './database.js'
import {
  initializeOpencodeForDirectory,
  getOpencodeServers,
  getOpencodeClientV2,
} from './opencode.js'
import { sendThreadMessage, NOTIFY_MESSAGE_FLAGS, SILENT_MESSAGE_FLAGS } from './discord-utils.js'
import { formatPart } from './message-formatting.js'
import { getOpencodeSystemMessage, type WorktreeInfo } from './system-message.js'
import { createLogger } from './logger.js'
import { isAbortError } from './utils.js'
import {
  showAskUserQuestionDropdowns,
  cancelPendingQuestion,
  pendingQuestionContexts,
} from './commands/ask-question.js'
import { showPermissionDropdown, cleanupPermissionContext } from './commands/permissions.js'
import * as errore from 'errore'

const sessionLogger = createLogger('SESSION')
const voiceLogger = createLogger('VOICE')
const discordLogger = createLogger('DISCORD')

export const abortControllers = new Map<string, AbortController>()

// Track multiple pending permissions per thread (keyed by permission ID)
// OpenCode handles blocking/sequencing - we just need to track all pending permissions
// to avoid duplicates and properly clean up on auto-reject
export const pendingPermissions = new Map<
  string, // threadId
  Map<string, { permission: PermissionRequest; messageId: string; directory: string; contextHash: string }> // permissionId -> data
>()

export type QueuedMessage = {
  prompt: string
  userId: string
  username: string
  queuedAt: number
  images?: FilePartInput[]
}

// Queue of messages waiting to be sent after current response finishes
// Key is threadId, value is array of queued messages
export const messageQueue = new Map<string, QueuedMessage[]>()

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
 * Abort a running session and retry with the last user message.
 * Used when model preference changes mid-request.
 * Fetches last user message from OpenCode API instead of tracking in memory.
 * @returns true if aborted and retry scheduled, false if no active request
 */
export async function abortAndRetrySession({
  sessionId,
  thread,
  projectDirectory,
}: {
  sessionId: string
  thread: ThreadChannel
  projectDirectory: string
}): Promise<boolean> {
  const controller = abortControllers.get(sessionId)

  if (!controller) {
    sessionLogger.log(`[ABORT+RETRY] No active request for session ${sessionId}`)
    return false
  }

  sessionLogger.log(`[ABORT+RETRY] Aborting session ${sessionId} for model change`)

  // Abort with special reason so we don't show "completed" message
  controller.abort('model-change')

  // Also call the API abort endpoint
  const getClient = await initializeOpencodeForDirectory(projectDirectory)
  if (getClient instanceof Error) {
    sessionLogger.error(`[ABORT+RETRY] Failed to initialize OpenCode client:`, getClient.message)
    return false
  }
  const abortResult = await errore.tryAsync(() => {
    return getClient().session.abort({ path: { id: sessionId } })
  })
  if (abortResult instanceof Error) {
    sessionLogger.log(`[ABORT+RETRY] API abort call failed (may already be done):`, abortResult)
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
  const images = lastUserMessage.parts.filter((p) => p.type === 'file') as FilePartInput[]

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
}: {
  prompt: string
  thread: ThreadChannel
  projectDirectory?: string
  originalMessage?: Message
  images?: FilePartInput[]
  channelId?: string
  /** If set, uses session.command API instead of session.prompt */
  command?: { name: string; arguments: string }
  /** Agent to use for this session */
  agent?: string
}): Promise<{ sessionID: string; result: any; port?: number } | undefined> {
  voiceLogger.log(
    `[OPENCODE SESSION] Starting for thread ${thread.id} with prompt: "${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}"`,
  )

  const sessionStartTime = Date.now()

  const directory = projectDirectory || process.cwd()
  sessionLogger.log(`Using directory: ${directory}`)

  const getClient = await initializeOpencodeForDirectory(directory)
  if (getClient instanceof Error) {
    await sendThreadMessage(thread, `✗ ${getClient.message}`)
    return
  }

  const serverEntry = getOpencodeServers().get(directory)
  const port = serverEntry?.port

  const row = getDatabase()
    .prepare('SELECT session_id FROM thread_sessions WHERE thread_id = ?')
    .get(thread.id) as { session_id: string } | undefined
  let sessionId = row?.session_id
  let session

  if (sessionId) {
    sessionLogger.log(`Attempting to reuse existing session ${sessionId}`)
    const sessionResponse = await errore.tryAsync(() => {
      return getClient().session.get({
        path: { id: sessionId },
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
    })
    session = sessionResponse.data
    sessionLogger.log(`Created new session ${session?.id}`)
  }

  if (!session) {
    throw new Error('Failed to create or get session')
  }

  getDatabase()
    .prepare('INSERT OR REPLACE INTO thread_sessions (thread_id, session_id) VALUES (?, ?)')
    .run(thread.id, session.id)
  sessionLogger.log(`Stored session ${session.id} for thread ${thread.id}`)

  // Store agent preference if provided
  if (agent) {
    setSessionAgent(session.id, agent)
    sessionLogger.log(`Set agent preference for session ${session.id}: ${agent}`)
  }

  const existingController = abortControllers.get(session.id)
  if (existingController) {
    voiceLogger.log(`[ABORT] Cancelling existing request for session: ${session.id}`)
    existingController.abort(new Error('New request started'))
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

  // Cancel any pending question tool if user sends a new message (silently, no thread message)
  const questionCancelled = await cancelPendingQuestion(thread.id)
  if (questionCancelled) {
    sessionLogger.log(`[QUESTION] Cancelled pending question due to new message`)
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

  // Use v2 client for event subscription (has proper types for question.asked events)
  const clientV2 = getOpencodeClientV2(directory)
  if (!clientV2) {
    throw new Error(`OpenCode v2 client not found for directory: ${directory}`)
  }
  const eventsResult = await clientV2.event.subscribe(
    { directory },
    { signal: abortController.signal },
  )

  if (abortController.signal.aborted) {
    sessionLogger.log(`[DEBOUNCE] Aborted during subscribe, exiting`)
    return
  }

  const events = eventsResult.stream
  sessionLogger.log(`Subscribed to OpenCode events`)

  const sentPartIds = new Set<string>(
    (
      getDatabase()
        .prepare('SELECT part_id FROM part_messages WHERE thread_id = ?')
        .all(thread.id) as { part_id: string }[]
    ).map((row) => row.part_id),
  )

  const partBuffer = new Map<string, Map<string, Part>>()
  let stopTyping: (() => void) | null = null
  let usedModel: string | undefined
  let usedProviderID: string | undefined
  let usedAgent: string | undefined
  let tokensUsedInSession = 0
  let lastDisplayedContextPercentage = 0
  let modelContextLimit: number | undefined
  let assistantMessageId: string | undefined

  let typingInterval: NodeJS.Timeout | null = null

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

  const sendPartMessage = async (part: Part) => {
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
    sentPartIds.add(part.id)

    getDatabase()
      .prepare(
        'INSERT OR REPLACE INTO part_messages (part_id, message_id, thread_id) VALUES (?, ?, ?)',
      )
      .run(part.id, sendResult.id, thread.id)
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
            query: { directory },
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
            const taskDisplay = `┣ task **${label}** _${description}_`
            await sendThreadMessage(thread, taskDisplay + '\n\n')
            sentPartIds.add(part.id)
          }
        }
        return
      }

      if (part.type === 'tool' && part.state.status === 'completed') {
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
      getDatabase()
        .prepare(
          'INSERT OR REPLACE INTO part_messages (part_id, message_id, thread_id) VALUES (?, ?, ?)',
        )
        .run(part.id, sendResult.id, thread.id)
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
      if (permission.sessionID !== session.id) {
        voiceLogger.log(
          `[PERMISSION IGNORED] Permission for different session (expected: ${session.id}, got: ${permission.sessionID})`,
        )
        return
      }

      const threadPermissions = pendingPermissions.get(thread.id)
      if (threadPermissions?.has(permission.id)) {
        sessionLogger.log(
          `[PERMISSION] Skipping duplicate permission ${permission.id} (already pending)`,
        )
        return
      }

      sessionLogger.log(
        `Permission requested: permission=${permission.permission}, patterns=${permission.patterns.join(', ')}`,
      )

      if (stopTyping) {
        stopTyping()
        stopTyping = null
      }

      const { messageId, contextHash } = await showPermissionDropdown({
        thread,
        permission,
        directory,
      })

      if (!pendingPermissions.has(thread.id)) {
        pendingPermissions.set(thread.id, new Map())
      }
      pendingPermissions.get(thread.id)!.set(permission.id, {
        permission,
        messageId,
        directory,
        contextHash,
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
      if (sessionID !== session.id) {
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

    const handleSessionIdle = (idleSessionId: string) => {
      if (idleSessionId === session.id) {
        sessionLogger.log(`[SESSION IDLE] Session ${session.id} is idle, aborting`)
        abortController.abort('finished')
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

      if (!abortController.signal.aborted || abortController.signal.reason === 'finished') {
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

          const providersResponse = await getClient().provider.list({ query: { directory } })
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
            }).catch(async (e) => {
              sessionLogger.error(`[QUEUE] Failed to process queued message:`, e)
              const errorMsg = e instanceof Error ? e.message : String(e)
              await sendThreadMessage(thread, `✗ Queued message failed: ${errorMsg.slice(0, 200)}`)
            })
          })
        }
      } else {
        sessionLogger.log(
          `Session was aborted (reason: ${abortController.signal.reason}), skipping duration message`,
        )
      }
    }
  }

  const promptResult: Error | { sessionID: string; result: any; port?: number } | undefined =
    await errore.tryAsync(async () => {
      const eventHandlerPromise = eventHandler()

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
          url: img.url.slice(0, 100),
        })),
      )
      const imagePathsList = images.map((img) => `- ${img.filename}: ${img.url}`).join('\n')
      return `${prompt}\n\n**attached images:**\n${imagePathsList}`
    })()

    const parts = [{ type: 'text' as const, text: promptWithImagePaths }, ...images]
    sessionLogger.log(`[PROMPT] Parts to send:`, parts.length)

    const agentPreference =
      getSessionAgent(session.id) || (channelId ? getChannelAgent(channelId) : undefined)
    if (agentPreference) {
      sessionLogger.log(`[AGENT] Using agent preference: ${agentPreference}`)
    }

    const modelPreference =
      getSessionModel(session.id) || (channelId ? getChannelModel(channelId) : undefined)
    const modelParam = (() => {
      if (agentPreference) {
        sessionLogger.log(`[MODEL] Skipping model param, agent "${agentPreference}" controls model`)
        return undefined
      }
      if (!modelPreference) {
        return undefined
      }
      const [providerID, ...modelParts] = modelPreference.split('/')
      const modelID = modelParts.join('/')
      if (!providerID || !modelID) {
        return undefined
      }
      sessionLogger.log(`[MODEL] Using model preference: ${modelPreference}`)
      return { providerID, modelID }
    })()

    const worktreeInfo = getThreadWorktree(thread.id)
    const worktree: WorktreeInfo | undefined =
      worktreeInfo?.status === 'ready' && worktreeInfo.worktree_directory
        ? {
            worktreeDirectory: worktreeInfo.worktree_directory,
            branch: worktreeInfo.worktree_name,
            mainRepoDirectory: worktreeInfo.project_directory,
          }
        : undefined

    const response = command
      ? await getClient().session.command({
          path: { id: session.id },
          body: {
            command: command.name,
            arguments: command.arguments,
            agent: agentPreference,
          },
          signal: abortController.signal,
        })
      : await getClient().session.prompt({
          path: { id: session.id },
          body: {
            parts,
            system: getOpencodeSystemMessage({ sessionId: session.id, channelId, worktree }),
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

    abortController.abort('finished')

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

  if (!errore.isError(promptResult)) {
    return promptResult
  }

  const promptError: Error = promptResult instanceof Error ? promptResult : new Error('Unknown error')
  if (isAbortError(promptError, abortController.signal)) {
    return
  }

  sessionLogger.error(`ERROR: Failed to send prompt:`, promptError)
  abortController.abort('error')

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
