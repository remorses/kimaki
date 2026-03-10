// /restart-opencode-server command - Restart the single shared opencode server.
// Used for resolving opencode state issues, internal bugs, refreshing auth state, plugins, etc.
// Aborts in-progress sessions in this channel before restarting. Note: since there is one
// shared server, this restart affects all projects. Other runtimes reconnect through their
// listener backoff loop once the shared server comes back.


import type { CommandContext } from './types.js'
import { PLATFORM_MESSAGE_FLAGS } from '../platform/message-flags.js'
import { restartOpencodeServer } from '../opencode.js'
import {
  resolveWorkingDirectory,
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import { disposeRuntimesForDirectory } from '../session-handler/thread-session-runtime.js'
import { getRootChannelId, isTextChannel, isThreadChannel } from './channel-ref.js'

const logger = createLogger(LogPrefix.OPENCODE)

export async function handleRestartOpencodeServerCommand({
  command,
}: CommandContext): Promise<void> {
  const channel = command.channel

  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const isThread = isThreadChannel(channel)

  if (!isThread && !isTextChannel(channel)) {
    await command.reply({
      content: 'This command can only be used in text channels or threads',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const resolved = await resolveWorkingDirectory({ channel })

  if (!resolved) {
    await command.reply({
      content: 'Could not determine project directory for this channel',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL | SILENT_MESSAGE_FLAGS,
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
  const parentChannelId = getRootChannelId(channel)
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
