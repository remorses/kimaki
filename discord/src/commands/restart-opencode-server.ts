// /restart-opencode-server command - Restart the single shared opencode server
// and re-register Discord slash commands.
// Used for resolving opencode state issues, internal bugs, refreshing auth state,
// plugins, and picking up new/changed slash commands or agents. Aborts in-progress
// sessions in this channel before restarting. Note: since there is one shared server,
// this restart affects all projects. Other runtimes reconnect through their listener
// backoff loop once the shared server comes back.

import {
  ChannelType,
  MessageFlags,
  type ThreadChannel,
  type TextChannel,
} from 'discord.js'
import type { Command as OpencodeCommand } from '@opencode-ai/sdk/v2'
import type { CommandContext } from './types.js'
import { initializeOpencodeForDirectory, restartOpencodeServer } from '../opencode.js'
import {
  resolveWorkingDirectory,
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import { disposeRuntimesForDirectory } from '../session-handler/thread-session-runtime.js'
import { registerCommands, type AgentInfo } from '../discord-command-registration.js'

const logger = createLogger(LogPrefix.OPENCODE)

export async function handleRestartOpencodeServerCommand({
  command,
  appId,
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
    content: `Opencode server **restarted** successfully${abortMsg}. Re-registering slash commands...`,
  })
  logger.log('[RESTART] Shared opencode server restarted')

  // Re-register Discord slash commands after restart so new/changed
  // commands, agents, and plugins are picked up immediately.
  const token = command.client.token
  if (!token) {
    logger.error('[RESTART] No bot token available, skipping command registration')
    await command.editReply({
      content: `Opencode server **restarted**${abortMsg}, but slash command re-registration skipped (no bot token)`,
    })
    return
  }
  const guildIds = [...command.client.guilds.cache.keys()]

  const opencodeResult = await initializeOpencodeForDirectory(projectDirectory)
  const [userCommands, agents]: [OpencodeCommand[], AgentInfo[]] =
    await (async (): Promise<[OpencodeCommand[], AgentInfo[]]> => {
      if (opencodeResult instanceof Error) {
        logger.warn('[RESTART] OpenCode init failed, registering without user commands:', opencodeResult.message)
        return [[], []]
      }
      const getClient = opencodeResult
      const [cmds, ags] = await Promise.all([
        getClient()
          .command.list({ directory: projectDirectory })
          .then((r) => r.data || [])
          .catch((e) => {
            logger.warn('[RESTART] Failed to load user commands:', e instanceof Error ? e.stack : String(e))
            return [] as OpencodeCommand[]
          }),
        getClient()
          .app.agents({ directory: projectDirectory })
          .then((r) => r.data || [])
          .catch((e) => {
            logger.warn('[RESTART] Failed to load agents:', e instanceof Error ? e.stack : String(e))
            return [] as AgentInfo[]
          }),
      ])
      return [cmds, ags]
    })()

  const registerResult = await registerCommands({ token, appId, guildIds, userCommands, agents })
    .then(() => null)
    .catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
  if (registerResult instanceof Error) {
    logger.error('[RESTART] Failed to re-register commands:', registerResult.message)
    await command.editReply({
      content: `Opencode server **restarted**${abortMsg}, but slash command re-registration failed: ${registerResult.message}`,
    })
    return
  }

  logger.log('[RESTART] Slash commands re-registered')
  await command.editReply({
    content: `Opencode server **restarted** and slash commands **re-registered**${abortMsg}`,
  })
}
