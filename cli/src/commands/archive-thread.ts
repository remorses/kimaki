// Manual archive command - /archive-thread
// Immediately archives the current thread without confirmation.

import { ChannelType, MessageFlags, Routes } from 'discord.js'
import type { CommandContext } from './types.js'
import { createLogger, formatErrorWithStack } from '../logger.js'

const logger = createLogger('ARCHIVE')

export async function handleArchiveThreadCommand({ command }: CommandContext): Promise<void> {
  const channel = command.channel

  if (!channel || !channel.isThread()) {
    await command.reply({
      content: 'This command can only be used in a thread.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await command.deferReply({ flags: MessageFlags.Ephemeral })

  const rest = command.client.rest

  try {
    await rest.patch(Routes.channel(channel.id), {
      body: { archived: true },
    })
    await command.editReply({ content: 'Thread archived.' })
  } catch (error) {
    logger.error(`Error archiving thread ${channel.id}:`, formatErrorWithStack(error))
    await command.editReply({ content: 'Failed to archive thread.' })
  }
}

const threadTypes = [
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
]

export const archiveThreadSlashCommand = {
  name: 'archive-thread',
  description: 'Immediately archive this thread without confirmation',
  allowedChannelTypes: threadTypes,
}
