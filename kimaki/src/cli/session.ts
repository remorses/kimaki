// `session ...` commands. Reads go straight to OpenCode and SQLite; writes
// (abort, title, queue, fork, ...) go through the running bot's lock routes.

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { wrapJsonSchema, type Goke } from 'goke'

import { parseDuration } from '../duration.ts'
import { OpenCodeError } from '../errors.ts'
import { editorsForFile, loadFileEditEvents } from '../file-edit-log.ts'
import { allMessages, allSessions, readSessionMarkdown, sessionEventsFile } from '../session-events.ts'
import {
  action,
  DATA_DIR_HELP,
  dataDirOrDefault,
  discordApi,
  fail,
  isThread,
  printJson,
  printRows,
  projectDirectory,
  readClient,
  SESSION_HELP,
  resolveTarget,
  targetOrEnv,
  waitAndPrintSession,
} from './shared.ts'

const execFileAsync = promisify(execFile)

// list, search, wait, editors, diff, url
export function registerSessionQueryCommands(cli: Goke) {
  cli.command('session list', 'List sessions with native status and token counts')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--project <path>', 'Project (default: current directory)')
    .option('--all', 'All projects')
    .option('--active', 'Only busy sessions; exit 1 when none remain, 64 on errors')
    .option('--exclude <id>', wrapJsonSchema<string[]>({ type: 'array', items: { type: 'string' }, description: 'Exclude session (repeatable)' }))
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const errorCode = options.active ? 64 : 1
      const client = await readClient(errorCode)
      const directory = options.all ? undefined : await projectDirectory({ project: options.project, channel: undefined, dataDir: options.dataDir })
      const [sessions, active, forms, permissions] = await Promise.all([
        allSessions({ client, directory }),
        client.session.active().catch((error: Error) => error),
        client.form.list().catch((error: Error) => error),
        client.permission.request.list().catch((error: Error) => error),
      ])
      if (sessions instanceof Error) fail(sessions, errorCode)
      if (active instanceof Error) fail(active, errorCode)
      if (forms instanceof Error) fail(forms, errorCode)
      if (permissions instanceof Error) fail(permissions, errorCode)
      const waiting = new Set([...forms.data.map((form) => form.sessionID), ...permissions.data.map((permission) => permission.sessionID)])
      const excluded = options.exclude ?? []
      const rows = sessions
        .filter((session) => !excluded.includes(session.id) && (!options.active || session.id in active))
        .map((session) => ({ ...session, status: waiting.has(session.id) ? 'waiting' : session.id in active ? 'busy' : 'idle' }))
      printRows({ json: options.json, rows, line: (row) => `${row.id} ${row.status} ${row.title ?? ''} tokens: ${row.tokens.input + row.tokens.output}` })
      if (options.active && rows.length === 0) process.exitCode = 1
    })

  cli.command('session search <query>', 'Search titles, then real message content')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--project <path>', 'Project (default: current directory)')
    .option('-c, --channel <id>', 'Project of this Discord channel')
    .option('--all', 'All projects')
    .option('--days <n>', 'Recent days (default: 14; 0 = all)')
    .option('--json', 'Output as JSON')
    .action(async (query, options) => {
      const client = await readClient()
      const directory = options.all ? undefined : await projectDirectory({ project: options.project, channel: options.channel, dataDir: options.dataDir })
      const sessions = await allSessions({ client, directory })
      if (sessions instanceof Error) fail(sessions)
      // `/pattern/flags` is a regular expression, anything else a case-insensitive substring.
      const pattern = query.match(/^\/(.*)\/([dgimsuvy]*)$/)
      const expression = pattern ? new RegExp(pattern[1]!, pattern[2]) : null
      const matches = (text: string) => {
        if (!expression) return text.toLowerCase().includes(query.toLowerCase())
        expression.lastIndex = 0
        return expression.test(text)
      }
      const days = Number(options.days ?? 14)
      if (!Number.isFinite(days) || days < 0) fail(new Error('--days must be a non-negative number'))
      const recent = sessions.filter((session) => !days || session.time.updated >= Date.now() - days * 86400000)
      // OpenCode has no content search API: scan pages newest first, stop at the first hit.
      const hit = async (session: (typeof sessions)[number]) => {
        if (matches(session.title ?? '')) return true
        const scan = async (cursor: string | undefined): Promise<OpenCodeError | boolean> => {
          const page = await client.message.list({ sessionID: session.id, limit: 200, ...(cursor ? { cursor } : { order: 'desc' as const }) })
            .catch((cause) => new OpenCodeError({ operation: 'message.list', cause }))
          if (page instanceof Error) return page
          if (page.data.some((message) => matches(message.type === 'user' ? message.text : JSON.stringify(message)))) return true
          return page.cursor.next ? scan(page.cursor.next) : false
        }
        return scan(undefined)
      }
      // 8 sessions at a time.
      const results: boolean[] = new Array(recent.length)
      const next = { index: 0 }
      await Promise.all(Array.from({ length: Math.min(8, recent.length) }, async () => {
        while (next.index < recent.length) {
          const index = next.index++
          const result = await hit(recent[index]!)
          if (result instanceof Error) fail(result)
          results[index] = result
        }
      }))
      const found = recent.filter((_, index) => results[index])
      printRows({ json: options.json, rows: found, line: (session) => `${session.id} ${session.title}` })
    })

  cli.command('session wait <id>', 'Wait until idle or waiting for input, then print the session')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--timeout <duration>', 'Timeout, for example 30m or 2h')
    .action(async (id, options) => {
      const { sessionId } = await resolveTarget(id, options.dataDir)
      const timeout = options.timeout ? parseDuration(options.timeout) : undefined
      if (timeout instanceof Error) fail(new Error('Use --timeout 30m, 2h, or another positive duration'))
      const client = await readClient()
      await waitAndPrintSession({ client, sessionId, signal: timeout === undefined ? undefined : AbortSignal.timeout(timeout) })
    })

  cli.command('session editors <file>', 'List sessions that last edited a file, newest first')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--json', 'Output as JSON')
    .option('--limit <n>', 'Max sessions to show (default: 20)')
    .action(async (file, options) => {
      const limit = Number(options.limit ?? 20)
      if (!Number.isInteger(limit) || limit < 1) fail(new Error('--limit must be a positive integer'))
      const events = await loadFileEditEvents({ dataDir: dataDirOrDefault(options.dataDir) })
      if (events instanceof Error) fail(events)
      const editors = (await editorsForFile({ events, filePath: file, cwd: process.cwd() })).slice(0, limit)
      if (editors.length === 0) fail(new Error(`No recorded editors for ${path.resolve(file)}`))
      // Titles are optional: a missing database only hides them.
      const titles = new Map<string, string>()
      const { openDb } = await import('../db.ts')
      const opened = await openDb({ dataDir: dataDirOrDefault(options.dataDir), migrate: false })
      if (!(opened instanceof Error)) {
        const threads = await opened.db.query.thread_sessions.findMany({ where: { session_id: { in: editors.map((editor) => editor.sessionId) } }, orderBy: { updated_at: 'desc' } }).catch(() => [])
        for (const thread of threads) if (!titles.has(thread.session_id) && thread.last_synced_name) titles.set(thread.session_id, thread.last_synced_name)
        opened.close()
      }
      const rows = editors.map((editor) => ({ sessionId: editor.sessionId, title: titles.get(editor.sessionId) ?? '-', editedAt: new Date(editor.at).toISOString() }))
      printRows({ json: options.json, rows, line: (row) => `${row.sessionId} | ${row.title} | ${row.editedAt}` })
    })

  cli.command('session diff', 'Upload the git diff of the session folder to critique.work and print the URL')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-s, --session <id>', SESSION_HELP)
    .action(async (options) => {
      const id = options.session ?? process.env['OPENCODE_SESSION_ID']
      if (!id) fail(new Error('Use --session or run inside an OpenCode session'))
      const client = await readClient()
      const { sessionId } = await resolveTarget(id, options.dataDir)
      const session = await client.session.get({ sessionID: sessionId }).catch((cause) => new OpenCodeError({ operation: 'session.get', cause }))
      if (session instanceof Error) fail(session)
      const result = await execFileAsync('critique', ['--web', session.title ?? 'Session diff'], { cwd: session.location.directory })
        .catch((cause: Error & { stderr?: string }) => new Error(`critique failed: ${cause.stderr?.trim() || cause.message}`, { cause }))
      if (result instanceof Error) fail(result)
      process.stdout.write(result.stdout)
    })

  cli.command('session url <id>', 'Print the Discord URL of a session or thread')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .action(async (id, options) => {
      const result = await resolveTarget(id, options.dataDir)
      if (!result.threadId) fail(new Error(`No Kimaki thread for ${id}. Pass a root session ID or thread ID.`))
      const { api } = await discordApi(options.dataDir)
      const thread = await api.channels.get(result.threadId).catch((error: Error) => error)
      if (thread instanceof Error) fail(thread)
      if (!isThread(thread)) fail(new Error('Target is not a Discord thread'))
      if (!thread.guild_id) fail(new Error('Thread has no guild'))
      process.stdout.write(`https://discord.com/channels/${thread.guild_id}/${result.threadId}\n`)
    })
}

// abort, archive, title, queue, command, shell, btw, fork, resume: all through the bot.
export function registerSessionActionCommands(cli: Goke) {
  cli.command('session abort [id]', 'Stop the running turn and clear its queue')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .action(async (id, options) => action({ route: 'session.abort', dataDir: options.dataDir, input: targetOrEnv(id) }))

  cli.command('session archive [id]', 'Archive a session thread')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .action(async (id, options) => action({ route: 'session.archive', dataDir: options.dataDir, input: targetOrEnv(id) }))

  cli.command('session title <title>', 'Rename the session and its Discord thread')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-s, --session <id>', SESSION_HELP)
    .action(async (title, options) => action({ route: 'session.title', dataDir: options.dataDir, input: { text: title, ...targetOrEnv(options.session) } }))

  for (const name of ['add', 'remove'] as const) {
    cli.command(`session queue ${name} <value>`, `${name} native queued prompts`)
      .option('--data-dir <path>', DATA_DIR_HELP)
      .option('-s, --session <id>', SESSION_HELP)
      .option('--json', 'Output as JSON')
      .action(async (value, options) => {
        const target = targetOrEnv(options.session)
        if (name === 'add') return action({ route: 'queue.add', dataDir: options.dataDir, input: { ...target, text: value } })
        return action({ route: 'queue.remove', dataDir: options.dataDir, input: { ...target, inboxId: value } })
      })
  }
  for (const name of ['list', 'clear'] as const) {
    cli.command(`session queue ${name}`, `${name} native queued prompts`)
      .option('--data-dir <path>', DATA_DIR_HELP)
      .option('-s, --session <id>', SESSION_HELP)
      .option('--json', 'Output as JSON')
      .action(async (options) => action({ route: `queue.${name}`, dataDir: options.dataDir, input: targetOrEnv(options.session) }))
  }

  cli.command('session command <name> [...args]', 'Run an OpenCode command, skill, or MCP prompt')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-s, --session <id>', SESSION_HELP)
    .option('--queue', 'Run after the current turn instead of interrupting')
    .action(async (name, args, options) => {
      const text = [name, ...args, ...(options['--'] ?? [])].join(' ')
      await action({ route: 'session.command', dataDir: options.dataDir, input: { ...targetOrEnv(options.session), text, queue: options.queue } })
    })

  for (const name of ['shell', 'btw'] as const) {
    cli.command(`session ${name} <text>`, `Run ${name} through the shared session action`)
      .option('--data-dir <path>', DATA_DIR_HELP)
      .option('-s, --session <id>', SESSION_HELP)
      .option('--queue', 'Queue an OpenCode command')
      .action(async (text, options) => action({ route: `session.${name}`, dataDir: options.dataDir, input: { ...targetOrEnv(options.session), text } }))
  }

  cli.command('session fork [id]', 'Fork a root or child session into a new thread')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--before <messageId>', 'Fork before this user message')
    .option('-n, --name <name>', 'Thread name')
    .action(async (id, options) => action({ route: 'session.fork', dataDir: options.dataDir, input: { ...targetOrEnv(id), before: options.before, name: options.name } }))

  cli.command('session resume <id>', 'Bind an existing session to a new thread in its project channel')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-c, --channel <id>', 'Destination channel (default: channel of the session folder)')
    .action(async (id, options) => action({ route: 'session.resume', dataDir: options.dataDir, input: { sessionId: id, channelId: options.channel } }))
}

// events, read, cwd
export function registerSessionHistoryCommands(cli: Goke) {
  cli.command('session events <id>', 'Print the recorded OpenCode events of a thread as JSONL (root + subagents)')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .example('kimaki2 session events ses_abc | jq -r .event.type | sort | uniq -c')
    .example(`kimaki2 session events ses_abc | jq 'select(.event.type == "session.retry.scheduled")'`)
    .action(async (id, options) => {
      const resolved = await resolveTarget(id, options.dataDir)
      if (!resolved.threadId) fail(new Error(`No Kimaki thread for ${id}. Pass a root session ID or thread ID.`))
      const file = sessionEventsFile({ dataDir: dataDirOrDefault(options.dataDir), threadId: resolved.threadId })
      if (!fs.existsSync(file)) fail(new Error(`No events recorded for thread ${resolved.threadId} yet (${file})`))
      await pipeline(fs.createReadStream(file), process.stdout)
    })

  cli.command('session read <id>', 'Print the messages of a session from OpenCode as markdown')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--thinking', 'Include reasoning')
    .option('--verbose', 'Include full tool inputs and outputs')
    .option('--json', 'Print raw OpenCode messages')
    .action(async (id, options) => {
      // Subagent sessions are not in SQLite: resolveTarget keeps their ID.
      const { sessionId } = await resolveTarget(id, options.dataDir)
      const client = await readClient()
      if (options.json) {
        const messages = await allMessages({ client, sessionId })
        if (messages instanceof Error) fail(messages)
        return printJson(messages)
      }
      const markdown = await readSessionMarkdown({ client, sessionId, thinking: options.thinking, verbose: options.verbose })
      if (markdown instanceof Error) fail(markdown)
      process.stdout.write(`${markdown}\n`)
    })

  cli.command('session cwd [directory]', 'Show or change the working directory at a native safe boundary')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-s, --session <id>', SESSION_HELP)
    .action(async (directory, options) => {
      await action({ route: 'session.cwd', dataDir: options.dataDir, input: { ...targetOrEnv(options.session), directory } })
    })
}
