// /merge-worktree command - Merge worktree commits into main/default branch.
// Handles both branch-based worktrees and detached HEAD state.
// After merge, switches to detached HEAD at main so user can keep working.

import { type ThreadChannel } from 'discord.js'
import type { CommandContext } from './types.js'
import { getThreadWorktree } from '../database.js'
import { createLogger, LogPrefix } from '../logger.js'
import { execAsync } from '../worktree-utils.js'

const logger = createLogger(LogPrefix.WORKTREE)

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

/**
 * Check if worktree is in detached HEAD state.
 */
async function isDetachedHead(worktreeDir: string): Promise<boolean> {
  try {
    await execAsync(`git -C "${worktreeDir}" symbolic-ref HEAD`)
    return false
  } catch (error) {
    logger.debug(
      `Failed to resolve HEAD for ${worktreeDir}:`,
      error instanceof Error ? error.message : String(error),
    )
    return true
  }
}

/**
 * Get current branch name (returns null if detached).
 */
async function getCurrentBranch(worktreeDir: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`git -C "${worktreeDir}" symbolic-ref --short HEAD`)
    return stdout.trim() || null
  } catch (error) {
    logger.debug(
      `Failed to get current branch for ${worktreeDir}:`,
      error instanceof Error ? error.message : String(error),
    )
    return null
  }
}

/**
 * Get commit subjects between two refs for squash commit message.
 * Returns array of commit subjects (first line of each commit message).
 */
async function getCommitSubjects(repoDir: string, baseRef: string, headRef: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync(
      `git -C "${repoDir}" log --format="%s" ${baseRef}..${headRef}`,
    )
    return stdout
      .trim()
      .split('\n')
      .filter((s) => {
        return s.length > 0
      })
  } catch (error) {
    logger.warn(
      `Failed to get commit subjects:`,
      error instanceof Error ? error.message : String(error),
    )
    return []
  }
}

/**
 * Generate a squash commit message with worktree context and commit subjects.
 */
function generateSquashMessage(
  branchName: string,
  worktreeDir: string,
  commitSubjects: string[],
): string {
  const lines: string[] = []

  // Header with worktree info
  lines.push(`worktree merge: ${branchName}`)
  lines.push(``)
  lines.push(`Worktree: ${worktreeDir}`)

  // Add commit subjects if any
  if (commitSubjects.length > 0) {
    lines.push(``)
    lines.push(`Commits:`)
    for (const subject of commitSubjects) {
      lines.push(`- ${subject}`)
    }
  }

  return lines.join('\n')
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

  const mainRepoDir = worktreeInfo.project_directory
  const worktreeDir = worktreeInfo.worktree_directory

  try {
    // 1. Check for uncommitted changes
    const { stdout: status } = await execAsync(`git -C "${worktreeDir}" status --porcelain`)
    if (status.trim()) {
      await command.editReply(
        `❌ Uncommitted changes detected in worktree.\n\nPlease commit your changes first, then retry \`/merge-worktree\`.`,
      )
      return
    }

    // 2. Get the default branch name
    logger.log(`Getting default branch for ${mainRepoDir}`)
    let defaultBranch: string

    try {
      const { stdout } = await execAsync(
        `git -C "${mainRepoDir}" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@'`,
      )
      defaultBranch = stdout.trim() || 'main'
    } catch (error) {
      logger.warn(
        `Failed to detect default branch for ${mainRepoDir}, falling back to main:`,
        error instanceof Error ? error.message : String(error),
      )
      defaultBranch = 'main'
    }

    // 3. Determine if we're on a branch or detached HEAD
    const isDetached = await isDetachedHead(worktreeDir)
    const currentBranch = await getCurrentBranch(worktreeDir)
    let branchToMerge: string
    let tempBranch: string | null = null

    if (isDetached) {
      // Create a temporary branch from detached HEAD
      tempBranch = `temp-merge-${Date.now()}`
      logger.log(`Detached HEAD detected, creating temp branch: ${tempBranch}`)
      await execAsync(`git -C "${worktreeDir}" checkout -b ${tempBranch}`)
      branchToMerge = tempBranch
    } else {
      branchToMerge = currentBranch || worktreeInfo.worktree_name
    }

    logger.log(`Default branch: ${defaultBranch}, branch to merge: ${branchToMerge}`)

    // 4. Get commit subjects BEFORE merging default branch in (so we capture original commits)
    const mergeBase = await execAsync(`git -C "${worktreeDir}" merge-base ${defaultBranch} HEAD`)
      .then(({ stdout }) => {
        return stdout.trim()
      })
      .catch(() => {
        return defaultBranch
      })
    const commitSubjects = await getCommitSubjects(worktreeDir, mergeBase, 'HEAD')
    const squashMessage = generateSquashMessage(
      worktreeInfo.worktree_name || branchToMerge,
      worktreeDir,
      commitSubjects,
    )
    logger.log(`Generated squash message:\n${squashMessage}`)

    // 5. Merge default branch INTO worktree (handles diverged branches)
    logger.log(`Merging ${defaultBranch} into worktree at ${worktreeDir}`)
    try {
      await execAsync(`git -C "${worktreeDir}" merge ${defaultBranch} --no-edit`)
    } catch (e) {
      // If merge fails (conflicts), abort and report
      await execAsync(`git -C "${worktreeDir}" merge --abort`).catch((error) => {
        logger.warn(
          `Failed to abort merge in ${worktreeDir}:`,
          error instanceof Error ? error.message : String(error),
        )
      })
      // Clean up temp branch if we created one
      if (tempBranch) {
        await execAsync(`git -C "${worktreeDir}" checkout --detach`).catch((error) => {
          logger.warn(
            `Failed to detach HEAD after merge conflict in ${worktreeDir}:`,
            error instanceof Error ? error.message : String(error),
          )
        })
        await execAsync(`git -C "${worktreeDir}" branch -D ${tempBranch}`).catch((error) => {
          logger.warn(
            `Failed to delete temp branch ${tempBranch} in ${worktreeDir}:`,
            error instanceof Error ? error.message : String(error),
          )
        })
      }
      throw new Error(`Merge conflict - resolve manually in worktree then retry`)
    }

    // 6. Squash merge into default branch in main repo
    // Save state, do merge, restore state
    logger.log(`Squash merging ${branchToMerge} into ${defaultBranch} in main repo`)

    // Save current state of main repo
    const originalBranch = await getCurrentBranch(mainRepoDir)
    const { stdout: originalHead } = await execAsync(`git -C "${mainRepoDir}" rev-parse HEAD`)
    const originalHeadCommit = originalHead.trim()

    // Check if main repo has uncommitted changes
    const { stdout: mainStatus } = await execAsync(`git -C "${mainRepoDir}" status --porcelain`)
    const mainHadChanges = mainStatus.trim().length > 0
    if (mainHadChanges) {
      await execAsync(`git -C "${mainRepoDir}" stash push -m "merge-worktree-temp"`)
    }

    try {
      // Checkout default branch in main repo
      await execAsync(`git -C "${mainRepoDir}" checkout ${defaultBranch}`)

      // Squash merge the worktree branch
      await execAsync(`git -C "${mainRepoDir}" merge --squash ${branchToMerge}`)

      // Commit with descriptive message (escape quotes for shell)
      const escapedMessage = squashMessage.replace(/"/g, '\\"')
      await execAsync(`git -C "${mainRepoDir}" commit -m "${escapedMessage}"`)

      logger.log(`Squash merge committed successfully`)
    } finally {
      // Restore original branch/HEAD state
      if (originalBranch) {
        await execAsync(`git -C "${mainRepoDir}" checkout ${originalBranch}`).catch((error) => {
          logger.warn(
            `Failed to restore original branch ${originalBranch}:`,
            error instanceof Error ? error.message : String(error),
          )
        })
      } else {
        // Was detached, restore to original commit
        await execAsync(`git -C "${mainRepoDir}" checkout ${originalHeadCommit}`).catch((error) => {
          logger.warn(
            `Failed to restore detached HEAD:`,
            error instanceof Error ? error.message : String(error),
          )
        })
      }

      // Restore stashed changes if any
      if (mainHadChanges) {
        await execAsync(`git -C "${mainRepoDir}" stash pop`).catch((error) => {
          logger.warn(
            `Failed to restore stashed changes:`,
            error instanceof Error ? error.message : String(error),
          )
        })
      }
    }

    // 7. Switch to detached HEAD at default branch (allows main to be checked out elsewhere)
    logger.log(`Switching to detached HEAD at ${defaultBranch}`)
    await execAsync(`git -C "${worktreeDir}" checkout --detach ${defaultBranch}`)

    // 8. Delete the merged branch (temp or original)
    logger.log(`Deleting merged branch ${branchToMerge}`)
    await execAsync(`git -C "${worktreeDir}" branch -D ${branchToMerge}`).catch((error) => {
      logger.warn(
        `Failed to delete merged branch ${branchToMerge} in ${worktreeDir}:`,
        error instanceof Error ? error.message : String(error),
      )
    })

    // Also delete the original worktree branch if different from what we merged
    if (!isDetached && branchToMerge !== worktreeInfo.worktree_name) {
      await execAsync(`git -C "${worktreeDir}" branch -D ${worktreeInfo.worktree_name}`).catch((error) => {
        logger.warn(
          `Failed to delete worktree branch ${worktreeInfo.worktree_name} in ${worktreeDir}:`,
          error instanceof Error ? error.message : String(error),
        )
      })
    }

    // 9. Remove worktree prefix from thread title (fire and forget with timeout)
    void removeWorktreePrefixFromTitle(thread)

    const sourceDesc = isDetached ? 'detached commits' : `\`${branchToMerge}\``
    await command.editReply(
      `✅ Merged ${sourceDesc} into \`${defaultBranch}\`\n\nWorktree now at detached HEAD - you can keep working here.`,
    )

    logger.log(`Successfully merged ${branchToMerge} into ${defaultBranch}`)
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e)
    logger.error(`Merge failed: ${errorMsg}`)
    await command.editReply(`❌ Merge failed:\n\`\`\`\n${errorMsg}\n\`\`\``)
  }
}
