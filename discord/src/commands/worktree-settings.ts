// /enable-worktrees and /disable-worktrees commands.
// Allows per-channel opt-in for automatic worktree creation,
// as an alternative to the global --use-worktrees CLI flag.

import { ChatInputCommandInteraction, ChannelType, type TextChannel } from 'discord.js'
import { getChannelWorktreesEnabled, setChannelWorktreesEnabled } from '../database.js'
import { getKimakiMetadata } from '../discord-utils.js'
import { createLogger } from '../logger.js'

const worktreeSettingsLogger = createLogger('WORKTREE_SETTINGS')

/**
 * Handle the /enable-worktrees slash command.
 * Enables automatic worktree creation for new sessions in this channel.
 */
export async function handleEnableWorktreesCommand({
  command,
  appId,
}: {
  command: ChatInputCommandInteraction
  appId: string
}): Promise<void> {
  worktreeSettingsLogger.log('[ENABLE_WORKTREES] Command called')

  const channel = command.channel

  if (!channel || channel.type !== ChannelType.GuildText) {
    await command.reply({
      content: 'This command can only be used in text channels (not threads).',
      ephemeral: true,
    })
    return
  }

  const textChannel = channel as TextChannel
  const metadata = getKimakiMetadata(textChannel)

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

  const wasEnabled = getChannelWorktreesEnabled(textChannel.id)
  setChannelWorktreesEnabled(textChannel.id, true)

  worktreeSettingsLogger.log(`[ENABLE_WORKTREES] Enabled for channel ${textChannel.id}`)

  await command.reply({
    content: wasEnabled
      ? `Worktrees are already enabled for this channel.\n\nNew sessions started from messages in **#${textChannel.name}** will automatically create git worktrees.`
      : `Worktrees **enabled** for this channel.\n\nNew sessions started from messages in **#${textChannel.name}** will now automatically create git worktrees.\n\nUse \`/disable-worktrees\` to turn this off.`,
    ephemeral: true,
  })
}

/**
 * Handle the /disable-worktrees slash command.
 * Disables automatic worktree creation for new sessions in this channel.
 */
export async function handleDisableWorktreesCommand({
  command,
  appId,
}: {
  command: ChatInputCommandInteraction
  appId: string
}): Promise<void> {
  worktreeSettingsLogger.log('[DISABLE_WORKTREES] Command called')

  const channel = command.channel

  if (!channel || channel.type !== ChannelType.GuildText) {
    await command.reply({
      content: 'This command can only be used in text channels (not threads).',
      ephemeral: true,
    })
    return
  }

  const textChannel = channel as TextChannel
  const metadata = getKimakiMetadata(textChannel)

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

  const wasEnabled = getChannelWorktreesEnabled(textChannel.id)
  setChannelWorktreesEnabled(textChannel.id, false)

  worktreeSettingsLogger.log(`[DISABLE_WORKTREES] Disabled for channel ${textChannel.id}`)

  await command.reply({
    content: wasEnabled
      ? `Worktrees **disabled** for this channel.\n\nNew sessions started from messages in **#${textChannel.name}** will use the main project directory.\n\nUse \`/enable-worktrees\` to turn this back on.`
      : `Worktrees are already disabled for this channel.\n\nNew sessions will use the main project directory.`,
    ephemeral: true,
  })
}
