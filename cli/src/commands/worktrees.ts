// /worktrees command — list all git worktrees for the current channel's project.
// Uses `git worktree list --porcelain` as source of truth, enriched with
// DB metadata (thread link, created_at) when available. Shows kimaki-created,
// opencode-created, and manually created worktrees in a single table.
// Renders a markdown table that the CV2 pipeline auto-formats for Discord,
// including HTML-backed action buttons for deletable worktrees.

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
import crypto from 'node:crypto'
import { GitCommandError } from '../errors.js'
import { resolveWorkingDirectory } from '../discord-utils.js'
import {
  deleteWorktree,
  git,
  getDefaultBranch,
  listGitWorktrees,
  type GitWorktree,
} from '../worktrees.js'
import path from 'node:path'

// Extracts the git stderr from a deleteWorktree error via errore.findCause.
// Chain: Error { cause: GitCommandError { cause: CommandError { stderr } } }.
export function extractGitStderr(error: Error): string | undefined {
  const gitErr = errore.findCause(error, GitCommandError)
  const stderr = (gitErr?.cause as { stderr?: string } | undefined)?.stderr?.trim()
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

// Stable button ID derived from directory path via sha1 hash.
// Avoids collisions that truncated path suffixes can cause.
function worktreeButtonKey(directory: string): string {
  return crypto.createHash('sha1').update(directory).digest('hex').slice(0, 12)
}

// Unified worktree row that merges git data with optional DB metadata.
type WorktreeRow = {
  directory: string
  branch: string | null
  name: string
  threadId: string | null
  guildId: string | null
  createdAt: Date | null
  source: 'kimaki' | 'opencode' | 'manual'
  // DB-only worktrees (pending/error) won't appear in git list
  dbStatus: 'ready' | 'pending' | 'error'
  // Git-level flags that block deletion
  locked: boolean
  prunable: boolean
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
  editReply: (
    options: string | InteractionEditReplyOptions,
  ) => Promise<unknown>
}

// 5s timeout per git call — prevents hangs from deleted dirs, git locks, slow disks.
// Returns null on timeout/error so the table shows "unknown" for that worktree.
const GIT_CMD_TIMEOUT = 5_000
const GLOBAL_TIMEOUT = 10_000

// Detect worktree source from branch name and directory path.
// opencode/kimaki-* branches → kimaki, opencode worktree paths → opencode, else manual.
function detectWorktreeSource({
  branch,
  directory,
}: {
  branch: string | null
  directory: string
}): 'kimaki' | 'opencode' | 'manual' {
  if (branch?.startsWith('opencode/kimaki-')) {
    return 'kimaki'
  }
  // opencode stores worktrees under ~/.local/share/opencode/worktree/
  if (directory.includes('/opencode/worktree/')) {
    return 'opencode'
  }
  return 'manual'
}

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
  rows,
  gitStatuses,
  guildId,
}: {
  rows: WorktreeRow[]
  gitStatuses: (WorktreeGitStatus | null)[]
  guildId: string
}): string {
  const header = '| Source | Name | Status | Created | Folder | Action |'
  const separator = '|---|---|---|---|---|---|'
  const tableRows = rows.map((row, i) => {
    const sourceCell = (() => {
      if (row.threadId && row.guildId) {
        const threadLink = `[${row.source}](https://discord.com/channels/${row.guildId}/${row.threadId})`
        return threadLink
      }
      return row.source
    })()
    const name = row.name
    const gs = gitStatuses[i] ?? null
    const status = (() => {
      if (row.dbStatus !== 'ready') {
        return row.dbStatus
      }
      if (row.locked) {
        return 'locked'
      }
      if (row.prunable) {
        return 'prunable'
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
    const created = row.createdAt ? formatTimeAgo(row.createdAt) : '-'
    const folder = row.directory
    const action = buildActionCell({ row, gitStatus: gs })
    return `| ${sourceCell} | ${name} | ${status} | ${created} | ${folder} | ${action} |`
  })
  return [header, separator, ...tableRows].join('\n')
}

function buildActionCell({
  row,
  gitStatus,
}: {
  row: WorktreeRow
  gitStatus: WorktreeGitStatus | null
}): string {
  if (!canDeleteWorktree({ row, gitStatus })) {
    return '-'
  }
  return buildDeleteButtonHtml({
    buttonId: `del-wt-${worktreeButtonKey(row.directory)}`,
  })
}

function buildDeleteButtonHtml({
  buttonId,
}: {
  buttonId: string
}): string {
  return `<button id="${buttonId}" variant="secondary">Delete</button>`
}

function canDeleteWorktree({
  row,
  gitStatus,
}: {
  row: WorktreeRow
  gitStatus: WorktreeGitStatus | null
}): boolean {
  if (row.dbStatus !== 'ready') {
    return false
  }
  if (row.locked) {
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
async function resolveGitStatuses({
  rows,
  projectDirectory,
  timeout,
}: {
  rows: WorktreeRow[]
  projectDirectory: string
  timeout: number
}): Promise<(WorktreeGitStatus | null)[]> {
  const nullFallback = rows.map(() => null)

  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<(WorktreeGitStatus | null)[]>((resolve) => {
    timer = setTimeout(() => {
      resolve(nullFallback)
    }, timeout)
  })

  const work = (async () => {
    const defaultBranch = await getDefaultBranch(projectDirectory, {
      timeout: GIT_CMD_TIMEOUT,
    })

    return Promise.all(
      rows.map((row) => {
        if (row.dbStatus !== 'ready' || row.locked || row.prunable) {
          return null
        }
        return getWorktreeGitStatus({ directory: row.directory, defaultBranch })
      }),
    )
  })()

  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

// Merge git worktrees with DB metadata into unified WorktreeRows.
// Git is the source of truth for what exists on disk. DB rows that aren't
// in the git list (pending/error) are appended at the end.
async function buildWorktreeRows({
  projectDirectory,
  gitWorktrees,
}: {
  projectDirectory: string
  gitWorktrees: GitWorktree[]
}): Promise<WorktreeRow[]> {
  const prisma = await getPrisma()
  const dbWorktrees = await prisma.thread_worktrees.findMany({
    where: { project_directory: projectDirectory },
  })

  // Index DB worktrees by directory for fast lookup
  const dbByDirectory = new Map<string, ThreadWorktree>()
  for (const dbWt of dbWorktrees) {
    if (dbWt.worktree_directory) {
      dbByDirectory.set(dbWt.worktree_directory, dbWt)
    }
  }

  // Track which DB rows got matched so we can append unmatched ones
  const matchedDbThreadIds = new Set<string>()

  // Build rows from git worktrees (the source of truth for on-disk state).
  // Use real DB status when available — a git-visible worktree whose DB row
  // is still 'pending' means setup hasn't finished (race window).
  const gitRows: WorktreeRow[] = gitWorktrees.map((gw) => {
    const dbMatch = dbByDirectory.get(gw.directory)
    if (dbMatch) {
      matchedDbThreadIds.add(dbMatch.thread_id)
    }
    const source = detectWorktreeSource({
      branch: gw.branch,
      directory: gw.directory,
    })
    const name = gw.branch ?? path.basename(gw.directory)
    const dbStatus: 'ready' | 'pending' | 'error' = (() => {
      if (!dbMatch) {
        return 'ready'
      }
      if (dbMatch.status === 'error') {
        return 'error'
      }
      if (dbMatch.status === 'pending') {
        return 'pending'
      }
      return 'ready'
    })()
    return {
      directory: gw.directory,
      branch: gw.branch,
      name,
      threadId: dbMatch?.thread_id ?? null,
      guildId: null, // filled in by caller
      createdAt: dbMatch?.created_at ?? null,
      source,
      dbStatus,
      locked: gw.locked,
      prunable: gw.prunable,
    }
  })

  // Append DB-only worktrees (pending/error/stale — not visible to git).
  // Preserve actual DB status so stale 'ready' rows show as 'ready' (missing).
  const dbOnlyRows: WorktreeRow[] = dbWorktrees
    .filter((dbWt) => {
      return !matchedDbThreadIds.has(dbWt.thread_id)
    })
    .map((dbWt) => {
      const dbStatus: 'ready' | 'pending' | 'error' = (() => {
        if (dbWt.status === 'error') {
          return 'error'
        }
        if (dbWt.status === 'pending') {
          return 'pending'
        }
        return 'ready'
      })()
      return {
        directory: dbWt.worktree_directory ?? dbWt.project_directory,
        branch: null,
        name: dbWt.worktree_name,
        threadId: dbWt.thread_id,
        guildId: null,
        createdAt: dbWt.created_at,
        source: 'kimaki' as const,
        dbStatus,
        locked: false,
        prunable: false,
      }
    })

  return [...gitRows, ...dbOnlyRows]
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
  channel: ChatInputCommandInteraction['channel'] | ButtonInteraction['channel'],
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

  const gitWorktrees = await listGitWorktrees({
    projectDirectory,
    timeout: GIT_CMD_TIMEOUT,
  })
  // On git failure, fall back to empty list (DB-only rows still shown)
  const gitList = gitWorktrees instanceof Error ? [] : gitWorktrees

  const rows = await buildWorktreeRows({ projectDirectory, gitWorktrees: gitList })
  // Inject guildId into all rows for thread link rendering
  for (const row of rows) {
    row.guildId = guildId
  }

  if (rows.length === 0) {
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
    rows,
    projectDirectory,
    timeout: GLOBAL_TIMEOUT,
  })

  // Map deletable worktrees by button ID for the HTML action resolver.
  // Uses the same worktreeButtonKey() as buildActionCell.
  const deletableRowsByButtonId = new Map<string, WorktreeRow>()
  rows.forEach((row, index) => {
    const gitStatus = gitStatuses[index] ?? null
    if (!canDeleteWorktree({ row, gitStatus })) {
      return
    }
    deletableRowsByButtonId.set(`del-wt-${worktreeButtonKey(row.directory)}`, row)
  })

  const tableMarkdown = buildWorktreeTable({
    rows,
    gitStatuses,
    guildId,
  })
  const markdown = notice ? `${notice}\n\n${tableMarkdown}` : tableMarkdown
  const segments = splitTablesFromMarkdown(markdown, {
    resolveButtonCustomId: ({ button }) => {
      const row = deletableRowsByButtonId.get(button.id)
      if (!row) {
        return new Error(`No worktree registered for button ${button.id}`)
      }

      const actionId = registerHtmlAction({
        ownerKey,
        threadId: row.threadId ?? row.directory,
        run: async ({ interaction }) => {
          await handleDeleteWorktreeAction({
            interaction,
            row,
            projectDirectory,
          })
        },
      })
      return buildHtmlActionCustomId(actionId)
    },
  })

  const components: APIMessageTopLevelComponent[] = segments.flatMap((segment) => {
    if (segment.type === 'components') {
      return segment.components
    }

    const textDisplay: APITextDisplayComponent = {
      type: ComponentType.TextDisplay,
      content: segment.text,
    }
    return [textDisplay]
  })

  await editReply({
    components,
    flags: MessageFlags.IsComponentsV2,
  })
}

async function handleDeleteWorktreeAction({
  interaction,
  row,
  projectDirectory,
}: {
  interaction: ButtonInteraction
  row: WorktreeRow
  projectDirectory: string
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

  // Pass branch name for branch cleanup. Empty string for detached HEAD
  // worktrees so deleteWorktree skips the `git branch -d` step.
  const displayName = row.branch ?? row.name
  const deleteResult = await deleteWorktree({
    projectDirectory,
    worktreeDirectory: row.directory,
    worktreeName: row.branch ?? '',
  })
  if (deleteResult instanceof Error) {
    const gitStderr = extractGitStderr(deleteResult)
    const detail = gitStderr
      ? `\`\`\`\n${gitStderr}\n\`\`\``
      : deleteResult.message
    await interaction
      .followUp({
        content: `Failed to delete \`${displayName}\`\n${detail}`,
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {
        return undefined
      })
    return
  }

  // Clean up DB row if this was a kimaki-tracked worktree
  if (row.threadId) {
    await deleteThreadWorktree(row.threadId)
  }

  await renderWorktreesReply({
    guildId,
    userId: interaction.user.id,
    channelId: interaction.channelId,
    projectDirectory,
    notice: `Deleted \`${displayName}\`.`,
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
