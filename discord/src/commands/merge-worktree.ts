// /merge-worktree command - Merge worktree commits into default branch.
// Uses worktrunk-style pipeline: commit -> squash -> rebase -> local push.
// On rebase conflicts, asks the AI model in the thread to resolve them.

import { type ThreadChannel } from 'discord.js'
import type { CommandContext } from './types.js'
import { getThreadWorktree, getThreadSession } from '../database.js'
import { createLogger, LogPrefix } from '../logger.js'
import { mergeWorktree } from '../worktree-utils.js'
import { sendThreadMessage, resolveWorkingDirectory } from '../discord-utils.js'
import { handleOpencodeSession, abortControllers, addToQueue } from '../session-handler.js'

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
 * Send a conflict resolution prompt to the AI model.
 * If a session is actively streaming, queues it. Otherwise sends directly.
 * Mirrors the pattern in /queue command (queue.ts).
 */
async function sendConflictResolutionPrompt({ thread, worktreeInfo, command, appId }: {
  thread: ThreadChannel
  worktreeInfo: { project_directory: string }
  command: CommandContext['command']
  appId?: string
}): Promise<void> {
  const conflictPrompt = [
    'A rebase conflict occurred while merging this worktree into the default branch.',
    'Please resolve the rebase conflicts:',
    '1. Check `git status` to see which files have conflicts',
    '2. Edit the conflicted files to resolve the merge markers',
    '3. Stage resolved files with `git add`',
    '4. Continue the rebase with `git rebase --continue`',
    '5. After the rebase completes successfully, tell me so I can run `/merge-worktree` again',
  ].join('\n')

  // Check if there's an active session streaming a response
  const sessionId = await getThreadSession(thread.id)
  const existingController = sessionId ? abortControllers.get(sessionId) : null
  const hasActiveRequest = Boolean(existingController && !existingController.signal.aborted)

  if (hasActiveRequest) {
    // Session is busy, queue the message for when it finishes
    addToQueue({
      threadId: thread.id,
      message: {
        prompt: conflictPrompt,
        userId: command.user.id,
        username: command.user.displayName,
        queuedAt: Date.now(),
        appId,
      },
    })
    logger.log(`[merge] Queued conflict resolution prompt (session active)`)
    return
  }

  // No active request, send directly
  const resolved = await resolveWorkingDirectory({ channel: thread })
  handleOpencodeSession({
    prompt: conflictPrompt,
    thread,
    projectDirectory: resolved?.projectDirectory || worktreeInfo.project_directory,
    channelId: thread.parentId || thread.id,
    username: command.user.displayName,
    userId: command.user.id,
    appId,
  }).catch((e) => {
    logger.error(`[merge] Failed to send conflict resolution prompt:`, e)
    sendThreadMessage(thread, `Failed to send conflict resolution prompt: ${e instanceof Error ? e.message : String(e)}`).catch(() => {})
  })
}

export async function handleMergeWorktreeCommand({ command, appId }: CommandContext): Promise<void> {
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

  const result = await mergeWorktree({
    worktreeDir: worktreeInfo.worktree_directory,
    mainRepoDir: worktreeInfo.project_directory,
    worktreeName: worktreeInfo.worktree_name,
    onProgress: (msg) => {
      logger.log(`[merge] ${msg}`)
    },
  })

  if (result.success) {
    void removeWorktreePrefixFromTitle(thread)
    await command.editReply(
      `Merged \`${result.branchName}\` into \`${result.defaultBranch}\` @ ${result.shortSha} (${result.commitCount} commit${result.commitCount === 1 ? '' : 's'})\nWorktree now at detached HEAD.`,
    )
    return
  }

  // Handle rebase conflicts by asking the AI agent to resolve them
  if (result.conflictType === 'rebase') {
    await command.editReply(
      `Rebase conflict detected. Asking the model to resolve...`,
    )

    await sendConflictResolutionPrompt({ thread, worktreeInfo, command, appId })

    await sendThreadMessage(
      thread,
      `Rebase conflict while merging into default branch. The model will attempt to resolve it.`,
    )
    return
  }

  await command.editReply(`Merge failed: ${result.error}`)
}
