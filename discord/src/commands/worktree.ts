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
  getChannelDirectory,
  getThreadWorktree,
} from '../database.js'
import { initializeOpencodeForDirectory, getOpencodeClientV2 } from '../opencode.js'
import { SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import { createWorktreeWithSubmodules, captureGitDiff, type CapturedDiff } from '../worktree-utils.js'
import { WORKTREE_PREFIX } from './merge-worktree.js'
import * as errore from 'errore'

const logger = createLogger(LogPrefix.WORKTREE)

class WorktreeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'WorktreeError'
  }
}

/**
 * Format worktree name: lowercase, spaces to dashes, remove special chars, add opencode/kimaki- prefix.
 * "My Feature" → "opencode/kimaki-my-feature"
 * Returns empty string if no valid name can be extracted.
 */
export function formatWorktreeName(name: string): string {
  const formatted = name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')

  if (!formatted) {
    return ''
  }
  return `opencode/kimaki-${formatted}`
}

/**
 * Derive worktree name from thread name.
 * Handles existing "⬦ worktree: opencode/kimaki-name" format or uses thread name directly.
 */
function deriveWorktreeNameFromThread(threadName: string): string {
  // Handle existing "⬦ worktree: opencode/kimaki-name" format
  const worktreeMatch = threadName.match(/worktree:\s*(.+)$/i)
  const extractedName = worktreeMatch?.[1]?.trim()
  if (extractedName) {
    // If already has opencode/kimaki- prefix, return as is
    if (extractedName.startsWith('opencode/kimaki-')) {
      return extractedName
    }
    return formatWorktreeName(extractedName)
  }
  // Use thread name directly
  return formatWorktreeName(threadName)
}

/**
 * Get project directory from database.
 */
async function getProjectDirectoryFromChannel(
  channel: TextChannel,
  appId: string,
): Promise<string | WorktreeError> {
  const channelConfig = await getChannelDirectory(channel.id)

  if (!channelConfig) {
    return new WorktreeError('This channel is not configured with a project directory')
  }

  if (channelConfig.appId && channelConfig.appId !== appId) {
    return new WorktreeError('This channel is not configured for this bot')
  }

  if (!fs.existsSync(channelConfig.directory)) {
    return new WorktreeError(`Directory does not exist: ${channelConfig.directory}`)
  }

  return channelConfig.directory
}

/**
 * Create worktree in background and update starter message when done.
 * If diff is provided, it's applied during worktree creation (before submodule init).
 */
async function createWorktreeInBackground({
  thread,
  starterMessage,
  worktreeName,
  projectDirectory,
  clientV2,
  diff,
}: {
  thread: ThreadChannel
  starterMessage: Message
  worktreeName: string
  projectDirectory: string
  clientV2: ReturnType<typeof getOpencodeClientV2> & {}
  diff?: CapturedDiff | null
}): Promise<void> {
  // Create worktree using SDK v2, apply diff, then init submodules
  logger.log(`Creating worktree "${worktreeName}" for project ${projectDirectory}`)
  const worktreeResult = await createWorktreeWithSubmodules({
    clientV2,
    directory: projectDirectory,
    name: worktreeName,
    diff,
  })

  if (worktreeResult instanceof Error) {
    const errorMsg = worktreeResult.message
    logger.error('[NEW-WORKTREE] Error:', worktreeResult)
    await setWorktreeError({ threadId: thread.id, errorMessage: errorMsg })
    await starterMessage.edit(`🌳 **Worktree: ${worktreeName}**\n❌ ${errorMsg}`)
    return
  }

  // Success - update database and edit starter message
  await setWorktreeReady({ threadId: thread.id, worktreeDirectory: worktreeResult.directory })
  const diffStatus = diff ? (worktreeResult.diffApplied ? '\n✅ Changes applied' : '\n⚠️ Failed to apply changes') : ''
  await starterMessage.edit(
    `🌳 **Worktree: ${worktreeName}**\n` +
    `📁 \`${worktreeResult.directory}\`\n` +
    `🌿 Branch: \`${worktreeResult.branch}\`` +
    diffStatus
  )
}

export async function handleNewWorktreeCommand({
  command,
  appId,
}: CommandContext): Promise<void> {
  await command.deferReply({ ephemeral: false })

  const channel = command.channel
  if (!channel) {
    await command.editReply('Cannot determine channel')
    return
  }

  const isThread =
    channel.type === ChannelType.PublicThread || channel.type === ChannelType.PrivateThread

  // Handle command in existing thread - attach worktree to this thread
  if (isThread) {
    await handleWorktreeInThread({ command, appId, thread: channel as ThreadChannel })
    return
  }

  // Handle command in text channel - create new thread with worktree (existing behavior)
  if (channel.type !== ChannelType.GuildText) {
    await command.editReply('This command can only be used in text channels or threads')
    return
  }

  const rawName = command.options.getString('name')
  if (!rawName) {
    await command.editReply(
      'Name is required when creating a worktree from a text channel. Use `/new-worktree name:my-feature`',
    )
    return
  }

  const worktreeName = formatWorktreeName(rawName)
  if (!worktreeName) {
    await command.editReply('Invalid worktree name. Please use letters, numbers, and spaces.')
    return
  }

  const textChannel = channel as TextChannel

  const projectDirectory = await getProjectDirectoryFromChannel(textChannel, appId)
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

      // Add user to thread so it appears in their sidebar
      await thread.members.add(command.user.id)

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
  await createPendingWorktree({
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

/**
 * Handle /new-worktree when called inside an existing thread.
 * Attaches a worktree to the current thread, using thread name if no name provided.
 */
async function handleWorktreeInThread({
  command,
  appId,
  thread,
}: CommandContext & { thread: ThreadChannel }): Promise<void> {
  // Error if thread already has a worktree
  if (await getThreadWorktree(thread.id)) {
    await command.editReply('This thread already has a worktree attached.')
    return
  }

  // Get worktree name from parameter or derive from thread name
  const rawName = command.options.getString('name')
  const worktreeName = rawName ? formatWorktreeName(rawName) : deriveWorktreeNameFromThread(thread.name)

  if (!worktreeName) {
    await command.editReply('Invalid worktree name. Please provide a name or rename the thread.')
    return
  }

  // Get parent channel for project directory
  const parent = thread.parent
  if (!parent || parent.type !== ChannelType.GuildText) {
    await command.editReply('Cannot determine parent channel')
    return
  }

  const projectDirectory = await getProjectDirectoryFromChannel(parent as TextChannel, appId)
  if (errore.isError(projectDirectory)) {
    await command.editReply(projectDirectory.message)
    return
  }

  // Initialize opencode
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

  const existingWorktreePath = listResult.find((dir) => dir.endsWith(`/${worktreeName}`))
  if (existingWorktreePath) {
    await command.editReply(
      `Worktree \`${worktreeName}\` already exists at \`${existingWorktreePath}\``,
    )
    return
  }

  // Capture git diff from project directory before creating worktree.
  // This allows transferring uncommitted changes to the new worktree.
  const diff = await captureGitDiff(projectDirectory)
  const hasDiff = diff && (diff.staged || diff.unstaged)

  // Store pending worktree in database for this existing thread
  await createPendingWorktree({
    threadId: thread.id,
    worktreeName,
    projectDirectory,
  })

  // Send status message in thread
  const diffNote = hasDiff ? '\n📋 Will transfer uncommitted changes' : ''
  const statusMessage = await thread.send({
    content: `🌳 **Creating worktree: ${worktreeName}**\n⏳ Setting up...${diffNote}`,
    flags: SILENT_MESSAGE_FLAGS,
  })

  await command.editReply(`Creating worktree \`${worktreeName}\` for this thread...`)

  // Create worktree in background, passing diff to apply after creation
  createWorktreeInBackground({
    thread,
    starterMessage: statusMessage,
    worktreeName,
    projectDirectory,
    clientV2,
    diff,
  }).catch((e) => {
    logger.error('[NEW-WORKTREE] Background error:', e)
  })
}
