// Worktree management command: /new-worktree
// Uses OpenCode SDK v2 to create worktrees with kimaki- prefix
// Creates thread immediately, then worktree in background so user can type

import { ChannelType, type TextChannel, type ThreadChannel, type Message } from 'discord.js'
import fs from 'node:fs'
import type { CommandContext } from './types.js'
import {
  createPendingWorktree,
  setWorktreeReady,
  setWorktreeError,
} from '../database.js'
import { initializeOpencodeForDirectory, getOpencodeClientV2 } from '../opencode.js'
import { SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { extractTagsArrays } from '../xml.js'
import { createLogger } from '../logger.js'
import { createWorktreeWithSubmodules } from '../worktree-utils.js'
import { WORKTREE_PREFIX } from './merge-worktree.js'
import * as errore from 'errore'

const logger = createLogger('WORKTREE')

class WorktreeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'WorktreeError'
  }
}

/**
 * Format worktree name: lowercase, spaces to dashes, remove special chars, add opencode/kimaki- prefix.
 * "My Feature" → "opencode/kimaki-my-feature"
 */
export function formatWorktreeName(name: string): string {
  const formatted = name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')

  return `opencode/kimaki-${formatted}`
}

/**
 * Get project directory from channel topic.
 */
function getProjectDirectoryFromChannel(
  channel: TextChannel,
  appId: string,
): string | WorktreeError {
  if (!channel.topic) {
    return new WorktreeError('This channel has no topic configured')
  }

  const extracted = extractTagsArrays({
    xml: channel.topic,
    tags: ['kimaki.directory', 'kimaki.app'],
  })

  const projectDirectory = extracted['kimaki.directory']?.[0]?.trim()
  const channelAppId = extracted['kimaki.app']?.[0]?.trim()

  if (channelAppId && channelAppId !== appId) {
    return new WorktreeError('This channel is not configured for this bot')
  }

  if (!projectDirectory) {
    return new WorktreeError('This channel is not configured with a project directory')
  }

  if (!fs.existsSync(projectDirectory)) {
    return new WorktreeError(`Directory does not exist: ${projectDirectory}`)
  }

  return projectDirectory
}

/**
 * Create worktree in background and update starter message when done.
 */
async function createWorktreeInBackground({
  thread,
  starterMessage,
  worktreeName,
  projectDirectory,
  clientV2,
}: {
  thread: ThreadChannel
  starterMessage: Message
  worktreeName: string
  projectDirectory: string
  clientV2: ReturnType<typeof getOpencodeClientV2> & {}
}): Promise<void> {
  // Create worktree using SDK v2 and init submodules
  logger.log(`Creating worktree "${worktreeName}" for project ${projectDirectory}`)
  const worktreeResult = await createWorktreeWithSubmodules({
    clientV2,
    directory: projectDirectory,
    name: worktreeName,
  })

  if (worktreeResult instanceof Error) {
    const errorMsg = worktreeResult.message
    logger.error('[NEW-WORKTREE] Error:', worktreeResult)
    setWorktreeError({ threadId: thread.id, errorMessage: errorMsg })
    await starterMessage.edit(`🌳 **Worktree: ${worktreeName}**\n❌ ${errorMsg}`)
    return
  }

  // Success - update database and edit starter message
  setWorktreeReady({ threadId: thread.id, worktreeDirectory: worktreeResult.directory })
  await starterMessage.edit(
    `🌳 **Worktree: ${worktreeName}**\n` +
    `📁 \`${worktreeResult.directory}\`\n` +
    `🌿 Branch: \`${worktreeResult.branch}\``
  )
}

export async function handleNewWorktreeCommand({
  command,
  appId,
}: CommandContext): Promise<void> {
  await command.deferReply({ ephemeral: false })

  const rawName = command.options.getString('name', true)
  const worktreeName = formatWorktreeName(rawName)

  if (worktreeName === 'kimaki-') {
    await command.editReply('Invalid worktree name. Please use letters, numbers, and spaces.')
    return
  }

  const channel = command.channel

  if (!channel || channel.type !== ChannelType.GuildText) {
    await command.editReply('This command can only be used in text channels')
    return
  }

  const textChannel = channel as TextChannel

  const projectDirectory = getProjectDirectoryFromChannel(textChannel, appId)
  if (errore.isError(projectDirectory)) {
    await command.editReply(projectDirectory.message)
    return
  }

  // Initialize opencode and check if worktree already exists
  const getClient = await initializeOpencodeForDirectory(projectDirectory)
  if (errore.isError(getClient)) {
    await command.editReply(`Failed to initialize OpenCode: ${getClient.message}`)
    return
  }

  const clientV2 = getOpencodeClientV2(projectDirectory)
  if (!clientV2) {
    await command.editReply('Failed to get OpenCode client')
    return
  }

  // Check if worktree with this name already exists
  // SDK returns array of directory paths like "~/.opencode/worktree/abc/kimaki-my-feature"
  const listResult = await errore.tryAsync({
    try: async () => {
      const response = await clientV2.worktree.list({ directory: projectDirectory })
      return response.data || []
    },
    catch: (e) => new WorktreeError('Failed to list worktrees', { cause: e }),
  })

  if (errore.isError(listResult)) {
    await command.editReply(listResult.message)
    return
  }

  // Check if any worktree path ends with our name
  const existingWorktree = listResult.find((dir) => dir.endsWith(`/${worktreeName}`))
  if (existingWorktree) {
    await command.editReply(`Worktree \`${worktreeName}\` already exists at \`${existingWorktree}\``)
    return
  }

  // Create thread immediately so user can start typing
  const result = await errore.tryAsync({
    try: async () => {
      const starterMessage = await textChannel.send({
        content: `🌳 **Creating worktree: ${worktreeName}**\n⏳ Setting up...`,
        flags: SILENT_MESSAGE_FLAGS,
      })

      const thread = await starterMessage.startThread({
        name: `${WORKTREE_PREFIX}worktree: ${worktreeName}`,
        autoArchiveDuration: 1440,
        reason: 'Worktree session',
      })

      return { thread, starterMessage }
    },
    catch: (e) => new WorktreeError('Failed to create thread', { cause: e }),
  })

  if (errore.isError(result)) {
    logger.error('[NEW-WORKTREE] Error:', result.cause)
    await command.editReply(result.message)
    return
  }

  const { thread, starterMessage } = result

  // Store pending worktree in database
  createPendingWorktree({
    threadId: thread.id,
    worktreeName,
    projectDirectory,
  })

  await command.editReply(`Creating worktree in ${thread.toString()}`)

  // Create worktree in background (don't await)
  createWorktreeInBackground({
    thread,
    starterMessage,
    worktreeName,
    projectDirectory,
    clientV2,
  }).catch((e) => {
    logger.error('[NEW-WORKTREE] Background error:', e)
  })
}
