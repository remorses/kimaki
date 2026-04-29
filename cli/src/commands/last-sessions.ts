// /last-sessions command — list the 20 most recently active sessions across
// all projects, sorted by last activity. Renders a markdown table with
// clickable thread links and project names via Discord CV2 components.

import {
  ChatInputCommandInteraction,
  ComponentType,
  MessageFlags,
  type APIMessageTopLevelComponent,
  type APITextDisplayComponent,
  type Client,
} from 'discord.js'
import path from 'node:path'
import { getPrisma } from '../db.js'
import { getChannelDirectory } from '../database.js'
import { splitTablesFromMarkdown } from '../format-tables.js'
import { formatTimeAgo } from './worktrees.js'

const MAX_ROWS = 20

interface SessionRow {
  threadId: string
  sessionId: string
  lastActive: Date
  projectName: string | undefined
}

async function fetchRecentSessions({
  client,
}: {
  client: Client
}): Promise<SessionRow[]> {
  const prisma = await getPrisma()

  // Fetch all thread sessions with their most recent event timestamp.
  // Prisma doesn't support ORDER BY aggregated subquery, so we fetch all
  // sessions with their latest event and sort in JS.
  const sessions = await prisma.thread_sessions.findMany({
    select: {
      thread_id: true,
      session_id: true,
      created_at: true,
      session_events: {
        orderBy: { timestamp: 'desc' },
        take: 1,
        select: { timestamp: true },
      },
    },
  })

  // Build rows with resolved last-active timestamp
  const withTimestamp = sessions.map((s) => {
    const latestEventTs = s.session_events[0]?.timestamp
    const lastActive: Date = latestEventTs
      ? new Date(Number(latestEventTs))
      : s.created_at ?? new Date(0)
    return {
      threadId: s.thread_id,
      sessionId: s.session_id,
      lastActive,
    }
  })

  // Sort by last active descending, take top N
  withTimestamp.sort((a, b) => {
    return b.lastActive.getTime() - a.lastActive.getTime()
  })
  const top = withTimestamp.slice(0, MAX_ROWS)

  // Resolve project names via Discord thread parent channel
  const channelDirCache = new Map<string, string | undefined>()

  const rows: SessionRow[] = await Promise.all(
    top.map(async (row) => {
      let projectName: string | undefined
      try {
        const channel = await client.channels.fetch(row.threadId)
        const parentId =
          channel && 'parentId' in channel ? channel.parentId : undefined
        if (parentId) {
          if (!channelDirCache.has(parentId)) {
            const dir = await getChannelDirectory(parentId)
            channelDirCache.set(
              parentId,
              dir ? path.basename(dir.directory) : undefined,
            )
          }
          projectName = channelDirCache.get(parentId)
        }
      } catch {
        // Thread may have been deleted or is inaccessible
      }
      return {
        threadId: row.threadId,
        sessionId: row.sessionId,
        lastActive: row.lastActive,
        projectName,
      }
    }),
  )

  return rows
}

function buildSessionTable({ rows }: { rows: SessionRow[] }): string {
  const header = '| Project | Thread | Last Active |'
  const separator = '|---|---|---|'
  const tableRows = rows.map((row) => {
    const project = row.projectName ?? 'unknown'
    const thread = `<#${row.threadId}>`
    const lastActive = formatTimeAgo(row.lastActive)
    return `| ${project} | ${thread} | ${lastActive} |`
  })
  return [header, separator, ...tableRows].join('\n')
}

export async function handleLastSessionsCommand({
  command,
}: {
  command: ChatInputCommandInteraction
  appId: string
}): Promise<void> {
  if (!command.guildId) {
    await command.reply({
      content: 'This command can only be used in a server.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await command.deferReply({ flags: MessageFlags.Ephemeral })

  const rows = await fetchRecentSessions({ client: command.client })

  if (rows.length === 0) {
    const textDisplay: APITextDisplayComponent = {
      type: ComponentType.TextDisplay,
      content: 'No sessions found.',
    }
    await command.editReply({
      components: [textDisplay],
      flags: MessageFlags.IsComponentsV2,
    })
    return
  }

  const tableMarkdown = buildSessionTable({ rows })
  const segments = splitTablesFromMarkdown(tableMarkdown)

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

  await command.editReply({
    components,
    flags: MessageFlags.IsComponentsV2,
  })
}
