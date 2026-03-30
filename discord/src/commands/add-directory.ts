// /add-directory command - Preapprove an external directory for this thread.

import {
  ChannelType,
  MessageFlags,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import type { CommandContext } from './types.js'
import { getThreadSession } from '../database.js'
import { normalizeAllowedDirectoryPath } from '../directory-permissions.js'
import {
  resolveWorkingDirectory,
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import { createLogger } from '../logger.js'
import { getOrCreateRuntime } from '../session-handler/thread-session-runtime.js'

const logger = createLogger('ADD_DIR')

export async function handleAddDirectoryCommand({
  command,
  appId,
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

  const runtime = getOrCreateRuntime({
    threadId: channel.id,
    thread: channel as ThreadChannel,
    projectDirectory: resolved.projectDirectory,
    sdkDirectory: resolved.workingDirectory,
    channelId: (channel as ThreadChannel).parentId || channel.id,
    appId,
  })
  runtime.primeNextExternalDirectoryAccess({
    directory: normalizedPath,
  })

  await command.editReply(
    `Directory preapproved for the next message in this thread.\n\`${normalizedPath}\`\nKimaki will auto-accept matching external directory requests for \`${normalizedPath}/*\` during the next run only.`,
  )
  logger.log(`Thread ${channel.id} primed one-shot directory ${normalizedPath}`)
}
