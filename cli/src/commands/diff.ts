// /diff command - Show git diff as a shareable URL.

import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import path from 'node:path'
import type { CommandContext } from './types.js'
import {
  resolveWorkingDirectory,
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import { uploadGitDiffViaCritique } from '../critique-utils.js'

const logger = createLogger(LogPrefix.DIFF)

export async function handleDiffCommand({
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
      content: 'This command can only be used in a text channel or thread',
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

  const { workingDirectory } = resolved

  await command.deferReply({ flags: SILENT_MESSAGE_FLAGS })

  const projectName = path.basename(workingDirectory)
  const title = `${projectName}: Discord /diff`
  const result = await uploadGitDiffViaCritique({
    title,
    cwd: workingDirectory,
  })

  if (!result) {
    await command.editReply({ content: 'No changes to show' })
    return
  }

  if (result.error || !result.url) {
    await command.editReply({ content: result.error || 'No changes to show' })
    return
  }

  const imageUrl = `https://critique.work/og/${result.id}.png`
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setURL(result.url)
    .setImage(imageUrl)

  await command.editReply({ embeds: [embed] })
  logger.log(`Diff shared: ${result.url}`)
}
