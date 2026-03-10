// /merge-worktree command - Merge worktree commits into default branch.
// Uses worktrunk-style pipeline: squash -> rebase -> local push.
// On rebase conflicts, asks the AI model in the thread to resolve them.

import { type TextChannel, type ThreadChannel } from 'discord.js'
import type { AutocompleteContext, CommandContext } from './types.js'
import {
  getThreadWorktree,
  getThreadSession,
  getChannelDirectory,
} from '../database.js'
import { createLogger, LogPrefix } from '../logger.js'
import { notifyError } from '../sentry.js'
import { mergeWorktree, listBranchesByLastCommit, validateBranchRef } from '../worktrees.js'
import {
  sendThreadMessage,
  resolveWorkingDirectory,
  resolveProjectDirectoryFromAutocomplete,
} from '../discord-utils.js'
import {
  getOrCreateRuntime,
} from '../session-handler/thread-session-runtime.js'
import { RebaseConflictError, DirtyWorktreeError } from '../errors.js'

const logger = createLogger(LogPrefix.WORKTREE)

/** Worktree thread title prefix - indicates unmerged worktree */
export const WORKTREE_PREFIX = '⬦ '

async function removeWorktreePrefixFromTitle(
  thread: ThreadChannel,
): Promise<void> {
  if (!thread.name.startsWith(WORKTREE_PREFIX)) {
    return
  }
  const newName = thread.name.slice(WORKTREE_PREFIX.length)
  const timeoutMs = 5000
  await Promise.race([
    thread.setName(newName).catch((e) => {
      logger.warn(
        `Failed to update thread title: ${e instanceof Error ? e.message : String(e)}`,
      )
    }),
    new Promise<void>((resolve) => {
      setTimeout(() => {
        logger.warn(`Thread title update timed out after ${timeoutMs}ms`)
        resolve()
      }, timeoutMs)
    }),
  ])
}

/**
 * Send a prompt to the AI model in the thread.
 * If a session is actively streaming, queues it. Otherwise sends directly.
 * Routes through ThreadSessionRuntime.
 */
async function sendPromptToModel({
  prompt,
  thread,
  projectDirectory,
  command,
  appId,
}: {
  prompt: string
  thread: ThreadChannel
  projectDirectory: string
  command: CommandContext['command']
  appId?: string
}): Promise<void> {
  const resolved = await resolveWorkingDirectory({ channel: thread })

  // Merge prompts use opencode queue mode.
  const runtime = getOrCreateRuntime({
    threadId: thread.id,
    thread,
    projectDirectory: resolved?.projectDirectory || projectDirectory,
    sdkDirectory: resolved?.workingDirectory || projectDirectory,
    channelId: thread.parentId || thread.id,
    appId,
  })
  await runtime.enqueueIncoming({
    prompt,
    userId: command.user.id,
    username: command.user.displayName,
    appId,
    mode: 'opencode',
  })
}

export async function handleMergeWorktreeCommand({
  command,
  appId,
}: CommandContext): Promise<void> {
  await command.deferReply({ ephemeral: false })

  const channel = command.channel
  if (!channel || !channel.isThread()) {
    await command.editReply('This command can only be used in a thread')
    return
  }

  const thread = channel as ThreadChannel
  const worktreeInfo = await getThreadWorktree(thread.id)
  if (!worktreeInfo) {
    await command.editReply('This thread is not associated with a worktree')
    return
  }

  if (worktreeInfo.status !== 'ready' || !worktreeInfo.worktree_directory) {
    await command.editReply(
      `Worktree is not ready (status: ${worktreeInfo.status})${worktreeInfo.error_message ? `: ${worktreeInfo.error_message}` : ''}`,
    )
    return
  }

  const rawTargetBranch = command.options.getString('target-branch') || undefined
  let targetBranch = rawTargetBranch
  if (targetBranch) {
    const validated = await validateBranchRef({
      directory: worktreeInfo.project_directory,
      ref: targetBranch,
    })
    if (validated instanceof Error) {
      await command.editReply(`Invalid target branch: \`${targetBranch}\``)
      return
    }
    targetBranch = validated
  }

  const result = await mergeWorktree({
    worktreeDir: worktreeInfo.worktree_directory,
    mainRepoDir: worktreeInfo.project_directory,
    worktreeName: worktreeInfo.worktree_name,
    targetBranch,
    onProgress: (msg) => {
      logger.log(`[merge] ${msg}`)
    },
  })

  if (result instanceof Error) {
    if (result instanceof DirtyWorktreeError) {
      await command.editReply(
        'Merge failed: uncommitted changes in the worktree. Commit changes first, then run `/merge-worktree` again.',
      )
      return
    }

    if (result instanceof RebaseConflictError) {
      await command.editReply(
        'Rebase conflict detected. Asking the model to resolve...',
      )
      await sendPromptToModel({
        prompt: [
          'A rebase conflict occurred while merging this worktree into the default branch.',
          'Please resolve the rebase conflicts:',
          '1. Check `git status` to see which files have conflicts',
          '2. Edit the conflicted files to resolve the merge markers',
          '3. Stage resolved files with `git add`',
          '4. Continue the rebase with `git rebase --continue`',
          '5. After the rebase completes successfully, tell me so I can run `/merge-worktree` again',
        ].join('\n'),
        thread,
        projectDirectory: worktreeInfo.project_directory,
        command,
        appId,
      })
      return
    }

    await command.editReply(`Merge failed: ${result.message}`)
    return
  }

  void removeWorktreePrefixFromTitle(thread)
  await command.editReply(
    `Merged \`${result.branchName}\` into \`${result.defaultBranch}\` @ ${result.shortSha} (${result.commitCount} commit${result.commitCount === 1 ? '' : 's'})\nWorktree now at detached HEAD.`,
  )
}

/**
 * Autocomplete handler for /merge-worktree target-branch option.
 * Lists local branches only (no remotes) sorted by most recent commit date.
 * Resolves directory from the thread's worktree info or parent channel.
 */
export async function handleMergeWorktreeAutocomplete({
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

    // Local branches only — merge targets must be local refs
    const branches = await listBranchesByLastCommit({
      directory: projectDirectory,
      query: focusedValue,
      includeRemote: false,
    })

    await interaction.respond(
      branches.map((name) => {
        return { name, value: name }
      }),
    )
  } catch (e) {
    logger.error('[MERGE-WORKTREE] Autocomplete error:', e)
    await interaction.respond([]).catch(() => {})
  }
}
