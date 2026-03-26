// /abort command - Abort the current OpenCode request in this thread.

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
import { getRuntime } from '../session-handler/thread-session-runtime.js'
import { createLogger, LogPrefix } from '../logger.js'

const logger = createLogger(LogPrefix.ABORT)

export async function handleAbortCommand({
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

  await command.deferReply({ flags: SILENT_MESSAGE_FLAGS })

  const resolved = await resolveWorkingDirectory({
    channel: channel as TextChannel | ThreadChannel,
  })

  if (!resolved) {
    await command.editReply('Could not determine project directory for this channel')
    return
  }

  const { projectDirectory } = resolved

  const sessionId = await getThreadSession(channel.id)

  if (!sessionId) {
    await command.editReply('No active session in this thread')
    return
  }

  // abortActiveRun delegates to session.abort(), run settlement stays event-driven.
  const runtime = getRuntime(channel.id)
  if (runtime) {
    runtime.abortActiveRun('user-requested')
  } else {
    // No runtime but session exists — fall back to direct API abort
    const getClient = await initializeOpencodeForDirectory(projectDirectory)
    if (getClient instanceof Error) {
      await command.editReply(`Failed to abort: ${getClient.message}`)
      return
    }
    try {
      await getClient().session.abort({ sessionID: sessionId })
    } catch (error) {
      logger.error('[ABORT] API abort failed:', error)
    }
  }

  await command.editReply('Request **aborted**')
  logger.log(`Session ${sessionId} aborted by user`)
}
