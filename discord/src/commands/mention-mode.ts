// /toggle-mention-mode command.
// Toggles mention-only mode for a channel.
// When enabled, bot only responds to messages that @mention it.
// Messages in threads are not affected - they always work without mentions.


import type { CommandEvent } from '../platform/types.js'
import { PLATFORM_MESSAGE_FLAGS } from '../platform/message-flags.js'
import {
  getChannelDirectory,
  getChannelMentionMode,
  setChannelMentionMode,
} from '../database.js'
import { createLogger, LogPrefix } from '../logger.js'
import { isTextChannel } from './channel-ref.js'

const mentionModeLogger = createLogger(LogPrefix.CLI)

/**
 * Handle the /toggle-mention-mode slash command.
 * Toggles whether the bot only responds when @mentioned in this channel.
 */
export async function handleToggleMentionModeCommand({
  command,
}: {
  command: CommandEvent
  appId: string
}): Promise<void> {
  mentionModeLogger.log('[TOGGLE_MENTION_MODE] Command called')

  const channel = command.channel

  if (!isTextChannel(channel)) {
    await command.reply({
      content: 'This command can only be used in text channels (not threads).',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL,
    })
    return
  }
  const textChannel = channel

  const channelConfig = await getChannelDirectory(textChannel.id)
  if (!channelConfig?.directory) {
    await command.reply({
      content:
        'This channel is not configured with a project directory.\nUse `/add-project` to set up this channel.',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL,
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
       : `Mention mode **disabled** for this channel.\nThe bot will respond to all messages in **#${textChannel.name || textChannel.id}**.`,
    flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL,
  })
}
