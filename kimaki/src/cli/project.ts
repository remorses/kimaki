// Project, channel and worktree commands. `project` reads SQLite and the
// Discord REST API directly; channel settings and worktrees go through the bot.

import path from 'node:path'
import type { Goke } from 'goke'

import { createAnalytics } from '../analytics.ts'
import type { KimakiDb } from '../db.ts'
import { callBot } from '../lock-server.ts'
import { action, DATA_DIR_HELP, dataDirOrDefault, fail, openCliDb, printJson } from './shared.ts'

const WORKTREE_TIMEOUT_MS = 25 * 60_000

// SQLite and Discord helpers load lazily: see the note in shared.ts.
async function addProject({ db, dataDir, guild, directory, machine }: { db: KimakiDb; dataDir: string; guild: string | undefined; directory: string; machine: string }) {
  const [{ readSavedCredentials, restApiUrl }, { addProjectChannel, countUserProjects, createApi, resolveGuildId }] = await Promise.all([import('../credentials.ts'), import('../project.ts')])
  const credentials = await readSavedCredentials({ db })
  if (credentials instanceof Error) return credentials
  if (!credentials) return new Error('No saved bot credentials. Start kimaki once to onboard.')
  const guildId = await resolveGuildId({ db, guildId: guild })
  if (guildId instanceof Error) return guildId
  const api = createApi({ token: credentials.token, restUrl: restApiUrl(credentials) })
  const added = await addProjectChannel({ api, db, guildId, directory, machine })
  if (added instanceof Error || !added.created) return added
  // Agents run this while the bot runs: follow the bot's --no-analytics.
  const status = await callBot({ dataDir, route: 'status', input: {} })
  const botAnalytics = status instanceof Error ? null : status.data.analytics
  const analytics = createAnalytics({ dataDir, botMode: credentials.mode, enabled: botAnalytics !== false })
  const projects = await countUserProjects({ db, dataDir })
  analytics.track('project_registered', { project_kind: 'user', source: 'cli', ...(!(projects instanceof Error) && { user_project_count: projects }) })
  await analytics.flush()
  return added
}

export function registerProjectCommands(cli: Goke) {
  cli.command('project list', 'List project directories and their channels')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      const { listProjects } = await import('../project.ts')
      const opened = await openCliDb(options.dataDir)
      const rows = await listProjects({ db: opened.db })
      opened.close()
      if (rows instanceof Error) fail(rows)
      if (options.json) return printJson(rows.map((row) => ({ channelId: row.channel_id, directory: row.directory, guildId: row.guild_id })))
      for (const row of rows) process.stdout.write(`<#${row.channel_id}> ${row.directory}\n`)
    })

  cli.command('project add [directory]', 'Create a channel for a directory (default: current directory)')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-g, --guild <guildId>', 'Server (default: the one with Kimaki channels)')
    .option('--machine-name <name>', 'Machine name of a new category and of a channel name suffix (default: hostname)')
    .action(async (directory, options) => {
      const { defaultMachineName } = await import('../project.ts')
      const opened = await openCliDb(options.dataDir)
      const result = await addProject({
        db: opened.db,
        dataDir: dataDirOrDefault(options.dataDir),
        guild: options.guild,
        directory: path.resolve(directory ?? process.cwd()),
        machine: options.machineName ?? defaultMachineName(),
      })
      opened.close()
      if (result instanceof Error) fail(result)
      process.stdout.write(`${result.created ? 'Added' : 'Already added'} <#${result.channelId}> for ${result.directory}\n`)
    })
}

// channel agent / model / verbosity
export function registerChannelPreferenceCommands(cli: Goke) {
  cli.command('channel agent [value]', 'Set channel agent through the running bot')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-c, --channel <id>', 'Target channel (default: current project)')
    .option('--clear', 'Clear the saved agent')
    .action(async (value, options) => {
      await action({ route: 'channel.agent', dataDir: options.dataDir, input: { channelId: options.channel, directory: process.cwd(), agent: value, clear: options.clear } })
    })
  cli.command('channel model [value]', 'Set channel model through the running bot')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-c, --channel <id>', 'Target channel (default: current project)')
    .option('--variant <name>', 'Thinking variant for model')
    .option('--global', 'Default of all channels without their own model')
    .option('--clear', 'Clear the saved model')
    .action(async (value, options) => {
      const model = { model: value, variant: options.variant, clear: options.clear }
      if (options.global) {
        await action({ route: 'global.model', dataDir: options.dataDir, input: model })
        return
      }
      await action({ route: 'channel.model', dataDir: options.dataDir, input: { channelId: options.channel, directory: process.cwd(), ...model } })
    })
  // A missing verbosity gets the bot's "Invalid channel action or value".
  cli.command('channel verbosity [value]', 'Set channel verbosity through the running bot')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-c, --channel <id>', 'Target channel (default: current project)')
    .action(async (value, options) => {
      await action({ route: 'channel.verbosity', dataDir: options.dataDir, input: { channelId: options.channel, directory: process.cwd(), text: value ?? '' } })
    })
}

export function registerChannelWorktreeCommand(cli: Goke) {
  cli.command('channel worktrees <value>', 'Set automatic worktrees: on | off')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-c, --channel <id>', 'Project channel (default: current directory)')
    .action(async (value, options) => {
      await action({ route: 'channel.worktrees', dataDir: options.dataDir, input: { channelId: options.channel, directory: process.cwd(), text: value } })
    })
}

export function registerWorktreeCommands(cli: Goke) {
  cli.command('worktree list', 'List linked Git worktrees')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-c, --channel <id>', 'Project channel')
    .option('-p, --project <path>', 'Project directory (default: current directory)')
    .action(async (options) => {
      await action({ route: 'worktree.list', dataDir: options.dataDir, input: { channelId: options.channel, directory: path.resolve(options.project ?? process.cwd()) } })
    })

  cli.command('worktree create [name]', 'Create an isolated worktree session')
    .option('--data-dir <path>', DATA_DIR_HELP)
    .option('-c, --channel <id>', 'Project channel')
    .option('-p, --project <path>', 'Project directory (default: current directory)')
    .option('--base-branch <ref>', 'Starting Git ref (default: project HEAD)')
    .action(async (name, options) => {
      const input = { channelId: options.channel, directory: path.resolve(options.project ?? process.cwd()), name, baseBranch: options.baseBranch }
      await action({ route: 'worktree.create', dataDir: options.dataDir, input, signal: AbortSignal.timeout(WORKTREE_TIMEOUT_MS) })
    })

  for (const operation of ['remove', 'merge'] as const) {
    cli.command(`worktree ${operation} <directory>`, operation === 'merge' ? 'Merge into a local target branch' : 'Remove a clean, merged worktree checkout; retain branch refs')
      .option('--data-dir <path>', DATA_DIR_HELP)
      .option('-c, --channel <id>', 'Project channel')
      .option('-p, --project <path>', 'Project directory (default: current directory)')
      .option('--target-branch <branch>', 'Local merge target branch')
      .option('--strategy <name>', 'Merge strategy: rebase | squash')
      .action(async (directory, options) => {
        const input = {
          channelId: options.channel,
          directory: path.resolve(options.project ?? process.cwd()),
          text: path.resolve(directory),
          targetBranch: options.targetBranch,
          strategy: options.strategy,
        }
        await action({ route: `worktree.${operation}`, dataDir: options.dataDir, input, signal: AbortSignal.timeout(WORKTREE_TIMEOUT_MS) })
      })
  }
}
