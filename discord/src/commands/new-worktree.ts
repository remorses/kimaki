// Worktree management command: /new-worktree
// Uses OpenCode SDK v2 to create worktrees with kimaki- prefix
// Creates thread immediately, then worktree in background so user can type

import {
  ChannelType,
  REST,
  type TextChannel,
  type ThreadChannel,
  type Message,
} from 'discord.js'
import fs from 'node:fs'
import type { CommandContext } from './types.js'
import {
  createPendingWorktree,
  setWorktreeReady,
  setWorktreeError,
  getChannelDirectory,
  getThreadWorktree,
} from '../database.js'
import {
  SILENT_MESSAGE_FLAGS,
  reactToThread,
  resolveProjectDirectoryFromAutocomplete,
} from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import { notifyError } from '../sentry.js'
import {
  createWorktreeWithSubmodules,
  execAsync,
  listBranchesByLastCommit,
  validateBranchRef,
} from '../worktrees.js'
import { WORKTREE_PREFIX } from './merge-worktree.js'
import type { AutocompleteContext } from './types.js'
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
): Promise<string | WorktreeError> {
  const channelConfig = await getChannelDirectory(channel.id)

  if (!channelConfig) {
    return new WorktreeError(
      'This channel is not configured with a project directory',
    )
  }

  if (!fs.existsSync(channelConfig.directory)) {
    return new WorktreeError(
      `Directory does not exist: ${channelConfig.directory}`,
    )
  }

  return channelConfig.directory
}

/**
 * Create worktree in background and update starter message when done.
 */
async function createWorktreeInBackground({
  thread,
  starterMessage,
  worktreeName,
  projectDirectory,
  baseBranch,
  rest,
}: {
  thread: ThreadChannel
  starterMessage: Message
  worktreeName: string
  projectDirectory: string
  baseBranch?: string
  rest: REST
}): Promise<void> {
  logger.log(
    `Creating worktree "${worktreeName}" for project ${projectDirectory}${baseBranch ? ` from ${baseBranch}` : ''}`,
  )
  const worktreeResult = await createWorktreeWithSubmodules({
    directory: projectDirectory,
    name: worktreeName,
    baseBranch,
  })

  if (worktreeResult instanceof Error) {
    const errorMsg = worktreeResult.message
    logger.error('[NEW-WORKTREE] Error:', worktreeResult)
    await setWorktreeError({ threadId: thread.id, errorMessage: errorMsg })
    await starterMessage.edit(
      `🌳 **Worktree: ${worktreeName}**\n❌ ${errorMsg}`,
    )
    return
  }

  // Success - update database and edit starter message
  await setWorktreeReady({
    threadId: thread.id,
    worktreeDirectory: worktreeResult.directory,
  })

  // React with tree emoji to mark as worktree thread
  await reactToThread({
    rest,
    threadId: thread.id,
    channelId: thread.parentId || undefined,
    emoji: '🌳',
  })

  await starterMessage.edit(
    `🌳 **Worktree: ${worktreeName}**\n` +
      `📁 \`${worktreeResult.directory}\`\n` +
      `🌿 Branch: \`${worktreeResult.branch}\``,
  )
}

async function findExistingWorktreePath({
  projectDirectory,
  worktreeName,
}: {
  projectDirectory: string
  worktreeName: string
}): Promise<string | undefined | Error> {
  const listResult = await errore.tryAsync({
    try: () =>
      execAsync('git worktree list --porcelain', { cwd: projectDirectory }),
    catch: (e) => new WorktreeError('Failed to list worktrees', { cause: e }),
  })
  if (errore.isError(listResult)) {
    return listResult
  }

  const lines = listResult.stdout.split('\n')
  let currentPath = ''
  const branchRef = `refs/heads/${worktreeName}`

  for (const line of lines) {
    if (line.startsWith('worktree ')) {
      currentPath = line.slice('worktree '.length)
      continue
    }
    if (
      line.startsWith('branch ') &&
      line.slice('branch '.length) === branchRef
    ) {
      return currentPath || undefined
    }
  }

  return undefined
}

export async function handleNewWorktreeCommand({
  command,
}: CommandContext): Promise<void> {
  await command.deferReply({ ephemeral: false })

  const channel = command.channel
  if (!channel) {
    await command.editReply('Cannot determine channel')
    return
  }

  const isThread =
    channel.type === ChannelType.PublicThread ||
    channel.type === ChannelType.PrivateThread

  // Handle command in existing thread - attach worktree to this thread
  if (isThread) {
    await handleWorktreeInThread({
      command,
      thread: channel as ThreadChannel,
    })
    return
  }

  // Handle command in text channel - create new thread with worktree (existing behavior)
  if (channel.type !== ChannelType.GuildText) {
    await command.editReply(
      'This command can only be used in text channels or threads',
    )
    return
  }

  const rawName = command.options.getString('name')
  const rawBaseBranch = command.options.getString('base-branch') || undefined
  if (!rawName) {
    await command.editReply(
      'Name is required when creating a worktree from a text channel. Use `/new-worktree name:my-feature`',
    )
    return
  }

  const worktreeName = formatWorktreeName(rawName)
  if (!worktreeName) {
    await command.editReply(
      'Invalid worktree name. Please use letters, numbers, and spaces.',
    )
    return
  }

  const textChannel = channel as TextChannel

  const projectDirectory = await getProjectDirectoryFromChannel(
    textChannel,
  )
  if (errore.isError(projectDirectory)) {
    await command.editReply(projectDirectory.message)
    return
  }

  let baseBranch = rawBaseBranch
  if (baseBranch) {
    const validated = await validateBranchRef({
      directory: projectDirectory,
      ref: baseBranch,
    })
    if (validated instanceof Error) {
      await command.editReply(`Invalid base branch: \`${baseBranch}\``)
      return
    }
    baseBranch = validated
  }

  const existingWorktree = await findExistingWorktreePath({
    projectDirectory,
    worktreeName,
  })
  if (errore.isError(existingWorktree)) {
    await command.editReply(existingWorktree.message)
    return
  }
  if (existingWorktree) {
    await command.editReply(
      `Worktree \`${worktreeName}\` already exists at \`${existingWorktree}\``,
    )
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
    baseBranch,
    rest: command.client.rest,
  }).catch((e) => {
    logger.error('[NEW-WORKTREE] Background error:', e)
    void notifyError(e, 'Background worktree creation failed')
  })
}

/**
 * Handle /new-worktree when called inside an existing thread.
 * Attaches a worktree to the current thread, using thread name if no name provided.
 */
async function handleWorktreeInThread({
  command,
  thread,
}: {
  command: CommandContext['command']
  thread: ThreadChannel
}): Promise<void> {
  // Error if thread already has a worktree
  if (await getThreadWorktree(thread.id)) {
    await command.editReply('This thread already has a worktree attached.')
    return
  }

  // Get worktree name from parameter or derive from thread name
  const rawName = command.options.getString('name')
  const rawBaseBranch = command.options.getString('base-branch') || undefined
  const worktreeName = rawName
    ? formatWorktreeName(rawName)
    : deriveWorktreeNameFromThread(thread.name)

  if (!worktreeName) {
    await command.editReply(
      'Invalid worktree name. Please provide a name or rename the thread.',
    )
    return
  }

  // Get parent channel for project directory
  const parent = thread.parent
  if (!parent || parent.type !== ChannelType.GuildText) {
    await command.editReply('Cannot determine parent channel')
    return
  }

  const projectDirectory = await getProjectDirectoryFromChannel(
    parent as TextChannel,
  )
  if (errore.isError(projectDirectory)) {
    await command.editReply(projectDirectory.message)
    return
  }

  let baseBranch = rawBaseBranch
  if (baseBranch) {
    const validated = await validateBranchRef({
      directory: projectDirectory,
      ref: baseBranch,
    })
    if (validated instanceof Error) {
      await command.editReply(`Invalid base branch: \`${baseBranch}\``)
      return
    }
    baseBranch = validated
  }

  const existingWorktreePath = await findExistingWorktreePath({
    projectDirectory,
    worktreeName,
  })
  if (errore.isError(existingWorktreePath)) {
    await command.editReply(existingWorktreePath.message)
    return
  }
  if (existingWorktreePath) {
    await command.editReply(
      `Worktree \`${worktreeName}\` already exists at \`${existingWorktreePath}\``,
    )
    return
  }

  // Store pending worktree in database for this existing thread
  await createPendingWorktree({
    threadId: thread.id,
    worktreeName,
    projectDirectory,
  })

  // Send status message in thread
  const statusMessage = await thread.send({
    content: `🌳 **Creating worktree: ${worktreeName}**\n⏳ Setting up...`,
    flags: SILENT_MESSAGE_FLAGS,
  })

  await command.editReply(
    `Creating worktree \`${worktreeName}\` for this thread...`,
  )

  createWorktreeInBackground({
    thread,
    starterMessage: statusMessage,
    worktreeName,
    projectDirectory,
    baseBranch,
    rest: command.client.rest,
  }).catch((e) => {
    logger.error('[NEW-WORKTREE] Background error:', e)
    void notifyError(e, 'Background worktree creation failed (in-thread)')
  })
}

/**
 * Autocomplete handler for /new-worktree base-branch option.
 * Lists local + remote branches sorted by most recent commit date.
 */
export async function handleNewWorktreeAutocomplete({
  interaction,
}: AutocompleteContext): Promise<void> {
  try {
    const focusedValue = interaction.options.getFocused()

    // interaction.channel can be null when the channel isn't cached
    // (common with gateway-proxy). Use channelId which is always available
    // from the raw interaction payload.
    const projectDirectory = await resolveProjectDirectoryFromAutocomplete(interaction)

    if (!projectDirectory) {
      await interaction.respond([])
      return
    }

    const branches = await listBranchesByLastCommit({
      directory: projectDirectory,
      query: focusedValue,
    })

    await interaction.respond(
      branches.map((name) => {
        return { name, value: name }
      }),
    )
  } catch (e) {
    logger.error('[NEW-WORKTREE] Autocomplete error:', e)
    await interaction.respond([]).catch(() => {})
  }
}
