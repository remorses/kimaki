// /toggle-worktrees command.
// Allows per-channel opt-in for automatic worktree creation,
// as an alternative to the global --use-worktrees CLI flag.

import {
  ChatInputCommandInteraction,
  MessageFlags,
  ChannelType,
  type TextChannel,
} from 'discord.js'
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
  command: ChatInputCommandInteraction
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

  const metadata = await getKimakiMetadata(channel)

  if (!metadata.projectDirectory) {
    await command.reply({
      content:
        'This channel is not configured with a project directory.\nUse `/add-project` to set up this channel.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const wasEnabled = await getChannelWorktreesEnabled(channel.id)
  const nextEnabled = !wasEnabled
  await setChannelWorktreesEnabled(channel.id, nextEnabled)

  const nextLabel = nextEnabled ? 'enabled' : 'disabled'

  worktreeSettingsLogger.log(
    `[TOGGLE_WORKTREES] ${nextLabel.toUpperCase()} for channel ${channel.id}`,
  )

  await command.reply({
    content: nextEnabled
      ? `Worktrees **enabled** for this channel.\n\nNew sessions started from messages in **#${channel.name}** will now automatically create git worktrees.\n\nNew setting for **#${channel.name}**: **enabled**.`
      : `Worktrees **disabled** for this channel.\n\nNew sessions started from messages in **#${channel.name}** will use the main project directory.\n\nNew setting for **#${channel.name}**: **disabled**.`,
  })
}
