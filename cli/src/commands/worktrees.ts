// /worktrees command — list worktree sessions for the current channel's project.
// Renders a markdown table that the CV2 pipeline auto-formats for Discord,
// including HTML-backed action buttons for deletable worktrees.
//
// Lists ALL git worktrees for the project, not only kimaki-managed ones.
// Kimaki-tracked worktrees come from the local SQLite thread_worktrees table
// (with thread links and delete buttons). External worktrees (created manually
// with `git worktree add`) come from `git worktree list --porcelain` and appear
// with their branch/path but no thread link or delete button.

import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  ChannelType,
  ComponentType,
  MessageFlags,
  type TextChannel,
  type ThreadChannel,
  type APIMessageTopLevelComponent,
  type APITextDisplayComponent,
  type InteractionEditReplyOptions,
} from 'discord.js'
import {
  deleteThreadWorktree,
  getThreadWorktree,
  type ThreadWorktree,
} from '../database.js'
import { getPrisma } from '../db.js'
import { splitTablesFromMarkdown } from '../format-tables.js'
import {
  buildHtmlActionCustomId,
  cancelHtmlActionsForOwner,
  registerHtmlAction,
} from '../html-actions.js'
import * as errore from 'errore'
import { GitCommandError } from '../errors.js'
import { resolveWorkingDirectory } from '../discord-utils.js'
import { deleteWorktree, git, getDefaultBranch } from '../worktrees.js'

// Extracts the git stderr from a deleteWorktree error via errore.findCause.
// Chain: Error { cause: GitCommandError { cause: CommandError { stderr } } }.
export function extractGitStderr(error: Error): string | undefined {
  const gitErr = errore.findCause(error, GitCommandError)
  const stderr = (
    gitErr?.cause as { stderr?: string } | undefined
  )?.stderr?.trim()
  if (stderr && stderr.length > 0) {
    return stderr
  }
  return undefined
}

export function formatTimeAgo(date: Date): string {
  const diffMs = Date.now() - date.getTime()
  if (diffMs < 0) {
    return 'just now'
  }
  const totalSeconds = Math.floor(diffMs / 1000)
  if (totalSeconds < 60) {
    return `${totalSeconds}s ago`
  }
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) {
    return `${totalMinutes}m ago`
  }
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours < 24) {
    return minutes > 0 ? `${hours}h ${minutes}m ago` : `${hours}h ago`
  }
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours > 0 ? `${days}d ${remainingHours}h ago` : `${days}d ago`
}

function statusLabel(wt: ThreadWorktree): string {
  if (wt.status === 'ready') {
    return 'ready'
  }
  if (wt.status === 'error') {
    return 'error'
  }
  return 'pending'
}

type WorktreeGitStatus = {
  dirty: boolean
  aheadCount: number
}

type WorktreesReplyTarget = {
  guildId: string
  userId: string
  channelId: string
  projectDirectory: string
  notice?: string
  editReply: (options: string | InteractionEditReplyOptions) => Promise<unknown>
}

// 5s timeout per git call — prevents hangs from deleted dirs, git locks, slow disks.
// Returns null on timeout/error so the table shows "unknown" for that worktree.
const GIT_CMD_TIMEOUT = 5_000
const GLOBAL_TIMEOUT = 10_000

// Checks dirty state and commits ahead of default branch in parallel.
// Returns null for worktrees that aren't ready or when the directory is
// missing / git commands fail / timeout (e.g. deleted worktree folder).
async function getWorktreeGitStatus({
  wt,
  defaultBranch,
}: {
  wt: ThreadWorktree
  defaultBranch: string
}): Promise<WorktreeGitStatus | null> {
  if (wt.status !== 'ready' || !wt.worktree_directory) {
    return null
  }
  try {
    const dir = wt.worktree_directory
    // Use raw git calls so errors/timeouts are visible — isDirty() swallows
    // errors and returns false, which would render "merged" instead of "unknown".
    const [statusResult, aheadResult] = await Promise.all([
      git(dir, 'status --porcelain', { timeout: GIT_CMD_TIMEOUT }),
      git(dir, `rev-list --count "${defaultBranch}..HEAD"`, {
        timeout: GIT_CMD_TIMEOUT,
      }),
    ])
    if (statusResult instanceof Error || aheadResult instanceof Error) {
      return null
    }
    const aheadCount = parseInt(aheadResult, 10)
    if (!Number.isFinite(aheadCount)) {
      return null
    }
    return { dirty: statusResult.length > 0, aheadCount }
  } catch {
    return null
  }
}

function buildWorktreeTable({
  worktrees,
  gitStatuses,
  guildId,
}: {
  worktrees: ThreadWorktree[]
  gitStatuses: (WorktreeGitStatus | null)[]
  guildId: string
}): string {
  const header = '| Thread | Name | Status | Created | Folder | Action |'
  const separator = '|---|---|---|---|---|---|'
  const rows = worktrees.map((wt, i) => {
    const threadLink = `[thread](https://discord.com/channels/${guildId}/${wt.thread_id})`
    const name = wt.worktree_name
    const gs = gitStatuses[i] ?? null
    const status = (() => {
      if (wt.status !== 'ready') {
        return statusLabel(wt)
      }
      if (!gs) {
        return 'unknown'
      }
      const parts: string[] = []
      if (gs.dirty) {
        parts.push('dirty')
      }
      if (gs.aheadCount > 0) {
        parts.push(`${gs.aheadCount} ahead`)
      } else {
        parts.push('merged')
      }
      return parts.join(', ')
    })()
    const created = wt.created_at ? formatTimeAgo(wt.created_at) : 'unknown'
    const folder = wt.worktree_directory ?? wt.project_directory
    const action = buildActionCell({ wt, gitStatus: gs })
    return `| ${threadLink} | ${name} | ${status} | ${created} | ${folder} | ${action} |`
  })
  return [header, separator, ...rows].join('\n')
}

function buildActionCell({
  wt,
  gitStatus,
}: {
  wt: ThreadWorktree
  gitStatus: WorktreeGitStatus | null
}): string {
  if (!canDeleteWorktree({ wt, gitStatus })) {
    return '-'
  }

  return buildDeleteButtonHtml({
    buttonId: `delete-worktree-${wt.thread_id}`,
  })
}

function buildDeleteButtonHtml({ buttonId }: { buttonId: string }): string {
  return `<button id="${buttonId}" variant="secondary">Delete</button>`
}

function canDeleteWorktree({
  wt,
  gitStatus,
}: {
  wt: ThreadWorktree
  gitStatus: WorktreeGitStatus | null
}): boolean {
  if (wt.status !== 'ready' || !wt.worktree_directory) {
    return false
  }
  if (!gitStatus) {
    return false
  }
  if (gitStatus.dirty) {
    return false
  }
  return gitStatus.aheadCount === 0
}

// Resolves git statuses for all worktrees within a single global deadline.
// Caches getDefaultBranch per project_directory to avoid redundant spawns.
// Returns null for any worktree whose git calls fail, timeout, or exceed
// the global deadline — the table renders those as "unknown".
async function resolveGitStatuses({
  worktrees,
  timeout,
}: {
  worktrees: ThreadWorktree[]
  timeout: number
}): Promise<(WorktreeGitStatus | null)[]> {
  const nullFallback = worktrees.map(() => null)

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<(WorktreeGitStatus | null)[]>((resolve) => {
    timer = setTimeout(() => {
      resolve(nullFallback)
    }, timeout)
  })

  const work = (async () => {
    // Resolve default branch once per unique project directory (avoids
    // redundant git subprocess spawns when multiple worktrees share a project).
    const uniqueProjectDirs = [
      ...new Set(worktrees.map((wt) => wt.project_directory)),
    ]
    const defaultBranchEntries = await Promise.all(
      uniqueProjectDirs.map(async (dir) => {
        const branch = await getDefaultBranch(dir, { timeout: GIT_CMD_TIMEOUT })
        return [dir, branch] as const
      }),
    )
    const defaultBranchByProject = new Map(defaultBranchEntries)

    return Promise.all(
      worktrees.map((wt) => {
        const defaultBranch =
          defaultBranchByProject.get(wt.project_directory) ?? 'main'
        return getWorktreeGitStatus({ wt, defaultBranch })
      }),
    )
  })()

  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

async function getRecentWorktrees({
  projectDirectory,
}: {
  projectDirectory: string
}): Promise<ThreadWorktree[]> {
  const prisma = await getPrisma()
  return await prisma.thread_worktrees.findMany({
    where: {
      project_directory: projectDirectory,
    },
    orderBy: { created_at: 'desc' },
    take: 10,
  })
}

function getWorktreesActionOwnerKey({
  userId,
  channelId,
}: {
  userId: string
  channelId: string
}): string {
  return `worktrees:${userId}:${channelId}`
}

function isProjectChannel(
  channel:
    | ChatInputCommandInteraction['channel']
    | ButtonInteraction['channel'],
): boolean {
  if (!channel) {
    return false
  }

  return [
    ChannelType.GuildText,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel.type)
}

async function renderWorktreesReply({
  guildId,
  userId,
  channelId,
  projectDirectory,
  notice,
  editReply,
}: WorktreesReplyTarget): Promise<void> {
  const ownerKey = getWorktreesActionOwnerKey({ userId, channelId })
  cancelHtmlActionsForOwner(ownerKey)

  const worktrees = await getRecentWorktrees({ projectDirectory })
  if (worktrees.length === 0) {
    const message = notice
      ? `${notice}\n\nNo worktrees found.`
      : 'No worktrees found.'
    const textDisplay: APITextDisplayComponent = {
      type: ComponentType.TextDisplay,
      content: message,
    }
    await editReply({
      components: [textDisplay],
      flags: MessageFlags.IsComponentsV2,
    })
    return
  }

  const gitStatuses = await resolveGitStatuses({
    worktrees,
    timeout: GLOBAL_TIMEOUT,
  })
  const deletableWorktreesByButtonId = new Map<string, ThreadWorktree>()
  worktrees.forEach((wt, index) => {
    const gitStatus = gitStatuses[index] ?? null
    if (!canDeleteWorktree({ wt, gitStatus })) {
      return
    }
    deletableWorktreesByButtonId.set(`delete-worktree-${wt.thread_id}`, wt)
  })

  const tableMarkdown = buildWorktreeTable({
    worktrees,
    gitStatuses,
    guildId,
  })
  const markdown = notice ? `${notice}\n\n${tableMarkdown}` : tableMarkdown
  const segments = splitTablesFromMarkdown(markdown, {
    resolveButtonCustomId: ({ button }) => {
      const worktree = deletableWorktreesByButtonId.get(button.id)
      if (!worktree) {
        return new Error(`No worktree registered for button ${button.id}`)
      }

      const actionId = registerHtmlAction({
        ownerKey,
        threadId: worktree.thread_id,
        run: async ({ interaction }) => {
          await handleDeleteWorktreeAction({
            interaction,
            threadId: worktree.thread_id,
          })
        },
      })
      return buildHtmlActionCustomId(actionId)
    },
  })

  const components: APIMessageTopLevelComponent[] = segments.flatMap(
    (segment) => {
      if (segment.type === 'components') {
        return segment.components
      }

      const textDisplay: APITextDisplayComponent = {
        type: ComponentType.TextDisplay,
        content: segment.text,
      }
      return [textDisplay]
    },
  )

  await editReply({
    components,
    flags: MessageFlags.IsComponentsV2,
  })
}

async function handleDeleteWorktreeAction({
  interaction,
  threadId,
}: {
  interaction: ButtonInteraction
  threadId: string
}): Promise<void> {
  const guildId = interaction.guildId
  if (!guildId) {
    await interaction.editReply({
      components: [
        {
          type: ComponentType.TextDisplay,
          content: 'This action can only be used in a server.',
        },
      ],
      flags: MessageFlags.IsComponentsV2,
    })
    return
  }

  const worktree = await getThreadWorktree(threadId)
  if (!worktree) {
    if (!isProjectChannel(interaction.channel)) {
      await interaction.editReply({
        components: [
          {
            type: ComponentType.TextDisplay,
            content:
              'This action can only be used in a project channel or thread.',
          },
        ],
        flags: MessageFlags.IsComponentsV2,
      })
      return
    }

    const resolved = await resolveWorkingDirectory({
      channel: interaction.channel as TextChannel | ThreadChannel,
    })
    if (!resolved) {
      await interaction.editReply({
        components: [
          {
            type: ComponentType.TextDisplay,
            content: 'Could not determine the project folder for this channel.',
          },
        ],
        flags: MessageFlags.IsComponentsV2,
      })
      return
    }

    await renderWorktreesReply({
      guildId,
      userId: interaction.user.id,
      channelId: interaction.channelId,
      projectDirectory: resolved.projectDirectory,
      notice: 'Worktree was already removed.',
      editReply: (options) => {
        return interaction.editReply(options)
      },
    })
    return
  }

  if (worktree.status !== 'ready' || !worktree.worktree_directory) {
    await renderWorktreesReply({
      guildId,
      userId: interaction.user.id,
      channelId: interaction.channelId,
      projectDirectory: worktree.project_directory,
      notice: `Cannot delete \`${worktree.worktree_name}\` because it is ${worktree.status}.`,
      editReply: (options) => {
        return interaction.editReply(options)
      },
    })
    return
  }

  const deleteResult = await deleteWorktree({
    projectDirectory: worktree.project_directory,
    worktreeDirectory: worktree.worktree_directory,
    worktreeName: worktree.worktree_name,
  })
  if (deleteResult instanceof Error) {
    // Send error as a separate ephemeral follow-up so the table stays intact.
    // Dig into cause chain to surface the actual git stderr when available.
    const gitStderr = extractGitStderr(deleteResult)
    const detail = gitStderr
      ? `\`\`\`\n${gitStderr}\n\`\`\``
      : deleteResult.message
    await interaction
      .followUp({
        content: `Failed to delete \`${worktree.worktree_name}\`\n${detail}`,
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {
        return undefined
      })
    return
  }

  await deleteThreadWorktree(threadId)
  await renderWorktreesReply({
    guildId,
    userId: interaction.user.id,
    channelId: interaction.channelId,
    projectDirectory: worktree.project_directory,
    notice: `Deleted \`${worktree.worktree_name}\`.`,
    editReply: (options) => {
      return interaction.editReply(options)
    },
  })
}

export async function handleWorktreesCommand({
  command,
}: {
  command: ChatInputCommandInteraction
  appId: string
}): Promise<void> {
  const channel = command.channel
  const guildId = command.guildId
  if (!guildId || !channel) {
    await command.reply({
      content: 'This command can only be used in a server channel.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  if (!isProjectChannel(channel)) {
    await command.reply({
      content: 'This command can only be used in a project channel or thread.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const resolved = await resolveWorkingDirectory({
    channel: channel as TextChannel | ThreadChannel,
  })
  if (!resolved) {
    await command.reply({
      content: 'Could not determine the project folder for this channel.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await command.deferReply({ flags: MessageFlags.Ephemeral })
  await renderWorktreesReply({
    guildId,
    userId: command.user.id,
    channelId: command.channelId,
    projectDirectory: resolved.projectDirectory,
    editReply: (options) => {
      return command.editReply(options)
    },
  })
}
