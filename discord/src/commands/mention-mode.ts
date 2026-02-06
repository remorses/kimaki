// /toggle-mention-mode command.
// Toggles mention-only mode for a channel.
// When enabled, bot only responds to messages that @mention it.
// Messages in threads are not affected - they always work without mentions.

import { ChatInputCommandInteraction, ChannelType, type TextChannel } from 'discord.js'
import { getChannelMentionMode, setChannelMentionMode } from '../database.js'
import { getKimakiMetadata } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'

const mentionModeLogger = createLogger(LogPrefix.CLI)

/**
 * Handle the /toggle-mention-mode slash command.
 * Toggles whether the bot only responds when @mentioned in this channel.
 */
export async function handleToggleMentionModeCommand({
  command,
  appId,
}: {
  command: ChatInputCommandInteraction
  appId: string
}): Promise<void> {
  mentionModeLogger.log('[TOGGLE_MENTION_MODE] Command called')

  const channel = command.channel

  if (!channel || channel.type !== ChannelType.GuildText) {
    await command.reply({
      content: 'This command can only be used in text channels (not threads).',
      ephemeral: true,
    })
    return
  }

  const textChannel = channel as TextChannel
  const metadata = await getKimakiMetadata(textChannel)

  if (metadata.channelAppId && metadata.channelAppId !== appId) {
    await command.reply({
      content: 'This channel is configured for a different bot.',
      ephemeral: true,
    })
    return
  }

  if (!metadata.projectDirectory) {
    await command.reply({
      content:
        'This channel is not configured with a project directory.\nUse `/add-project` to set up this channel.',
      ephemeral: true,
    })
    return
  }

  const wasEnabled = await getChannelMentionMode(textChannel.id)
  const nextEnabled = !wasEnabled
  await setChannelMentionMode(textChannel.id, nextEnabled)

  const nextLabel = nextEnabled ? 'enabled' : 'disabled'

  mentionModeLogger.log(
    `[TOGGLE_MENTION_MODE] ${nextLabel.toUpperCase()} for channel ${textChannel.id}`,
  )

  await command.reply({
    content: nextEnabled
      ? `Mention mode **enabled** for this channel.\nThe bot will only start new sessions when @mentioned.\nMessages in existing threads are not affected.`
      : `Mention mode **disabled** for this channel.\nThe bot will respond to all messages in **#${textChannel.name}**.`,
    ephemeral: true,
  })
}
