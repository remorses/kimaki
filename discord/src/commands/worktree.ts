// Worktree management command: /new-worktree
// Uses OpenCode SDK v2 to create worktrees with kimaki- prefix
// Creates thread immediately, then worktree in background so user can type

import { ChannelType, type TextChannel, type ThreadChannel } from 'discord.js'
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
import * as errore from 'errore'

const logger = createLogger('WORKTREE')

class WorktreeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'WorktreeError'
  }
}

/**
 * Format worktree name: lowercase, spaces to dashes, remove special chars, add kimaki- prefix.
 * "My Feature" → "kimaki-my-feature"
 */
function formatWorktreeName(name: string): string {
  const formatted = name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')

  return `kimaki-${formatted}`
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
 * Create worktree in background and update thread when done.
 */
async function createWorktreeInBackground({
  thread,
  worktreeName,
  projectDirectory,
}: {
  thread: ThreadChannel
  worktreeName: string
  projectDirectory: string
}): Promise<void> {
  // Initialize opencode server
  const getClient = await initializeOpencodeForDirectory(projectDirectory)
  if (errore.isError(getClient)) {
    setWorktreeError({ threadId: thread.id, errorMessage: getClient.message })
    await thread.send({
      content: `❌ Failed to initialize OpenCode: ${getClient.message}`,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const clientV2 = getOpencodeClientV2(projectDirectory)
  if (!clientV2) {
    setWorktreeError({ threadId: thread.id, errorMessage: 'Failed to get OpenCode client' })
    await thread.send({
      content: '❌ Failed to get OpenCode client',
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  // Create worktree using SDK v2
  logger.log(`Creating worktree "${worktreeName}" for project ${projectDirectory}`)
  const worktreeResult = await errore.tryAsync({
    try: async () => {
      const response = await clientV2.worktree.create({
        directory: projectDirectory,
        worktreeCreateInput: {
          name: worktreeName,
        },
      })

      if (response.error) {
        throw new Error(`SDK error: ${JSON.stringify(response.error)}`)
      }

      if (!response.data) {
        throw new Error('No worktree data returned from SDK')
      }

      return response.data
    },
    catch: (e) => new WorktreeError('Failed to create worktree', { cause: e }),
  })

  if (errore.isError(worktreeResult)) {
    const errorMsg = worktreeResult.message
    logger.error('[NEW-WORKTREE] Error:', worktreeResult.cause)
    setWorktreeError({ threadId: thread.id, errorMessage: errorMsg })
    await thread.send({
      content: `❌ ${errorMsg}`,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  // Success - update database and notify
  setWorktreeReady({ threadId: thread.id, worktreeDirectory: worktreeResult.directory })
  await thread.send({
    content: `✅ Worktree ready!\n📁 \`${worktreeResult.directory}\`\n🌿 Branch: \`${worktreeResult.branch}\``,
    flags: SILENT_MESSAGE_FLAGS,
  })
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

  // Create thread immediately so user can start typing
  const threadResult = await errore.tryAsync({
    try: async () => {
      const starterMessage = await textChannel.send({
        content: `🌳 **Creating worktree: ${worktreeName}**\n⏳ Setting up...`,
        flags: SILENT_MESSAGE_FLAGS,
      })

      const thread = await starterMessage.startThread({
        name: `worktree: ${worktreeName}`,
        autoArchiveDuration: 1440,
        reason: 'Worktree session',
      })

      return thread
    },
    catch: (e) => new WorktreeError('Failed to create thread', { cause: e }),
  })

  if (errore.isError(threadResult)) {
    logger.error('[NEW-WORKTREE] Error:', threadResult.cause)
    await command.editReply(threadResult.message)
    return
  }

  // Store pending worktree in database
  createPendingWorktree({
    threadId: threadResult.id,
    worktreeName,
    projectDirectory,
  })

  await command.editReply(`Creating worktree in ${threadResult.toString()}`)

  // Create worktree in background (don't await)
  createWorktreeInBackground({
    thread: threadResult,
    worktreeName,
    projectDirectory,
  }).catch((e) => {
    logger.error('[NEW-WORKTREE] Background error:', e)
  })
}
