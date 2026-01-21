// /share command - Share the current session as a public URL.

import { ChannelType, type ThreadChannel } from 'discord.js'
import type { CommandContext } from './types.js'
import { getDatabase } from '../database.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import { resolveTextChannel, getKimakiMetadata, SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { createLogger } from '../logger.js'
import * as errore from 'errore'

const logger = createLogger('SHARE')

export async function handleShareCommand({ command }: CommandContext): Promise<void> {
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

  const getClient = await initializeOpencodeForDirectory(directory)
  if (errore.isError(getClient)) {
    await command.reply({
      content: `Failed to share session: ${getClient.message}`,
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  try {
    const response = await getClient().session.share({
      path: { id: sessionId },
    })

    if (!response.data?.share?.url) {
      await command.reply({
        content: 'Failed to generate share URL',
        ephemeral: true,
        flags: SILENT_MESSAGE_FLAGS,
      })
      return
    }

    await command.reply({
      content: `🔗 **Session shared:** ${response.data.share.url}`,
      flags: SILENT_MESSAGE_FLAGS,
    })
    logger.log(`Session ${sessionId} shared: ${response.data.share.url}`)
  } catch (error) {
    logger.error('[SHARE] Error:', error)
    await command.reply({
      content: `Failed to share session: ${error instanceof Error ? error.message : 'Unknown error'}`,
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
  }
}
