// First-run onboarding. Kimaki does not ask which projects to add. It creates
// one default channel, backed by <dataDir>/projects/kimaki, posts a welcome
// message, and starts a session in a thread under it. That session asks the
// user which projects they want, searches for them, and adds channels with
// `kimaki project add` (see project.ts).
//
//   credentials (credentials.ts) ─▶ bot ready ─▶ pick guild (gateway: the
//     installed one) ─▶ "Kimaki <machine>" category + #kimaki channel ─▶ welcome message
//     ─▶ "Kimaki onboarding" thread + session with ONBOARDING prompt
//
// Existing project mappings also mark an upgraded install as already configured.

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import * as clack from '@clack/prompts'
import { ChannelType, Events, type Client, type Guild } from 'discord.js'
import * as errore from 'errore'
import dedent from 'string-dedent'

import { API } from '@discordjs/core/http-only'

import { ConfigError, DbError, DiscordError, OpenCodeMissingError, type OpenCodeV1Error, type OpenCodeVersionError } from './errors.ts'
import { NOTIFY_MESSAGE_FLAGS } from './format-parts.ts'
import { createLogger } from './logger.ts'
import { checkOpencode, findOpencodeBinary, installedOpencodeBinary, OPENCODE_INSTALL_COMMAND } from './opencode-server.ts'
import type { Bot } from './bot.ts'
import { startSession } from './sessions.ts'
import { addProjectChannel, defaultChannelName, defaultProjectDirectory } from './project.ts'

const logger = createLogger('ONBOARD')
const execFileAsync = promisify(execFile)

const DEFAULT_CHANNEL_TOPIC =
  'General channel for misc tasks with Kimaki. Not connected to a specific project or repository.'

// Waits until a self-hosted bot is in at least one server. A gateway client
// in no server cannot be fixed by waiting: the install URL must be opened
// again (V1 behavior), so that is an error with the URL.
async function waitForGuild({ discord, installUrl, gateway }: { discord: Client; installUrl: string; gateway: boolean }): Promise<ConfigError | Guild> {
  const first = discord.guilds.cache.first()
  if (first) return first
  if (gateway) {
    return new ConfigError({ reason: `The Kimaki bot is in no Discord server. Open this URL to add it (do not share it, it contains your credentials), then run kimaki again: ${installUrl}` })
  }
  logger.log(`bot is in no server yet, install it: ${installUrl}`)
  process.stderr.write(`\nAdd the bot to your Discord server:\n${installUrl}\n\nWaiting...\n`)
  return new Promise((resolve) => discord.once(Events.GuildCreate, resolve))
}

// Many servers: --guild, else a prompt, else an error listing the choices.
export async function chooseGuild({
  discord,
  guildId,
  installUrl,
  gateway,
}: {
  discord: Client
  guildId?: string
  installUrl: string
  gateway: boolean
}): Promise<ConfigError | Guild> {
  if (guildId) {
    const guild = discord.guilds.cache.get(guildId)
    return guild ?? new ConfigError({ reason: `The bot is not in server ${guildId}` })
  }
  const guilds = [...discord.guilds.cache.values()]
  if (guilds.length <= 1) return waitForGuild({ discord, installUrl, gateway })
  if (!process.stdin.isTTY) {
    const choices = guilds.map((guild) => `${guild.id} (${guild.name})`).join(', ')
    return new ConfigError({ reason: `The bot is in several servers: ${choices}. Pass --guild <id>.` })
  }
  const picked = await clack.select({
    message: 'Which server should Kimaki use?',
    options: guilds.map((guild) => ({ value: guild.id, label: guild.name })),
  })
  if (clack.isCancel(picked)) return new ConfigError({ reason: 'Onboarding cancelled' })
  return discord.guilds.cache.get(picked) ?? new ConfigError({ reason: `Unknown server ${picked}` })
}

// Before the Discord install: a running OpenCode service, or a V2 binary to
// start one. When OpenCode is missing it installs V2 with the official script,
// like V1 installed its tools (asks first in a terminal). An OpenCode 1 or an
// old V2 is never replaced: the error tells the user how to install V2.
export async function ensureOpencode({
  serviceFile,
}: {
  serviceFile?: string
}): Promise<OpenCodeMissingError | OpenCodeV1Error | OpenCodeVersionError | ConfigError | void> {
  const checked = await checkOpencode({ serviceFile })
  if (checked instanceof Error) return checked
  if (checked === 'ready') return
  const missing = new OpenCodeMissingError({ install: OPENCODE_INSTALL_COMMAND })
  // The script is bash-only; OPENCODE_PATH points at a binary the user chose.
  if (process.platform === 'win32' || process.env['OPENCODE_PATH']) return missing
  if (process.stdin.isTTY) {
    const confirmed = await clack.confirm({ message: `Kimaki requires OpenCode 2. Install it now with \`${OPENCODE_INSTALL_COMMAND}\`?` })
    if (clack.isCancel(confirmed) || !confirmed) return missing
  } else {
    logger.log(`OpenCode 2 not found, installing: ${OPENCODE_INSTALL_COMMAND}`)
  }
  // Script output goes to stderr: stdout is for `data:` events (logging rules in AGENTS.md).
  const exitCode = await new Promise<number | ConfigError>((resolve) => {
    const child = spawn('/bin/bash', ['-c', OPENCODE_INSTALL_COMMAND], { stdio: ['ignore', 2, 2], signal: AbortSignal.timeout(600_000) })
    child.on('error', (cause) => resolve(new ConfigError({ reason: 'OpenCode install failed to run', cause })))
    child.on('close', (code) => resolve(code ?? 1))
  })
  if (exitCode instanceof Error) return exitCode
  if (exitCode !== 0) return new ConfigError({ reason: `OpenCode install exited with code ${exitCode}. ${missing.message}` })
  const installed = await findOpencodeBinary()
  if (installed instanceof Error) return installed
  if (installed === null) return new ConfigError({ reason: `OpenCode install finished but ${installedOpencodeBinary()} does not run. ${missing.message}` })
  logger.log(`installed OpenCode 2 at ${installed}`)
}

// macOS: keep the machine awake while the bot runs (-s also on lid close on
// AC power). -w exits caffeinate with this process, whatever ends it.
export function startCaffeinate(): void {
  if (process.platform !== 'darwin') return
  const child = errore.try(
    () => spawn('caffeinate', ['-s', '-w', String(process.pid)], { stdio: 'ignore' }),
    (e) => new ConfigError({ reason: 'caffeinate failed to start', cause: e }),
  )
  if (child instanceof Error) {
    logger.warn(child.message)
    return
  }
  child.on('error', (error) => logger.warn(`caffeinate: ${error.message}`))
  child.unref()
}

export function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`
}

export function onboardingPrompt({ kimaki }: { kimaki: string }): string {
  return dedent`
    This is the Kimaki onboarding thread. Kimaki maps Discord channels to project folders on this computer:
    a message in a project channel starts a coding session in that folder.

    Help the user add channels for their projects:

    1. Greet the user in one short sentence and ask if they want channels for their projects. Suggest
       searching for git repositories on this computer.
    2. If they agree, search. Only list folders that exist, most recently changed first, at most 15:
       \`find ~/Documents ~/Projects ~/projects ~/code ~/dev ~/src ~/repos ~/GitHub ~/github -maxdepth 3 -name .git -prune 2>/dev/null\`
       Skip folders that already have a channel: \`${kimaki} project list\`
    3. Ask which ones to add with the question tool (multiple choice, one option per folder).
    4. Add each chosen folder with its absolute path: \`${kimaki} project add <absolute-directory>\`
       The command prints the new channel as a mention like <#123>. Reply with the list of new channels.

    Never add a channel the user did not choose. Keep every message short.
  `
}

// The shell command the agent runs to call this Kimaki install.
export function kimakiShellCommand({ command, dataDir }: { command: readonly string[]; dataDir: string }): string {
  return [...command, '--data-dir', dataDir].map(shellQuote).join(' ')
}

class GitInitError extends errore.createTaggedError({
  name: 'GitInitError',
  message: 'Could not create $directory',
}) {}

async function createDefaultDirectory(directory: string): Promise<GitInitError | void> {
  const created = errore.try(
    () => {
      fs.mkdirSync(directory, { recursive: true })
      const gitignore = path.join(directory, '.gitignore')
      if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, 'node_modules/\ntmp/\n*.log\n.DS_Store\n')
    },
    (e) => new GitInitError({ directory, cause: e }),
  )
  if (created instanceof Error) return created
  if (fs.existsSync(path.join(directory, '.git'))) return
  // Without git the folder still works; only branch names in footers are missing.
  const init = await execFileAsync('git', ['init', '-q'], { cwd: directory, timeout: 10_000 }).catch(
    (e) => new GitInitError({ directory, cause: e }),
  )
  if (init instanceof Error) logger.warn(`git init failed in ${directory}: ${init.message}`)
}

export type OnboardingResult = { guildId: string; channelId: string; threadId: string } | null

export async function runOnboarding({
  bot,
  dataDir,
  guild,
  guildId,
  installUrl,
  kimaki,
  gateway,
  installerId,
  machine,
}: {
  bot: Bot
  dataDir: string
  guild?: Guild
  guildId?: string
  installUrl?: string
  // Shell command for `kimaki`, from kimakiShellCommand().
  kimaki: string
  gateway: boolean
  // --machine-name, else defaultMachineName().
  machine: string
  // Gateway installs report who installed the bot; else the guild owner.
  installerId?: string | null
}): Promise<
  Error | OnboardingResult
> {
  const { db } = bot
  const directory = defaultProjectDirectory({ dataDir })
  const projects = await db.query.channel_directories
    .findMany({ where: { channel_type: 'text' } })
    .catch((e) => new DbError({ operation: 'read channel_directories', cause: e }))
  if (projects instanceof Error) return projects
  const mapped = projects.find((project) => project.directory === directory)
  if (!mapped && projects.length > 0) return null
  // Done once the default channel has a message (the welcome). An empty channel
  // means an earlier onboarding failed: retry in it. A deleted one stays deleted.
  if (mapped) {
    const existing = await bot.discord.channels.fetch(mapped.channel_id).catch(() => null)
    if (existing?.type !== ChannelType.GuildText) return null
    const messages = await existing.messages
      .fetch({ limit: 1 })
      .catch((e) => new DiscordError({ operation: 'read default channel', cause: e }))
    if (messages instanceof Error) return messages
    if (messages.size > 0) return null
  }

  const selectedGuild = await (async () => {
    if (guild) return guild
    const saved = mapped?.guild_id ? bot.discord.guilds.cache.get(mapped.guild_id) : null
    if (saved) return saved
    if (!installUrl) return new ConfigError({ reason: 'No server configured for onboarding. Run kimaki --guild <id>.' })
    return chooseGuild({ discord: bot.discord, guildId, installUrl, gateway })
  })()
  if (selectedGuild instanceof Error) return selectedGuild

  const directoryReady = await createDefaultDirectory(directory)
  if (directoryReady instanceof Error) return directoryReady
  const botName = bot.discord.user?.username ?? 'kimaki'
  const channel = await addProjectChannel({
    api: new API(bot.discord.rest),
    db,
    guildId: selectedGuild.id,
    directory,
    name: defaultChannelName({ botName, gateway }),
    topic: DEFAULT_CHANNEL_TOPIC,
    machine,
  })
  if (channel instanceof Error) return channel
  if (channel.created) bot.analytics.track('project_registered', { project_kind: 'default', source: 'onboarding' })

  const textChannel = await bot.discord.channels
    .fetch(channel.channelId)
    .catch((e) => new DiscordError({ operation: 'fetch default channel', cause: e }))
  if (textChannel instanceof Error) return textChannel
  if (textChannel?.type !== ChannelType.GuildText) {
    return new DiscordError({ operation: `default channel ${channel.channelId} is not a text channel` })
  }
  const owner = await selectedGuild.members
    .fetch(installerId ?? selectedGuild.ownerId)
    .catch((e) => new DiscordError({ operation: 'fetch installer', cause: e }))
  if (owner instanceof Error) return owner
  const welcome = await textChannel
    .send({
      content: dedent`
        **Kimaki** lets you code from Discord. Each project channel is linked to a folder on your computer. A message there starts an AI coding session in that folder.
        Reply in the thread below to add channels for your projects. <@${owner.id}>
      `,
      allowedMentions: { users: [owner.id] },
      flags: NOTIFY_MESSAGE_FLAGS,
    })
    .catch((e) => new DiscordError({ operation: 'send welcome message', cause: e }))
  if (welcome instanceof Error) return welcome

  const session = await startSession(bot, {
    channelId: channel.channelId,
    directory,
    route: { kind: 'steer', text: onboardingPrompt({ kimaki }) },
    author: { id: owner.id, username: owner.user.username },
    messageId: welcome.id,
    threadName: 'Kimaki onboarding',
    worktree: false,
  })
  if (session instanceof Error) {
    // Leaves the channel empty, so the next start onboards again.
    await welcome.delete().catch((e) => logger.warn(`delete welcome message: ${e instanceof Error ? e.message : String(e)}`))
    return session
  }
  logger.log(`onboarding thread ${session.threadId} in channel ${channel.channelId}`)
  return { guildId: selectedGuild.id, channelId: channel.channelId, threadId: session.threadId }
}
