// /abort command - Abort the current OpenCode request in this thread.

import { ChannelType, type ThreadChannel } from 'discord.js'
import type { CommandContext } from './types.js'
import { getDatabase } from '../database.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import { resolveTextChannel, getKimakiMetadata, SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { abortControllers } from '../session-handler.js'
import { createLogger } from '../logger.js'
import * as errore from 'errore'

const logger = createLogger('ABORT')

export async function handleAbortCommand({ command }: CommandContext): Promise<void> {
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
  const { projectDirectory: directory } = getKimakiMetadata(textChannel)

  if (!directory) {
    await command.reply({
      content: 'Could not determine project directory for this channel',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const row = getDatabase()
    .prepare('SELECT session_id FROM thread_sessions WHERE thread_id = ?')
    .get(channel.id) as { session_id: string } | undefined

  if (!row?.session_id) {
    await command.reply({
      content: 'No active session in this thread',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const sessionId = row.session_id

  const existingController = abortControllers.get(sessionId)
  if (existingController) {
    existingController.abort(new Error('User requested abort'))
    abortControllers.delete(sessionId)
  }

  const getClient = await initializeOpencodeForDirectory(directory)
  if (errore.isError(getClient)) {
    await command.reply({
      content: `Failed to abort: ${getClient.message}`,
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  try {
    await getClient().session.abort({
      path: { id: sessionId },
    })

    await command.reply({
      content: `🛑 Request **aborted**`,
      flags: SILENT_MESSAGE_FLAGS,
    })
    logger.log(`Session ${sessionId} aborted by user`)
  } catch (error) {
    logger.error('[ABORT] Error:', error)
    await command.reply({
      content: `Failed to abort: ${error instanceof Error ? error.message : 'Unknown error'}`,
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
  }
}
