// Daily async loop that prompts users about old Kimaki threads.
//
// For worktree threads:
//   - Checks if the worktree branch has been merged (0 commits ahead of default branch)
//     and has no uncommitted changes
//   - If merged and clean: sends a message with "Clean up worktree & archive" / "Dismiss" buttons
//   - On confirm: removes the worktree on disk and archives the thread
//
// For non-worktree threads:
//   - Checks if the thread is older than 2 days
//   - If stale: sends a message with "Archive thread" / "Dismiss" buttons
//   - On confirm: archives the thread

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Routes,
  type ButtonInteraction,
  type Client,
  type REST,
} from 'discord.js'
import fs from 'node:fs'
import {
  getAllThreadIds,
  getThreadWorktree,
  getThreadCreatedAt,
  getCleanupPromptedAt,
  setCleanupPromptedAt,
  deleteThreadWorktree,
} from './database.js'
import { git, isDirty, getDefaultBranch, deleteWorktree } from './worktrees.js'
import { registerHtmlAction, pendingHtmlActions } from './html-actions.js'
import { createLogger, formatErrorWithStack } from './logger.js'

const cleanupLogger = createLogger('CLEANUP')

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000
const CLEANUP_ACTION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const REPROMPT_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000
const NEVER_REPROMPT_AT = new Date('9999-12-31T00:00:00Z')

export function startThreadCleanupSweeper({
  discordClient,
  sweepIntervalMs = SWEEP_INTERVAL_MS,
}: {
  discordClient: Client
  sweepIntervalMs?: number
}): () => Promise<void> {
  let stopped = false
  let sweeping = false
  let sweepPromise: Promise<void> | null = null

  const sweep = async () => {
    if (stopped || sweeping) return
    sweeping = true

    const currentSweepPromise = (async () => {
      const rest = discordClient.rest
      const threadIds = await getAllThreadIds()
      cleanupLogger.log(`Cleanup sweep: evaluating ${threadIds.length} thread(s)`)

      for (const threadId of threadIds) {
        if (stopped) break
        try {
          await evaluateThreadForCleanup({
            threadId,
            rest,
          })
        } catch (error) {
          cleanupLogger.error(`Error evaluating thread ${threadId}:`, formatErrorWithStack(error))
        }
      }

      cleanupLogger.log('Cleanup sweep complete')
    })()

    sweepPromise = currentSweepPromise
    await currentSweepPromise.finally(() => {
      sweeping = false
      sweepPromise = null
    })
  }

  setTimeout(() => void sweep(), 60_000)
  const interval = setInterval(() => void sweep(), sweepIntervalMs)

  cleanupLogger.log(`Thread cleanup sweeper started (interval=${sweepIntervalMs}ms)`)

  return async () => {
    if (stopped) return
    stopped = true
    clearInterval(interval)
    if (sweepPromise) {
      await sweepPromise
      sweepPromise = null
    }
    cleanupLogger.log('Thread cleanup sweeper stopped')
  }
}

function hasPendingCleanupAction(threadId: string): boolean {
  for (const [, action] of pendingHtmlActions) {
    if (action.threadId === threadId && action.ownerKey === `cleanup:${threadId}`) {
      return true
    }
  }
  return false
}

export async function evaluateThreadForCleanup({
  threadId,
  rest,
}: {
  threadId: string
  rest: REST
}): Promise<void> {
  if (hasPendingCleanupAction(threadId)) return

  const lastPrompted = await getCleanupPromptedAt(threadId)
  if (lastPrompted && Date.now() - lastPrompted.getTime() < REPROMPT_COOLDOWN_MS) return

  if (await isThreadArchived({ rest, threadId })) {
    await setCleanupPromptedAt(threadId, NEVER_REPROMPT_AT).catch(() => undefined)
    return
  }

  const worktree = await getThreadWorktree(threadId)

  if (worktree) {
    await evaluateWorktreeThread({ threadId, worktree, rest })
  } else {
    await evaluateNormalThread({ threadId, rest })
  }
}

async function isThreadArchived({
  rest,
  threadId,
}: {
  rest: REST
  threadId: string
}): Promise<boolean> {
  try {
    const channel = (await rest.get(Routes.channel(threadId))) as { archived?: boolean } | null
    return Boolean(channel?.archived)
  } catch {
    return false
  }
}

async function evaluateWorktreeThread({
  threadId,
  worktree,
  rest,
}: {
  threadId: string
  worktree: {
    worktree_directory: string | null
    project_directory: string
    worktree_name: string
  }
  rest: REST
}): Promise<void> {
  if (!worktree.worktree_directory) return

  const createdAt = await getThreadCreatedAt(threadId)
  if (createdAt && Date.now() - createdAt.getTime() < TWO_DAYS_MS) return

  const worktreeDir = worktree.worktree_directory
  const projectDir = worktree.project_directory

  let dirExists: boolean
  try {
    await fs.promises.access(worktreeDir)
    dirExists = true
  } catch {
    dirExists = false
  }

  const isMerged = dirExists
    ? await isWorktreeMergedAndClean({
        worktreeDir,
        projectDir,
        threadId,
      })
    : true

  if (!isMerged) return

  const cleanupActionId = registerHtmlAction({
    ownerKey: `cleanup:${threadId}`,
    threadId,
    ttlMs: CLEANUP_ACTION_TTL_MS,
    run: async ({ interaction }) => {
      await interaction.editReply({
        content: 'Cleanup in progress...',
        components: [],
      })

      if (dirExists) {
        const delResult = await deleteWorktree({
          projectDirectory: projectDir,
          worktreeDirectory: worktreeDir,
          worktreeName: worktree.worktree_name,
        })
        if (delResult instanceof Error) {
          cleanupLogger.error(
            `Failed to delete worktree ${worktree.worktree_name}: ${delResult.message}`,
          )
          await interaction.followUp({
            content: `Failed to clean up worktree: ${delResult.message}`,
            flags: 64,
          })
          return
        }
      }

      await deleteThreadWorktree(threadId)
      await setCleanupPromptedAt(threadId, NEVER_REPROMPT_AT).catch(() => undefined)

      try {
        await rest.patch(Routes.channel(threadId), {
          body: { archived: true },
        })
        await interaction.editReply({
          content: 'Worktree cleaned up and thread archived.',
          components: [],
        })
      } catch (archiveError) {
        cleanupLogger.warn(
          `Failed to archive thread ${threadId} after cleanup:`,
          formatErrorWithStack(archiveError),
        )
        await interaction.editReply({
          content: 'Worktree cleaned up but failed to archive thread.',
          components: [],
        })
      }
    },
  })

  const dismissActionId = registerHtmlAction({
    ownerKey: `cleanup:${threadId}`,
    threadId,
    ttlMs: CLEANUP_ACTION_TTL_MS,
    run: async ({ interaction }) => {
      await setCleanupPromptedAt(threadId, NEVER_REPROMPT_AT).catch(() => undefined)
      await interaction.editReply({
        content: dirExists ? 'Worktree cleanup dismissed.' : 'Archive dismissed.',
        components: [],
      })
    },
  })

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`html_action:${cleanupActionId}`)
      .setLabel('Clean up worktree & archive')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`html_action:${dismissActionId}`)
      .setLabel('Dismiss')
      .setStyle(ButtonStyle.Secondary),
  )

  try {
    await rest.post(Routes.channelMessages(threadId), {
      body: {
        content: dirExists
          ? 'Your worktree changes have been merged into the default branch. Clean up the worktree and archive this thread?'
          : 'The worktree directory for this thread no longer exists. Archive this thread?',
        components: [row],
      },
    })
    cleanupLogger.log(`Sent cleanup prompt for worktree thread ${threadId}`)
  } catch {
    cleanupLogger.log(`Could not send cleanup prompt for thread ${threadId} (may be archived)`)
  }
}

async function isWorktreeMergedAndClean({
  worktreeDir,
  projectDir,
  threadId,
}: {
  worktreeDir: string
  projectDir: string
  threadId: string
}): Promise<boolean> {
  const dirty = await isDirty(worktreeDir)
  if (dirty) return false

  const defaultBranch = await getDefaultBranch(projectDir)
  const mergeBase = await git(worktreeDir, `merge-base HEAD "${defaultBranch}"`)
  if (mergeBase instanceof Error) {
    cleanupLogger.warn(`Cannot check merge status for ${threadId}: ${mergeBase.message}`)
    return false
  }

  const commitCountResult = await git(worktreeDir, `rev-list --count "${mergeBase}..HEAD"`)
  if (commitCountResult instanceof Error) {
    cleanupLogger.warn(`Cannot check commit count for ${threadId}: ${commitCountResult.message}`)
    return false
  }

  return parseInt(commitCountResult, 10) === 0
}

async function evaluateNormalThread({
  threadId,
  rest,
}: {
  threadId: string
  rest: REST
}): Promise<void> {
  const createdAt = await getThreadCreatedAt(threadId)
  if (!createdAt) return

  const age = Date.now() - createdAt.getTime()
  if (age < TWO_DAYS_MS) return

  const archiveActionId = registerHtmlAction({
    ownerKey: `cleanup:${threadId}`,
    threadId,
    ttlMs: CLEANUP_ACTION_TTL_MS,
    run: async ({ interaction }) => {
      await interaction.editReply({
        content: 'Archiving thread...',
        components: [],
      })

      try {
        await rest.patch(Routes.channel(threadId), {
          body: { archived: true },
        })
        await setCleanupPromptedAt(threadId, NEVER_REPROMPT_AT).catch(() => undefined)
        await interaction.editReply({
          content: 'Thread archived.',
          components: [],
        })
      } catch (archiveError) {
        cleanupLogger.warn(
          `Failed to archive thread ${threadId}:`,
          formatErrorWithStack(archiveError),
        )
        await interaction.editReply({
          content: 'Failed to archive thread.',
          components: [],
        })
      }
    },
  })

  const dismissActionId = registerHtmlAction({
    ownerKey: `cleanup:${threadId}`,
    threadId,
    ttlMs: CLEANUP_ACTION_TTL_MS,
    run: async ({ interaction }) => {
      await setCleanupPromptedAt(threadId, NEVER_REPROMPT_AT).catch(() => undefined)
      await interaction.editReply({
        content: 'Prompt dismissed.',
        components: [],
      })
    },
  })

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`html_action:${archiveActionId}`)
      .setLabel('Archive thread')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`html_action:${dismissActionId}`)
      .setLabel('Dismiss')
      .setStyle(ButtonStyle.Secondary),
  )

  try {
    await rest.post(Routes.channelMessages(threadId), {
      body: {
        content:
          'This thread has been inactive for over 2 days. Archive it to keep things tidy?\nYou can resume anytime by sending a message here.',
        components: [row],
      },
    })
    cleanupLogger.log(`Sent archive prompt for inactive thread ${threadId}`)
  } catch {
    cleanupLogger.log(`Could not send archive prompt for thread ${threadId} (may be archived)`)
  }
}
