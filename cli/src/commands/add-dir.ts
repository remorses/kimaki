// /add-dir command - Expand the current session's external_directory permissions.
// Resolves the requested directory against the active working directory, then
// updates the current session permission rules via OpenCode.

import {
  ChannelType,
  MessageFlags,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import type { PermissionRuleset } from '@opencode-ai/sdk/v2'
import fs from 'node:fs'
import path from 'node:path'
import type { CommandContext } from './types.js'
import { getThreadSession } from '../database.js'
import {
  buildExternalDirectoryPermissionRules,
  getOpencodeClient,
  initializeOpencodeForDirectory,
} from '../opencode.js'
import {
  resolveWorkingDirectory,
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'

const logger = createLogger(LogPrefix.PERMISSIONS)
const ALL_DIRECTORIES_PATTERN = '*'

export function resolveDirectoryPermissionPattern({
  input,
  workingDirectory,
}: {
  input: string
  workingDirectory: string
}): Error | string {
  const trimmedInput = input.trim()
  if (!trimmedInput) {
    return new Error('Directory is required')
  }

  if (trimmedInput === ALL_DIRECTORIES_PATTERN) {
    return ALL_DIRECTORIES_PATTERN
  }

  const absolutePath = path.resolve(workingDirectory, trimmedInput)
  if (!fs.existsSync(absolutePath)) {
    return new Error(`Directory does not exist: ${absolutePath}`)
  }

  let stats: fs.Stats
  try {
    stats = fs.statSync(absolutePath)
  } catch (error) {
    return new Error(`Failed to inspect directory: ${absolutePath}`, { cause: error })
  }

  if (!stats.isDirectory()) {
    return new Error(`Not a directory: ${absolutePath}`)
  }

  return absolutePath.replaceAll('\\', '/')
}

export function buildAddDirPermissionRules({
  resolvedPattern,
}: {
  resolvedPattern: string
}): PermissionRuleset {
  return buildExternalDirectoryPermissionRules({
    resolvedPattern,
    action: 'allow',
  })
}

export async function handleAddDirCommand({
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

  if (!isThread) {
    await command.reply({
      content: 'This command can only be used in a thread with an active session',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const resolvedDirectories = await resolveWorkingDirectory({
    channel: channel as TextChannel | ThreadChannel,
  })
  if (!resolvedDirectories) {
    await command.reply({
      content: 'Could not determine project directory for this channel',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const requestedDirectory = command.options.getString('directory', true)
  const resolvedPattern = resolveDirectoryPermissionPattern({
    input: requestedDirectory,
    workingDirectory: resolvedDirectories.workingDirectory,
  })
  if (resolvedPattern instanceof Error) {
    await command.reply({
      content: resolvedPattern.message,
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const sessionId = await getThreadSession(channel.id)
  if (!sessionId) {
    await command.reply({
      content: 'No active session in this thread',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  await command.deferReply({ flags: SILENT_MESSAGE_FLAGS })

  const getClient = await initializeOpencodeForDirectory(
    resolvedDirectories.projectDirectory,
  )
  if (getClient instanceof Error) {
    await command.editReply(`Failed to update session permissions: ${getClient.message}`)
    return
  }

  const client = getOpencodeClient(resolvedDirectories.projectDirectory)
  if (!client) {
    await command.editReply('Failed to get OpenCode client')
    return
  }

  try {
    const updateResponse = await client.session.update({
      sessionID: sessionId,
      permission: buildAddDirPermissionRules({ resolvedPattern }),
    })
    if (updateResponse.error) {
      await command.editReply('Failed to update session permissions')
      return
    }

    await command.editReply(
      resolvedPattern === ALL_DIRECTORIES_PATTERN
        ? 'Updated session permissions: all external directories are now allowed'
        : `Updated session permissions: allowed \`${resolvedPattern}\``,
    )
  } catch (error) {
    logger.error('[ADD-DIR] Failed to update session permissions:', error)
    await command.editReply(
      `Failed to update session permissions: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}
