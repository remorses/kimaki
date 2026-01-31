// Undo/Redo commands - /undo, /redo

import { ChannelType, type ThreadChannel } from 'discord.js'
import type { CommandContext } from './types.js'
import { getThreadSession } from '../database.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import { resolveTextChannel, getKimakiMetadata, SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import * as errore from 'errore'

const logger = createLogger(LogPrefix.UNDO_REDO)

export async function handleUndoCommand({ command }: CommandContext): Promise<void> {
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

  const textChannel = await resolveTextChannel(channel as ThreadChannel)
  const { projectDirectory: directory } = await getKimakiMetadata(textChannel)

  if (!directory) {
    await command.reply({
      content: 'Could not determine project directory for this channel',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const sessionId = await getThreadSession(channel.id)

  if (!sessionId) {
    await command.reply({
      content: 'No active session in this thread',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  await command.deferReply({ flags: SILENT_MESSAGE_FLAGS })

  const getClient = await initializeOpencodeForDirectory(directory)
  if (getClient instanceof Error) {
    await command.editReply(`Failed to undo: ${getClient.message}`)
    return
  }

  try {
    // Fetch messages to find the last assistant message
    const messagesResponse = await getClient().session.messages({
      path: { id: sessionId },
    })

    if (!messagesResponse.data || messagesResponse.data.length === 0) {
      await command.editReply('No messages to undo')
      return
    }

    // Find the last assistant message
    const lastAssistantMessage = [...messagesResponse.data]
      .reverse()
      .find((m) => m.info.role === 'assistant')

    if (!lastAssistantMessage) {
      await command.editReply('No assistant message to undo')
      return
    }

    const response = await getClient().session.revert({
      path: { id: sessionId },
      body: { messageID: lastAssistantMessage.info.id },
    })

    if (response.error) {
      await command.editReply(`Failed to undo: ${JSON.stringify(response.error)}`)
      return
    }

    const diffInfo = response.data?.revert?.diff
      ? `\n\`\`\`diff\n${response.data.revert.diff.slice(0, 1500)}\n\`\`\``
      : ''

    await command.editReply(`⏪ **Undone** - reverted last assistant message${diffInfo}`)
    logger.log(`Session ${sessionId} reverted message ${lastAssistantMessage.info.id}`)
  } catch (error) {
    logger.error('[UNDO] Error:', error)
    await command.editReply(
      `Failed to undo: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}

export async function handleRedoCommand({ command }: CommandContext): Promise<void> {
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

  const textChannel = await resolveTextChannel(channel as ThreadChannel)
  const { projectDirectory: directory } = await getKimakiMetadata(textChannel)

  if (!directory) {
    await command.reply({
      content: 'Could not determine project directory for this channel',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const sessionId = await getThreadSession(channel.id)

  if (!sessionId) {
    await command.reply({
      content: 'No active session in this thread',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  await command.deferReply({ flags: SILENT_MESSAGE_FLAGS })

  const getClient = await initializeOpencodeForDirectory(directory)
  if (getClient instanceof Error) {
    await command.editReply(`Failed to redo: ${getClient.message}`)
    return
  }

  try {
    // Check if session has reverted state
    const sessionResponse = await getClient().session.get({
      path: { id: sessionId },
    })

    if (!sessionResponse.data?.revert) {
      await command.editReply('Nothing to redo - no previous undo found')
      return
    }

    const response = await getClient().session.unrevert({
      path: { id: sessionId },
    })

    if (response.error) {
      await command.editReply(`Failed to redo: ${JSON.stringify(response.error)}`)
      return
    }

    await command.editReply(`⏩ **Restored** - session back to previous state`)
    logger.log(`Session ${sessionId} unrevert completed`)
  } catch (error) {
    logger.error('[REDO] Error:', error)
    await command.editReply(
      `Failed to redo: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}
