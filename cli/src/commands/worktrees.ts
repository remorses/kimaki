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

// A single entry in `git worktree list --porcelain` output.
type GitWorktreeInfo = {
  path: string
  head: string
  // Short branch name (e.g. "main") extracted from "refs/heads/…".
  // null for detached HEAD or bare worktrees.
  branch: string | null
  bare: boolean
}

/**
 * Parse `git worktree list --porcelain` stdout into structured entries.
 * Each worktree block is separated by a blank line. Fields per block:
 *   worktree <path>
 *   HEAD <hash>
 *   branch refs/heads/<name>  | detached | bare
 */
export function parseGitWorktreeList(output: string): GitWorktreeInfo[] {
  const blocks = output.split(/\n\n+/).filter(Boolean)
  return blocks.flatMap((block) => {
    const lines = block.split('\n')
    let worktreePath: string | null = null
    let head: string | null = null
    let branch: string | null = null
    let bare = false
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        worktreePath = line.slice('worktree '.length)
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length)
      } else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length)
        branch = ref.replace(/^refs\/heads\//, '') || null
      } else if (line === 'bare') {
        bare = true
      }
    }
    if (!worktreePath || !head) {
      return []
    }
    return [{ path: worktreePath, head, branch, bare }]
  })
}

/**
 * Run `git worktree list --porcelain` inside projectDirectory and return
 * parsed entries. Returns null on git error/timeout.
 */
async function listAllGitWorktrees(
  projectDirectory: string,
): Promise<GitWorktreeInfo[] | null> {
  const result = await git(projectDirectory, 'worktree list --porcelain', {
    timeout: GIT_CMD_TIMEOUT,
  })
  if (typeof result !== 'string') {
    return null
  }
  return parseGitWorktreeList(result)
}

// A display entry is either a kimaki-managed worktree (from SQLite) or an
// external worktree discovered only from `git worktree list`.
type WorktreeDisplayEntry =
  | { kind: 'kimaki'; wt: ThreadWorktree }
  | {
      kind: 'external'
      path: string
      branch: string | null
      projectDirectory: string
    }

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
// Returns null when the directory is missing / git commands fail / timeout.
async function getWorktreeGitStatus({
  directory,
  defaultBranch,
}: {
  directory: string
  defaultBranch: string
}): Promise<WorktreeGitStatus | null> {
  try {
    // Use raw git calls so errors/timeouts are visible — isDirty() swallows
    // errors and returns false, which would render "merged" instead of "unknown".
    const [statusResult, aheadResult] = await Promise.all([
      git(directory, 'status --porcelain', { timeout: GIT_CMD_TIMEOUT }),
      git(directory, `rev-list --count "${defaultBranch}..HEAD"`, {
        timeout: GIT_CMD_TIMEOUT,
      }),
    ])
    if (typeof statusResult !== 'string' || typeof aheadResult !== 'string') {
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
  entries,
  gitStatuses,
  guildId,
}: {
  entries: WorktreeDisplayEntry[]
  gitStatuses: (WorktreeGitStatus | null)[]
  guildId: string
}): string {
  const header = '| Thread | Name | Status | Created | Folder | Action |'
  const separator = '|---|---|---|---|---|---|'
  const rows = entries.map((entry, i) => {
    const gs = gitStatuses[i] ?? null
    if (entry.kind === 'external') {
      const name = entry.branch ?? 'detached'
      const status = (() => {
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
      return `| - | ${name} | ${status} | - | ${entry.path} | - |`
    }
    const wt = entry.wt
    const threadLink = `[thread](https://discord.com/channels/${guildId}/${wt.thread_id})`
    const name = wt.worktree_name
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
    const action = buildActionCell({ entry, gitStatus: gs })
    return `| ${threadLink} | ${name} | ${status} | ${created} | ${folder} | ${action} |`
  })
  return [header, separator, ...rows].join('\n')
}

function buildActionCell({
  entry,
  gitStatus,
}: {
  entry: WorktreeDisplayEntry
  gitStatus: WorktreeGitStatus | null
}): string {
  if (!canDeleteWorktree({ entry, gitStatus })) {
    return '-'
  }
  // canDeleteWorktree returns false for non-kimaki entries, so entry.kind === 'kimaki' here.
  if (entry.kind !== 'kimaki') {
    return '-'
  }
  return buildDeleteButtonHtml({
    buttonId: `delete-worktree-${entry.wt.thread_id}`,
  })
}

function buildDeleteButtonHtml({ buttonId }: { buttonId: string }): string {
  return `<button id="${buttonId}" variant="secondary">Delete</button>`
}

function canDeleteWorktree({
  entry,
  gitStatus,
}: {
  entry: WorktreeDisplayEntry
  gitStatus: WorktreeGitStatus | null
}): boolean {
  // External worktrees have no thread_id / SQLite record — no delete support.
  if (entry.kind !== 'kimaki') {
    return false
  }
  const wt = entry.wt
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

// Returns the directory to run git status in for a display entry.
// Returns null for non-ready kimaki worktrees (skip git status).
function getEntryDirectory(entry: WorktreeDisplayEntry): string | null {
  if (entry.kind === 'external') {
    return entry.path
  }
  const wt = entry.wt
  if (wt.status !== 'ready' || !wt.worktree_directory) {
    return null
  }
  return wt.worktree_directory
}

function getEntryProjectDirectory(entry: WorktreeDisplayEntry): string {
  if (entry.kind === 'external') {
    return entry.projectDirectory
  }
  return entry.wt.project_directory
}

// Resolves git statuses for all display entries within a single global deadline.
// Caches getDefaultBranch per project_directory to avoid redundant spawns.
// Returns null for any entry whose git calls fail, timeout, or exceed
// the global deadline — the table renders those as "unknown".
async function resolveGitStatuses({
  entries,
  timeout,
}: {
  entries: WorktreeDisplayEntry[]
  timeout: number
}): Promise<(WorktreeGitStatus | null)[]> {
  const nullFallback = entries.map(() => null)

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
      ...new Set(entries.map((e) => getEntryProjectDirectory(e))),
    ]
    const defaultBranchEntries = await Promise.all(
      uniqueProjectDirs.map(async (dir) => {
        const branch = await getDefaultBranch(dir, { timeout: GIT_CMD_TIMEOUT })
        return [dir, branch] as const
      }),
    )
    const defaultBranchByProject = new Map(defaultBranchEntries)

    return Promise.all(
      entries.map((entry) => {
        const directory = getEntryDirectory(entry)
        if (!directory) {
          return Promise.resolve(null)
        }
        const defaultBranch =
          defaultBranchByProject.get(getEntryProjectDirectory(entry)) ?? 'main'
        return getWorktreeGitStatus({ directory, defaultBranch })
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

  const kimakiWorktrees = await getRecentWorktrees({ projectDirectory })

  // Build the set of directories already tracked by kimaki so we can skip
  // them when merging in external git worktrees (avoids duplicates).
  const kimakiDirs = new Set(
    kimakiWorktrees.flatMap((wt) =>
      wt.worktree_directory ? [wt.worktree_directory] : [],
    ),
  )

  // Fetch all git worktrees and build external entries for those not in SQLite.
  // Skip the main worktree (projectDirectory itself) — it is the base repo, not a feature branch.
  const gitWorktrees = await listAllGitWorktrees(projectDirectory)
  const externalEntries: WorktreeDisplayEntry[] = (gitWorktrees ?? []).flatMap(
    (gw) => {
      if (gw.path === projectDirectory || kimakiDirs.has(gw.path)) {
        return []
      }
      return [
        {
          kind: 'external' as const,
          path: gw.path,
          branch: gw.branch,
          projectDirectory,
        },
      ]
    },
  )

  const kimakiEntries: WorktreeDisplayEntry[] = kimakiWorktrees.map((wt) => ({
    kind: 'kimaki' as const,
    wt,
  }))

  // Kimaki-managed worktrees first (ordered by created_at desc from SQL), then external.
  const entries: WorktreeDisplayEntry[] = [...kimakiEntries, ...externalEntries]

  if (entries.length === 0) {
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
    entries,
    timeout: GLOBAL_TIMEOUT,
  })
  const deletableWorktreesByButtonId = new Map<string, ThreadWorktree>()
  entries.forEach((entry, index) => {
    if (entry.kind !== 'kimaki') {
      return
    }
    const gitStatus = gitStatuses[index] ?? null
    if (!canDeleteWorktree({ entry, gitStatus })) {
      return
    }
    deletableWorktreesByButtonId.set(
      `delete-worktree-${entry.wt.thread_id}`,
      entry.wt,
    )
  })

  const tableMarkdown = buildWorktreeTable({
    entries,
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
