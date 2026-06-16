// Worktree management command: /new-worktree
// Uses OpenCode SDK v2 to create worktrees with kimaki- prefix
// Creates thread immediately, then worktree in background so user can type

import { ChannelType, REST, type TextChannel, type ThreadChannel, type Message } from 'discord.js'
import fs from 'node:fs'
import { OpenCodeSdkError } from '../errors.js'
import type { CommandContext } from './types.js'
import {
  createPendingWorktree,
  setWorktreeReady,
  setWorktreeError,
  getChannelDirectory,
  getThreadSession,
  setThreadSession,
} from '../database.js'
import {
  SILENT_MESSAGE_FLAGS,
  reactToThread,
  resolveProjectDirectoryFromAutocomplete,
  resolveTextChannel,
  sendThreadMessage,
} from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import { notifyError } from '../sentry.js'
import {
  createWorktreeWithSubmodules,
  execAsync,
  listBranchesByLastCommit,
  validateBranchRef,
} from '../worktrees.js'
import { getOrCreateRuntime } from '../session-handler/thread-session-runtime.js'
import { buildSessionPermissions, initializeOpencodeForDirectory } from '../opencode.js'
import { WORKTREE_PREFIX } from './merge-worktree.js'
import type { AutocompleteContext } from './types.js'
import * as errore from 'errore'
import { copyCurrentSessionModel } from './model.js'

const logger = createLogger(LogPrefix.WORKTREE)
const DEFAULT_WORKTREE_BASE_REF = 'HEAD'

async function resolveRequestedWorktreeBaseRef({
  projectDirectory,
  rawBaseBranch,
}: {
  projectDirectory: string
  rawBaseBranch?: string
}): Promise<string | Error> {
  if (!rawBaseBranch) {
    // Default to the current local HEAD so worktrees can branch from
    // unpublished commits in the main checkout.
    return DEFAULT_WORKTREE_BASE_REF
  }

  return validateBranchRef({
    directory: projectDirectory,
    ref: rawBaseBranch,
  })
}

/** Status message shown while a worktree is being created. */
export function worktreeCreatingMessage(worktreeName: string): string {
  return `🌳 **Creating worktree: ${worktreeName}**\n⏳ Setting up...`
}

class WorktreeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WorktreeError'
  }
}

/**
 * Lowercase, collapse whitespace to dashes, drop non-[a-z0-9-] chars.
 * Does NOT add the `opencode/kimaki-` prefix — callers do that so they can
 * optionally compress the slug first for auto-derived names.
 */
export function slugifyWorktreeName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
}

/**
 * Compress a slug by stripping vowels from each dash-separated word, but
 * keeping the first character so the word stays recognizable.
 * Only applied to slugs longer than 20 chars — short names are left alone.
 *
 * "configurable-sidebar-width-by-component" → "cnfgrbl-sdbr-wdth-by-cmpnnt"
 *
 * Used ONLY for auto-derived worktree names (thread name, prompt slug)
 * so long Discord titles don't produce 80-char folder paths that make
 * the agent lazy and reuse the previous worktree. User-provided names
 * via `--worktree <name>` or `/new-worktree name:` are never compressed.
 */
export function shortenWorktreeSlug(slug: string): string {
  if (slug.length <= 20) {
    return slug
  }
  const shortened = slug
    .split('-')
    .map((word) => {
      if (!word) {
        return word
      }
      const first = word[0]
      const rest = word.slice(1).replace(/[aeiou]/g, '')
      return first + rest
    })
    .join('-')
  return shortened || slug
}

/**
 * Format worktree name: lowercase, spaces to dashes, remove special chars, add opencode/kimaki- prefix.
 * "My Feature" → "opencode/kimaki-my-feature"
 * Returns empty string if no valid name can be extracted.
 *
 * This is the "explicit" path used when the user provides a specific name.
 * The slug is NOT compressed — if you ask for `my-long-explicit-branch-name`
 * you get `opencode/kimaki-my-long-explicit-branch-name` verbatim.
 */
export function formatWorktreeName(name: string): string {
  const slug = slugifyWorktreeName(name)
  if (!slug) {
    return ''
  }
  return `opencode/kimaki-${slug}`
}

/**
 * Format an auto-derived worktree name (from a Discord thread title or a
 * prompt). Same as formatWorktreeName but compresses slugs longer than 20
 * chars by stripping vowels so the on-disk folder name stays short.
 */
export function formatAutoWorktreeName(name: string): string {
  const slug = slugifyWorktreeName(name)
  if (!slug) {
    return ''
  }
  return `opencode/kimaki-${shortenWorktreeSlug(slug)}`
}

/**
 * Derive worktree name from thread name.
 * Handles existing "⬦ worktree: opencode/kimaki-name" format or uses thread name directly.
 * Uses formatAutoWorktreeName so long thread titles get vowel-compressed.
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
    return formatAutoWorktreeName(extractedName)
  }
  // Use thread name directly (compressed if > 20 chars)
  return formatAutoWorktreeName(threadName)
}

/**
 * Get project directory from database.
 */
async function getProjectDirectoryFromChannel(
  channel: TextChannel,
): Promise<string | WorktreeError> {
  const channelConfig = await getChannelDirectory(channel.id)

  if (!channelConfig) {
    return new WorktreeError('This channel is not configured with a project directory')
  }

  if (!fs.existsSync(channelConfig.directory)) {
    return new WorktreeError(`Directory does not exist: ${channelConfig.directory}`)
  }

  return channelConfig.directory
}

/**
 * Create worktree and update the status message when done.
 * Handles the full lifecycle: pending DB entry, git creation, DB ready/error,
 * tree emoji reaction, and editing the status message.
 *
 * starterMessage is optional — if omitted, status edits are skipped (creation
 * still proceeds). This keeps worktree creation independent of Discord message
 * delivery, so a transient send failure never silently skips the worktree.
 *
 * Returns the worktree directory on success, or an Error on failure.
 * Never throws — all internal errors are caught and returned as Error values.
 */
export async function createWorktreeInBackground({
  thread,
  starterMessage,
  worktreeName,
  projectDirectory,
  baseBranch,
  rest,
}: {
  thread: ThreadChannel
  starterMessage?: Message
  worktreeName: string
  projectDirectory: string
  baseBranch?: string
  rest: REST
}): Promise<string | Error> {
  return (async () => {
    logger.log(
      `Creating worktree "${worktreeName}" for project ${projectDirectory}${baseBranch ? ` from ${baseBranch}` : ''}`,
    )


    const worktreeResult = await createWorktreeWithSubmodules({
      directory: projectDirectory,
      name: worktreeName,
      baseBranch,
      onProgress: (phase) => {
        editStatus(`🌳 **Worktree: ${worktreeName}**\n${phase}`)
      },
    })

if (worktreeResult instanceof Error) {
      const errorMsg = worktreeResult.message
      logger.error('[WORKTREE] Creation failed:', worktreeResult)
      await setWorktreeError({ threadId: thread.id, errorMessage: errorMsg })
      editStatus(`🌳 **Worktree: ${worktreeName}**\n❌ ${errorMsg}`)
    await editChain
    return worktreeResult
    }

      // DB ready update is critical; reaction is best-effort
      await setWorktreeReady({
        threadId: thread.id,
        worktreeDirectory: worktreeResult.directory,
      })

      void reactToThread({
        rest,
        threadId: thread.id,
        channelId: thread.parentId || undefined,
        emoji: '🌳',
      }).catch(() => {})

      editStatus(
        `🌳 **Worktree: ${worktreeName}**\n` +
          `📁 \`${worktreeResult.directory}\`\n` +
          `🌿 Branch: \`${worktreeResult.branch}\``,
      )

    await editChain
    return worktreeResult.directory      await editChain
      return worktreeResult
    }

    // DB ready update is critical; reaction is best-effort
    await setWorktreeReady({
      threadId: thread.id,
      worktreeDirectory: worktreeResult.directory,
    })

    void reactToThread({
      rest,
      threadId: thread.id,
      channelId: thread.parentId || undefined,
      emoji: '🌳',
    }).catch(() => {})

    editStatus(
      `🌳 **Worktree: ${worktreeName}**\n` +
        `📁 \`${worktreeResult.directory}\`\n` +
        `🌿 Branch: \`${worktreeResult.branch}\``,
    )
    await editChain
    return worktreeResult.directory
  })().catch((e) => {
    logger.error('[WORKTREE] Unexpected error in createWorktreeInBackground:', e)
    return new Error(`Worktree creation failed: ${e instanceof Error ? e.message : String(e)}`, {
      cause: e,
    })
  })
}

async function findExistingWorktreePath({
  projectDirectory,
  worktreeName,
export async function handleNewWorktreeCommand({ command, appId }: CommandContext): Promise<void> {
  await command.deferReply()

  const channel = command.channel
  if (!channel) {
    await command.editReply('Cannot determine channel')
    return
  }

  // Handle command in existing thread - attach worktree to this thread
  if (channel.type === ChannelType.PublicThread || channel.type === ChannelType.PrivateThread) {
    await handleWorktreeInThread({
      command,
      thread: channel,
      appId,
    })
    return
  }

  // Handle command in text channel - create new thread with worktree (existing behavior)
  if (channel.type !== ChannelType.GuildText) {
    await command.editReply('This command can only be used in text channels or threads')
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
    await command.editReply('Invalid worktree name. Please use letters, numbers, and spaces.')
    return
  }

  const projectDirectory = await getProjectDirectoryFromChannel(channel)
  if (errore.isError(projectDirectory)) {
    await command.editReply(projectDirectory.message)
    return
  }

  // Parallelize: base branch validation and existing worktree check are independent
  const [baseBranch, existingWorktree] = await Promise.all([
    resolveRequestedWorktreeBaseRef({ projectDirectory, rawBaseBranch }),
    findExistingWorktreePath({ projectDirectory, worktreeName }),
  ])
  if (baseBranch instanceof Error) {
    await command.editReply(`Invalid base branch: \`${rawBaseBranch}\``)
    return
  }
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
  const result = await (async () => {
    const starterMessage = await channel.send({
      content: worktreeCreatingMessage(worktreeName),
      flags: SILENT_MESSAGE_FLAGS,
    })

    const thread = await starterMessage.startThread({
      name: `${WORKTREE_PREFIX}worktree: ${worktreeName}`,
      autoArchiveDuration: 1440,
      reason: 'Worktree session',
    })

    // Parallelize: member add and editReply are independent
    await Promise.all([
      thread.members.add(command.user.id),
      command.editReply(`Creating worktree in ${thread.toString()}`),
    ])

    return { thread, starterMessage }
  })().catch((e) => new WorktreeError('Failed to create thread', { cause: e }))

  if (result instanceof Error) {
    logger.error('[NEW-WORKTREE] Error:', result.cause)
    await command.editReply(result.message)
    return
  }

  const { thread, starterMessage } = result

  // Create worktree in background (don't await)
  void createWorktreeInBackground({
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
 * Creates a separate worktree thread, using the source thread name if no name
 * is provided. The source thread stays bound to its original directory.
 */
async function handleWorktreeInThread({
  command,
  thread,
  appId,
}: {
  command: CommandContext['command']
  thread: ThreadChannel
  appId: string
}): Promise<void> {
  // Get worktree name from parameter or derive from thread name
  const rawName = command.options.getString('name')
  const rawBaseBranch = command.options.getString('base-branch') || undefined
  const worktreeName = rawName
    ? formatWorktreeName(rawName)
    : deriveWorktreeNameFromThread(thread.name)

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

  const projectDirectory = await getProjectDirectoryFromChannel(parent)
  if (errore.isError(projectDirectory)) {
    await command.editReply(projectDirectory.message)
    return
  }

  // Parallelize: base branch validation, existing worktree check, and parent channel
  // resolve are all independent. resolveTextChannel fetches the parent from Discord
  // cache/API which can overlap with the git operations.
  const [baseBranch, existingWorktreePath, textChannel] = await Promise.all([
    resolveRequestedWorktreeBaseRef({ projectDirectory, rawBaseBranch }),
    findExistingWorktreePath({ projectDirectory, worktreeName }),
    resolveTextChannel(thread),
  ])
  if (baseBranch instanceof Error) {
    await command.editReply(`Invalid base branch: \`${rawBaseBranch}\``)
    return
  }
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
  if (!textChannel) {
    await command.editReply('Could not resolve parent text channel')
    return
  }

  const threadResult = await (async () => {
    const worktreeThread = await textChannel.threads.create({
      name: `${WORKTREE_PREFIX}worktree: ${worktreeName}`.slice(0, 100),
      autoArchiveDuration: 1440,
      reason: `Worktree fork from thread ${thread.id}`,
    })
    // Parallelize: member add and status message send are independent
    const [, statusMessage] = await Promise.all([
      worktreeThread.members.add(command.user.id),
      worktreeThread.send({
        content: worktreeCreatingMessage(worktreeName),
        flags: SILENT_MESSAGE_FLAGS,
      }),
    ])
    return { worktreeThread, statusMessage }
  })().catch((e) => new WorktreeError('Failed to create worktree thread', { cause: e }))
  if (threadResult instanceof Error) {
    await command.editReply(threadResult.message)
    return
  }

  const { worktreeThread, statusMessage } = threadResult

  // Fire-and-forget: don't block background worktree creation on editReply
  void command.editReply(`Creating worktree in ${worktreeThread.toString()}`).catch(() => {})

  void createWorktreeInBackground({
    thread: worktreeThread,
    starterMessage: statusMessage,
    worktreeName,
    projectDirectory,
    baseBranch,
    rest: command.client.rest,
  })
    .then(async (result) => {
      if (result instanceof Error) return
      const sourceSessionId = await getThreadSession(thread.id)
      if (!sourceSessionId) {
        await sendThreadMessage(
          worktreeThread,
          'Worktree is ready. Send a message here to start a fresh session in this checkout.',
        )
        return
      }

      const getClient = await initializeOpencodeForDirectory(result, {
        originalRepoDirectory: projectDirectory,
        channelId: parent.id,
      })
      if (getClient instanceof Error) {
        await sendThreadMessage(
          worktreeThread,
          `✗ Worktree is ready, but failed to initialize OpenCode for context reuse: ${getClient.message}`,
        )
        return
      }

      const forkResponse = await getClient()
        .session.fork({
          sessionID: sourceSessionId,
          directory: result,
        })
        .catch((e) => new OpenCodeSdkError({ operation: 'session.fork', cause: e }))
      if (forkResponse instanceof Error) {
        logger.error('[NEW-WORKTREE] Failed to fork session into worktree:', forkResponse)
        void notifyError(forkResponse, 'Failed to fork session into worktree')
        await sendThreadMessage(
          worktreeThread,
          `✗ Worktree is ready, but failed to reuse session context there: ${forkResponse.message}`,
        )
        return
      }

      const forkedSession = forkResponse.data
      if (!forkedSession) {
        const error = new Error('OpenCode did not return a forked session')
        logger.error('[NEW-WORKTREE] Failed to fork session into worktree:', error)
        void notifyError(error, 'Failed to fork session into worktree')
        await sendThreadMessage(
          worktreeThread,
          `✗ Worktree is ready, but failed to reuse session context there: ${error.message}`,
        )
        return
      }

          directory: result,
          permission: buildSessionPermissions({
            directory: result,
            originalRepoDirectory: projectDirectory,
          }),
        })
        .catch((e) => new OpenCodeSdkError({ operation: 'session.update', cause: e }))
      if (permissionResponse instanceof Error || permissionResponse.error) {
        const error =
          permissionResponse instanceof Error
            ? permissionResponse
            : new Error('OpenCode rejected forked session permission update')
        logger.error('[NEW-WORKTREE] Failed to update forked session permissions:', error)
        void notifyError(error, 'Failed to update forked session permissions')
        await sendThreadMessage(
          worktreeThread,
          `✗ Worktree is ready, but failed to update forked session permissions: ${error.message}`,
        )
        return
      }

      await setThreadSession(worktreeThread.id, forkedSession.id)
      getOrCreateRuntime({
        threadId: worktreeThread.id,
        thread: worktreeThread,
        projectDirectory,
        sdkDirectory: result,
        channelId: parent.id,
        appId,
      })
      await sendThreadMessage(
        worktreeThread,
        `Reusing context from <#${thread.id}> in worktree session \`${forkedSession.id}\`.`,
      )
    })
    .catch((e) => {
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
