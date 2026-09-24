// /abort command - Abort the current OpenCode request in this thread.

import {
  ChannelType,
  MessageFlags,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import type { CommandContext } from './types.js'
import {
  cancelSessionSleepForThread,
  deleteThreadQueueItems,
  getThreadSession,
} from '../database.js'
import { getOpencodeClient, initializeOpencodeForDirectory } from '../opencode.js'
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

  await command.deferReply()

  const resolved = await resolveWorkingDirectory({
    channel: channel as TextChannel | ThreadChannel,
  })

  if (!resolved) {
    await command.editReply('Could not determine project directory for this channel')
    return
  }

  const { projectDirectory, workingDirectory } = resolved

  const sessionId = await getThreadSession(channel.id)

  if (!sessionId) {
    await command.editReply('No active session in this thread')
    return
  }

  // Aborting is an explicit "stop waiting" from the user, and it never goes
  // through enqueueIncoming, so cancel any pending sleep here too. Otherwise the
  // wake would still fire later and restart a session the user just stopped.
  await cancelSessionSleepForThread({ threadId: channel.id })

  // abortActiveRun delegates to session.abort() and clears the /queue, so
  // queued messages are not sent after abort or restored after a restart.
  const runtime = getRuntime(channel.id)
  let clearedCount = 0
  if (runtime) {
    const cleared = await runtime.abortActiveRun('user-requested')
    clearedCount = cleared.length
  } else {
    const deleteResult = await deleteThreadQueueItems(channel.id).catch((error) => {
      return new Error('Failed to clear persisted queue', { cause: error })
    })
    if (deleteResult instanceof Error) {
      logger.error(`[ABORT] ${deleteResult.message}:`, deleteResult.cause)
    }
    // No runtime but session exists — fall back to direct API abort
    const serverResult = await initializeOpencodeForDirectory(projectDirectory)
    if (serverResult instanceof Error) {
      await command.editReply(`Failed to abort: ${serverResult.message}`)
      return
    }
    try {
      const client = getOpencodeClient(workingDirectory)
      if (client) {
        await client.session.abort({ sessionID: sessionId, directory: workingDirectory })
      }
    } catch (error) {
      logger.error('[ABORT] API abort failed:', error)
    }
  }

  const queueNote = clearedCount > 0
    ? `, cleared ${clearedCount} queued message${clearedCount > 1 ? 's' : ''}`
    : ''
  await command.editReply(`Request **aborted**${queueNote}`)
  logger.log(`Session ${sessionId} aborted by user`)
}
