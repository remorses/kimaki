// Queue commands - /queue, /clear-queue

import { ChannelType, type ThreadChannel } from 'discord.js'
import type { CommandContext } from './types.js'
import { getThreadSession } from '../database.js'
import {
  resolveTextChannel,
  getKimakiMetadata,
  sendThreadMessage,
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import {
  handleOpencodeSession,
  abortControllers,
  addToQueue,
  getQueueLength,
  clearQueue,
} from '../session-handler.js'
import { createLogger, LogPrefix } from '../logger.js'

const logger = createLogger(LogPrefix.QUEUE)

export async function handleQueueCommand({ command, appId }: CommandContext): Promise<void> {
  const message = command.options.getString('message', true)
  const channel = command.channel

  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const isThread = [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel.type)

  if (!isThread) {
    await command.reply({
      content: 'This command can only be used in a thread with an active session',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const sessionId = await getThreadSession(channel.id)

  if (!sessionId) {
    await command.reply({
      content: 'No active session in this thread. Send a message directly instead.',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  // Check if there's an active request running
  const existingController = abortControllers.get(sessionId)
  const hasActiveRequest = Boolean(existingController && !existingController.signal.aborted)
  if (existingController && existingController.signal.aborted) {
    abortControllers.delete(sessionId)
  }

  if (!hasActiveRequest) {
    // No active request, send immediately
    const textChannel = await resolveTextChannel(channel as ThreadChannel)
    const { projectDirectory } = await getKimakiMetadata(textChannel)

    if (!projectDirectory) {
      await command.reply({
        content: 'Could not determine project directory',
        ephemeral: true,
        flags: SILENT_MESSAGE_FLAGS,
      })
      return
    }

    await command.reply({
      content: `» **${command.user.displayName}:** ${message.slice(0, 100)}${message.length > 100 ? '...' : ''}`,
      flags: SILENT_MESSAGE_FLAGS,
    })

    logger.log(`[QUEUE] No active request, sending immediately in thread ${channel.id}`)

    handleOpencodeSession({
      prompt: message,
      thread: channel as ThreadChannel,
      projectDirectory,
      channelId: textChannel?.id || channel.id,
      appId,
    }).catch(async (e) => {
      logger.error(`[QUEUE] Failed to send message:`, e)
      const errorMsg = e instanceof Error ? e.message : String(e)
      await sendThreadMessage(channel as ThreadChannel, `✗ Failed: ${errorMsg.slice(0, 200)}`)
    })

    return
  }

  // Add to queue
  const queuePosition = addToQueue({
    threadId: channel.id,
    message: {
      prompt: message,
      userId: command.user.id,
      username: command.user.displayName,
      queuedAt: Date.now(),
      appId,
    },
  })

  await command.reply({
    content: `✅ Message queued (position: ${queuePosition}). Will be sent after current response.`,
    ephemeral: true,
    flags: SILENT_MESSAGE_FLAGS,
  })

  logger.log(`[QUEUE] User ${command.user.displayName} queued message in thread ${channel.id}`)
}

export async function handleClearQueueCommand({ command }: CommandContext): Promise<void> {
  const channel = command.channel

  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const isThread = [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel.type)

  if (!isThread) {
    await command.reply({
      content: 'This command can only be used in a thread',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const queueLength = getQueueLength(channel.id)

  if (queueLength === 0) {
    await command.reply({
      content: 'No messages in queue',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  clearQueue(channel.id)

  await command.reply({
    content: `🗑 Cleared ${queueLength} queued message${queueLength > 1 ? 's' : ''}`,
    flags: SILENT_MESSAGE_FLAGS,
  })

  logger.log(`[QUEUE] User ${command.user.displayName} cleared queue in thread ${channel.id}`)
}
