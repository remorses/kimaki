// Session inspection and archival terminal commands.
import { goke } from 'goke'
import { z } from 'zod'
import { note } from '@clack/prompts'
import YAML from 'yaml'
import * as errore from 'errore'
import type { OpencodeClient, Event as OpenCodeEvent } from '@opencode-ai/sdk/v2'
import { Events, ActivityType, type PresenceStatusData, type Guild, Routes } from 'discord.js'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawn, execSync } from 'node:child_process'
import { createLogger, LogPrefix, initLogFile } from '../logger.js'
import { createDiscordClient, initDatabase, getChannelDirectory, initializeOpencodeForDirectory, createProjectChannels } from '../discord-bot.js'
import { getBotTokenWithMode, getThreadSession, getThreadIdBySessionId, getSessionEventSnapshot, getDb, createScheduledTask, listScheduledTasks, cancelScheduledTask, getScheduledTask, updateScheduledTask, getSessionStartSourcesBySessionIds, deleteChannelDirectoryById, findChannelsByDirectory, getThreadWorktree } from '../database.js'
import { ShareMarkdown } from '../markdown.js'
import { parseSessionSearchPattern, findFirstSessionSearchHit, buildSessionSearchSnippet, getPartSearchTexts } from '../session-search.js'
import { formatWorktreeName, formatAutoWorktreeName } from '../commands/new-worktree.js'
import { WORKTREE_PREFIX } from '../commands/merge-worktree.js'
import type { ThreadStartMarker } from '../system-message.js'
import { buildOpencodeEventLogLine } from '../session-handler/opencode-session-event-log.js'
import { createDiscordRest } from '../discord-urls.js'
import { archiveThread, uploadFilesToDiscord, stripMentions } from '../discord-utils.js'
import { setDataDir, setProjectsDir, getDataDir, getProjectsDir } from '../config.js'
import { execAsync, validateWorktreeDirectory } from '../worktrees.js'
import { upgrade, getCurrentVersion } from '../upgrade.js'
import { getPromptPreview, parseSendAtValue, parseScheduledTaskPayload, serializeScheduledTaskPayload, type ScheduledTaskPayload } from '../task-schedule.js'
import {
  EXIT_NO_RESTART,
  formatMemberLookupUnavailableMessage,
  formatRelativeTime,
  formatTaskScheduleLine,
  isDiscordMemberLookupUnavailable,
  isGuildMemberSearchResult,
  isThreadChannelType,
  printDiscordInstallUrlAndExit,
  resolveBotCredentials,
  resolveDiscordUserOption,
  sendDiscordMessageWithOptionalAttachment,
} from '../cli-runner.js'

const cliLogger = createLogger(LogPrefix.CLI)
const cli = goke()

async function resolveSessionDirectoryFromDatabase({
  sessionId,
}: {
  sessionId: string
}): Promise<Error | string> {
  const threadId = await getThreadIdBySessionId(sessionId)
  if (threadId) {
    const worktree = await getThreadWorktree(threadId)
    if (worktree?.status === 'ready' && worktree.worktree_directory) {
      return worktree.worktree_directory
    }

    const { token: botToken } = await resolveBotCredentials({})
    const rest = createDiscordRest(botToken)
    const threadData = (await rest.get(Routes.channel(threadId))) as {
      id: string
      type: number
      parent_id?: string
    }
    if (!isThreadChannelType(threadData.type)) {
      return new Error(`Channel is not a thread: ${threadId}`)
    }
    if (!threadData.parent_id) {
      return new Error(`Thread has no parent channel: ${threadId}`)
    }
    const channelConfig = await getChannelDirectory(threadData.parent_id)
    if (!channelConfig) {
      return new Error(
        `Thread parent channel is not configured with a project directory: ${threadData.parent_id}`,
      )
    }
    return channelConfig.directory
  }

  return new Error(
    `Session is not linked to a Kimaki thread in the local database: ${sessionId}`,
  )
}

cli
  .command(
    'session list',
    'List all OpenCode sessions, marking which were started via Kimaki',
  )
  .option(
    '--project <path>',
    'Project directory to list sessions for (defaults to cwd)',
  )
  .option('--json', 'Output as JSON')
  .action(async (options: { project?: string; json?: boolean }) => {
    try {
      const projectDirectory = path.resolve(options.project || '.')

      await initDatabase()

      cliLogger.log('Connecting to OpenCode server...')
      const getClient = await initializeOpencodeForDirectory(projectDirectory)
      if (getClient instanceof Error) {
        cliLogger.error('Failed to connect to OpenCode:', getClient.message)
        process.exit(EXIT_NO_RESTART)
      }

      const sessionsResponse = await getClient().session.list()
      const sessions = sessionsResponse.data || []

      if (sessions.length === 0) {
        cliLogger.log('No sessions found')
        process.exit(0)
      }

      // Look up which sessions were started via kimaki (have a thread mapping)
      const db = await getDb()
      const threadSessions = await db.query.thread_sessions.findMany({
        columns: { thread_id: true, session_id: true },
      })
      const sessionToThread = new Map(
        threadSessions
          .filter((row) => row.session_id !== '')
          .map((row) => [row.session_id, row.thread_id]),
      )
      const sessionStartSources = await getSessionStartSourcesBySessionIds(
        sessions.map((session) => session.id),
      )

      const scheduleModeLabel = ({
        scheduleKind,
      }: {
        scheduleKind: 'at' | 'cron'
      }): 'delay' | 'cron' => {
        if (scheduleKind === 'at') {
          return 'delay'
        }
        return 'cron'
      }

      if (options.json) {
        const output = sessions.map((session) => {
          const startSource = sessionStartSources.get(session.id)
          const startedBy = startSource
            ? `scheduled-${scheduleModeLabel({ scheduleKind: startSource.schedule_kind })}`
            : null
          return {
            id: session.id,
            title: session.title || 'Untitled Session',
            directory: session.directory,
            updated: new Date(session.time.updated).toISOString(),
            source: sessionToThread.has(session.id) ? 'kimaki' : 'opencode',
            threadId: sessionToThread.get(session.id) || null,
            startedBy,
            scheduledTaskId: startSource?.scheduled_task_id || null,
          }
        })
        console.log(JSON.stringify(output, null, 2))
        process.exit(0)
      }

      for (const session of sessions) {
        const threadId = sessionToThread.get(session.id)
        const startSource = sessionStartSources.get(session.id)
        const source = threadId ? '(kimaki)' : '(opencode)'
        const startedBy = startSource
          ? ` | started-by: ${scheduleModeLabel({ scheduleKind: startSource.schedule_kind })}${startSource.scheduled_task_id ? ` (#${startSource.scheduled_task_id})` : ''}`
          : ''
        const updatedAt = new Date(session.time.updated).toISOString()
        const threadInfo = threadId ? ` | thread: ${threadId}` : ''
        console.log(
          `${session.id} | ${session.title || 'Untitled Session'} | ${session.directory} | ${updatedAt} | ${source}${threadInfo}${startedBy}`,
        )
      }

      process.exit(0)
    } catch (error) {
      cliLogger.error(
        'Error:',
        error instanceof Error ? error.stack : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

cli
  .command(
    'session read <sessionId>',
    'Read a session conversation as markdown (pipe to file to grep)',
  )
  .option('--project <path>', 'Project directory (defaults to cwd)')
  .action(async (sessionId: string, options: { project?: string }) => {
    try {
      const projectDirectory = path.resolve(options.project || '.')

      await initDatabase()

      cliLogger.log('Connecting to OpenCode server...')
      const getClient = await initializeOpencodeForDirectory(projectDirectory)
      if (getClient instanceof Error) {
        cliLogger.error('Failed to connect to OpenCode:', getClient.message)
        process.exit(EXIT_NO_RESTART)
      }

      // Try current project first (fast path)
      const markdown = new ShareMarkdown(getClient())
      const result = await markdown.generate({ sessionID: sessionId })
      if (!(result instanceof Error)) {
        process.stdout.write(result)
        process.exit(0)
      }

      // Session not found in current project, search across all projects.
      // project.list() returns all known projects globally from any OpenCode server,
      // but session.list/get are scoped to the server's own project. So we try each.
      cliLogger.log('Session not in current project, searching all projects...')
      const projectsResponse = await getClient().project.list()
      const projects = projectsResponse.data || []
      const otherProjects = projects
        .filter((p) => path.resolve(p.worktree) !== projectDirectory)
        .filter((p) => {
          try {
            fs.accessSync(p.worktree, fs.constants.R_OK)
            return true
          } catch {
            return false
          }
        })
        // Sort by most recently created first to find sessions faster
        .sort((a, b) => b.time.created - a.time.created)

      for (const project of otherProjects) {
        const dir = project.worktree
        cliLogger.log(`Trying project: ${dir}`)
        const otherClient = await initializeOpencodeForDirectory(dir)
        if (otherClient instanceof Error) continue
        const otherMarkdown = new ShareMarkdown(otherClient())
        const otherResult = await otherMarkdown.generate({
          sessionID: sessionId,
        })
        if (!(otherResult instanceof Error)) {
          process.stdout.write(otherResult)
          process.exit(0)
        }
      }

      cliLogger.error(`Session ${sessionId} not found in any project`)
      process.exit(EXIT_NO_RESTART)
    } catch (error) {
      cliLogger.error(
        'Error:',
        error instanceof Error ? error.stack : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

cli
  .command(
    'session wait <sessionId>',
    'Wait for a session to finish, then print its conversation as markdown',
  )
  .action(async (sessionId) => {
    try {
      await initDatabase()

      const projectDirectory = await resolveSessionDirectoryFromDatabase({
        sessionId,
      })
      if (projectDirectory instanceof Error) {
        cliLogger.error(projectDirectory.message)
        process.exit(EXIT_NO_RESTART)
      }

      const { waitAndOutputExistingSession } = await import('../wait-session.js')
      await waitAndOutputExistingSession({
        sessionId,
        projectDirectory,
      })

      process.exit(0)
    } catch (error) {
      cliLogger.error(
        'Error:',
        error instanceof Error ? error.stack : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

cli
  .command(
    'session search <query>',
    'Search past sessions for text or /regex/flags in the selected project',
  )
  .option('--project <path>', 'Project directory (defaults to cwd)')
  .option('--channel <channelId>', 'Resolve project from a Discord channel ID')
  .option('--limit <n>', 'Maximum matched sessions to return (default: 20)')
  .option('--json', 'Output as JSON')
  .action(async (query, options) => {
    try {
      await initDatabase()

      if (options.project && options.channel) {
        cliLogger.error('Use either --project or --channel, not both')
        process.exit(EXIT_NO_RESTART)
      }

      const limit = (() => {
        const rawLimit =
          typeof options.limit === 'string' ? options.limit : '20'
        const parsed = Number.parseInt(rawLimit, 10)
        if (Number.isNaN(parsed) || parsed < 1) {
          return new Error(`Invalid --limit value: ${rawLimit}`)
        }
        return parsed
      })()

      if (limit instanceof Error) {
        cliLogger.error(limit.message)
        process.exit(EXIT_NO_RESTART)
      }

      const projectDirectoryResult = await (async (): Promise<
        string | Error
      > => {
        if (options.channel) {
          const channelConfig = await getChannelDirectory(options.channel)
          if (!channelConfig) {
            return new Error(
              `No project mapping found for channel: ${options.channel}`,
            )
          }
          return path.resolve(channelConfig.directory)
        }
        return path.resolve(options.project || '.')
      })()

      if (projectDirectoryResult instanceof Error) {
        cliLogger.error(projectDirectoryResult.message)
        process.exit(EXIT_NO_RESTART)
      }

      const projectDirectory = projectDirectoryResult
      if (!fs.existsSync(projectDirectory)) {
        cliLogger.error(`Directory does not exist: ${projectDirectory}`)
        process.exit(EXIT_NO_RESTART)
      }

      const searchPattern = parseSessionSearchPattern(query)
      if (searchPattern instanceof Error) {
        cliLogger.error(searchPattern.message)
        process.exit(EXIT_NO_RESTART)
      }

      cliLogger.log('Connecting to OpenCode server...')
      const getClient = await initializeOpencodeForDirectory(projectDirectory)
      if (getClient instanceof Error) {
        cliLogger.error('Failed to connect to OpenCode:', getClient.message)
        process.exit(EXIT_NO_RESTART)
      }

      const sessionsResponse = await getClient().session.list()
      const sessions = sessionsResponse.data || []
      if (sessions.length === 0) {
        cliLogger.log('No sessions found')
        process.exit(0)
      }

      const db = await getDb()
      const threadSessions = await db.query.thread_sessions.findMany({
        columns: { thread_id: true, session_id: true },
      })
      const sessionToThread = new Map(
        threadSessions
          .filter((row) => row.session_id !== '')
          .map((row) => [row.session_id, row.thread_id]),
      )

      const sortedSessions = [...sessions].sort((a, b) => {
        return b.time.updated - a.time.updated
      })

      const matchedSessions: Array<{
        id: string
        title: string
        directory: string
        updated: string
        source: 'kimaki' | 'opencode'
        threadId: string | null
        snippets: string[]
      }> = []

      let scannedSessions = 0

      for (const session of sortedSessions) {
        scannedSessions++
        const messagesResponse = await getClient().session.messages({
          sessionID: session.id,
        })
        const messages = messagesResponse.data || []

        const snippets = messages
          .flatMap((message) => {
            const rolePrefix =
              message.info.role === 'assistant'
                ? 'assistant'
                : message.info.role === 'user'
                  ? 'user'
                  : 'message'

            return message.parts.filter((p) => !(p.type === 'text' && p.synthetic)).flatMap((part) => {
              return getPartSearchTexts(part).flatMap((text) => {
                const hit = findFirstSessionSearchHit({
                  text,
                  searchPattern,
                })
                if (!hit) {
                  return []
                }
                const snippet = buildSessionSearchSnippet({ text, hit })
                if (!snippet) {
                  return []
                }
                return [`${rolePrefix}: ${snippet}`]
              })
            })
          })
          .slice(0, 3)

        if (snippets.length === 0) {
          continue
        }

        const threadId = sessionToThread.get(session.id)
        matchedSessions.push({
          id: session.id,
          title: session.title || 'Untitled Session',
          directory: session.directory,
          updated: new Date(session.time.updated).toISOString(),
          source: threadId ? 'kimaki' : 'opencode',
          threadId: threadId || null,
          snippets,
        })

        if (matchedSessions.length >= limit) {
          break
        }
      }

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              query: searchPattern.raw,
              mode: searchPattern.mode,
              projectDirectory,
              scannedSessions,
              matches: matchedSessions,
            },
            null,
            2,
          ),
        )
        process.exit(0)
      }

      if (matchedSessions.length === 0) {
        cliLogger.log(
          `No matches found for ${searchPattern.raw} in ${projectDirectory} (${scannedSessions} sessions scanned)`,
        )
        process.exit(0)
      }

      cliLogger.log(
        `Found ${matchedSessions.length} matching session(s) for ${searchPattern.raw} in ${projectDirectory}`,
      )

      for (const match of matchedSessions) {
        const threadInfo = match.threadId ? ` | thread: ${match.threadId}` : ''
        console.log(
          `${match.id} | ${match.title} | ${match.updated} | ${match.source}${threadInfo}`,
        )
        console.log(`  Directory: ${match.directory}`)
        match.snippets.forEach((snippet) => {
          console.log(`  - ${snippet}`)
        })
      }

      process.exit(0)
    } catch (error) {
      cliLogger.error(
        'Error:',
        error instanceof Error ? error.stack : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

cli
  .command(
    'session export-events-jsonl',
    'Export persisted session events from SQLite to JSONL for debugging Kimaki runtime bugs',
  )
  .option(
    '--session <sessionId>',
    'Session ID whose persisted event stream should be exported',
  )
  .option(
    '--out <file>',
    'Output .jsonl path (useful for reproducing Kimaki issues in event-stream-state tests)',
  )
  .action(async (options) => {
    const sessionId =
      typeof options.session === 'string' ? options.session.trim() : ''
    if (!sessionId) {
      cliLogger.error('Missing --session value')
      process.exit(EXIT_NO_RESTART)
    }

    const outFile = typeof options.out === 'string' ? options.out.trim() : ''
    if (!outFile) {
      cliLogger.error('Missing --out value')
      process.exit(EXIT_NO_RESTART)
    }
    if (path.extname(outFile).toLowerCase() !== '.jsonl') {
      cliLogger.error('--out must point to a .jsonl file')
      process.exit(EXIT_NO_RESTART)
    }

    const outPath = path.resolve(outFile)
    const rows = await getSessionEventSnapshot({ sessionId })
    if (rows.length === 0) {
      cliLogger.error(
        `No persisted events found for session ${sessionId}. The session may not have emitted events yet.`,
      )
      process.exit(EXIT_NO_RESTART)
    }

    const parsedRows = rows.flatMap((row) => {
      const parsed = errore.try(
        () => {
          return JSON.parse(row.event_json) as OpenCodeEvent
        },
        (error) => {
          return new Error('Failed to parse persisted event JSON', {
            cause: error,
          })
        },
      )
      if (parsed instanceof Error) {
        cliLogger.warn(
          `Skipping invalid persisted event row ${row.id}: ${parsed.message}`,
        )
        return []
      }

      return [{ row, event: parsed }]
    })

    if (parsedRows.length === 0) {
      cliLogger.error(
        `No valid persisted events found for session ${sessionId}.`,
      )
      process.exit(EXIT_NO_RESTART)
    }

    const projectDirectory = parsedRows.reduce((directory, { event }) => {
      if (directory) {
        return directory
      }
      if (event.type !== 'session.updated') {
        return directory
      }
      return event.properties.info.directory
    }, '')

    const lines = parsedRows.map(({ row, event }) => {
      return JSON.stringify(
        buildOpencodeEventLogLine({
          timestamp: Number(row.timestamp),
          threadId: row.thread_id,
          projectDirectory,
          event,
        }),
      )
    })
    const jsonl = `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`

    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, jsonl, 'utf8')
    cliLogger.log(
      `Exported ${lines.length} events from ${sessionId} to ${outPath}`,
    )
    process.exit(0)
  })

cli
  .command(
    'session archive [threadId]',
    'Archive a Discord thread and stop its mapped OpenCode session',
  )
  .option('--session <sessionId>', 'Resolve thread from an OpenCode session ID')
  .action(async (threadIdArg: string | undefined, options: { session?: string }) => {
    try {
      await initDatabase()

      // Resolve threadId from --session or positional arg
      if (threadIdArg && options.session) {
        cliLogger.error('Use either a thread ID or --session, not both')
        process.exit(EXIT_NO_RESTART)
      }
      const resolvedThreadId = await (async (): Promise<string> => {
        if (threadIdArg) {
          return threadIdArg
        }
        if (options.session) {
          const id = await getThreadIdBySessionId(options.session)
          if (!id) {
            cliLogger.error(`No Discord thread found for session: ${options.session}`)
            process.exit(EXIT_NO_RESTART)
          }
          return id
        }
        cliLogger.error('Provide a thread ID or --session <sessionId>')
        process.exit(EXIT_NO_RESTART)
      })()

      const { token: botToken } = await resolveBotCredentials()

      const rest = createDiscordRest(botToken)
      const threadData = (await rest.get(Routes.channel(resolvedThreadId))) as {
        id: string
        type: number
        name?: string
        parent_id?: string
      }

      if (!isThreadChannelType(threadData.type)) {
        cliLogger.error(`Channel is not a thread: ${resolvedThreadId}`)
        process.exit(EXIT_NO_RESTART)
      }

      const sessionId = options.session || await getThreadSession(resolvedThreadId)
      let client: OpencodeClient | null = null
      if (sessionId && threadData.parent_id) {
        const channelConfig = await getChannelDirectory(threadData.parent_id)
        if (!channelConfig) {
          cliLogger.warn(
            `No channel directory mapping found for parent channel ${threadData.parent_id}`,
          )
        } else {
          const getClient = await initializeOpencodeForDirectory(
            channelConfig.directory,
          )
          if (getClient instanceof Error) {
            cliLogger.warn(
              `Could not initialize OpenCode for ${channelConfig.directory}: ${getClient.message}`,
            )
          } else {
            client = getClient()
          }
        }
      } else {
        cliLogger.warn(
          `No mapped OpenCode session found for thread ${resolvedThreadId}`,
        )
      }

      await archiveThread({
        rest,
        threadId: resolvedThreadId,
        parentChannelId: threadData.parent_id,
        sessionId,
        client,
      })

      const threadLabel = threadData.name || resolvedThreadId
      note(
        `Archived thread: ${threadLabel}\nThread ID: ${resolvedThreadId}`,
        '✅ Archived',
      )
      process.exit(0)
    } catch (error) {
      cliLogger.error(
        'Error:',
        error instanceof Error ? error.stack : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

cli
  .command(
    'session abort <sessionId>',
    'Abort a running session without archiving the thread',
  )
  .action(async (sessionId) => {
    try {
      await initDatabase()

      const { token: botToken } = await resolveBotCredentials()
      const rest = createDiscordRest(botToken)

      // Try to resolve the project directory for the OpenCode abort call
      const directory = await resolveSessionDirectoryFromDatabase({ sessionId })
      if (directory instanceof Error) {
        cliLogger.error(directory.message)
        process.exit(EXIT_NO_RESTART)
      }

      const serverResult = await initializeOpencodeForDirectory(directory)
      if (serverResult instanceof Error) {
        cliLogger.error(`Failed to initialize OpenCode: ${serverResult.message}`)
        process.exit(EXIT_NO_RESTART)
      }

      const client = serverResult()
      // Don't pass directory — the server resolves sessions by ID regardless
      // of the x-opencode-directory header, matching archiveThread's pattern.
      // This avoids issues when --cwd was used (session directory != project directory).
      const abortResult = await client.session.abort({
        sessionID: sessionId,
      }).catch((e) => new Error('Failed to abort session', { cause: e }))
      if (abortResult instanceof Error) {
        cliLogger.error(abortResult.message)
        process.exit(EXIT_NO_RESTART)
      }

      // Post a message in the Discord thread so it's clear why the session stopped
      const threadId = await getThreadIdBySessionId(sessionId)
      if (threadId) {
        await rest.post(Routes.channelMessages(threadId), {
          body: { content: 'Session aborted via CLI' },
        }).catch((e) => {
          cliLogger.warn(`Could not post abort message to thread: ${e instanceof Error ? e.message : String(e)}`)
        })
      }

      note(
        `Aborted session: ${sessionId}${threadId ? `\nThread ID: ${threadId}` : ''}`,
        '✅ Aborted',
      )
      process.exit(0)
    } catch (error) {
      cliLogger.error(
        'Error:',
        error instanceof Error ? error.stack : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

cli
  .command(
    'session discord-url <sessionId>',
    'Print the Discord thread URL for a session',
  )
  .option('--json', 'Output as JSON')
  .action(async (sessionId, options) => {
    await initDatabase()
    const threadId = await getThreadIdBySessionId(sessionId)
    if (!threadId) {
      cliLogger.error(`No Discord thread found for session: ${sessionId}`)
      process.exit(EXIT_NO_RESTART)
    }
    const { token: botToken } = await resolveBotCredentials()
    const rest = createDiscordRest(botToken)
    const threadData = (await rest.get(Routes.channel(threadId))) as {
      id: string
      guild_id: string
      name?: string
    }
    const url = `https://discord.com/channels/${threadData.guild_id}/${threadData.id}`
    if (options.json) {
      console.log(JSON.stringify({
        url,
        threadId: threadData.id,
        guildId: threadData.guild_id,
        sessionId,
        threadName: threadData.name,
      }))
    } else {
      console.log(url)
    }
    process.exit(0)
  })


export default cli
