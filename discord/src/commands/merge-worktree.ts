// /merge-worktree command - Merge worktree branch into main/default branch.
// Finds the default branch, merges the worktree branch into it,
// and removes the ⬦ prefix from the thread title.

import { ChannelType, type ThreadChannel } from 'discord.js'
import type { CommandContext } from './types.js'
import { getThreadWorktree } from '../database.js'
import { createLogger } from '../logger.js'
import { execAsync } from '../worktree-utils.js'

const logger = createLogger('MERGE-WORKTREE')

/** Worktree thread title prefix - indicates unmerged worktree */
export const WORKTREE_PREFIX = '⬦ '

/**
 * Remove the worktree prefix from a thread title.
 * Uses Promise.race with timeout since Discord thread title updates can hang.
 */
async function removeWorktreePrefixFromTitle(thread: ThreadChannel): Promise<void> {
  if (!thread.name.startsWith(WORKTREE_PREFIX)) {
    return
  }

  const newName = thread.name.slice(WORKTREE_PREFIX.length)

  // Race between the edit and a timeout - thread title updates are heavily rate-limited
  const timeoutMs = 5000
  const editPromise = thread.setName(newName).catch((e) => {
    logger.warn(`Failed to update thread title: ${e instanceof Error ? e.message : String(e)}`)
  })

  const timeoutPromise = new Promise<void>((resolve) => {
    setTimeout(() => {
      logger.warn(`Thread title update timed out after ${timeoutMs}ms`)
      resolve()
    }, timeoutMs)
  })

  await Promise.race([editPromise, timeoutPromise])
}

export async function handleMergeWorktreeCommand({ command, appId }: CommandContext): Promise<void> {
  await command.deferReply({ ephemeral: false })

  const channel = command.channel

  // Must be in a thread
  if (!channel || !channel.isThread()) {
    await command.editReply('This command can only be used in a thread')
    return
  }

  const thread = channel as ThreadChannel

  // Get worktree info from database
  const worktreeInfo = getThreadWorktree(thread.id)
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

  const mainRepoDir = worktreeInfo.project_directory
  const worktreeBranch = worktreeInfo.worktree_name

  try {
    // 1. Get the default branch name
    logger.log(`Getting default branch for ${mainRepoDir}`)
    let defaultBranch: string

    try {
      const { stdout } = await execAsync(
        `git -C "${mainRepoDir}" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'`,
      )
      defaultBranch = stdout.trim() || 'main'
    } catch {
      defaultBranch = 'main'
    }

    logger.log(`Default branch: ${defaultBranch}, worktree branch: ${worktreeBranch}`)

    // 2. Fast-forward default branch to worktree branch (no checkout needed)
    // This works without checkout by updating the branch ref directly
    logger.log(`Fast-forwarding ${defaultBranch} to ${worktreeBranch} in ${mainRepoDir}`)
    const { stdout: mergeOutput } = await execAsync(
      `git -C "${mainRepoDir}" fetch . ${worktreeBranch}:${defaultBranch}`,
    )

    // 4. Remove worktree prefix from thread title (fire and forget with timeout)
    void removeWorktreePrefixFromTitle(thread)

    await command.editReply(
      `✅ Fast-forwarded \`${defaultBranch}\` to \`${worktreeBranch}\`\n\n\`\`\`\n${mergeOutput.trim() || 'Done'}\n\`\`\``,
    )

    logger.log(`Successfully merged ${worktreeBranch} into ${defaultBranch}`)
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e)
    logger.error(`Merge failed: ${errorMsg}`)

    // Provide helpful message for non-fast-forward case
    const hint = errorMsg.includes('non-fast-forward')
      ? '\n\n**Hint:** This requires a non-fast-forward merge. Rebase or merge manually.'
      : ''

    await command.editReply(`❌ Merge failed:\n\`\`\`\n${errorMsg}\n\`\`\`${hint}`)
  }
}
