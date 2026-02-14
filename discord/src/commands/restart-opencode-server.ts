// /restart-opencode-server command - Restart the opencode server for the current channel.
// Used for resolving opencode state issues, internal bugs, refreshing auth state, plugins, etc.
// Aborts all in-progress sessions in this channel before restarting to avoid orphaned requests.

import { ChannelType, type ThreadChannel, type TextChannel } from 'discord.js'
import type { CommandContext } from './types.js'
import { initializeOpencodeForDirectory, restartOpencodeServer } from '../opencode.js'
import { resolveWorkingDirectory, SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import { getAllThreadSessionIds, getThreadIdBySessionId } from '../database.js'
import { abortControllers } from '../session-handler.js'
import * as errore from 'errore'

const logger = createLogger(LogPrefix.OPENCODE)

export async function handleRestartOpencodeServerCommand({
  command,
  appId,
}: CommandContext): Promise<void> {
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

  const isTextChannel = channel.type === ChannelType.GuildText

  if (!isThread && !isTextChannel) {
    await command.reply({
      content: 'This command can only be used in text channels or threads',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const resolved = await resolveWorkingDirectory({
    channel: channel as TextChannel | ThreadChannel,
  })

  if (!resolved) {
    await command.reply({
      content: 'Could not determine project directory for this channel',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const { projectDirectory, channelAppId } = resolved

  if (channelAppId && channelAppId !== appId) {
    await command.reply({
      content: 'This channel is not configured for this bot',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  // Defer reply since restart may take a moment
  await command.deferReply({ flags: SILENT_MESSAGE_FLAGS })

  // Abort all in-progress sessions in this channel before restarting.
  // Find sessions with active abort controllers, check if their thread belongs
  // to this channel (thread parentId matches, or command was run in the thread itself).
  const parentChannelId = isThread ? (channel as ThreadChannel).parentId : channel.id
  const activeSessionIds = [...abortControllers.keys()]
  let abortedCount = 0

  if (activeSessionIds.length > 0) {
    const getClient = await initializeOpencodeForDirectory(projectDirectory)
    const client = !(getClient instanceof Error) ? getClient : null

    for (const sessionId of activeSessionIds) {
      const threadId = await getThreadIdBySessionId(sessionId)
      if (!threadId) {
        continue
      }
      // Check if thread belongs to this channel: either the thread IS this channel,
      // or the thread's parent matches the parent channel
      const threadChannel = await errore.tryAsync(() => {
        return command.client.channels.fetch(threadId)
      })
      if (threadChannel instanceof Error || !threadChannel) {
        continue
      }
      const threadParentId = 'parentId' in threadChannel ? threadChannel.parentId : null
      if (threadId !== channel.id && threadParentId !== parentChannelId) {
        continue
      }

      const controller = abortControllers.get(sessionId)
      if (controller) {
        logger.log(`[RESTART] Aborting session ${sessionId} in thread ${threadId}`)
        controller.abort(new Error('Server restart requested'))
        abortControllers.delete(sessionId)
        abortedCount++
      }
      if (client) {
        await errore.tryAsync(() => {
          return client().session.abort({ path: { id: sessionId } })
        })
      }
    }
  }

  if (abortedCount > 0) {
    logger.log(`[RESTART] Aborted ${abortedCount} active session(s) before restart`)
  }

  logger.log(`[RESTART] Restarting opencode server for directory: ${projectDirectory}`)

  const result = await restartOpencodeServer(projectDirectory)

  if (result instanceof Error) {
    logger.error('[RESTART] Failed:', result)
    await command.editReply({
      content: `Failed to restart opencode server: ${result.message}`,
    })
    return
  }

  const abortMsg =
    abortedCount > 0
      ? ` (aborted ${abortedCount} active session${abortedCount > 1 ? 's' : ''})`
      : ''
  await command.editReply({
    content: `Opencode server **restarted** successfully${abortMsg}`,
  })
  logger.log(`[RESTART] Opencode server restarted for directory: ${projectDirectory}`)
}
