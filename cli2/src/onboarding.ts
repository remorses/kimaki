// First-run onboarding. Kimaki does not ask which projects to add. It creates
// one default channel, backed by <dataDir>/projects/kimaki, posts a welcome
// message, and starts a session in a thread under it. That session asks the
// user which projects they want, searches for them, and adds channels with
// `kimaki project add` (see project.ts).
//
//   credentials (credentials.ts) ─▶ bot ready ─▶ pick guild (gateway: the
//     installed one) ─▶ "Kimaki" category + #kimaki channel ─▶ welcome message
//     ─▶ "Kimaki onboarding" thread + session with ONBOARDING prompt
//
// Runs once per data dir: when the default directory already has a mapping
// (also if the user later deleted that channel) nothing happens.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import * as clack from '@clack/prompts'
import { ChannelType, Events, type Client, type Guild } from 'discord.js'
import * as errore from 'errore'
import dedent from 'string-dedent'

import { API } from '@discordjs/core/http-only'

import { selfHostedInstallUrl } from './credentials.ts'
import { ConfigError, DbError, DiscordError, OpenCodeError, OpenCodeUnavailableError } from './errors.ts'
import { createLogger } from './logger.ts'
import type { BotHandle } from './main.ts'
import { addProjectChannel, defaultNames, defaultProjectDirectory } from './project.ts'

const logger = createLogger('ONBOARD')
const execFileAsync = promisify(execFile)

const DEFAULT_CHANNEL_TOPIC =
  'General channel for misc tasks with Kimaki. Not connected to a specific project or repository.'

// Waits until the bot is in at least one server, printing the install URL.
export async function waitForGuild({ discord }: { discord: Client }): Promise<Guild> {
  const first = discord.guilds.cache.first()
  if (first) return first
  const url = selfHostedInstallUrl({ appId: discord.user?.id ?? '' })
  logger.log(`bot is in no server yet, install it: ${url}`)
  process.stderr.write(`\nAdd the bot to your Discord server:\n${url}\n\nWaiting...\n`)
  return new Promise((resolve) => discord.once(Events.GuildCreate, resolve))
}

// Many servers: --guild, else a prompt, else an error listing the choices.
export async function chooseGuild({
  discord,
  guildId,
}: {
  discord: Client
  guildId?: string
}): Promise<ConfigError | Guild> {
  if (guildId) {
    const guild = discord.guilds.cache.get(guildId)
    return guild ?? new ConfigError({ reason: `The bot is not in server ${guildId}` })
  }
  const guilds = [...discord.guilds.cache.values()]
  if (guilds.length <= 1) return waitForGuild({ discord })
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

function shellQuote(arg: string): string {
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

export type OnboardingResult = { channelId: string; threadId: string } | null

export async function runOnboarding({
  bot,
  dataDir,
  guild,
  kimaki,
  gateway,
  installerId,
}: {
  bot: BotHandle
  dataDir: string
  guild: Guild
  // Shell command for `kimaki`, from kimakiShellCommand().
  kimaki: string
  gateway: boolean
  // Gateway installs report who installed the bot; else the guild owner.
  installerId?: string | null
}): Promise<
  ConfigError | DbError | DiscordError | GitInitError | OpenCodeError | OpenCodeUnavailableError | OnboardingResult
> {
  const { db } = bot.db
  const directory = defaultProjectDirectory({ dataDir })
  const mapped = await db.query.channel_directories
    .findFirst({ where: { directory } })
    .catch((e) => new DbError({ operation: 'read channel_directories', cause: e }))
  if (mapped instanceof Error) return mapped
  if (mapped) return null

  const directoryReady = await createDefaultDirectory(directory)
  if (directoryReady instanceof Error) return directoryReady
  const botName = bot.discord.user?.username ?? 'kimaki'
  const channel = await addProjectChannel({
    api: new API(bot.discord.rest),
    db,
    guildId: guild.id,
    directory,
    name: defaultNames({ botName, gateway }).channel,
    topic: DEFAULT_CHANNEL_TOPIC,
    categoryName: defaultNames({ botName, gateway }).category,
  })
  if (channel instanceof Error) return channel

  const textChannel = await bot.discord.channels
    .fetch(channel.channelId)
    .catch((e) => new DiscordError({ operation: 'fetch default channel', cause: e }))
  if (textChannel instanceof Error) return textChannel
  if (textChannel?.type !== ChannelType.GuildText) {
    return new DiscordError({ operation: `default channel ${channel.channelId} is not a text channel` })
  }
  const owner = await guild.members
    .fetch(installerId ?? guild.ownerId)
    .catch((e) => new DiscordError({ operation: 'fetch installer', cause: e }))
  if (owner instanceof Error) return owner
  const welcome = await textChannel
    .send({
      content: dedent`
        **Kimaki** lets you code from Discord. Each project channel is linked to a folder on your computer. A message there starts an AI coding session in that folder.
        Reply in the thread below to add channels for your projects. <@${owner.id}>
      `,
      allowedMentions: { users: [owner.id] },
    })
    .catch((e) => new DiscordError({ operation: 'send welcome message', cause: e }))
  if (welcome instanceof Error) return welcome

  const session = await bot.actions.startSession({
    channelId: channel.channelId,
    directory,
    text: onboardingPrompt({ kimaki }),
    author: { id: owner.id, username: owner.user.username },
    messageId: welcome.id,
    threadName: 'Kimaki onboarding',
  })
  if (session instanceof Error) return session
  logger.log(`onboarding thread ${session.threadId} in channel ${channel.channelId}`)
  return { channelId: channel.channelId, threadId: session.threadId }
}
