// /worktrees command — list all worktree sessions sorted by creation date.
// Renders a markdown table that the CV2 pipeline auto-formats for Discord.

import {
  ChatInputCommandInteraction,
  MessageFlags,
  type APIMessageTopLevelComponent,
  type APITextDisplayComponent,
} from 'discord.js'
import type { ThreadWorktree } from '../database.js'
import { getPrisma } from '../db.js'
import { splitTablesFromMarkdown } from '../format-tables.js'
import { git, getDefaultBranch } from '../worktrees.js'

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

// 5s timeout per git call — prevents hangs from deleted dirs, git locks, slow disks.
// Returns null on timeout/error so the table shows "unknown" for that worktree.
const GIT_CMD_TIMEOUT = 5_000

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
  const header = '| Thread | Name | Status | Created | Folder |'
  const separator = '|---|---|---|---|---|'
  const rows = worktrees.map((wt, i) => {
    const threadLink = `[thread](https://discord.com/channels/${guildId}/${wt.thread_id})`
    const name = wt.worktree_name
    const gs = gitStatuses[i]
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
    return `| ${threadLink} | ${name} | ${status} | ${created} | ${folder} |`
  })
  return [header, separator, ...rows].join('\n')
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

export async function handleWorktreesCommand({
  command,
}: {
  command: ChatInputCommandInteraction
  appId: string
}): Promise<void> {
  const guildId = command.guildId
  if (!guildId) {
    await command.reply({
      content: 'This command can only be used in a server.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await command.deferReply({ flags: MessageFlags.Ephemeral })

  const prisma = await getPrisma()
  const worktrees = await prisma.thread_worktrees.findMany({
    orderBy: { created_at: 'desc' },
    take: 10,
  })

  if (worktrees.length === 0) {
    await command.editReply({ content: 'No worktrees found.' })
    return
  }

  // 10s global deadline covers both default-branch prefetch and per-worktree
  // git status checks. Guarantees the command responds within Discord's
  // interaction window even if git is slow or unreachable.
  const GLOBAL_TIMEOUT = 10_000
  const gitStatuses = await resolveGitStatuses({ worktrees, timeout: GLOBAL_TIMEOUT })

  const markdown = buildWorktreeTable({ worktrees, gitStatuses, guildId })
  const segments = splitTablesFromMarkdown(markdown)

  // Convert segments to top-level CV2 components:
  // text segments → TextDisplay, table segments → Container (from pipeline)
  const components: APIMessageTopLevelComponent[] = segments.flatMap(
    (segment) => {
      if (segment.type === 'components') {
        return segment.components
      }
      const textDisplay: APITextDisplayComponent = {
        type: 10,
        content: segment.text,
      }
      return [textDisplay as APIMessageTopLevelComponent]
    },
  )

  await command.editReply({ components })
}
