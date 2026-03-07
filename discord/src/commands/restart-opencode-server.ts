// /restart-opencode-server command - Restart the single shared opencode server.
// Used for resolving opencode state issues, internal bugs, refreshing auth state, plugins, etc.
// Aborts in-progress sessions in this channel before restarting. Note: since there is one
// shared server, this restart affects all projects. Sessions in other channels will reconnect
// automatically via the event listener's backoff loop.

import {
  ChannelType,
  MessageFlags,
  type ThreadChannel,
  type TextChannel,
} from 'discord.js'
import type { CommandContext } from './types.js'
import { restartOpencodeServer } from '../opencode.js'
import {
  resolveWorkingDirectory,
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import { disposeRuntimesForDirectory } from '../session-handler/thread-session-runtime.js'

const logger = createLogger(LogPrefix.OPENCODE)

export async function handleRestartOpencodeServerCommand({
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

  const isTextChannel = channel.type === ChannelType.GuildText

  if (!isThread && !isTextChannel) {
    await command.reply({
      content: 'This command can only be used in text channels or threads',
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

  // Defer reply since restart may take a moment
  await command.deferReply({ flags: SILENT_MESSAGE_FLAGS })

  // Dispose all runtimes for this directory/channel scope.
  // disposeRuntimesForDirectory aborts active runs, kills listeners, and
  // removes runtimes from the registry. Scoped by channelId so runtimes
  // in other channels sharing the same project directory are not affected.
  const parentChannelId = isThread
    ? (channel as ThreadChannel).parentId
    : channel.id
  const abortedCount = disposeRuntimesForDirectory({
    directory: projectDirectory,
    channelId: parentChannelId || undefined,
  })

  logger.log(`[RESTART] Restarting shared opencode server`)

  const result = await restartOpencodeServer()

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
  logger.log('[RESTART] Shared opencode server restarted')
}
