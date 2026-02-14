// /compact command - Trigger context compaction (summarization) for the current session.

import { ChannelType, type TextChannel, type ThreadChannel } from 'discord.js'
import type { CommandContext } from './types.js'
import { getThreadSession } from '../database.js'
import { initializeOpencodeForDirectory, getOpencodeClientV2 } from '../opencode.js'
import { resolveWorkingDirectory, SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'

const logger = createLogger(LogPrefix.COMPACT)

export async function handleCompactCommand({ command }: CommandContext): Promise<void> {
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

  const resolved = await resolveWorkingDirectory({ channel: channel as TextChannel | ThreadChannel })

  if (!resolved) {
    await command.reply({
      content: 'Could not determine project directory for this channel',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const { projectDirectory, workingDirectory } = resolved

  const sessionId = await getThreadSession(channel.id)

  if (!sessionId) {
    await command.reply({
      content: 'No active session in this thread',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  // Ensure server is running for the base project directory
  const getClient = await initializeOpencodeForDirectory(projectDirectory)
  if (getClient instanceof Error) {
    await command.reply({
      content: `Failed to compact: ${getClient.message}`,
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const clientV2 = getOpencodeClientV2(projectDirectory)
  if (!clientV2) {
    await command.reply({
      content: 'Failed to get OpenCode client',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  // Defer reply since compaction may take a moment
  await command.deferReply({ flags: SILENT_MESSAGE_FLAGS })

  try {
    // Get session messages to find the model from the last user message
    const messagesResult = await clientV2.session.messages({
      sessionID: sessionId,
      directory: workingDirectory,
    })

    if (messagesResult.error || !messagesResult.data) {
      logger.error('[COMPACT] Failed to get messages:', messagesResult.error)
      await command.editReply({
        content: 'Failed to compact: Could not retrieve session messages',
      })
      return
    }

    // Find the last user message to get the model
    const lastUserMessage = [...messagesResult.data]
      .reverse()
      .find((msg) => msg.info.role === 'user')

    if (!lastUserMessage || lastUserMessage.info.role !== 'user') {
      await command.editReply({
        content: 'Failed to compact: No user message found in session',
      })
      return
    }

    const { providerID, modelID } = lastUserMessage.info.model

    const result = await clientV2.session.summarize({
      sessionID: sessionId,
      directory: workingDirectory,
      providerID,
      modelID,
      auto: false,
    })

    if (result.error) {
      logger.error('[COMPACT] Error:', result.error)
      const errorMessage = 'data' in result.error && result.error.data
        ? (result.error.data as { message?: string }).message || 'Unknown error'
        : 'Unknown error'
      await command.editReply({
        content: `Failed to compact: ${errorMessage}`,
      })
      return
    }

    await command.editReply({
      content: `📦 Session **compacted** successfully`,
    })
    logger.log(`Session ${sessionId} compacted by user`)
  } catch (error) {
    logger.error('[COMPACT] Error:', error)
    await command.editReply({
      content: `Failed to compact: ${error instanceof Error ? error.message : 'Unknown error'}`,
    })
  }
}
