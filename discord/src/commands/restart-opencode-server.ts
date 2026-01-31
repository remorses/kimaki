// /restart-opencode-server command - Restart the opencode server for the current channel.
// Used for resolving opencode state issues, internal bugs, refreshing auth state, plugins, etc.

import { ChannelType, type ThreadChannel, type TextChannel } from 'discord.js'
import type { CommandContext } from './types.js'
import { restartOpencodeServer } from '../opencode.js'
import { resolveTextChannel, getKimakiMetadata, SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'

const logger = createLogger(LogPrefix.OPENCODE)

export async function handleRestartOpencodeServerCommand({ command, appId }: CommandContext): Promise<void> {
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

  let projectDirectory: string | undefined
  let channelAppId: string | undefined

  if (isThread) {
    const thread = channel as ThreadChannel
    const textChannel = await resolveTextChannel(thread)
    const metadata = await getKimakiMetadata(textChannel)
    projectDirectory = metadata.projectDirectory
    channelAppId = metadata.channelAppId
  } else if (channel.type === ChannelType.GuildText) {
    const textChannel = channel as TextChannel
    const metadata = await getKimakiMetadata(textChannel)
    projectDirectory = metadata.projectDirectory
    channelAppId = metadata.channelAppId
  } else {
    await command.reply({
      content: 'This command can only be used in text channels or threads',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  if (channelAppId && channelAppId !== appId) {
    await command.reply({
      content: 'This channel is not configured for this bot',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  if (!projectDirectory) {
    await command.reply({
      content: 'Could not determine project directory for this channel',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  // Defer reply since restart may take a moment
  await command.deferReply({ flags: SILENT_MESSAGE_FLAGS })

  logger.log(`[RESTART] Restarting opencode server for directory: ${projectDirectory}`)

  const result = await restartOpencodeServer(projectDirectory)

  if (result instanceof Error) {
    logger.error('[RESTART] Failed:', result)
    await command.editReply({
      content: `Failed to restart opencode server: ${result.message}`,
    })
    return
  }

  await command.editReply({
    content: `🔄 Opencode server **restarted** successfully`,
  })
  logger.log(`[RESTART] Opencode server restarted for directory: ${projectDirectory}`)
}
