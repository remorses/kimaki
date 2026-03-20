// Undo/Redo commands - /undo, /redo

import {
  ChannelType,
  MessageFlags,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import type { CommandContext } from './types.js'
import { getThreadSession } from '../database.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import {
  resolveWorkingDirectory,
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'

const logger = createLogger(LogPrefix.UNDO_REDO)

export async function handleUndoCommand({
  command,
}: CommandContext): Promise<void> {
  const channel = command.channel

  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
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
      content:
        'This command can only be used in a thread with an active session',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const resolved = await resolveWorkingDirectory({
    channel: channel as TextChannel | ThreadChannel,
  })

  if (!resolved) {
    await command.reply({
      content: 'Could not determine project directory for this channel',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const { projectDirectory } = resolved

  const sessionId = await getThreadSession(channel.id)

  if (!sessionId) {
    await command.reply({
      content: 'No active session in this thread',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  await command.deferReply({ flags: SILENT_MESSAGE_FLAGS })

  const getClient = await initializeOpencodeForDirectory(projectDirectory)
  if (getClient instanceof Error) {
    await command.editReply(`Failed to undo: ${getClient.message}`)
    return
  }

  try {
    const client = getClient()

    // Fetch session to check existing revert state
    const sessionResponse = await client.session.get({
      sessionID: sessionId,
    })

    const messagesResponse = await client.session.messages({
      sessionID: sessionId,
    })

    if (!messagesResponse.data || messagesResponse.data.length === 0) {
      await command.editReply('No messages to undo')
      return
    }

    // Follow the same approach as the OpenCode TUI (use-session-commands.tsx):
    // find the last user message that is before the current revert point
    // (or the last user message if no revert is active). This matches the
    // TUI's `findLast(userMessages(), (x) => !revert || x.id < revert)`.
    const currentRevert = sessionResponse.data?.revert?.messageID
    const userMessages = messagesResponse.data.filter((m) => {
      return m.info.role === 'user'
    })
    const targetUserMessage = [...userMessages].reverse().find((m) => {
      return !currentRevert || m.info.id < currentRevert
    })

    if (!targetUserMessage) {
      await command.editReply('No messages to undo')
      return
    }

    // session.revert() reverts filesystem patches (file edits, writes) and
    // marks the session with revert.messageID. Messages are NOT deleted — they
    // get cleaned up automatically on the next promptAsync() call via
    // SessionRevert.cleanup(). The model only sees messages before the revert
    // point when processing the next prompt.
    const response = await client.session.revert({
      sessionID: sessionId,
      messageID: targetUserMessage.info.id,
    })

    if (response.error) {
      await command.editReply(
        `Failed to undo: ${JSON.stringify(response.error)}`,
      )
      return
    }

    const diffInfo = response.data?.revert?.diff
      ? `\n\`\`\`diff\n${response.data.revert.diff.slice(0, 1500)}\n\`\`\``
      : ''

    await command.editReply(`Undone - reverted last assistant message${diffInfo}`)
    logger.log(
      `Session ${sessionId} reverted to before user message ${targetUserMessage.info.id}`,
    )
  } catch (error) {
    logger.error('[UNDO] Error:', error)
    await command.editReply(
      `Failed to undo: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}

export async function handleRedoCommand({
  command,
}: CommandContext): Promise<void> {
  const channel = command.channel

  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
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
      content:
        'This command can only be used in a thread with an active session',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const resolved = await resolveWorkingDirectory({
    channel: channel as TextChannel | ThreadChannel,
  })

  if (!resolved) {
    await command.reply({
      content: 'Could not determine project directory for this channel',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const { projectDirectory } = resolved

  const sessionId = await getThreadSession(channel.id)

  if (!sessionId) {
    await command.reply({
      content: 'No active session in this thread',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  await command.deferReply({ flags: SILENT_MESSAGE_FLAGS })

  const getClient = await initializeOpencodeForDirectory(projectDirectory)
  if (getClient instanceof Error) {
    await command.editReply(`Failed to redo: ${getClient.message}`)
    return
  }

  try {
    const client = getClient()

    // Fetch session to check existing revert state
    const sessionResponse = await client.session.get({
      sessionID: sessionId,
    })

    const revertMessageID = sessionResponse.data?.revert?.messageID
    if (!revertMessageID) {
      await command.editReply('Nothing to redo - no previous undo found')
      return
    }

    // Follow the same approach as the OpenCode TUI (use-session-commands.tsx):
    // find the next user message after the current revert point. If one exists,
    // move the revert cursor forward to it (one step redo). If none exists,
    // fully unrevert — we're at the end of the message history.
    const messagesResponse = await client.session.messages({
      sessionID: sessionId,
    })
    const userMessages = (messagesResponse.data ?? []).filter((m) => {
      return m.info.role === 'user'
    })
    const nextMessage = userMessages.find((m) => {
      return m.info.id > revertMessageID
    })

    if (!nextMessage) {
      // No more messages after revert point — fully unrevert
      const response = await client.session.unrevert({
        sessionID: sessionId,
      })
      if (response.error) {
        await command.editReply(
          `Failed to redo: ${JSON.stringify(response.error)}`,
        )
        return
      }
      await command.editReply('Restored - session fully back to previous state')
      logger.log(`Session ${sessionId} unrevert completed`)
      return
    }

    // Move revert cursor forward one step to the next user message
    const response = await client.session.revert({
      sessionID: sessionId,
      messageID: nextMessage.info.id,
    })

    if (response.error) {
      await command.editReply(
        `Failed to redo: ${JSON.stringify(response.error)}`,
      )
      return
    }

    await command.editReply('Restored one step forward')
    logger.log(`Session ${sessionId} redo: moved revert to ${nextMessage.info.id}`)
  } catch (error) {
    logger.error('[REDO] Error:', error)
    await command.editReply(
      `Failed to redo: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}
