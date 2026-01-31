// /verbosity command.
// Sets the output verbosity level for sessions in a channel.
// 'tools-and-text' (default): shows all output including tool executions
// 'text-only': only shows text responses (⬥ diamond parts)

import { ChatInputCommandInteraction, ChannelType, type TextChannel, type ThreadChannel } from 'discord.js'
import { getChannelVerbosity, setChannelVerbosity, type VerbosityLevel } from '../database.js'
import { createLogger, LogPrefix } from '../logger.js'

const verbosityLogger = createLogger(LogPrefix.VERBOSITY)

/**
 * Handle the /verbosity slash command.
 * Sets output verbosity for the channel (applies immediately, even mid-session).
 */
export async function handleVerbosityCommand({
  command,
  appId,
}: {
  command: ChatInputCommandInteraction
  appId: string
}): Promise<void> {
  verbosityLogger.log('[VERBOSITY] Command called')

  const channel = command.channel
  if (!channel) {
    await command.reply({
      content: 'Could not determine channel.',
      ephemeral: true,
    })
    return
  }

  // Get the parent channel ID (for threads, use parent; for text channels, use self)
  const channelId = (() => {
    if (channel.type === ChannelType.GuildText) {
      return channel.id
    }
    if (
      channel.type === ChannelType.PublicThread ||
      channel.type === ChannelType.PrivateThread ||
      channel.type === ChannelType.AnnouncementThread
    ) {
      return (channel as ThreadChannel).parentId || channel.id
    }
    return channel.id
  })()

  const level = command.options.getString('level', true) as VerbosityLevel
  const currentLevel = await getChannelVerbosity(channelId)

  if (currentLevel === level) {
    await command.reply({
      content: `Verbosity is already set to **${level}** for this channel.`,
      ephemeral: true,
    })
    return
  }

  await setChannelVerbosity(channelId, level)
  verbosityLogger.log(`[VERBOSITY] Set channel ${channelId} to ${level}`)

  const description = (() => {
    if (level === 'text-only') {
      return 'Only text responses will be shown. Tool executions, status messages, and thinking will be hidden.'
    }
    if (level === 'text-and-essential-tools') {
      return 'Text responses and essential tools (edits, custom MCP tools) will be shown. Read, search, and navigation tools will be hidden.'
    }
    return 'All output will be shown, including tool executions and status messages.'
  })()

  await command.reply({
    content: `Verbosity set to **${level}** for this channel.\n${description}\nThis is a per-channel setting and applies immediately, including any active sessions.`,
    ephemeral: true,
  })
}
