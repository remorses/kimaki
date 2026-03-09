// /toggle-worktrees command.
// Allows per-channel opt-in for automatic worktree creation,
// as an alternative to the global --use-worktrees CLI flag.

import {
  MessageFlags,
  ChannelType,
  type TextChannel,
} from 'discord.js'
import type { CommandEvent } from '../platform/types.js'
import {
  getChannelWorktreesEnabled,
  setChannelWorktreesEnabled,
} from '../database.js'
import { getKimakiMetadata } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'

const worktreeSettingsLogger = createLogger(LogPrefix.WORKTREE)

/**
 * Handle the /toggle-worktrees slash command.
 * Toggles automatic worktree creation for new sessions in this channel.
 */
export async function handleToggleWorktreesCommand({
  command,
}: {
  command: CommandEvent
  appId: string
}): Promise<void> {
  worktreeSettingsLogger.log('[TOGGLE_WORKTREES] Command called')

  const channel = command.channel

  if (!channel || channel.type !== ChannelType.GuildText) {
    await command.reply({
      content: 'This command can only be used in text channels (not threads).',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const textChannel = channel as TextChannel
  const metadata = await getKimakiMetadata(textChannel)

  if (!metadata.projectDirectory) {
    await command.reply({
      content:
        'This channel is not configured with a project directory.\nUse `/add-project` to set up this channel.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const wasEnabled = await getChannelWorktreesEnabled(textChannel.id)
  const nextEnabled = !wasEnabled
  await setChannelWorktreesEnabled(textChannel.id, nextEnabled)

  const nextLabel = nextEnabled ? 'enabled' : 'disabled'

  worktreeSettingsLogger.log(
    `[TOGGLE_WORKTREES] ${nextLabel.toUpperCase()} for channel ${textChannel.id}`,
  )

  await command.reply({
    content: nextEnabled
      ? `Worktrees **enabled** for this channel.\n\nNew sessions started from messages in **#${textChannel.name}** will now automatically create git worktrees.\n\nNew setting for **#${textChannel.name}**: **enabled**.`
      : `Worktrees **disabled** for this channel.\n\nNew sessions started from messages in **#${textChannel.name}** will use the main project directory.\n\nNew setting for **#${textChannel.name}**: **disabled**.`,
    flags: MessageFlags.Ephemeral,
  })
}
