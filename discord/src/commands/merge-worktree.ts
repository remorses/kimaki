// /merge-worktree command - Merge worktree commits into default branch.
// Uses worktrunk-style pipeline: squash -> rebase -> local push.
// On rebase conflicts, asks the AI model in the thread to resolve them.

import { type ThreadChannel } from 'discord.js'
import type { CommandContext } from './types.js'
import { getThreadWorktree, getThreadSession } from '../database.js'
import { createLogger, LogPrefix } from '../logger.js'
import { mergeWorktree } from '../worktree-utils.js'
import { sendThreadMessage, resolveWorkingDirectory } from '../discord-utils.js'
import { handleOpencodeSession, abortControllers, addToQueue } from '../session-handler.js'
import { RebaseConflictError, DirtyWorktreeError } from '../errors.js'

const logger = createLogger(LogPrefix.WORKTREE)

/** Worktree thread title prefix - indicates unmerged worktree */
export const WORKTREE_PREFIX = '⬦ '

async function removeWorktreePrefixFromTitle(thread: ThreadChannel): Promise<void> {
  if (!thread.name.startsWith(WORKTREE_PREFIX)) {
    return
  }
  const newName = thread.name.slice(WORKTREE_PREFIX.length)
  const timeoutMs = 5000
  await Promise.race([
    thread.setName(newName).catch((e) => {
      logger.warn(`Failed to update thread title: ${e instanceof Error ? e.message : String(e)}`)
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
  const sessionId = await getThreadSession(thread.id)
  const existingController = sessionId ? abortControllers.get(sessionId) : null
  const hasActiveRequest = Boolean(existingController && !existingController.signal.aborted)

  if (hasActiveRequest) {
    addToQueue({
      threadId: thread.id,
      message: {
        prompt,
        userId: command.user.id,
        username: command.user.displayName,
        queuedAt: Date.now(),
        appId,
      },
    })
    logger.log(`[merge] Queued prompt (session active)`)
    return
  }

  const resolved = await resolveWorkingDirectory({ channel: thread })
  handleOpencodeSession({
    prompt,
    thread,
    projectDirectory: resolved?.projectDirectory || projectDirectory,
    channelId: thread.parentId || thread.id,
    username: command.user.displayName,
    userId: command.user.id,
    appId,
  }).catch((e) => {
    logger.error(`[merge] Failed to send prompt to model:`, e)
    sendThreadMessage(
      thread,
      `Failed to send prompt: ${e instanceof Error ? e.message : String(e)}`,
    ).catch(() => {})
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

  const result = await mergeWorktree({
    worktreeDir: worktreeInfo.worktree_directory,
    mainRepoDir: worktreeInfo.project_directory,
    worktreeName: worktreeInfo.worktree_name,
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
      await command.editReply('Rebase conflict detected. Asking the model to resolve...')
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
