// /resume command - Resume an existing OpenCode session.

// ThreadAutoArchiveDuration.OneDay = 1440 minutes
const THREAD_AUTO_ARCHIVE_ONE_DAY = 1440
import fs from 'node:fs'
import type { CommandContext, AutocompleteContext } from './types.js'
import {
  getChannelDirectory,
  setThreadSession,
  setPartMessagesBatch,
  getAllThreadSessionIds,
} from '../database.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import {
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import { collectLastAssistantParts } from '../message-formatting.js'
import { createLogger, LogPrefix } from '../logger.js'
import * as errore from 'errore'
import { getDefaultRuntimeAdapter } from '../session-handler/thread-session-runtime.js'
import { isTextChannel, isThreadChannel, getRootChannelId } from './channel-ref.js'

const logger = createLogger(LogPrefix.RESUME)

export async function handleResumeCommand({
  command,
}: CommandContext): Promise<void> {
  await command.deferReply({ ephemeral: false })

  const sessionId = command.options.getString('session', true)
  const channel = command.channel

  if (isThreadChannel(channel)) {
    await command.editReply(
      'This command can only be used in project channels, not threads',
    )
    return
  }

  if (!isTextChannel(channel)) {
    await command.editReply('This command can only be used in text channels')
    return
  }
  const textChannel = channel

  const channelConfig = await getChannelDirectory(textChannel.id)
  const projectDirectory = channelConfig?.directory

  if (!projectDirectory) {
    await command.editReply(
      'This channel is not configured with a project directory',
    )
    return
  }

  if (!fs.existsSync(projectDirectory)) {
    await command.editReply(`Directory does not exist: ${projectDirectory}`)
    return
  }

  try {
    const getClient = await initializeOpencodeForDirectory(projectDirectory)
    if (getClient instanceof Error) {
      await command.editReply(getClient.message)
      return
    }

    const sessionResponse = await getClient().session.get({
      sessionID: sessionId,
    })

    if (!sessionResponse.data) {
      await command.editReply('Session not found')
      return
    }

    const sessionTitle = sessionResponse.data.title

    const adapter = getDefaultRuntimeAdapter()
    if (!adapter) {
      throw new Error('No runtime adapter configured')
    }
    const channelTarget = {
      channelId: textChannel.id,
    }
    const starterMessage = await adapter.conversation(channelTarget).send({
      markdown: `**Resuming session:** ${sessionTitle}`,
      flags: SILENT_MESSAGE_FLAGS,
    })
    const { thread, target: threadTarget } = await adapter
      .conversation(channelTarget)
      .message(starterMessage.id)
      .then((messageHandle) => {
        return messageHandle.startThread({
          name: `Resume: ${sessionTitle}`.slice(0, 100),
          autoArchiveDuration: THREAD_AUTO_ARCHIVE_ONE_DAY,
          reason: `Resuming session ${sessionId}`,
        })
      })

    const threadHandle = await adapter.thread({
      threadId: threadTarget.threadId,
      parentId: thread.parentId,
    })
    if (!threadHandle) {
      throw new Error(`Thread not found: ${threadTarget.threadId}`)
    }
    await threadHandle.addMember(command.user.id)

    await setThreadSession(thread.id, sessionId)

    logger.log(`[RESUME] Created thread ${thread.id} for session ${sessionId}`)

    const messagesResponse = await getClient().session.messages({
      sessionID: sessionId,
    })

    if (!messagesResponse.data) {
      throw new Error('Failed to fetch session messages')
    }

    const messages = messagesResponse.data

    await command.editReply(
      `Resumed session "${sessionTitle}" in <#${thread.id}>`,
    )

    await adapter.conversation(threadTarget).send({
      markdown: `**Resumed session:** ${sessionTitle}\n**Created:** ${new Date(sessionResponse.data.time.created).toLocaleString()}\n\n*Loading ${messages.length} messages...*`,
    })

    try {
      const { partIds, content, skippedCount } = collectLastAssistantParts({
        messages,
      })

      if (skippedCount > 0) {
        await adapter.conversation(threadTarget).send({
          markdown: `*Skipped ${skippedCount} older assistant parts...*`,
        })
      }

      if (content.trim()) {
        const discordMessage = await adapter.conversation(threadTarget).send({
          markdown: content,
        })

        // Store part-message mappings atomically
        await setPartMessagesBatch(
          partIds.map((partId) => ({
            partId,
            messageId: discordMessage.id,
            threadId: thread.id,
          })),
        )
      }

      const messageCount = messages.length

      await adapter.conversation(threadTarget).send({
        markdown: `**Session resumed!** Loaded ${messageCount} messages.\n\nYou can now continue the conversation by sending messages in this thread.`,
      })
    } catch (sendError) {
      logger.error('[RESUME] Error sending messages to thread:', sendError)
      await adapter.conversation(threadTarget).send({
        markdown: `Failed to load message history, but session is connected. You can still send new messages.`,
      })
    }
  } catch (error) {
    logger.error('[RESUME] Error:', error)
    await command.editReply(
      `Failed to resume session: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}

export async function handleResumeAutocomplete({
  interaction,
}: AutocompleteContext): Promise<void> {
  const focused = interaction.options.getFocused()
  const focusedValue = typeof focused === 'string' ? focused : focused.value

  let projectDirectory: string | undefined

  if (interaction.channel) {
    const rootChannelId = getRootChannelId(interaction.channel)
    if (rootChannelId) {
      const channelConfig = await getChannelDirectory(rootChannelId)
      projectDirectory = channelConfig?.directory
    }
  }

  if (!projectDirectory) {
    await interaction.respond([])
    return
  }

  try {
    const getClient = await initializeOpencodeForDirectory(projectDirectory)
    if (getClient instanceof Error) {
      await interaction.respond([])
      return
    }

    const sessionsResponse = await getClient().session.list()
    if (!sessionsResponse.data) {
      await interaction.respond([])
      return
    }

    const existingSessionIds = new Set(await getAllThreadSessionIds())

    const sessions = sessionsResponse.data
      .filter((session) => !existingSessionIds.has(session.id))
      .filter((session) =>
        session.title.toLowerCase().includes(focusedValue.toLowerCase()),
      )
      .slice(0, 25)
      .map((session) => {
        const dateStr = new Date(session.time.updated).toLocaleString()
        const suffix = ` (${dateStr})`
        const maxTitleLength = 100 - suffix.length

        let title = session.title
        if (title.length > maxTitleLength) {
          title = title.slice(0, Math.max(0, maxTitleLength - 1)) + '…'
        }

        return {
          name: `${title}${suffix}`,
          value: session.id,
        }
      })

    await interaction.respond(sessions)
  } catch (error) {
    logger.error('[AUTOCOMPLETE] Error fetching sessions:', error)
    await interaction.respond([])
  }
}
