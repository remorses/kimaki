// /add-dir command - Expand the current session's external_directory permissions.
// Resolves the requested directory against the active working directory, then
// updates the current session permission rules via OpenCode.

import {
  MessageFlags,
} from 'discord.js'
import type { OpencodeClient, PermissionRuleset } from '@opencode-ai/sdk/v2'
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

async function waitForSessionIdle({
  client,
  sessionId,
  directory,
  timeoutMs = 2_000,
}: {
  client: OpencodeClient
  sessionId: string
  directory: string
  timeoutMs?: number
}): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const statusResponse = await client.session.status({ directory })
    const sessionStatus = statusResponse.data?.[sessionId]
    if (!sessionStatus || sessionStatus.type === 'idle') {
      return
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50)
    })
  }
}

async function restartSessionIfBusy({
  client,
  sessionId,
  directory,
}: {
  client: OpencodeClient
  sessionId: string
  directory: string
}): Promise<Error | boolean> {
  const statusResponse = await client.session.status({ directory })
  if (statusResponse.error) {
    return new Error('Failed to check session status')
  }

  const sessionStatus = statusResponse.data?.[sessionId]
  if (!sessionStatus || sessionStatus.type === 'idle') {
    return false
  }

  const abortResponse = await client.session.abort({
    sessionID: sessionId,
    directory,
  })
  if (abortResponse.error) {
    return new Error('Failed to abort in-progress session')
  }

  await waitForSessionIdle({ client, sessionId, directory })

  const resumeResponse = await client.session.promptAsync({
    sessionID: sessionId,
    directory,
    parts: [],
  })
  if (resumeResponse.error) {
    return new Error('Failed to resume session')
  }

  return true
}

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

  if (!channel.isThread()) {
    await command.reply({
      content: 'This command can only be used in a thread with an active session',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const resolvedDirectories = await resolveWorkingDirectory({
    channel,
  })
  if (!resolvedDirectories) {
    await command.reply({
      content: 'Could not determine project directory for this channel',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const requestedDirectory = command.options.getString('directory') ?? ALL_DIRECTORIES_PATTERN
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

    const restarted = await restartSessionIfBusy({
      client,
      sessionId,
      directory: resolvedDirectories.workingDirectory,
    })
    if (restarted instanceof Error) {
      await command.editReply(
        `Updated session permissions, but ${restarted.message.toLowerCase()}`,
      )
      return
    }

    const restartSuffix = restarted
      ? '. Restarted the in-progress session so the change applies now'
      : ''
    await command.editReply(
      resolvedPattern === ALL_DIRECTORIES_PATTERN
        ? `Updated session permissions: all external directories are now allowed${restartSuffix}`
        : `Updated session permissions: allowed \`${resolvedPattern}\`${restartSuffix}`,
    )
  } catch (error) {
    logger.error('[ADD-DIR] Failed to update session permissions:', error)
    await command.editReply(
      `Failed to update session permissions: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}
