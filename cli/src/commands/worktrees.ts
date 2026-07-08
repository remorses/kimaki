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
  type APIMessageTopLevelComponent,
  type APITextDisplayComponent,
  type InteractionEditReplyOptions,
} from 'discord.js'
import {
  deleteThreadWorkspace,
  type ThreadWorkspace,
} from '../database.js'
import { getDb } from '../db.js'
import { splitTablesFromMarkdown, truncateComponents } from '../format-tables.js'
import {
  buildHtmlActionCustomId,
  cancelHtmlActionsForOwner,
  registerHtmlAction,
} from '../html-actions.js'
import * as errore from 'errore'
import crypto from 'node:crypto'
import { GitCommandError, OpenCodeSdkError } from '../errors.js'
import { resolveWorkingDirectory } from '../discord-utils.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
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
  workspaceId: string | null
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
    // Show only the last 2 path segments to keep text size under Discord's
    // 4000-char displayable text limit. Full paths are too long.
    const folder = `…/${path.basename(path.dirname(row.directory))}/${path.basename(row.directory)}`
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
  const buttonId = `del-wt-${worktreeButtonKey(row.directory)}`
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
  const db = await getDb()
  const dbWorkspaces = await db.query.thread_workspaces.findMany({
    where: { project_directory: projectDirectory },
  })

  const toDate = (v: Date | string | null | undefined): Date | null => {
    if (!v) return null
    return v instanceof Date ? v : new Date(v)
  }

  // Index by directory for fast lookup
  const dbByDirectory = new Map<string, ThreadWorkspace>()
  for (const ws of dbWorkspaces) {
    if (ws.workspace_directory) {
      dbByDirectory.set(ws.workspace_directory, ws)
    }
  }

  // Track which DB rows got matched so we can append unmatched ones
  const matchedDbThreadIds = new Set<string>()

  // Build rows from git worktrees (the source of truth for on-disk state).
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
      if (!dbMatch) return 'ready'
      if (dbMatch.status === 'error') return 'error'
      if (dbMatch.status === 'pending') return 'pending'
      return 'ready'
    })()
    return {
      directory: gw.directory,
      branch: gw.branch,
      name,
      threadId: dbMatch?.thread_id ?? null,
      guildId: null,
      createdAt: toDate(dbMatch?.created_at),
      source,
      workspaceId: dbMatch?.workspace_id ?? null,
      dbStatus,
      locked: gw.locked,
      prunable: gw.prunable,
    }
  })

  // Append DB-only workspaces (pending/error/stale — not visible to git).
  const dbOnlyRows: WorktreeRow[] = dbWorkspaces
    .filter((ws) => !matchedDbThreadIds.has(ws.thread_id))
    .map((ws) => ({
      directory: ws.workspace_directory ?? ws.project_directory,
      branch: null,
      name: ws.workspace_name,
      threadId: ws.thread_id,
      guildId: null,
      createdAt: toDate(ws.created_at),
      source: 'kimaki' as const,
      workspaceId: ws.workspace_id,
      dbStatus: ws.status === 'error' ? 'error' : ws.status === 'pending' ? 'pending' : 'ready',
      locked: false,
      prunable: false,
    }))

  return [...gitRows, ...dbOnlyRows]
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

function resolveWorktreesWorkingDirectory(
  channel: NonNullable<ChatInputCommandInteraction['channel']>,
) {
  switch (channel.type) {
    case ChannelType.GuildText:
    case ChannelType.PublicThread:
    case ChannelType.PrivateThread:
    case ChannelType.AnnouncementThread:
      return resolveWorkingDirectory({ channel })
    default:
      return undefined
  }
}

async function renderWorktreesReply({
  guildId,
  userId,
  channelId,
  projectDirectory,
  notice,
  editReply,
}: WorktreesReplyTarget): Promise<void> {
  const ownerKey = `worktrees:${userId}:${channelId}`
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

  const allComponents: APIMessageTopLevelComponent[] = segments.flatMap((segment) => {
    if (segment.type === 'components') {
      return segment.components
    }

    const textDisplay: APITextDisplayComponent = {
      type: ComponentType.TextDisplay,
      content: segment.text,
    }
    return [textDisplay]
  })

  // Reserve budget for a truncation notice (1 component + its text length)
  // so appending the notice doesn't push us over either Discord limit.
  const truncatedNoticeContent = `*Some worktrees were not shown due to Discord's component limit. Use \`git worktree list\` for the full list.*`
  const { components, truncated } = truncateComponents(allComponents, {
    reserveCost: 1,
    reserveTextSize: truncatedNoticeContent.length,
  })
  if (truncated) {
    const truncatedNotice: APITextDisplayComponent = {
      type: ComponentType.TextDisplay,
      content: truncatedNoticeContent,
    }
    components.push(truncatedNotice)
  }

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

  // SDK-created workspaces must be removed through OpenCode so its workspace
  // table stays in sync. Legacy/manual worktrees have no workspace_id, so they
  // still use the direct git cleanup path.
  const displayName = row.branch ?? row.name
  const deleteResult = row.workspaceId
    ? await deleteWorkspace({ projectDirectory, workspaceId: row.workspaceId })
    : await deleteWorktree({
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

  if (row.threadId) {
    await deleteThreadWorkspace(row.threadId)
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

async function deleteWorkspace({
  projectDirectory,
  workspaceId,
}: {
  projectDirectory: string
  workspaceId: string
}) {
  const getClient = await initializeOpencodeForDirectory(projectDirectory)
  if (getClient instanceof Error) return getClient

  const response = await getClient().experimental.workspace.remove({
    id: workspaceId,
    directory: projectDirectory,
  }).catch((e) => new OpenCodeSdkError({ operation: 'workspace.remove', cause: e }))
  if (response instanceof Error) return response
  if (response.error) return new Error(`Workspace removal failed: ${JSON.stringify(response.error)}`)
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

  const resolved = await resolveWorktreesWorkingDirectory(channel)
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
