#!/usr/bin/env node
// kimaki2 entrypoint. `kimaki2` starts the bot and onboards on first start;
// `project list/add` manage project channels while the bot runs. Gateway mode
// and the other subcommands arrive in later phases (spec section 30).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { goke } from 'goke'

import { openDb } from './db.ts'
import { DEFAULT_LOCK_PORT } from './lock-server.ts'
import { createLogger } from './logger.ts'
import { startBot } from './main.ts'
import { resolveOpencode } from './opencode-server.ts'
import { readSessionMarkdown, resolveSession, sessionEventsFile } from './session-events.ts'
import { readSavedCredentials, resolveCredentials, restApiUrl } from './credentials.ts'
import { chooseGuild, kimakiShellCommand, runOnboarding } from './onboarding.ts'
import {
  addProjectChannel,
  categoryNameFor,
  createApi,
  listProjects,
  resolveGuildId,
} from './project.ts'

const logger = createLogger('CLI')

const cli = goke('kimaki2')

function dataDirOrDefault(dataDir: string | undefined): string {
  return path.resolve(dataDir ?? path.join(os.homedir(), '.kimaki'))
}

// Prints the error and its cause chain: "Discord login failed" alone hides why.
function fail(error: Error): never {
  const lines = [error.message]
  for (let cause = error.cause; cause instanceof Error; cause = cause.cause) lines.push(`  caused by: ${cause.message}`)
  process.stderr.write(`${lines.join('\n')}\n`)
  process.exit(1)
}

cli
  .command('', 'Start the bot. Runs onboarding on first start')
  .option('--data-dir <path>', 'Data directory (default: ~/.kimaki)')
  .option('-g, --guild <guildId>', 'Server to onboard when the bot is in several')
  .option('--gateway', 'Use the shared Kimaki bot, no Discord app needed')
  .option('--restart-onboarding', 'Choose credentials again')
  .action(async (options) => {
    const dataDir = dataDirOrDefault(options.dataDir)
    const resolved = await (async () => {
      const opened = await openDb({ dataDir, migrate: true })
      if (opened instanceof Error) return opened
      const result = await resolveCredentials({
        db: opened.db,
        gateway: Boolean(options.gateway),
        restartOnboarding: Boolean(options.restartOnboarding),
      })
      opened.close()
      return result
    })()
    if (resolved instanceof Error) fail(resolved)
    const { credentials, install } = resolved
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
      ensureOpencode: true,
    })
    if (bot instanceof Error) fail(bot)
    const shutdown = () => {
      void bot.stop().then(() => process.exit(0))
    }
    process.once('SIGTERM', shutdown)
    process.once('SIGINT', shutdown)

    const guild = await chooseGuild({ discord: bot.discord, guildId: options.guild ?? install?.guildId })
    if (guild instanceof Error) fail(guild)
    const onboarded = await runOnboarding({
      bot,
      dataDir,
      guild,
      kimaki,
      gateway: credentials.mode === 'gateway',
      installerId: install?.installerId,
    })
    if (onboarded instanceof Error) logger.error(`onboarding failed: ${onboarded.message}`)
    if (onboarded && !(onboarded instanceof Error)) {
      process.stderr.write(`Onboarding thread: https://discord.com/channels/${guild.id}/${onboarded.threadId}\n`)
    }
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
      const gateway = credentials.mode === 'gateway'
      const categoryName = await categoryNameFor({ api, guildId, botId: credentials.appId, gateway })
      if (categoryName instanceof Error) return categoryName
      return addProjectChannel({ api, db: opened.db, guildId, directory: projectDirectory, categoryName })
    })()
    opened.close()
    if (result instanceof Error) fail(result)
    const verb = result.created ? 'Added' : 'Already added'
    process.stdout.write(`${verb} <#${result.channelId}> for ${result.directory}\n`)
  })

cli.section('Session')

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
  .action(async (id, options) => {
    const opened = await openDb({ dataDir: dataDirOrDefault(options.dataDir), migrate: false })
    if (opened instanceof Error) fail(opened)
    const resolved = await resolveSession({ db: opened.db, id })
    opened.close()
    // Subagent sessions are not in SQLite: read them directly.
    const sessionId = resolved instanceof Error ? id : resolved.sessionId
    const endpoint = await resolveOpencode({ ensure: false })
    if (endpoint instanceof Error) fail(endpoint)
    const markdown = await readSessionMarkdown({ client: endpoint.client, sessionId })
    if (markdown instanceof Error) fail(markdown)
    process.stdout.write(`${markdown}\n`)
  })

cli.help()
void cli.parse()
