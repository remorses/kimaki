// OpenCode session lifecycle manager.
// Creates, maintains, and sends prompts to OpenCode sessions from Discord threads.
// Handles streaming events, permissions, abort signals, and message queuing.

import type { Part, PermissionRequest } from '@opencode-ai/sdk/v2'
import type { FilePartInput } from '@opencode-ai/sdk'
import type { Message, ThreadChannel } from 'discord.js'
import prettyMilliseconds from 'pretty-ms'
import { getDatabase, getSessionModel, getChannelModel, getSessionAgent, getChannelAgent } from './database.js'
import { initializeOpencodeForDirectory, getOpencodeServers, getOpencodeClientV2 } from './opencode.js'
import { sendThreadMessage, NOTIFY_MESSAGE_FLAGS, SILENT_MESSAGE_FLAGS } from './discord-utils.js'
import { formatPart } from './message-formatting.js'
import { getOpencodeSystemMessage } from './system-message.js'
import { createLogger } from './logger.js'
import { isAbortError } from './utils.js'
import { showAskUserQuestionDropdowns, cancelPendingQuestion } from './commands/ask-question.js'
import { showPermissionDropdown, cleanupPermissionContext } from './commands/permissions.js'

const sessionLogger = createLogger('SESSION')
const voiceLogger = createLogger('VOICE')
const discordLogger = createLogger('DISCORD')

export const abortControllers = new Map<string, AbortController>()

export const pendingPermissions = new Map<
  string,
  { permission: PermissionRequest; messageId: string; directory: string; contextHash: string }
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
  try {
    await getClient().session.abort({ path: { id: sessionId } })
  } catch (e) {
    sessionLogger.log(`[ABORT+RETRY] API abort call failed (may already be done):`, e)
  }

  // Small delay to let the abort propagate
  await new Promise((resolve) => { setTimeout(resolve, 300) })

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
  const textPart = lastUserMessage.parts.find((p) => p.type === 'text') as { type: 'text'; text: string } | undefined
  const prompt = textPart?.text || ''
  const images = lastUserMessage.parts.filter((p) => p.type === 'file') as FilePartInput[]

  sessionLogger.log(`[ABORT+RETRY] Re-triggering session ${sessionId} with new model`)

  // Use setImmediate to avoid blocking
  setImmediate(() => {
    handleOpencodeSession({
      prompt,
      thread,
      projectDirectory,
      images,
    }).catch(async (e) => {
      sessionLogger.error(`[ABORT+RETRY] Failed to retry:`, e)
      const errorMsg = e instanceof Error ? e.message : String(e)
      await sendThreadMessage(thread, `✗ Failed to retry with new model: ${errorMsg.slice(0, 200)}`)
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
}: {
  prompt: string
  thread: ThreadChannel
  projectDirectory?: string
  originalMessage?: Message
  images?: FilePartInput[]
  channelId?: string
  /** If set, uses session.command API instead of session.prompt */
  command?: { name: string; arguments: string }
}): Promise<{ sessionID: string; result: any; port?: number } | undefined> {
  voiceLogger.log(
    `[OPENCODE SESSION] Starting for thread ${thread.id} with prompt: "${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}"`,
  )

  const sessionStartTime = Date.now()

  const directory = projectDirectory || process.cwd()
  sessionLogger.log(`Using directory: ${directory}`)

  const getClient = await initializeOpencodeForDirectory(directory)

  const serverEntry = getOpencodeServers().get(directory)
  const port = serverEntry?.port

  const row = getDatabase()
    .prepare('SELECT session_id FROM thread_sessions WHERE thread_id = ?')
    .get(thread.id) as { session_id: string } | undefined
  let sessionId = row?.session_id
  let session

  if (sessionId) {
    sessionLogger.log(`Attempting to reuse existing session ${sessionId}`)
    try {
      const sessionResponse = await getClient().session.get({
        path: { id: sessionId },
      })
      session = sessionResponse.data
      sessionLogger.log(`Successfully reused session ${sessionId}`)
    } catch (error) {
      voiceLogger.log(
        `[SESSION] Session ${sessionId} not found, will create new one`,
      )
    }
  }

  if (!session) {
    const sessionTitle = prompt.length > 80 ? prompt.slice(0, 77) + '...' : prompt.slice(0, 80)
    voiceLogger.log(
      `[SESSION] Creating new session with title: "${sessionTitle}"`,
    )
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
    .prepare(
      'INSERT OR REPLACE INTO thread_sessions (thread_id, session_id) VALUES (?, ?)',
    )
    .run(thread.id, session.id)
  sessionLogger.log(`Stored session ${session.id} for thread ${thread.id}`)

  const existingController = abortControllers.get(session.id)
  if (existingController) {
    voiceLogger.log(
      `[ABORT] Cancelling existing request for session: ${session.id}`,
    )
    existingController.abort(new Error('New request started'))
  }

  const pendingPerm = pendingPermissions.get(thread.id)
  if (pendingPerm) {
    try {
      sessionLogger.log(`[PERMISSION] Auto-rejecting pending permission ${pendingPerm.permission.id} due to new message`)
      const clientV2 = getOpencodeClientV2(directory)
      if (clientV2) {
        await clientV2.permission.reply({
          requestID: pendingPerm.permission.id,
          reply: 'reject',
        })
      }
      // Clean up both the pending permission and its dropdown context
      cleanupPermissionContext(pendingPerm.contextHash)
      pendingPermissions.delete(thread.id)
      await sendThreadMessage(thread, `⚠️ Previous permission request auto-rejected due to new message`)
    } catch (e) {
      sessionLogger.log(`[PERMISSION] Failed to auto-reject permission:`, e)
      cleanupPermissionContext(pendingPerm.contextHash)
      pendingPermissions.delete(thread.id)
    }
  }

  // Cancel any pending question tool if user sends a new message
  const questionCancelled = await cancelPendingQuestion(thread.id)
  if (questionCancelled) {
    sessionLogger.log(`[QUESTION] Cancelled pending question due to new message`)
    await sendThreadMessage(thread, `⚠️ Previous question cancelled - processing your new message`)
  }

  const abortController = new AbortController()
  abortControllers.set(session.id, abortController)

  if (existingController) {
    await new Promise((resolve) => { setTimeout(resolve, 200) })
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
    { signal: abortController.signal }
  )

  if (abortController.signal.aborted) {
    sessionLogger.log(`[DEBOUNCE] Aborted during subscribe, exiting`)
    return
  }

  const events = eventsResult.stream
  sessionLogger.log(`Subscribed to OpenCode events`)

  const sentPartIds = new Set<string>(
    (getDatabase()
      .prepare('SELECT part_id FROM part_messages WHERE thread_id = ?')
      .all(thread.id) as { part_id: string }[])
      .map((row) => row.part_id)
  )

  let currentParts: Part[] = []
  let stopTyping: (() => void) | null = null
  let usedModel: string | undefined
  let usedProviderID: string | undefined
  let usedAgent: string | undefined
  let tokensUsedInSession = 0
  let lastDisplayedContextPercentage = 0
  let modelContextLimit: number | undefined

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

    thread.sendTyping().catch((e) => {
      discordLogger.log(`Failed to send initial typing: ${e}`)
    })

    typingInterval = setInterval(() => {
      thread.sendTyping().catch((e) => {
        discordLogger.log(`Failed to send periodic typing: ${e}`)
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

    try {
      const firstMessage = await sendThreadMessage(thread, content)
      sentPartIds.add(part.id)

      getDatabase()
        .prepare(
          'INSERT OR REPLACE INTO part_messages (part_id, message_id, thread_id) VALUES (?, ?, ?)',
        )
        .run(part.id, firstMessage.id, thread.id)
    } catch (error) {
      discordLogger.error(`ERROR: Failed to send part ${part.id}:`, error)
    }
  }

  const eventHandler = async () => {
    try {
      let assistantMessageId: string | undefined

      for await (const event of events) {
        if (event.type === 'message.updated') {
          const msg = event.properties.info

          if (msg.sessionID !== session.id) {
            continue
          }

          if (msg.role === 'assistant') {
            const newTokensTotal = msg.tokens.input + msg.tokens.output + msg.tokens.reasoning + msg.tokens.cache.read + msg.tokens.cache.write
            if (newTokensTotal > 0) {
              tokensUsedInSession = newTokensTotal
            }

            assistantMessageId = msg.id
            usedModel = msg.modelID
            usedProviderID = msg.providerID
            usedAgent = msg.mode

            if (tokensUsedInSession > 0 && usedProviderID && usedModel) {
              if (!modelContextLimit) {
                try {
                  const providersResponse = await getClient().provider.list({ query: { directory } })
                  const provider = providersResponse.data?.all?.find((p) => p.id === usedProviderID)
                  const model = provider?.models?.[usedModel]
                  if (model?.limit?.context) {
                    modelContextLimit = model.limit.context
                  }
                } catch (e) {
                  sessionLogger.error('Failed to fetch provider info for context limit:', e)
                }
              }

              if (modelContextLimit) {
                const currentPercentage = Math.floor((tokensUsedInSession / modelContextLimit) * 100)
                const thresholdCrossed = Math.floor(currentPercentage / 10) * 10
                if (thresholdCrossed > lastDisplayedContextPercentage && thresholdCrossed >= 10) {
                  lastDisplayedContextPercentage = thresholdCrossed
                  const chunk = `⬦ context usage ${currentPercentage}%`
                  await thread.send({ content: chunk, flags: SILENT_MESSAGE_FLAGS })
                }
              }
            }
          }
        } else if (event.type === 'message.part.updated') {
          const part = event.properties.part

          if (part.sessionID !== session.id) {
            continue
          }

          if (part.messageID !== assistantMessageId) {
            continue
          }

          const existingIndex = currentParts.findIndex(
            (p: Part) => p.id === part.id,
          )
          if (existingIndex >= 0) {
            currentParts[existingIndex] = part
          } else {
            currentParts.push(part)
          }

          if (part.type === 'step-start') {
            stopTyping = startTyping()
          }

          if (part.type === 'tool' && part.state.status === 'running') {
            await sendPartMessage(part)
          }

          if (part.type === 'reasoning') {
            await sendPartMessage(part)
          }

          if (part.type === 'step-finish') {
            for (const p of currentParts) {
              if (p.type !== 'step-start' && p.type !== 'step-finish') {
                await sendPartMessage(p)
              }
            }
            setTimeout(() => {
              if (abortController.signal.aborted) return
              stopTyping = startTyping()
            }, 300)
          }
        } else if (event.type === 'session.error') {
          sessionLogger.error(`ERROR:`, event.properties)
          if (event.properties.sessionID === session.id) {
            const errorData = event.properties.error
            const errorMessage = errorData?.data?.message || 'Unknown error'
            sessionLogger.error(`Sending error to thread: ${errorMessage}`)
            await sendThreadMessage(
              thread,
              `✗ opencode session error: ${errorMessage}`,
            )

            if (originalMessage) {
              try {
                await originalMessage.reactions.removeAll()
                await originalMessage.react('❌')
                voiceLogger.log(
                  `[REACTION] Added error reaction due to session error`,
                )
              } catch (e) {
                discordLogger.log(`Could not update reaction:`, e)
              }
            }
          } else {
            voiceLogger.log(
              `[SESSION ERROR IGNORED] Error for different session (expected: ${session.id}, got: ${event.properties.sessionID})`,
            )
          }
          break
        } else if (event.type === 'permission.asked') {
          const permission = event.properties
          if (permission.sessionID !== session.id) {
            voiceLogger.log(
              `[PERMISSION IGNORED] Permission for different session (expected: ${session.id}, got: ${permission.sessionID})`,
            )
            continue
          }

          sessionLogger.log(
            `Permission requested: permission=${permission.permission}, patterns=${permission.patterns.join(', ')}`,
          )

          // Show dropdown instead of text message
          const { messageId, contextHash } = await showPermissionDropdown({
            thread,
            permission,
            directory,
          })

          pendingPermissions.set(thread.id, {
            permission,
            messageId,
            directory,
            contextHash,
          })
        } else if (event.type === 'permission.replied') {
          const { requestID, reply, sessionID } = event.properties
          if (sessionID !== session.id) {
            continue
          }

          sessionLogger.log(
            `Permission ${requestID} replied with: ${reply}`,
          )

          const pending = pendingPermissions.get(thread.id)
          if (pending && pending.permission.id === requestID) {
            cleanupPermissionContext(pending.contextHash)
            pendingPermissions.delete(thread.id)
          }
        } else if (event.type === 'question.asked') {
          const questionRequest = event.properties

          if (questionRequest.sessionID !== session.id) {
            sessionLogger.log(
              `[QUESTION IGNORED] Question for different session (expected: ${session.id}, got: ${questionRequest.sessionID})`,
            )
            continue
          }

          sessionLogger.log(
            `Question requested: id=${questionRequest.id}, questions=${questionRequest.questions.length}`,
          )

          // Flush any pending text/reasoning parts before showing the dropdown
          // This ensures text the LLM generated before the question tool is shown first
          for (const p of currentParts) {
            if (p.type !== 'step-start' && p.type !== 'step-finish') {
              await sendPartMessage(p)
            }
          }

          await showAskUserQuestionDropdowns({
            thread,
            sessionId: session.id,
            directory,
            requestId: questionRequest.id,
            input: { questions: questionRequest.questions },
          })
        }
      }
    } catch (e) {
      if (isAbortError(e, abortController.signal)) {
        sessionLogger.log(
          'AbortController aborted event handling (normal exit)',
        )
        return
      }
      sessionLogger.error(`Unexpected error in event handling code`, e)
      throw e
    } finally {
      for (const part of currentParts) {
        if (!sentPartIds.has(part.id)) {
          try {
            await sendPartMessage(part)
          } catch (error) {
            sessionLogger.error(`Failed to send part ${part.id}:`, error)
          }
        }
      }

      if (stopTyping) {
        stopTyping()
        stopTyping = null
      }

      if (
        !abortController.signal.aborted ||
        abortController.signal.reason === 'finished'
      ) {
        const sessionDuration = prettyMilliseconds(
          Date.now() - sessionStartTime,
        )
        const attachCommand = port ? ` ⋅ ${session.id}` : ''
        const modelInfo = usedModel ? ` ⋅ ${usedModel}` : ''
        const agentInfo = usedAgent && usedAgent.toLowerCase() !== 'build' ? ` ⋅ **${usedAgent}**` : ''
        let contextInfo = ''

        try {
          const providersResponse = await getClient().provider.list({ query: { directory } })
          const provider = providersResponse.data?.all?.find((p) => p.id === usedProviderID)
          const model = provider?.models?.[usedModel || '']
          if (model?.limit?.context) {
            const percentage = Math.round((tokensUsedInSession / model.limit.context) * 100)
            contextInfo = ` ⋅ ${percentage}%`
          }
        } catch (e) {
          sessionLogger.error('Failed to fetch provider info for context percentage:', e)
        }

        await sendThreadMessage(thread, `_Completed in ${sessionDuration}${contextInfo}_${attachCommand}${modelInfo}${agentInfo}`, { flags: NOTIFY_MESSAGE_FLAGS })
        sessionLogger.log(`DURATION: Session completed in ${sessionDuration}, port ${port}, model ${usedModel}, tokens ${tokensUsedInSession}`)

        // Process queued messages after completion
        const queue = messageQueue.get(thread.id)
        if (queue && queue.length > 0) {
          const nextMessage = queue.shift()!
          if (queue.length === 0) {
            messageQueue.delete(thread.id)
          }

          sessionLogger.log(`[QUEUE] Processing queued message from ${nextMessage.username}`)

          // Show that queued message is being sent
          await sendThreadMessage(thread, `» **${nextMessage.username}:** ${nextMessage.prompt.slice(0, 150)}${nextMessage.prompt.length > 150 ? '...' : ''}`)

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

  try {
    const eventHandlerPromise = eventHandler()

    if (abortController.signal.aborted) {
      sessionLogger.log(`[DEBOUNCE] Aborted before prompt, exiting`)
      return
    }

    stopTyping = startTyping()

    voiceLogger.log(
      `[PROMPT] Sending prompt to session ${session.id}: "${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}"`,
    )
    // append image paths to prompt so ai knows where they are on disk
    const promptWithImagePaths = (() => {
      if (images.length === 0) {
        return prompt
      }
      sessionLogger.log(`[PROMPT] Sending ${images.length} image(s):`, images.map((img) => ({ mime: img.mime, filename: img.filename, url: img.url.slice(0, 100) })))
      const imagePathsList = images.map((img) => `- ${img.filename}: ${img.url}`).join('\n')
      return `${prompt}\n\n**attached images:**\n${imagePathsList}`
    })()

    const parts = [{ type: 'text' as const, text: promptWithImagePaths }, ...images]
    sessionLogger.log(`[PROMPT] Parts to send:`, parts.length)

    // Get model preference: session-level overrides channel-level
    const modelPreference = getSessionModel(session.id) || (channelId ? getChannelModel(channelId) : undefined)
    const modelParam = (() => {
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

    // Get agent preference: session-level overrides channel-level
    const agentPreference = getSessionAgent(session.id) || (channelId ? getChannelAgent(channelId) : undefined)
    if (agentPreference) {
      sessionLogger.log(`[AGENT] Using agent preference: ${agentPreference}`)
    }

    // Use session.command API for slash commands, session.prompt for regular messages
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
            system: getOpencodeSystemMessage({ sessionId: session.id, channelId }),
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
      try {
        await originalMessage.reactions.removeAll()
        await originalMessage.react('✅')
      } catch (e) {
        discordLogger.log(`Could not update reactions:`, e)
      }
    }

    return { sessionID: session.id, result: response.data, port }
  } catch (error) {
    sessionLogger.error(`ERROR: Failed to send prompt:`, error)

    if (!isAbortError(error, abortController.signal)) {
      abortController.abort('error')

      if (originalMessage) {
        try {
          await originalMessage.reactions.removeAll()
          await originalMessage.react('❌')
          discordLogger.log(`Added error reaction to message`)
        } catch (e) {
          discordLogger.log(`Could not update reaction:`, e)
        }
      }
      const errorName =
        error &&
        typeof error === 'object' &&
        'constructor' in error &&
        error.constructor &&
        typeof error.constructor.name === 'string'
          ? error.constructor.name
          : typeof error
      const errorMsg =
        error instanceof Error ? error.stack || error.message : String(error)
      await sendThreadMessage(
        thread,
        `✗ Unexpected bot Error: [${errorName}]\n${errorMsg}`,
      )
    }
  }
}
