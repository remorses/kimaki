// /add-directory command - Preapprove an external directory for this thread.

import {
  ChannelType,
  MessageFlags,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import type { CommandContext } from './types.js'
import {
  addThreadAllowedDirectory,
  getThreadSession,
} from '../database.js'
import { normalizeAllowedDirectoryPath } from '../directory-permissions.js'
import {
  resolveWorkingDirectory,
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import { createLogger } from '../logger.js'

const logger = createLogger('ADD_DIR')

export async function handleAddDirectoryCommand({
  command,
}: CommandContext): Promise<void> {
  const inputPath = command.options.getString('path', true)
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

  if (!isThread) {
    await command.reply({
      content: 'This command can only be used in a thread with an active session',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  await command.deferReply({
    flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
  })

  const sessionId = await getThreadSession(channel.id)
  if (!sessionId) {
    await command.editReply('No active session in this thread')
    return
  }

  const resolved = await resolveWorkingDirectory({
    channel: channel as TextChannel | ThreadChannel,
  })
  if (!resolved) {
    await command.editReply('Could not determine project directory for this channel')
    return
  }

  const normalizedPath = normalizeAllowedDirectoryPath({
    input: inputPath,
    workingDirectory: resolved.workingDirectory,
  })
  if (normalizedPath instanceof Error) {
    await command.editReply(normalizedPath.message)
    return
  }

  const created = await addThreadAllowedDirectory({
    threadId: channel.id,
    directory: normalizedPath,
  })
  const statusLine = created
    ? 'Directory preapproved for this thread.'
    : 'Directory was already preapproved for this thread.'

  await command.editReply(
    `${statusLine}\n\`${normalizedPath}\`\nKimaki will auto-accept matching external directory requests for \`${normalizedPath}/*\` in this thread.`,
  )
  logger.log(
    `Thread ${channel.id} ${created ? 'added' : 'kept'} allowed directory ${normalizedPath}`,
  )
}
