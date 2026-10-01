#!/usr/bin/env node
// kimaki2 entrypoint. `kimaki2` starts the bot and onboards on first start;
// `project list/add` manage project channels while the bot runs. Gateway mode
// and the other subcommands arrive in later phases (spec section 30).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import dedent from 'string-dedent'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { goke, wrapJsonSchema } from 'goke'
import { ChannelType } from 'discord.js'

import { openDb } from './db.ts'
import { DbError, OpenCodeError } from './errors.ts'
import { callBot, DEFAULT_LOCK_PORT } from './lock-server.ts'
import { editorsForFile, loadFileEditEvents } from './file-edit-log.ts'
import { createLogger } from './logger.ts'
import { startBot } from './main.ts'
import { opencodeConfigDir, resolveOpencode } from './opencode-server.ts'
import { allMessages, allSessions, readSessionMarkdown, resolveSession, sessionEventsFile, waitForSessionReady } from './session-events.ts'
import {
  emitEvent,
  gatewayCredentials,
  gatewayUrlsFromEnv,
  installUrlFor,
  readSavedCredentials,
  resolveCredentials,
  restApiUrl,
} from './credentials.ts'
import { chooseGuild, kimakiShellCommand, runOnboarding, startCaffeinate } from './onboarding.ts'
import { createAnalytics } from './analytics.ts'
import { addProjectChannel, canonicalPath, countUserProjects, createApi, defaultMachineName, listProjects, resolveGuildId } from './project.ts'

const logger = createLogger('CLI')
const execFileAsync = promisify(execFile)

const cli = goke('kimaki2')

async function readClient(errorCode = 1) {
  const endpoint = await resolveOpencode({ ensure: false, serviceFile: process.env['KIMAKI_OPENCODE_SERVICE_FILE'] })
  if (endpoint instanceof Error) fail(endpoint, errorCode)
  return endpoint.client
}

async function sessionIdFor(id: string, dataDir: string | undefined) {
  if (id.startsWith('ses_')) return id
  const opened = await openDb({ dataDir: dataDirOrDefault(dataDir), migrate: false })
  if (opened instanceof Error) fail(opened)
  const result = await resolveSession({ db: opened.db, id })
  opened.close()
  if (result instanceof Error) fail(result)
  return result.sessionId
}

async function discordApi(dataDir: string | undefined) {
  const opened = await openDb({ dataDir: dataDirOrDefault(dataDir), migrate: false })
  if (opened instanceof Error) fail(opened)
  const credentials = await readSavedCredentials({ db: opened.db })
  opened.close()
  if (credentials instanceof Error) fail(credentials)
  if (!credentials) fail(new Error('No saved bot credentials. Start Kimaki first.'))
  return { credentials, api: createApi({ token: credentials.token, restUrl: process.env['KIMAKI_DISCORD_REST_URL'] ?? restApiUrl(credentials) }) }
}

function dataDirOrDefault(dataDir: string | undefined): string {
  return path.resolve(dataDir ?? process.env['KIMAKI_DATA_DIR'] ?? path.join(os.homedir(), '.kimaki'))
}

// Project directory: --channel resolves through SQLite, else --project, else the current directory.
async function projectDirectory({ project, channel, dataDir }: { project: string | undefined; channel: string | undefined; dataDir: string | undefined }) {
  if (!channel) return canonicalPath(project ?? process.cwd())
  const opened = await openDb({ dataDir: dataDirOrDefault(dataDir), migrate: false })
  if (opened instanceof Error) fail(opened)
  const row = await opened.db.query.channel_directories.findFirst({ where: { channel_id: channel } }).catch((cause) => new DbError({ operation: 'find channel', cause }))
  opened.close()
  if (row instanceof Error) fail(row)
  if (!row) fail(new Error(`No project directory for channel ${channel}`))
  return canonicalPath(row.directory)
}

// null when the file vanished meanwhile (bot restart).
async function readRange({ file, start, end }: { file: string; start: number; end: number }): Promise<Buffer | null> {
  const handle = await fs.promises.open(file, 'r').catch(() => null)
  if (!handle) return null
  const buffer = Buffer.alloc(end - start)
  const read = await handle.read(buffer, 0, buffer.length, start).catch(() => null)
  await handle.close().catch(() => undefined)
  return read ? buffer.subarray(0, read.bytesRead) : null
}

// tail -f that survives the bot truncating the file on restart.
async function followFile(file: string): Promise<never> {
  const position = { offset: 0 }
  while (true) {
    const size = await fs.promises.stat(file).then((stat) => stat.size).catch(() => 0)
    if (size < position.offset) position.offset = 0
    if (size > position.offset) {
      const chunk = await readRange({ file, start: position.offset, end: size })
      if (chunk) process.stdout.write(chunk)
      position.offset = size
    }
    await sleep(300)
  }
}

// Prints the error and its cause chain: "Discord login failed" alone hides why.
function fail(error: Error, code = 1): never {
  const lines = [error.message]
  for (let cause = error.cause; cause instanceof Error; cause = cause.cause) lines.push(`  caused by: ${cause.message}`)
  process.stderr.write(`${lines.join('\n')}\n`)
  process.exit(code)
}

// Non-TTY hosts get the failure as an `error` event too (programmatic onboarding).
function failStartup(error: Error, installUrl?: string): never {
  if (!process.stdin.isTTY) emitEvent({ type: 'error', message: error.message, ...(installUrl && { install_url: installUrl }) })
  fail(error)
}

cli
  .command('', 'Start the bot. Runs onboarding on first start')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .option('-g, --guild <guildId>', 'Server to onboard when the bot is in several')
  .option('--gateway', 'Use the shared Kimaki bot, no Discord app needed')
  .option('--gateway-callback-url <url>', 'Redirect here after the gateway install (appends ?guild_id=<id>)')
  .option('--install-url', 'Print the install URL and exit (non-interactive onboarding)')
  .option('--machine-name <name>', 'Name in this machine\'s category "Kimaki <name>" (default: hostname)')
  .option('--restart-onboarding', 'Choose credentials again')
  .option('--no-analytics', 'Disable anonymous usage analytics (same as KIMAKI_STRADA_ENABLED=0)')
  .action(async (options) => {
    const dataDir = dataDirOrDefault(options.dataDir)
    const urls = gatewayUrlsFromEnv()
    const machine = options.machineName ?? defaultMachineName()
    const opened = await openDb({ dataDir, migrate: true })
    if (opened instanceof Error) failStartup(opened)

    if (options.installUrl) {
      const credentials = options.gateway
        ? await gatewayCredentials({ db: opened.db, urls })
        : await readSavedCredentials({ db: opened.db })
      opened.close()
      if (credentials instanceof Error) fail(credentials)
      if (!credentials) fail(new Error('No bot configured yet. Run kimaki first, or pass --gateway.'))
      process.stdout.write(`${installUrlFor({ credentials, website: urls.website, callbackUrl: options.gatewayCallbackUrl })}\n`)
      if (credentials.mode === 'gateway') process.stderr.write('This URL contains your client credentials. Do not share it.\n')
      return
    }

    startCaffeinate()
    const resolved = await resolveCredentials({
      db: opened.db,
      gateway: Boolean(options.gateway),
      restartOnboarding: Boolean(options.restartOnboarding),
      urls,
      callbackUrl: options.gatewayCallbackUrl,
    })
    opened.close()
    if (resolved instanceof Error) failStartup(resolved)
    const { credentials, install } = resolved
    const installUrl = installUrlFor({ credentials, website: urls.website, callbackUrl: options.gatewayCallbackUrl })
    // The agent calls this same install: same node, loader flags and script.
    const kimaki = kimakiShellCommand({
      command: [process.execPath, ...process.execArgv, process.argv[1] ?? 'kimaki2'],
      dataDir,
    })

    const bot = await startBot({
      kimakiCommand: kimaki,
      dataDir,
      token: credentials.token,
      discordRestUrl: restApiUrl(credentials),
      lockPort: Number(process.env['KIMAKI_LOCK_PORT'] || DEFAULT_LOCK_PORT),
      opencodeServiceFile: process.env['KIMAKI_OPENCODE_SERVICE_FILE'],
      ensureOpencode: true,
      opencodeConfigDir: opencodeConfigDir(),
      analytics: createAnalytics({ dataDir, botMode: credentials.mode, enabled: !options.noAnalytics }),
    })
    if (bot instanceof Error) failStartup(bot)
    const shutdown = () => {
      void bot.stop().then(() => process.exit(0))
    }
    process.once('SIGTERM', shutdown)
    process.once('SIGINT', shutdown)

    const gateway = credentials.mode === 'gateway'
    const guild = await chooseGuild({ discord: bot.discord, guildId: options.guild ?? install?.guildId, installUrl, gateway })
    if (guild instanceof Error) {
      await bot.stop()
      failStartup(guild, installUrl)
    }
    const onboarded = await runOnboarding({ bot, dataDir, guild, kimaki, gateway, installerId: install?.installerId, machine })
    if (onboarded instanceof Error) logger.error(`onboarding failed: ${onboarded.message}`)
    if (onboarded && !(onboarded instanceof Error)) {
      process.stderr.write(`Onboarding thread: https://discord.com/channels/${guild.id}/${onboarded.threadId}\n`)
    }
    if (!process.stdin.isTTY) emitEvent({ type: 'ready', app_id: credentials.appId, guild_ids: [...bot.discord.guilds.cache.keys()] })
  })

cli.section('Project')

cli
  .command('project list', 'List project directories and their channels')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const opened = await openDb({ dataDir: dataDirOrDefault(options.dataDir), migrate: false })
    if (opened instanceof Error) fail(opened)
    const rows = await listProjects({ db: opened.db })
    opened.close()
    if (rows instanceof Error) fail(rows)
    if (options.json) {
      const projects = rows.map((row) => ({ channelId: row.channel_id, directory: row.directory, guildId: row.guild_id }))
      process.stdout.write(`${JSON.stringify(projects, null, 2)}\n`)
      return
    }
    for (const row of rows) process.stdout.write(`<#${row.channel_id}> ${row.directory}\n`)
  })

cli
  .command('project add [directory]', 'Create a channel for a directory (default: current directory)')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .option('-g, --guild <guildId>', 'Server (default: the one with Kimaki channels)')
  .option('--machine-name <name>', 'Machine name of a new category and of a channel name suffix (default: hostname)')
  .action(async (directory, options) => {
    const projectDirectory = path.resolve(directory ?? process.cwd())
    const opened = await openDb({ dataDir: dataDirOrDefault(options.dataDir), migrate: false })
    if (opened instanceof Error) fail(opened)
    const result = await (async () => {
      const credentials = await readSavedCredentials({ db: opened.db })
      if (credentials instanceof Error) return credentials
      if (!credentials) return new Error('No saved bot credentials. Start kimaki once to onboard.')
      const guildId = await resolveGuildId({ db: opened.db, guildId: options.guild })
      if (guildId instanceof Error) return guildId
      const api = createApi({ token: credentials.token, restUrl: restApiUrl(credentials) })
      const added = await addProjectChannel({ api, db: opened.db, guildId, directory: projectDirectory, machine: options.machineName ?? defaultMachineName() })
      if (added instanceof Error || !added.created) return added
      const analytics = createAnalytics({ dataDir: dataDirOrDefault(options.dataDir), botMode: credentials.mode, enabled: true })
      const projects = await countUserProjects({ db: opened.db, dataDir: dataDirOrDefault(options.dataDir) })
      analytics.track('project_registered', { project_kind: 'user', source: 'cli', ...(!(projects instanceof Error) && { user_project_count: projects }) })
      await analytics.flush()
      return added
    })()
    opened.close()
    if (result instanceof Error) fail(result)
    const verb = result.created ? 'Added' : 'Already added'
    process.stdout.write(`${verb} <#${result.channelId}> for ${result.directory}\n`)
  })

cli.section('Session')

cli.command('session list', 'List sessions with native status and token counts')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .option('--project <path>', 'Project (default: current directory)')
  .option('--all', 'All projects')
  .option('--active', 'Only busy sessions; exit 1 when none remain, 64 on errors')
  .option('--exclude <id>', wrapJsonSchema<string[]>({ type: 'array', items: { type: 'string' }, description: 'Exclude session (repeatable)' }))
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const client = await readClient(options.active ? 64 : 1)
    const [sessions, active, forms, permissions] = await Promise.all([
      allSessions({ client, directory: options.all ? undefined : await projectDirectory({ project: options.project, channel: undefined, dataDir: options.dataDir }) }),
      client.session.active().catch((error: Error) => error), client.form.list().catch((error: Error) => error),
      client.permission.request.list().catch((error: Error) => error),
    ])
    if (sessions instanceof Error) fail(sessions, options.active ? 64 : 1)
    if (active instanceof Error) fail(active, options.active ? 64 : 1)
    if (forms instanceof Error) fail(forms, options.active ? 64 : 1)
    if (permissions instanceof Error) fail(permissions, options.active ? 64 : 1)
    const rows = sessions.filter((session) => !(options.exclude ?? []).includes(session.id) && (!options.active || session.id in active))
      .map((session) => ({ ...session, status: forms.data.some((form) => form.sessionID === session.id) || permissions.data.some((permission) => permission.sessionID === session.id) ? 'waiting' : session.id in active ? 'busy' : 'idle' }))
    process.stdout.write(options.json ? `${JSON.stringify(rows, null, 2)}\n` : rows.map((row) => `${row.id} ${row.status} ${row.title ?? ''} tokens: ${row.tokens.input + row.tokens.output}\n`).join(''))
    if (options.active && rows.length === 0) process.exitCode = 1
  })

cli.command('session search <query>', 'Search titles, then real message content')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .option('--project <path>', 'Project (default: current directory)')
  .option('-c, --channel <id>', 'Project of this Discord channel')
  .option('--all', 'All projects')
  .option('--days <n>', 'Recent days (default: 14; 0 = all)')
  .option('--json', 'Output as JSON')
  .action(async (query, options) => {
    const client = await readClient()
    const sessions = await allSessions({ client, directory: options.all ? undefined : await projectDirectory({ project: options.project, channel: options.channel, dataDir: options.dataDir }) })
    if (sessions instanceof Error) fail(sessions)
    const pattern = query.match(/^\/(.*)\/([dgimsuvy]*)$/)
    const expression = pattern ? new RegExp(pattern[1]!, pattern[2]) : null
    const matches = (text: string) => { if (!expression) return text.toLowerCase().includes(query.toLowerCase()); expression.lastIndex = 0; return expression.test(text) }
    const days = Number(options.days ?? 14)
    if (!Number.isFinite(days) || days < 0) fail(new Error('--days must be a non-negative number'))
    const found: typeof sessions = []
    for (const session of sessions) {
      if (days && session.time.updated < Date.now() - days * 86400000) continue
      if (matches(session.title ?? '')) { found.push(session); continue }
      const messages = await allMessages({ client, sessionId: session.id })
      if (messages instanceof Error) fail(messages)
      if (messages.some((message) => matches(message.type === 'user' ? message.text : JSON.stringify(message)))) found.push(session)
    }
    process.stdout.write(options.json ? `${JSON.stringify(found, null, 2)}\n` : found.map((session) => `${session.id} ${session.title}\n`).join(''))
  })

cli.command('session wait <id>', 'Wait until idle or waiting for input, then print the session')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .option('--timeout <duration>', 'Timeout, for example 30m or 2h')
  .action(async (id, options) => {
    const sessionId = await sessionIdFor(id, options.dataDir)
    const duration = options.timeout?.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/)
    if (options.timeout && !duration) fail(new Error('Use --timeout 30m, 2h, or another positive duration'))
    const units: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }
    const signal = duration ? AbortSignal.timeout(Number(duration[1]) * units[duration[2]!]!) : undefined
    const client = await readClient()
    const result = await waitForSessionReady({ client, sessionId, signal })
    if (result instanceof Error) fail(result)
    const markdown = await readSessionMarkdown({ client, sessionId })
    if (markdown instanceof Error) fail(markdown)
    process.stdout.write(`${markdown}\n`)
  })

cli.command('session editors <file>', 'List sessions that last edited a file, newest first')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .option('--json', 'Output as JSON')
  .option('--limit <n>', 'Max sessions to show (default: 20)')
  .action(async (file, options) => {
    const limit = Number(options.limit ?? 20)
    if (!Number.isInteger(limit) || limit < 1) fail(new Error('--limit must be a positive integer'))
    const events = await loadFileEditEvents({ dataDir: dataDirOrDefault(options.dataDir) })
    if (events instanceof Error) fail(events)
    const editors = (await editorsForFile({ events, filePath: file, cwd: process.cwd() })).slice(0, limit)
    if (editors.length === 0) fail(new Error(`No recorded editors for ${path.resolve(file)}`))
    const opened = await openDb({ dataDir: dataDirOrDefault(options.dataDir), migrate: false })
    const titles = new Map<string, string>()
    if (!(opened instanceof Error)) {
      const rows = await opened.db.query.thread_sessions.findMany({ where: { session_id: { in: editors.map((editor) => editor.sessionId) } }, orderBy: { updated_at: 'desc' } }).catch(() => [])
      for (const row of rows) if (!titles.has(row.session_id) && row.last_synced_name) titles.set(row.session_id, row.last_synced_name)
      opened.close()
    }
    const rows = editors.map((editor) => ({ sessionId: editor.sessionId, title: titles.get(editor.sessionId) ?? '-', editedAt: new Date(editor.at).toISOString() }))
    process.stdout.write(options.json ? `${JSON.stringify(rows, null, 2)}\n` : rows.map((row) => `${row.sessionId} | ${row.title} | ${row.editedAt}\n`).join(''))
  })

cli.command('session diff', 'Upload the git diff of the session folder to critique.work and print the URL')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .option('-s, --session <id>', 'Session (default: OPENCODE_SESSION_ID)')
  .action(async (options) => {
    const id = options.session ?? process.env['OPENCODE_SESSION_ID']
    if (!id) fail(new Error('Use --session or run inside an OpenCode session'))
    const client = await readClient()
    const session = await client.session.get({ sessionID: await sessionIdFor(id, options.dataDir) }).catch((cause) => new OpenCodeError({ operation: 'session.get', cause }))
    if (session instanceof Error) fail(session)
    const result = await execFileAsync('critique', ['--web', session.title ?? 'Session diff'], { cwd: session.location.directory })
      .catch((cause: Error & { stderr?: string }) => new Error(`critique failed: ${cause.stderr?.trim() || cause.message}`, { cause }))
    if (result instanceof Error) fail(result)
    process.stdout.write(result.stdout)
  })

cli.command('session url <id>', 'Print the Discord URL of a session or thread')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .action(async (id, options) => {
    const opened = await openDb({ dataDir: dataDirOrDefault(options.dataDir), migrate: false })
    if (opened instanceof Error) fail(opened)
    const result = await resolveSession({ db: opened.db, id })
    if (result instanceof Error) fail(result)
    opened.close()
    const { api } = await discordApi(options.dataDir)
    const thread = await api.channels.get(result.threadId).catch((error: Error) => error)
    if (thread instanceof Error) fail(thread)
    if (thread.type !== ChannelType.PublicThread && thread.type !== ChannelType.PrivateThread && thread.type !== ChannelType.AnnouncementThread) fail(new Error('Target is not a Discord thread'))
    if (!thread.guild_id) fail(new Error('Thread has no guild'))
    process.stdout.write(`https://discord.com/channels/${thread.guild_id}/${result.threadId}\n`)
  })

async function action(name: string, dataDir: string | undefined, input: unknown) {
  const result = await callBot({ dataDir: dataDirOrDefault(dataDir), route: `/kimaki/action/${name}`, input })
  if (result instanceof Error) fail(result)
  process.stdout.write(`${JSON.stringify(result.data)}\n`)
}

for (const command of ['agent', 'model', 'verbosity'] as const) {
  cli.command(`channel ${command} [value]`, `Set channel ${command} through the running bot`)
    .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
    .option('-c, --channel <id>', 'Target channel (default: current project)')
    .option('--variant <name>', 'Thinking variant for model')
    .option('--clear', 'Clear a saved agent or model')
    .action(async (value, options) => action(`channel.${command}`, options.dataDir, {
      channelId: options.channel, directory: process.cwd(), clear: options.clear, variant: options.variant,
      ...(command === 'verbosity' ? { text: value } : { [command]: value }),
    }))
}

cli.command('session abort [id]', 'Stop the running turn and clear its queue')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .action(async (id, options) => action('session.abort', options.dataDir, { sessionId: id ?? process.env['OPENCODE_SESSION_ID'] }))

cli.command('session archive [threadId]', 'Archive a session thread')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .option('-s, --session <id>', 'Session (default: OPENCODE_SESSION_ID)')
  .action(async (threadId, options) => action('session.archive', options.dataDir, { threadId, sessionId: threadId ? undefined : options.session ?? process.env['OPENCODE_SESSION_ID'] }))

cli.command('session title <title>', 'Rename the session and its Discord thread')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .option('-s, --session <id>', 'Session (default: OPENCODE_SESSION_ID)')
  .action(async (title, options) => action('session.title', options.dataDir, { text: title, sessionId: options.session ?? process.env['OPENCODE_SESSION_ID'] }))

for (const name of ['add', 'remove'] as const) {
  cli.command(`session queue ${name} <value>`, `${name} native queued prompts`)
    .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
    .option('-s, --session <id>', 'Session (default: OPENCODE_SESSION_ID)')
    .option('--json', 'Output as JSON')
    .action(async (value, options) => action(`queue.${name}`, options.dataDir, { sessionId: options.session ?? process.env['OPENCODE_SESSION_ID'], ...(name === 'add' ? { text: value } : { inboxId: value }) }))
}
for (const name of ['list', 'clear'] as const) {
  cli.command(`session queue ${name}`, `${name} native queued prompts`)
    .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
    .option('-s, --session <id>', 'Session (default: OPENCODE_SESSION_ID)')
    .option('--json', 'Output as JSON')
    .action(async (options) => action(`queue.${name}`, options.dataDir, { sessionId: options.session ?? process.env['OPENCODE_SESSION_ID'] }))
}

cli.command('session command <name> [...args]', 'Run an OpenCode command, skill, or MCP prompt')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .option('-s, --session <id>', 'Session (default: OPENCODE_SESSION_ID)')
  .option('--queue', 'Run after the current turn instead of interrupting')
  .action(async (name, args, options) => action('session.command', options.dataDir, { sessionId: options.session ?? process.env['OPENCODE_SESSION_ID'], text: [name, ...args, ...(options['--'] ?? [])].join(' '), queue: options.queue }))

for (const name of ['shell', 'btw'] as const) {
  cli.command(`session ${name} <text>`, `Run ${name} through the shared session action`)
    .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
    .option('-s, --session <id>', 'Session (default: OPENCODE_SESSION_ID)')
    .option('--queue', 'Queue an OpenCode command')
    .action(async (text, options) => action(`session.${name}`, options.dataDir, { sessionId: options.session ?? process.env['OPENCODE_SESSION_ID'], text, queue: options.queue }))
}

cli.command('session fork [id]', 'Fork a root or child session into a new thread')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .option('--before <messageId>', 'Fork before this user message')
  .option('-n, --name <name>', 'Thread name')
  .action(async (id, options) => action('session.fork', options.dataDir, { sessionId: id ?? process.env['OPENCODE_SESSION_ID'], before: options.before, name: options.name }))

cli.command('session resume <id>', 'Bind an existing session to a new thread in its project channel')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .option('-c, --channel <id>', 'Destination channel (default: channel of the session folder)')
  .action(async (id, options) => action('session.resume', options.dataDir, { sessionId: id, channelId: options.channel }))

cli.command('buttons', 'Show 1-3 action buttons. Call last, after visible text')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .option('-s, --session <id>', 'Session (default: OPENCODE_SESSION_ID)')
  .option('-b, --button <spec>', wrapJsonSchema<string[]>({ type: 'array', items: { type: 'string' }, description: "Repeatable: Label[=command][:white|blue|green|red]" }))
  .action(async (options) => {
    const result = await callBot({ dataDir: dataDirOrDefault(options.dataDir), route: '/kimaki/buttons', input: {
      sessionId: options.session ?? process.env['OPENCODE_SESSION_ID'], buttons: options.button, fromShell: Boolean(process.env['OPENCODE_SESSION_ID']), toolCall: process.env['KIMAKI_TOOL_CALL'],
    } })
    if (result instanceof Error) fail(result)
    process.stdout.write(`${JSON.stringify(result.data)}\n`)
  })

cli.command('upload-request', 'Ask for file uploads; waits up to 6 minutes. Shell timeout must be 10 minutes')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .option('-s, --session <id>', 'Session (default: OPENCODE_SESSION_ID)')
  .option('-p, --prompt <text>', 'Text above the upload button')
  .option('--max-files <n>', '1 to 10 (default: 5)')
  .action(async (options) => {
    const result = await callBot({ dataDir: dataDirOrDefault(options.dataDir), route: '/kimaki/upload-request', signal: AbortSignal.timeout(7 * 60_000), input: {
      sessionId: options.session ?? process.env['OPENCODE_SESSION_ID'], prompt: options.prompt, maxFiles: Number(options.maxFiles ?? 5), fromShell: Boolean(process.env['OPENCODE_SESSION_ID']), toolCall: process.env['KIMAKI_TOOL_CALL'],
    } })
    if (result instanceof Error) fail(result)
    process.stdout.write(`${JSON.stringify(result.data)}\n`)
  })

cli.command('login <provider>', 'Connect a provider using OpenCode integration credentials')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .option('--key <key>', 'API key to store in OpenCode')
  .option('--method <id>', 'OAuth method ID; without flags, list login methods')
  .option('--attempt <id>', 'Check or complete this native OAuth attempt')
  .option('--code <code>', 'Authorization code for the attempt')
  .option('--cancel', 'Cancel the native OAuth attempt')
  .action(async (provider, options) => {
    const result = await callBot({ dataDir: dataDirOrDefault(options.dataDir), route: '/kimaki/login', input: { provider, key: options.key, method: options.method, attempt: options.attempt, code: options.code, ...(options.cancel && { operation: 'cancel' }) } })
    if (result instanceof Error) fail(result)
    process.stdout.write(`${JSON.stringify(result.data)}\n`)
  })

cli.command('login credential <id>', 'Activate, remove, or label an OpenCode credential')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .option('--operation <name>', 'activate | remove | label')
  .option('--label <text>', 'Credential label')
  .action(async (id, options) => {
    const result = await callBot({ dataDir: dataDirOrDefault(options.dataDir), route: '/kimaki/credential', input: { id, operation: options.operation ?? 'activate', label: options.label } })
    if (result instanceof Error) fail(result)
    process.stdout.write(`${JSON.stringify(result.data)}\n`)
  })

cli
  .command('send', 'Start a session in a channel, or continue a thread')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .option('-c, --channel <id>', 'New thread in this channel')
  .option('-d, --project <path>', 'Project directory of the new thread')
  .option('--thread <id>', 'Continue this thread')
  .option('-s, --session <id>', 'Continue this local session')
  .option('-p, --prompt <text>', 'Prompt; thread suffixes . queue and . btw are supported')
  .option('-f, --file <path>', wrapJsonSchema<string[]>({ type: 'array', items: { type: 'string' }, description: 'Attach a local file (repeatable)' }))
  .option('-n, --name <text>', 'Thread name')
  .option('--agent <name>', 'Agent ID')
  .option('--model <provider/model>', 'Model for the new session')
  .option('-u, --user <id>', 'Add this Discord user to the thread')
  .option('--cwd <path>', 'Existing subfolder of the target project')
  .option('--parent-session <id>', 'Record the parent session in session metadata')
  .option('--permission <rule>', wrapJsonSchema<string[]>({ type: 'array', items: { type: 'string' }, description: 'Repeatable: tool[:pattern]:allow|deny|ask' }))
  .option('--notify-only', 'Post a notification thread without a model turn')
  .option('--wait', 'Wait until idle or input is needed, then print the session')
  .action(async (options) => {
    const result = await callBot({ dataDir: dataDirOrDefault(options.dataDir), route: '/kimaki/send', input: {
      channelId: options.channel, project: options.project, threadId: options.thread, sessionId: options.session,
      prompt: options.prompt, name: options.name, agent: options.agent, model: options.model, user: options.user,
      cwd: options.cwd, parentSessionId: options.parentSession, permissions: options.permission, notifyOnly: options.notifyOnly,
      files: (options.file ?? []).map((file) => ({ uri: pathToFileURL(path.resolve(file)).href, name: path.basename(file) })),
    } })
    if (result instanceof Error) fail(result)
    process.stdout.write(`${JSON.stringify(result.data)}\n`)
    if (options.wait) {
      const data = result.data
      if (!data || typeof data !== 'object' || !('sessionId' in data) || typeof data.sessionId !== 'string') fail(new Error('--wait requires an AI session, not --notify-only'))
      const client = await readClient()
      const waited = await waitForSessionReady({ client, sessionId: data.sessionId })
      if (waited instanceof Error) fail(waited)
      const transcript = await readSessionMarkdown({ client, sessionId: data.sessionId })
      if (transcript instanceof Error) fail(transcript)
      process.stdout.write(`${transcript}\n`)
    }
  })

cli
  .command('session events <id>', 'Print the recorded OpenCode events of a thread as JSONL (root + subagents)')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .example('kimaki2 session events ses_abc | jq -r .event.type | sort | uniq -c')
  .example(`kimaki2 session events ses_abc | jq 'select(.event.type == "session.retry.scheduled")'`)
  .action(async (id, options) => {
    const dataDir = dataDirOrDefault(options.dataDir)
    const opened = await openDb({ dataDir, migrate: false })
    if (opened instanceof Error) fail(opened)
    const resolved = await resolveSession({ db: opened.db, id })
    opened.close()
    if (resolved instanceof Error) fail(resolved)
    const file = sessionEventsFile({ dataDir, threadId: resolved.threadId })
    if (!fs.existsSync(file)) fail(new Error(`No events recorded for thread ${resolved.threadId} yet (${file})`))
    await pipeline(fs.createReadStream(file), process.stdout)
  })

cli
  .command('session read <id>', 'Print the messages of a session from OpenCode as markdown')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .option('--thinking', 'Include reasoning')
  .option('--verbose', 'Include full tool inputs and outputs')
  .option('--json', 'Print raw OpenCode messages')
  .action(async (id, options) => {
    const opened = await openDb({ dataDir: dataDirOrDefault(options.dataDir), migrate: false })
    if (opened instanceof Error) fail(opened)
    const resolved = await resolveSession({ db: opened.db, id })
    opened.close()
    // Subagent sessions are not in SQLite: read them directly.
    const sessionId = resolved instanceof Error ? id : resolved.sessionId
    const endpoint = await resolveOpencode({ ensure: false, serviceFile: process.env['KIMAKI_OPENCODE_SERVICE_FILE'] })
    if (endpoint instanceof Error) fail(endpoint)
    if (options.json) {
      const messages = await allMessages({ client: endpoint.client, sessionId })
      if (messages instanceof Error) fail(messages)
      process.stdout.write(`${JSON.stringify(messages, null, 2)}\n`)
      return
    }
    const markdown = await readSessionMarkdown({ client: endpoint.client, sessionId, thinking: options.thinking, verbose: options.verbose })
    if (markdown instanceof Error) fail(markdown)
    process.stdout.write(`${markdown}\n`)
  })

cli.section('Discord')

cli.command('thread list', 'List active and optionally archived threads in a channel')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .option('-c, --channel <id>', 'Channel to list')
  .option('--archived', 'Include archived threads')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    if (!options.channel) fail(new Error('Pass --channel <id>'))
    const { api } = await discordApi(options.dataDir)
    const channel = await api.channels.get(options.channel).catch((error: Error) => error)
    if (channel instanceof Error) fail(channel)
    if (channel.type !== ChannelType.GuildText || !channel.guild_id) fail(new Error('Use a guild text channel'))
    const active = await api.guilds.getActiveThreads(channel.guild_id).catch((error: Error) => error)
    if (active instanceof Error) fail(active)
    const threads = active.threads.filter((thread) => (thread.type === ChannelType.PublicThread || thread.type === ChannelType.PrivateThread || thread.type === ChannelType.AnnouncementThread) && thread.parent_id === options.channel)
    if (options.archived) {
      let before: string | undefined
      do {
        const archived = await api.channels.getArchivedThreads(options.channel, 'public', { limit: 100, before }).catch((error: Error) => error)
        if (archived instanceof Error) fail(archived)
        threads.push(...archived.threads)
        const last = archived.threads.at(-1)
        before = archived.has_more && last && (last.type === ChannelType.PublicThread || last.type === ChannelType.PrivateThread || last.type === ChannelType.AnnouncementThread) ? last.thread_metadata?.archive_timestamp : undefined
      } while (before)
    }
    process.stdout.write(options.json ? `${JSON.stringify(threads, null, 2)}\n` : threads.map((thread) => `${thread.id} ${thread.name}\n`).join(''))
  })

cli.command('user list', 'Find Discord users for mentions')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .option('-g, --guild <id>', 'Guild to search')
  .option('-q, --query <text>', 'Name filter')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    if (!options.guild) fail(new Error('Pass --guild <id>'))
    const { api } = await discordApi(options.dataDir)
    const members = options.query
      ? await api.guilds.searchForMembers(options.guild, { query: options.query, limit: 1000 }).catch((error: Error) => error)
      : await api.guilds.getMembers(options.guild, { limit: 1000 }).catch((error: Error) => error)
    if (members instanceof Error) fail(members)
    const users = members.map((member) => ({ id: member.user.id, username: member.user.username, name: member.nick ?? member.user.global_name }))
    process.stdout.write(options.json ? `${JSON.stringify(users, null, 2)}\n` : users.map((user) => `${user.id} ${user.username}${user.name ? ` (${user.name})` : ''}\n`).join(''))
  })

cli.command('upload-to-discord <...files>', 'Attach local files to a session thread')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .option('-s, --session <id>', 'Session (default: OPENCODE_SESSION_ID)')
  .action(async (files, options) => {
    const id = options.session ?? process.env['OPENCODE_SESSION_ID']
    if (!id) fail(new Error('Use --session or run inside an OpenCode session'))
    const result = await callBot({ dataDir: dataDirOrDefault(options.dataDir), route: '/kimaki/upload', input: { id, files: files.map((file) => ({ path: path.resolve(file), name: path.basename(file) })) } })
    if (result instanceof Error) fail(result)
    process.stdout.write(`${JSON.stringify(result.data)}\n`)
  })

cli.section('Bot')

cli.command('status', 'Bot health: running, pid, uptime, OpenCode URL and version, guilds')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const result = await callBot({ dataDir: dataDirOrDefault(options.dataDir), route: '/kimaki/status', input: {} })
    if (result instanceof Error) {
      process.stdout.write(options.json ? `${JSON.stringify({ running: false, reason: result.message })}\n` : `not running: ${result.message}\n`)
      process.exitCode = 1
      return
    }
    const status = { running: true, ...(result.data && typeof result.data === 'object' ? result.data : {}) }
    if (options.json) {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`)
      return
    }
    const value = (key: string) => (key in status ? JSON.stringify(status[key as keyof typeof status]) : '?')
    process.stdout.write(dedent`
      running: pid ${value('pid')}, up ${value('uptimeSec')}s, mode ${value('mode')}
      opencode: ${value('opencode')}
      guilds: ${value('guilds')}
      data dir: ${value('dataDir')}
    ` + '\n')
  })

cli.command('logs', 'Print the log file path. The bot resets the file on every start')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .option('-f, --follow', 'Print the log and keep printing new lines')
  .action(async (options) => {
    const file = path.join(dataDirOrDefault(options.dataDir), 'kimaki.log')
    if (!options.follow) {
      process.stdout.write(`${file}\n`)
      return
    }
    await followFile(file)
  })

cli.command('bot token', 'Print saved bot credentials for automation')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .action(async (options) => process.stdout.write(`${(await discordApi(options.dataDir)).credentials.token}\n`))

cli.command('bot install-url', 'Print the Discord bot install URL')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .option('--gateway-callback-url <url>', 'Gateway only: redirect here after the install')
  .action(async (options) => {
    const { credentials } = await discordApi(options.dataDir)
    process.stdout.write(`${installUrlFor({ credentials, website: gatewayUrlsFromEnv().website, callbackUrl: options.gatewayCallbackUrl })}\n`)
  })

cli.help()
void cli.parse()
