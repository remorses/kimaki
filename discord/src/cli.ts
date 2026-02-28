#!/usr/bin/env node
// Main CLI entrypoint for the Kimaki Discord bot.
// Handles interactive setup, Discord OAuth, slash command registration,
// project channel creation, and launching the bot with opencode integration.
import { goke } from 'goke'
import {
  intro,
  outro,
  text,
  password,
  note,
  cancel,
  isCancel,
  confirm,
  log,
  multiselect,
} from '@clack/prompts'
import {
  deduplicateByKey,
  generateBotInstallUrl,
  abbreviatePath,
} from './utils.js'
import {
  getChannelsWithDescriptions,
  createDiscordClient,
  initDatabase,
  getChannelDirectory,
  startDiscordBot,
  initializeOpencodeForDirectory,
  ensureKimakiCategory,
  createProjectChannels,
  type ChannelWithTags,
} from './discord-bot.js'
import {
  getBotToken,
  setBotToken,
  setChannelDirectory,
  findChannelsByDirectory,
  findChannelByAppId,
  getThreadSession,
  getThreadIdBySessionId,
  getPrisma,
  createScheduledTask,
  listScheduledTasks,
  cancelScheduledTask,
  getSessionStartSourcesBySessionIds,
} from './database.js'
import { ShareMarkdown } from './markdown.js'
import {
  parseSessionSearchPattern,
  findFirstSessionSearchHit,
  buildSessionSearchSnippet,
  getPartSearchTexts,
} from './session-search.js'
import { formatWorktreeName } from './commands/worktree.js'
import { WORKTREE_PREFIX } from './commands/merge-worktree.js'
import type { ThreadStartMarker } from './system-message.js'
import yaml from 'js-yaml'
import type {
  OpencodeClient,
  Command as OpencodeCommand,
} from '@opencode-ai/sdk/v2'
import {
  Events,
  ChannelType,
  type CategoryChannel,
  type Guild,
  type REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder,
} from 'discord.js'
import { createDiscordRest, discordApiUrl } from './discord-urls.js'
import path from 'node:path'
import fs from 'node:fs'
import * as errore from 'errore'

import { createLogger, formatErrorWithStack, initLogFile, LogPrefix } from './logger.js'
import { initSentry, notifyError } from './sentry.js'
import {
  archiveThread,
  uploadFilesToDiscord,
  stripMentions,
} from './discord-utils.js'
import { spawn, execSync, type ExecSyncOptions } from 'node:child_process'

import {
  setDataDir,
  getDataDir,
  setDefaultVerbosity,
  setDefaultMentionMode,
  setCritiqueEnabled,
  setVerboseOpencodeServer,
  getProjectsDir,
} from './config.js'
import { sanitizeAgentName } from './commands/agent.js'
import { execAsync } from './worktree-utils.js'
import {
  backgroundUpgradeKimaki,
  upgrade,
  getCurrentVersion,
} from './upgrade.js'

import { startHranaServer } from './hrana-server.js'
import { startIpcPolling, stopIpcPolling } from './ipc-polling.js'
import {
  getLocalTimeZone,
  getPromptPreview,
  parseSendAtValue,
  serializeScheduledTaskPayload,
  type ParsedSendAt,
  type ScheduledTaskPayload,
} from './task-schedule.js'

const cliLogger = createLogger(LogPrefix.CLI)

// Strip bracketed paste escape sequences from terminal input.
// iTerm2 and other terminals wrap pasted content with \x1b[200~ and \x1b[201~
// which can cause validation to fail on macOS. See: https://github.com/remorses/kimaki/issues/18
function stripBracketedPaste(value: string | undefined): string {
  if (!value) {
    return ''
  }
  return value
    .replace(/\x1b\[200~/g, '')
    .replace(/\x1b\[201~/g, '')
    .trim()
}


// Derive the Discord Application ID from a bot token.
// Discord bot tokens have the format: base64(userId).timestamp.hmac
// The first segment is the bot's user ID (= Application ID) base64-encoded.
function appIdFromToken(token: string): string | undefined {
  const segment = token.split('.')[0]
  if (!segment) {
    return undefined
  }
  try {
    const decoded = Buffer.from(segment, 'base64').toString('utf8')
    if (/^\d{17,20}$/.test(decoded)) {
      return decoded
    }
    return undefined
  } catch {
    return undefined
  }
}

// Resolve bot token and app ID from env var or database.
// Used by CLI subcommands (send, project add) that need credentials
// but don't run the interactive wizard.
async function resolveBotCredentials({ appIdOverride }: { appIdOverride?: string } = {}): Promise<{
  token: string
  appId: string | undefined
}> {
  const envToken = process.env.KIMAKI_BOT_TOKEN
  if (envToken) {
    // Prefer token-derived appId over stale DB values when using env token,
    // since the DB may have credentials from a different bot.
    const appId = appIdOverride || appIdFromToken(envToken)
    return { token: envToken, appId }
  }

  const botRow = await getBotToken().catch((e: unknown) => {
    cliLogger.error('Database error:', e instanceof Error ? e.message : String(e))
    return null
  })
  if (!botRow) {
    cliLogger.error('No bot token found. Set KIMAKI_BOT_TOKEN env var or run `kimaki` first to set up.')
    process.exit(EXIT_NO_RESTART)
  }
  return { token: botRow.token, appId: appIdOverride || botRow.app_id }
}

function isThreadChannelType(type: number): boolean {
  return [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(type)
}

async function sendDiscordMessageWithOptionalAttachment({
  channelId,
  prompt,
  botToken,
  embeds,
  rest,
}: {
  channelId: string
  prompt: string
  botToken: string
  embeds?: Array<{ color: number; footer: { text: string } }>
  rest: REST
}): Promise<{ id: string }> {
  const discordMaxLength = 2000
  if (prompt.length <= discordMaxLength) {
    return (await rest.post(Routes.channelMessages(channelId), {
      body: { content: prompt, embeds },
    })) as { id: string }
  }

  const preview = prompt.slice(0, 100).replace(/\n/g, ' ')
  const summaryContent = `Prompt attached as file (${prompt.length} chars)\n\n> ${preview}...`

  const tmpDir = path.join(process.cwd(), 'tmp')
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true })
  }
  const tmpFile = path.join(tmpDir, `prompt-${Date.now()}.md`)
  fs.writeFileSync(tmpFile, prompt)

  try {
    const formData = new FormData()
    formData.append(
      'payload_json',
      JSON.stringify({
        content: summaryContent,
        attachments: [{ id: 0, filename: 'prompt.md' }],
        embeds,
      }),
    )
    const buffer = fs.readFileSync(tmpFile)
    formData.append(
      'files[0]',
      new Blob([buffer], { type: 'text/markdown' }),
      'prompt.md',
    )

    const starterMessageResponse = await fetch(
      discordApiUrl(`/channels/${channelId}/messages`),
      {
        method: 'POST',
        headers: {
          Authorization: `Bot ${botToken}`,
        },
        body: formData,
      },
    )

    if (!starterMessageResponse.ok) {
      const error = await starterMessageResponse.text()
      throw new Error(
        `Discord API error: ${starterMessageResponse.status} - ${error}`,
      )
    }

    return (await starterMessageResponse.json()) as { id: string }
  } finally {
    fs.unlinkSync(tmpFile)
  }
}

function formatRelativeTime(target: Date): string {
  const diffMs = target.getTime() - Date.now()
  if (diffMs <= 0) {
    return 'due now'
  }

  const totalSeconds = Math.floor(diffMs / 1000)
  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }

  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) {
    return `${totalMinutes}m`
  }

  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours < 24) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  }

  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`
}

function formatTaskScheduleLine(schedule: ParsedSendAt): string {
  if (schedule.scheduleKind === 'at') {
    return `one-time at ${schedule.runAt.toISOString()}`
  }
  return `cron "${schedule.cronExpr}" (${schedule.timezone}) next ${schedule.nextRunAt.toISOString()}`
}

const EXIT_NO_RESTART = 64

// Detect if a CLI tool is installed, prompt to install if missing.
// Uses official install scripts with platform-specific commands for Unix vs Windows.
// Sets process.env[envPathKey] to the found binary path for the current session.
// After install, re-checks PATH first, then falls back to common install locations.
async function ensureCommandAvailable({
  name,
  envPathKey,
  installUnix,
  installWindows,
  possiblePathsUnix,
  possiblePathsWindows,
}: {
  name: string
  envPathKey: string
  installUnix: string
  installWindows: string
  possiblePathsUnix: string[]
  possiblePathsWindows: string[]
}): Promise<void> {
  if (process.env[envPathKey]) {
    return
  }

  const isWindows = process.platform === 'win32'
  const whichCmd = isWindows ? 'where' : 'which'
  const isInstalled = await execAsync(`${whichCmd} ${name}`, {
    env: process.env,
  }).then(
    () => {
      return true
    },
    () => {
      return false
    },
  )

  if (isInstalled) {
    return
  }

  note(`${name} is required but not found in your PATH.`, `${name} Not Found`)

  const shouldInstall = await confirm({
    message: `Would you like to install ${name} right now?`,
  })

  if (isCancel(shouldInstall) || !shouldInstall) {
    cancel(`${name} is required to run this bot`)
    process.exit(EXIT_NO_RESTART)
  }

  cliLogger.log(`Installing ${name}...`)

  try {
    // Use explicit shell invocation to avoid Node shell-mode quirks on Windows.
    // PowerShell needs -NoProfile and -ExecutionPolicy Bypass for install scripts.
    // Unix uses login shell (-l) so install scripts can update PATH in shell config.
    const cmd = isWindows ? 'powershell.exe' : '/bin/bash'
    const args = isWindows
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', installWindows]
      : ['-lc', installUnix]
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: 'inherit', env: process.env })
      child.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`${name} install exited with code ${code}`))
        }
      })
      child.on('error', reject)
    })
    cliLogger.log(`${name} installed successfully!`)
  } catch (error) {
    cliLogger.log(`Failed to install ${name}`)
    cliLogger.error(
      'Installation error:',
      error instanceof Error ? error.message : String(error),
    )
    process.exit(EXIT_NO_RESTART)
  }

  // After install, re-check PATH first (install script may have added it)
  const foundInPath = await execAsync(`${whichCmd} ${name}`, {
    env: process.env,
  }).then(
    (result) => {
      return result.stdout.trim()
    },
    () => {
      return ''
    },
  )
  if (foundInPath) {
    process.env[envPathKey] = foundInPath
    return
  }

  // Fall back to probing common install locations
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const accessFlag = isWindows ? fs.constants.F_OK : fs.constants.X_OK
  const possiblePaths = (isWindows ? possiblePathsWindows : possiblePathsUnix)
    .filter((p) => {
      return !p.startsWith('~') || home
    })
    .map((p) => {
      return p.replace('~', home)
    })

  const installedPath = possiblePaths.find((p) => {
    try {
      fs.accessSync(p, accessFlag)
      return true
    } catch {
      return false
    }
  })

  if (!installedPath) {
    note(
      `${name} was installed but may not be available in this session.\n` +
        'Please restart your terminal and run this command again.',
      'Restart Required',
    )
    process.exit(EXIT_NO_RESTART)
  }

  process.env[envPathKey] = installedPath
}

// Run opencode upgrade in the background so the user always has the latest version.

// Spawn caffeinate on macOS to prevent system sleep while bot is running.
// Not detached, so it dies automatically with the parent process.
function startCaffeinate() {
  if (process.platform !== 'darwin') {
    return
  }
  try {
    const proc = spawn('caffeinate', ['-i'], {
      stdio: 'ignore',
      detached: false,
    })
    proc.on('error', (err) => {
      cliLogger.warn('Failed to start caffeinate:', err.message)
    })
    cliLogger.log('Started caffeinate to prevent system sleep')
  } catch (err) {
    cliLogger.warn(
      'Failed to spawn caffeinate:',
      err instanceof Error ? err.message : String(err),
    )
  }
}
const cli = goke('kimaki')

process.title = 'kimaki'

type CliOptions = {
  restart?: boolean
  addChannels?: boolean
  dataDir?: string
  useWorktrees?: boolean
  enableVoiceChannels?: boolean
}

// Commands to skip when registering user commands (reserved names)
const SKIP_USER_COMMANDS = ['init']

import { registeredUserCommands } from './config.js'

type AgentInfo = {
  name: string
  description?: string
  mode: string
  hidden?: boolean
}

async function registerCommands({
  token,
  appId,
  userCommands = [],
  agents = [],
}: {
  token: string
  appId: string
  userCommands?: OpencodeCommand[]
  agents?: AgentInfo[]
}) {
  const commands = [
    new SlashCommandBuilder()
      .setName('resume')
      .setDescription('Resume an existing OpenCode session')
      .addStringOption((option) => {
        option
          .setName('session')
          .setDescription('The session to resume')
          .setRequired(true)
          .setAutocomplete(true)

        return option
      })
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('new-session')
      .setDescription('Start a new OpenCode session')
      .addStringOption((option) => {
        option
          .setName('prompt')
          .setDescription('Prompt content for the session')
          .setRequired(true)

        return option
      })
      .addStringOption((option) => {
        option
          .setName('files')
          .setDescription(
            'Files to mention (comma or space separated; autocomplete)',
          )
          .setAutocomplete(true)
          .setMaxLength(6000)

        return option
      })
      .addStringOption((option) => {
        option
          .setName('agent')
          .setDescription('Agent to use for this session')
          .setAutocomplete(true)

        return option
      })
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('new-worktree')
      .setDescription(
        'Create a new git worktree (in thread: uses thread name if no name given)',
      )
      .addStringOption((option) => {
        option
          .setName('name')
          .setDescription(
            'Name for worktree (optional in threads - uses thread name)',
          )
          .setRequired(false)

        return option
      })
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('merge-worktree')
      .setDescription('Merge the worktree branch into the default branch')
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('toggle-worktrees')
      .setDescription(
        'Toggle automatic git worktree creation for new sessions in this channel',
      )
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('toggle-mention-mode')
      .setDescription(
        'Toggle mention-only mode (bot only responds when @mentioned)',
      )
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('add-project')
      .setDescription(
        'Create Discord channels for a project. Use `npx kimaki project add` for unlisted projects',
      )
      .addStringOption((option) => {
        option
          .setName('project')
          .setDescription(
            'Recent OpenCode projects. Use `npx kimaki project add` if not listed',
          )
          .setRequired(true)
          .setAutocomplete(true)

        return option
      })
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('remove-project')
      .setDescription('Remove Discord channels for a project')
      .addStringOption((option) => {
        option
          .setName('project')
          .setDescription('Select a project to remove')
          .setRequired(true)
          .setAutocomplete(true)

        return option
      })
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('create-new-project')
      .setDescription(
        'Create a new project folder, initialize git, and start a session',
      )
      .addStringOption((option) => {
        option
          .setName('name')
          .setDescription('Name for the new project folder')
          .setRequired(true)

        return option
      })
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('abort')
      .setDescription('Abort the current OpenCode request in this thread')
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('compact')
      .setDescription(
        'Compact the session context by summarizing conversation history',
      )
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('stop')
      .setDescription('Abort the current OpenCode request in this thread')
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('share')
      .setDescription('Share the current session as a public URL')
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('diff')
      .setDescription('Show git diff as a shareable URL')
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('fork')
      .setDescription('Fork the session from a past user message')
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('model')
      .setDescription('Set the preferred model for this channel or session')
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('unset-model-override')
      .setDescription('Remove model override and use default instead')
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('login')
      .setDescription(
        'Authenticate with an AI provider (OAuth or API key). Use this instead of /connect',
      )
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('agent')
      .setDescription('Set the preferred agent for this channel or session')
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('queue')
      .setDescription(
        'Queue a message to be sent after the current response finishes',
      )
      .addStringOption((option) => {
        option
          .setName('message')
          .setDescription('The message to queue')
          .setRequired(true)

        return option
      })
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('clear-queue')
      .setDescription('Clear all queued messages in this thread')
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('queue-command')
      .setDescription(
        'Queue a user command to run after the current response finishes',
      )
      .addStringOption((option) => {
        option
          .setName('command')
          .setDescription('The command to run')
          .setRequired(true)
          .setAutocomplete(true)
        return option
      })
      .addStringOption((option) => {
        option
          .setName('arguments')
          .setDescription('Arguments to pass to the command')
          .setRequired(false)
        return option
      })
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('undo')
      .setDescription('Undo the last assistant message (revert file changes)')
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('redo')
      .setDescription('Redo previously undone changes')
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('verbosity')
      .setDescription('Set output verbosity for new sessions in this channel')
      .addStringOption((option) => {
        option
          .setName('level')
          .setDescription('Verbosity level')
          .setRequired(true)
          .addChoices(
            { name: 'tools-and-text', value: 'tools-and-text' },
            {
              name: 'text-and-essential-tools (default)',
              value: 'text-and-essential-tools',
            },
            { name: 'text-only', value: 'text-only' },
          )
        return option
      })
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('restart-opencode-server')
      .setDescription(
        'Restart the opencode server for this channel only (fixes state/auth/plugins)',
      )
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('run-shell-command')
      .setDescription(
        'Run a shell command in the project directory. Tip: prefix messages with ! as shortcut',
      )
      .addStringOption((option) => {
        option
          .setName('command')
          .setDescription('Command to run')
          .setRequired(true)
        return option
      })
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('context-usage')
      .setDescription(
        'Show token usage and context window percentage for this session',
      )
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('session-id')
      .setDescription(
        'Show current session ID and opencode attach command for this thread',
      )
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('upgrade-and-restart')
      .setDescription(
        'Upgrade kimaki to the latest version and restart the bot',
      )
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('transcription-key')
      .setDescription(
        'Set API key for voice message transcription (OpenAI or Gemini)',
      )
      .setDMPermission(false)
      .toJSON(),
  ]

  // Add user-defined commands with -cmd suffix
  // Also populate registeredUserCommands for /queue-command autocomplete
  registeredUserCommands.length = 0
  for (const cmd of userCommands) {
    if (SKIP_USER_COMMANDS.includes(cmd.name)) {
      continue
    }

    // Sanitize command name: oh-my-opencode uses MCP commands with colons and slashes,
    // which Discord doesn't allow in command names.
    // Discord command names: lowercase, alphanumeric and hyphens only, must start with letter/number.
    const sanitizedName = cmd.name
      .toLowerCase()
      .replace(/[:/]/g, '-') // Replace : and / with hyphens first
      .replace(/[^a-z0-9-]/g, '-') // Replace any other non-alphanumeric chars
      .replace(/-+/g, '-') // Collapse multiple hyphens
      .replace(/^-|-$/g, '') // Remove leading/trailing hyphens

    // Skip if sanitized name is empty - would create invalid command name like "-cmd"
    if (!sanitizedName) {
      continue
    }

    // Truncate base name before appending suffix so the -cmd suffix is never
    // lost to Discord's 32-char command name limit.
    const cmdSuffix = '-cmd'
    const baseName = sanitizedName.slice(0, 32 - cmdSuffix.length)
    const commandName = `${baseName}${cmdSuffix}`
    const description = cmd.description || `Run /${cmd.name} command`

    registeredUserCommands.push({
      name: cmd.name,
      discordName: baseName,
      description,
    })

    commands.push(
      new SlashCommandBuilder()
        .setName(commandName)
        .setDescription(description.slice(0, 100)) // Discord limits to 100 chars
        .addStringOption((option) => {
          option
            .setName('arguments')
            .setDescription('Arguments to pass to the command')
            .setRequired(false)
          return option
        })
        .setDMPermission(false)
        .toJSON(),
    )
  }

  // Add agent-specific quick commands like /plan-agent, /build-agent
  // Filter to primary/all mode agents (same as /agent command shows), excluding hidden agents
  const primaryAgents = agents.filter(
    (a) => (a.mode === 'primary' || a.mode === 'all') && !a.hidden,
  )
  for (const agent of primaryAgents) {
    const sanitizedName = sanitizeAgentName(agent.name)
    // Skip if sanitized name is empty or would create invalid command name
    // Discord command names must start with a lowercase letter or number
    if (!sanitizedName || !/^[a-z0-9]/.test(sanitizedName)) {
      continue
    }
    // Truncate base name before appending suffix so the -agent suffix is never
    // lost to Discord's 32-char command name limit.
    const agentSuffix = '-agent'
    const agentBaseName = sanitizedName.slice(0, 32 - agentSuffix.length)
    const commandName = `${agentBaseName}${agentSuffix}`
    const description = agent.description || `Switch to ${agent.name} agent`

    commands.push(
      new SlashCommandBuilder()
        .setName(commandName)
        .setDescription(description.slice(0, 100))
        .setDMPermission(false)
        .toJSON(),
    )
  }

  const rest = createDiscordRest(token)

  try {
    const data = (await rest.put(Routes.applicationCommands(appId), {
      body: commands,
    })) as any[]

    cliLogger.info(
      `COMMANDS: Successfully registered ${data.length} slash commands`,
    )
  } catch (error) {
    cliLogger.error(
      'COMMANDS: Failed to register slash commands: ' + String(error),
    )
    throw error
  }
}

async function reconcileKimakiRole({ guild }: { guild: Guild }): Promise<void> {
  try {
    const roles = await guild.roles.fetch()
    const existingRole = roles.find(
      (role) => role.name.toLowerCase() === 'kimaki',
    )

    if (existingRole) {
      if (existingRole.position > 1) {
        await existingRole.setPosition(1)
        cliLogger.info(`Moved "Kimaki" role to bottom in ${guild.name}`)
      }
      return
    }

    await guild.roles.create({
      name: 'Kimaki',
      position: 1,
      reason:
        'Kimaki bot permission role - assign to users who can start sessions, send messages in threads, and use voice features',
    })
    cliLogger.info(`Created "Kimaki" role in ${guild.name}`)
  } catch (error) {
    cliLogger.warn(
      `Could not reconcile Kimaki role in ${guild.name}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

async function collectKimakiChannels({
  guilds,
  appId,
  reconcileRoles,
}: {
  guilds: Guild[]
  appId: string
  reconcileRoles: boolean
}): Promise<{ guild: Guild; channels: ChannelWithTags[] }[]> {
  const guildResults = await Promise.all(
    guilds.map(async (guild) => {
      if (reconcileRoles) {
        void reconcileKimakiRole({ guild })
      }

      const channels = await getChannelsWithDescriptions(guild)
      const kimakiChans = channels.filter(
        (ch) => ch.kimakiDirectory && (!ch.kimakiApp || ch.kimakiApp === appId),
      )

      return { guild, channels: kimakiChans }
    }),
  )

  return guildResults.filter((result) => {
    return result.channels.length > 0
  })
}

/**
 * Store channel-directory mappings in the database.
 * Called after Discord login to persist channel configurations.
 */
async function storeChannelDirectories({
  kimakiChannels,
}: {
  kimakiChannels: { guild: Guild; channels: ChannelWithTags[] }[]
}): Promise<void> {
  for (const { guild, channels } of kimakiChannels) {
    for (const channel of channels) {
      if (channel.kimakiDirectory) {
        await setChannelDirectory({
          channelId: channel.id,
          directory: channel.kimakiDirectory,
          channelType: 'text',
          appId: channel.kimakiApp || null,
          skipIfExists: true,
        })

        const voiceChannel = guild.channels.cache.find(
          (ch) =>
            ch.type === ChannelType.GuildVoice && ch.name === channel.name,
        )

        if (voiceChannel) {
          await setChannelDirectory({
            channelId: voiceChannel.id,
            directory: channel.kimakiDirectory,
            channelType: 'voice',
            appId: channel.kimakiApp || null,
            skipIfExists: true,
          })
        }
      }
    }
  }
}

/**
 * Show the ready message with channel links.
 * Called at the end of startup to display available channels.
 */
function showReadyMessage({
  kimakiChannels,
  createdChannels,
  appId,
}: {
  kimakiChannels: { guild: Guild; channels: ChannelWithTags[] }[]
  createdChannels: { name: string; id: string; guildId: string }[]
  appId: string
}): void {
  const allChannels: {
    name: string
    id: string
    guildId: string
    directory?: string
  }[] = []

  allChannels.push(...createdChannels)

  kimakiChannels.forEach(({ guild, channels }) => {
    channels.forEach((ch) => {
      allChannels.push({
        name: ch.name,
        id: ch.id,
        guildId: guild.id,
        directory: ch.kimakiDirectory,
      })
    })
  })

  if (allChannels.length > 0) {
    const channelLinks = allChannels
      .map(
        (ch) =>
          `• #${ch.name}: https://discord.com/channels/${ch.guildId}/${ch.id}`,
      )
      .join('\n')

    note(
      `Your kimaki channels are ready! Click any link below to open in Discord:\n\n${channelLinks}\n\nSend a message in any channel to start using OpenCode!`,
      '🚀 Ready to Use',
    )
  }

  note(
    'Leave this process running to keep the bot active.\n\nIf you close this process or restart your machine, run `npx kimaki` again to start the bot.',
    '⚠️  Keep Running',
  )
}

/**
 * Background initialization for quick start mode.
 * Starts OpenCode server and registers slash commands without blocking bot startup.
 */
async function backgroundInit({
  currentDir,
  token,
  appId,
}: {
  currentDir: string
  token: string
  appId: string
}): Promise<void> {
  try {
    const opencodeResult = await initializeOpencodeForDirectory(currentDir)
    if (opencodeResult instanceof Error) {
      cliLogger.warn('Background OpenCode init failed:', opencodeResult.message)
      // Still try to register basic commands without user commands/agents
      await registerCommands({ token, appId, userCommands: [], agents: [] })
      return
    }

    const getClient = opencodeResult

    const [userCommands, agents] = await Promise.all([
      getClient()
        .command.list({ directory: currentDir })
        .then((r) => r.data || [])
        .catch((error) => {
          cliLogger.warn(
            'Failed to load user commands during background init:',
            error instanceof Error ? error.message : String(error),
          )
          return []
        }),
      getClient()
        .app.agents({ directory: currentDir })
        .then((r) => r.data || [])
        .catch((error) => {
          cliLogger.warn(
            'Failed to load agents during background init:',
            error instanceof Error ? error.message : String(error),
          )
          return []
        }),
    ])

    await registerCommands({ token, appId, userCommands, agents })
    cliLogger.log('Slash commands registered!')
  } catch (error) {
    cliLogger.error(
      'Background init failed:',
      error instanceof Error ? error.message : String(error),
    )
    void notifyError(error, 'Background init failed')
  }
}

async function run({
  restart,
  addChannels,
  useWorktrees,
  enableVoiceChannels,
}: CliOptions) {
  startCaffeinate()

  const forceSetup = Boolean(restart)

  // Step 0: Ensure required CLI tools are installed (OpenCode + Bun)
  await ensureCommandAvailable({
    name: 'opencode',
    envPathKey: 'OPENCODE_PATH',
    installUnix: 'curl -fsSL https://opencode.ai/install | bash',
    installWindows: 'irm https://opencode.ai/install.ps1 | iex',
    possiblePathsUnix: [
      '~/.local/bin/opencode',
      '~/.opencode/bin/opencode',
      '/usr/local/bin/opencode',
      '/opt/opencode/bin/opencode',
    ],
    possiblePathsWindows: [
      '~\\.local\\bin\\opencode.exe',
      '~\\AppData\\Local\\opencode\\opencode.exe',
      '~\\.opencode\\bin\\opencode.exe',
    ],
  })

  await ensureCommandAvailable({
    name: 'bun',
    envPathKey: 'BUN_PATH',
    installUnix: 'curl -fsSL https://bun.sh/install | bash',
    installWindows: 'irm bun.sh/install.ps1 | iex',
    possiblePathsUnix: ['~/.bun/bin/bun', '/usr/local/bin/bun'],
    possiblePathsWindows: ['~\\.bun\\bin\\bun.exe'],
  })


  backgroundUpgradeKimaki()

  // Start in-process Hrana server before database init. Required for the bot
  // process because it serves as both the DB server and the single-instance
  // lock (binds the fixed lock port). Without it, IPC and lock enforcement
  // don't work. CLI subcommands skip the server and use file: directly.
  const hranaResult = await startHranaServer({
    dbPath: path.join(getDataDir(), 'discord-sessions.db'),
  })
  if (hranaResult instanceof Error) {
    cliLogger.error('Failed to start hrana server:', hranaResult.message)
    process.exit(EXIT_NO_RESTART)
  }

  // Initialize database (connects to hrana server via HTTP)
  await initDatabase()

  // Resolve bot credentials from (in priority order):
  // 1. KIMAKI_BOT_TOKEN env var (headless/CI deployments)
  // 2. Saved credentials in the database
  // 3. Interactive setup wizard (first-time users)
  // App ID is always derived from the token (base64 first segment).
  const { appId, token, isQuickStart } = await (async (): Promise<{
    appId: string
    token: string
    isQuickStart: boolean
  }> => {
    const envToken = process.env.KIMAKI_BOT_TOKEN
    const existingBot = await getBotToken()

    // 1. Env var takes precedence (headless deployments)
    if (envToken && !forceSetup) {
      const derivedAppId = appIdFromToken(envToken)
      if (!derivedAppId) {
        cliLogger.error(
          'Could not derive Application ID from KIMAKI_BOT_TOKEN. The token appears malformed.',
        )
        process.exit(EXIT_NO_RESTART)
      }
      await setBotToken(derivedAppId, envToken)
      cliLogger.log(`Using KIMAKI_BOT_TOKEN env var (App ID: ${derivedAppId})`)
      return { appId: derivedAppId, token: envToken, isQuickStart: !addChannels }
    }

    // 2. Saved credentials in the database
    if (existingBot && !forceSetup) {
      note(
        `Using saved bot credentials:\nApp ID: ${existingBot.app_id}\n\nTo use different credentials, run with --restart`,
        'Existing Bot Found',
      )
      note(
        `Bot install URL (in case you need to add it to another server):\n${generateBotInstallUrl({ clientId: existingBot.app_id })}`,
        'Install URL',
      )
      return { appId: existingBot.app_id, token: existingBot.token, isQuickStart: !addChannels }
    }

    // 3. Interactive setup wizard
    if (forceSetup && existingBot) {
      note('Ignoring saved credentials due to --restart flag', 'Restart Setup')
    }

    note(
      '1. Go to https://discord.com/developers/applications\n' +
        '2. Click "New Application"\n' +
        '3. Give your application a name',
      'Step 1: Create Discord Application',
    )

    note(
      '1. Go to the "Bot" section in the left sidebar\n' +
        '2. Scroll down to "Privileged Gateway Intents"\n' +
        '3. Enable these intents by toggling them ON:\n' +
        '   • SERVER MEMBERS INTENT\n' +
        '   • MESSAGE CONTENT INTENT\n' +
        '4. Click "Save Changes" at the bottom',
      'Step 2: Enable Required Intents',
    )

    const intentsConfirmed = await text({
      message: 'Press Enter after enabling both intents:',
      placeholder: 'Enter',
    })
    if (isCancel(intentsConfirmed)) {
      cancel('Setup cancelled')
      process.exit(0)
    }

    note(
      '1. Still in the "Bot" section\n' +
        '2. Click "Reset Token" to generate a new bot token (in case of errors try again)\n' +
        "3. Copy the token (you won't be able to see it again!)",
      'Step 3: Get Bot Token',
    )
    const tokenInput = await password({
      message:
        'Enter your Discord Bot Token (from "Bot" section - click "Reset Token" if needed):',
      validate(value) {
        const cleaned = stripBracketedPaste(value)
        if (!cleaned) {
          return 'Bot token is required'
        }
        if (cleaned.length < 50) {
          return 'Invalid token format (too short)'
        }
      },
    })
    if (isCancel(tokenInput)) {
      cancel('Setup cancelled')
      process.exit(0)
    }

    const wizardToken = stripBracketedPaste(tokenInput)
    const derivedAppId = appIdFromToken(wizardToken)
    if (!derivedAppId) {
      cliLogger.error(
        'Could not derive Application ID from the bot token. The token appears malformed.',
      )
      process.exit(EXIT_NO_RESTART)
    }

    await setBotToken(derivedAppId, wizardToken)

    note(
      `Bot install URL:\n${generateBotInstallUrl({ clientId: derivedAppId })}\n\nYou MUST install the bot in your Discord server before continuing.`,
      'Step 4: Install Bot to Server',
    )
    const installed = await text({
      message: 'Press Enter AFTER you have installed the bot in your server:',
      placeholder: 'Enter',
    })
    if (isCancel(installed)) {
      cancel('Setup cancelled')
      process.exit(0)
    }

    return { appId: derivedAppId, token: wizardToken, isQuickStart: false }
  })()

  const shouldAddChannels =
    !isQuickStart || forceSetup || Boolean(addChannels)

  // Start OpenCode server EARLY - let it initialize in parallel with Discord login.
  // This is the biggest startup bottleneck (can take 1-30 seconds to spawn and wait for ready)
  const currentDir = process.cwd()
  cliLogger.log('Starting OpenCode server...')
  const opencodePromise = initializeOpencodeForDirectory(currentDir).then(
    (result) => {
      if (result instanceof Error) {
        throw new Error(result.message)
      }
      return result
    },
  )

  cliLogger.log('Connecting to Discord...')
  const discordClient = await createDiscordClient()

  const guilds: Guild[] = []
  const kimakiChannels: { guild: Guild; channels: ChannelWithTags[] }[] = []
  const createdChannels: { name: string; id: string; guildId: string }[] = []

  try {
    await new Promise((resolve, reject) => {
      discordClient.once(Events.ClientReady, async (c) => {
        guilds.push(...Array.from(c.guilds.cache.values()))

        if (isQuickStart) {
          resolve(null)
          return
        }

        // Process guild metadata when setup flow needs channel prompts.
        const guildResults = await collectKimakiChannels({
          guilds,
          appId,
          reconcileRoles: true,
        })

        // Collect results
        for (const result of guildResults) {
          kimakiChannels.push(result)
        }

        resolve(null)
      })

      discordClient.once(Events.Error, reject)

      discordClient.login(token).catch(reject)
    })

    cliLogger.log('Connected to Discord!')
    // Start IPC polling now that Discord client is ready.
    // Register cleanup on process exit since the shutdown handler lives in discord-bot.ts.
    await startIpcPolling({ discordClient })
    process.on('exit', stopIpcPolling)
  } catch (error) {
    cliLogger.log('Failed to connect to Discord')
    cliLogger.error(
      'Error: ' + (error instanceof Error ? error.message : String(error)),
    )
    process.exit(EXIT_NO_RESTART)
  }
  await setBotToken(appId, token)

  // Quick start: start the bot first, then defer channel sync/role reconciliation.
  if (isQuickStart) {
    cliLogger.log('Starting Discord bot...')
    await startDiscordBot({ token, appId, discordClient, useWorktrees })
    cliLogger.log('Discord bot is running!')

    // Background channel sync + role reconciliation should never block ready state.
    void (async () => {
      try {
        const backgroundChannels = await collectKimakiChannels({
          guilds,
          appId,
          reconcileRoles: true,
        })
        await storeChannelDirectories({ kimakiChannels: backgroundChannels })
        cliLogger.log(
          `Background channel sync completed for ${backgroundChannels.length} guild(s)`,
        )
      } catch (error) {
        cliLogger.warn(
          'Background channel sync failed:',
          error instanceof Error ? error.message : String(error),
        )
      }
    })()

    // Background: OpenCode init + slash command registration (non-blocking)
    void backgroundInit({ currentDir, token, appId })

    showReadyMessage({ kimakiChannels: [], createdChannels, appId })
    outro('✨ Bot ready! Listening for messages...')
    return
  }

  // Store channel-directory mappings
  await storeChannelDirectories({ kimakiChannels })

  if (kimakiChannels.length > 0) {
    const channelList = kimakiChannels
      .flatMap(({ guild, channels }) =>
        channels.map((ch) => {
          const appInfo =
            ch.kimakiApp === appId
              ? ' (this bot)'
              : ch.kimakiApp
                ? ` (app: ${ch.kimakiApp})`
                : ''
          return `#${ch.name} in ${guild.name}: ${ch.kimakiDirectory}${appInfo}`
        }),
      )
      .join('\n')

    note(channelList, 'Existing Kimaki Channels')
  }

  // Full setup path: wait for OpenCode, show prompts, create channels if needed
  // Await the OpenCode server that was started in parallel with Discord login
  cliLogger.log('Waiting for OpenCode server...')
  const getClient = await opencodePromise
  cliLogger.log('OpenCode server ready!')

  cliLogger.log('Fetching OpenCode data...')

  // Fetch projects, commands, and agents in parallel
  const [projects, allUserCommands, allAgents] = await Promise.all([
    getClient()
      .project.list()
      .then((r) => r.data || [])
      .catch((error) => {
        cliLogger.log('Failed to fetch projects')
        cliLogger.error(
          'Error:',
          error instanceof Error ? error.message : String(error),
        )
        discordClient.destroy()
        process.exit(EXIT_NO_RESTART)
      }),
    getClient()
      .command.list({ directory: currentDir })
      .then((r) => r.data || [])
      .catch((error) => {
        cliLogger.warn(
          'Failed to load user commands during setup:',
          error instanceof Error ? error.message : String(error),
        )
        return []
      }),
    getClient()
      .app.agents({ directory: currentDir })
      .then((r) => r.data || [])
      .catch((error) => {
        cliLogger.warn(
          'Failed to load agents during setup:',
          error instanceof Error ? error.message : String(error),
        )
        return []
      }),
  ])

  cliLogger.log(`Found ${projects.length} OpenCode project(s)`)

  const existingDirs = kimakiChannels.flatMap(({ channels }) =>
    channels
      .filter((ch) => ch.kimakiDirectory && ch.kimakiApp === appId)
      .map((ch) => ch.kimakiDirectory)
      .filter(Boolean),
  )

  const availableProjects = deduplicateByKey(
    projects.filter((project) => {
      if (existingDirs.includes(project.worktree)) {
        return false
      }
      if (path.basename(project.worktree).startsWith('opencode-test-')) {
        return false
      }
      return true
    }),
    (x) => x.worktree,
  )

  if (availableProjects.length === 0) {
    note(
      'All OpenCode projects already have Discord channels',
      'No New Projects',
    )
  }

  if (
    (!existingDirs?.length && availableProjects.length > 0) ||
    shouldAddChannels
  ) {
    const selectedProjects = await multiselect({
      message: 'Select projects to create Discord channels for:',
      options: availableProjects.map((project) => ({
        value: project.id,
        label: `${path.basename(project.worktree)} (${abbreviatePath(project.worktree)})`,
      })),
      required: false,
    })

    if (!isCancel(selectedProjects) && selectedProjects.length > 0) {
      let targetGuild: Guild
      if (guilds.length === 0) {
        cliLogger.error(
          'No Discord servers found! The bot must be installed in at least one server.',
        )
        process.exit(EXIT_NO_RESTART)
      }

      if (guilds.length === 1) {
        targetGuild = guilds[0]!
        note(`Using server: ${targetGuild.name}`, 'Server Selected')
      } else {
        const guildSelection = await multiselect({
          message: 'Select a Discord server to create channels in:',
          options: guilds.map((guild) => ({
            value: guild.id,
            label: `${guild.name} (${guild.memberCount} members)`,
          })),
          required: true,
          maxItems: 1,
        })

        if (isCancel(guildSelection)) {
          cancel('Setup cancelled')
          process.exit(0)
        }

        targetGuild = guilds.find((g) => g.id === guildSelection[0])!
      }

      cliLogger.log('Creating Discord channels...')

      for (const projectId of selectedProjects) {
        const project = projects.find((p) => p.id === projectId)
        if (!project) continue

        try {
          const { textChannelId, channelName } = await createProjectChannels({
            guild: targetGuild,
            projectDirectory: project.worktree,
            appId,
            botName: discordClient.user?.username,
            enableVoiceChannels,
          })

          createdChannels.push({
            name: channelName,
            id: textChannelId,
            guildId: targetGuild.id,
          })
        } catch (error) {
          cliLogger.error(
            `Failed to create channels for ${path.basename(project.worktree)}:`,
            error,
          )
        }
      }

      cliLogger.log(`Created ${createdChannels.length} channel(s)`)

      if (createdChannels.length > 0) {
        note(
          createdChannels.map((ch) => `#${ch.name}`).join('\n'),
          'Created Channels',
        )
      }
    }
  }

  // Log available user commands
  const registrableCommands = allUserCommands.filter(
    (cmd) => !SKIP_USER_COMMANDS.includes(cmd.name),
  )

  if (registrableCommands.length > 0) {
    const commandList = registrableCommands
      .map(
        (cmd) => `  /${cmd.name}-cmd - ${cmd.description || 'No description'}`,
      )
      .join('\n')

    note(
      `Found ${registrableCommands.length} user-defined command(s):\n${commandList}`,
      'OpenCode Commands',
    )
  }

  cliLogger.log('Registering slash commands asynchronously...')
  void registerCommands({
    token,
    appId,
    userCommands: allUserCommands,
    agents: allAgents,
  })
    .then(() => {
      cliLogger.log('Slash commands registered!')
    })
    .catch((error) => {
      cliLogger.error(
        'Failed to register slash commands:',
        error instanceof Error ? error.message : String(error),
      )
    })

  cliLogger.log('Starting Discord bot...')
  await startDiscordBot({ token, appId, discordClient, useWorktrees })
  cliLogger.log('Discord bot is running!')

  showReadyMessage({ kimakiChannels, createdChannels, appId })
  outro(
    '✨ Setup complete! Listening for new messages... do not close this process.',
  )
}

cli
  .command('', 'Set up and run the Kimaki Discord bot')
  .option('--restart', 'Prompt for new credentials even if saved')
  .option(
    '--add-channels',
    'Select OpenCode projects to create Discord channels before starting',
  )
  .option(
    '--data-dir <path>',
    'Data directory for config and database (default: ~/.kimaki)',
  )
  .option('--install-url', 'Print the bot install URL and exit')
  .option(
    '--use-worktrees',
    'Create git worktrees for all new sessions started from channel messages',
  )
  .option(
    '--enable-voice-channels',
    'Create voice channels for projects (disabled by default)',
  )
  .option(
    '--verbosity <level>',
    'Default verbosity for all channels (tools-and-text, text-and-essential-tools, or text-only)',
  )
  .option(
    '--mention-mode',
    'Bot only responds when @mentioned (default for all channels)',
  )
  .option(
    '--no-critique',
    'Disable automatic diff upload to critique.work in system prompts',
  )
  .option(
    '--auto-restart',
    'Automatically restart the bot on crash or OOM kill',
  )
  .option(
    '--verbose-opencode-server',
    'Forward OpenCode server stdout/stderr to kimaki.log',
  )
  .option('--no-sentry', 'Disable Sentry error reporting')
  .action(
    async (options: {
      restart?: boolean
      addChannels?: boolean
      dataDir?: string
      installUrl?: boolean
      useWorktrees?: boolean
      enableVoiceChannels?: boolean
      verbosity?: string
      mentionMode?: boolean
      noCritique?: boolean
      autoRestart?: boolean
      verboseOpencodeServer?: boolean
      noSentry?: boolean
    }) => {
      try {
        // Set data directory early, before any database access
        if (options.dataDir) {
          setDataDir(options.dataDir)
          cliLogger.log(`Using data directory: ${getDataDir()}`)
        }

        // Initialize file logging to <dataDir>/kimaki.log
        initLogFile(getDataDir())

        if (options.verbosity) {
          const validLevels = [
            'tools-and-text',
            'text-and-essential-tools',
            'text-only',
          ]
          if (!validLevels.includes(options.verbosity)) {
            cliLogger.error(
              `Invalid verbosity level: ${options.verbosity}. Use one of: ${validLevels.join(', ')}`,
            )
            process.exit(EXIT_NO_RESTART)
          }
          setDefaultVerbosity(
            options.verbosity as
              | 'tools-and-text'
              | 'text-and-essential-tools'
              | 'text-only',
          )
          cliLogger.log(`Default verbosity: ${options.verbosity}`)
        }

        if (options.mentionMode) {
          setDefaultMentionMode(true)
          cliLogger.log(
            'Default mention mode: enabled (bot only responds when @mentioned)',
          )
        }

        if (options.noCritique) {
          setCritiqueEnabled(false)
          cliLogger.log(
            'Critique disabled: diffs will not be auto-uploaded to critique.work',
          )
        }

        if (options.verboseOpencodeServer) {
          setVerboseOpencodeServer(true)
          cliLogger.log(
            'Verbose OpenCode server: stdout/stderr will be forwarded to kimaki.log',
          )
        }

        if (options.noSentry) {
          process.env.KIMAKI_SENTRY_DISABLED = '1'
          cliLogger.log('Sentry error reporting disabled (--no-sentry)')
        } else {
          initSentry()
        }

        if (options.installUrl) {
          await initDatabase()
          const existingBot = await getBotToken()

          if (!existingBot) {
            cliLogger.error(
              'No bot configured yet. Run `kimaki` first to set up.',
            )
            process.exit(EXIT_NO_RESTART)
          }

          cliLogger.log(generateBotInstallUrl({ clientId: existingBot.app_id }))
          process.exit(0)
        }

        // Single-instance enforcement is handled by the hrana server binding the lock port.
        // startHranaServer() in run() evicts any existing instance before binding.
        await run({
          restart: options.restart,
          addChannels: options.addChannels,
          dataDir: options.dataDir,
          useWorktrees: options.useWorktrees,
          enableVoiceChannels: options.enableVoiceChannels,
        })
      } catch (error) {
        cliLogger.error('Unhandled error:', formatErrorWithStack(error))
        process.exit(EXIT_NO_RESTART)
      }
    },
  )

cli
  .command(
    'upload-to-discord [...files]',
    'Upload files to a Discord thread for a session',
  )
  .option('-s, --session <sessionId>', 'OpenCode session ID')
  .action(async (files: string[], options: { session?: string }) => {
    try {
      const { session: sessionId } = options

      if (!sessionId) {
        cliLogger.error('Session ID is required. Use --session <sessionId>')
        process.exit(EXIT_NO_RESTART)
      }

      if (!files || files.length === 0) {
        cliLogger.error('At least one file path is required')
        process.exit(EXIT_NO_RESTART)
      }

      const resolvedFiles = files.map((f) => path.resolve(f))
      for (const file of resolvedFiles) {
        if (!fs.existsSync(file)) {
          cliLogger.error(`File not found: ${file}`)
          process.exit(EXIT_NO_RESTART)
        }
      }

      await initDatabase()

      const threadId = await getThreadIdBySessionId(sessionId)

      if (!threadId) {
        cliLogger.error(`No Discord thread found for session: ${sessionId}`)
        process.exit(EXIT_NO_RESTART)
      }

      const botRow = await getBotToken()

      if (!botRow) {
        cliLogger.error(
          'No bot credentials found. Run `kimaki` first to set up the bot.',
        )
        process.exit(EXIT_NO_RESTART)
      }

      cliLogger.log(`Uploading ${resolvedFiles.length} file(s)...`)

      await uploadFilesToDiscord({
        threadId: threadId,
        botToken: botRow.token,
        files: resolvedFiles,
      })

      cliLogger.log(`Uploaded ${resolvedFiles.length} file(s)!`)

      note(
        `Files uploaded to Discord thread!\n\nFiles: ${resolvedFiles.map((f) => path.basename(f)).join(', ')}`,
        '✅ Success',
      )

      process.exit(0)
    } catch (error) {
      cliLogger.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

cli
  .command(
    'send',
    'Send a message to a Discord channel/thread. Default creates a thread; use --thread/--session to continue existing.',
  )
  .alias('start-session') // backwards compatibility
  .option('-c, --channel <channelId>', 'Discord channel ID')
  .option(
    '-d, --project <path>',
    'Project directory (alternative to --channel)',
  )
  .option('-p, --prompt <prompt>', 'Message content')
  .option(
    '-n, --name [name]',
    'Thread name (optional, defaults to prompt preview)',
  )
  .option(
    '-a, --app-id [appId]',
    'Bot application ID (required if no local database)',
  )
  .option(
    '--notify-only',
    'Create notification thread without starting AI session',
  )
  .option(
    '--worktree [name]',
    'Create git worktree for session (name optional, derives from thread name)',
  )
  .option('-u, --user <username>', 'Discord username to add to thread')
  .option('--agent <agent>', 'Agent to use for the session')
  .option('--model <model>', 'Model to use (format: provider/model)')
  .option(
    '--send-at <schedule>',
    'Schedule send for future (UTC ISO date/time ending in Z, or cron expression)',
  )
  .option('--thread <threadId>', 'Post prompt to an existing thread')
  .option(
    '--session <sessionId>',
    'Post prompt to thread mapped to an existing session',
  )
  .option(
    '--wait',
    'Wait for session to complete, then print session text to stdout',
  )
  .action(
    async (options: {
      channel?: string
      project?: string
      prompt?: string
      name?: string
      appId?: string
      notifyOnly?: boolean
      worktree?: string | boolean
      user?: string
      agent?: string
      model?: string
      sendAt?: string
      thread?: string
      session?: string
      wait?: boolean
    }) => {
      try {
        let {
          channel: channelId,
          prompt,
          name,
          appId: optionAppId,
          notifyOnly,
          thread: threadId,
          session: sessionId,
        } = options
        const { project: projectPath } = options
        const sendAt = options.sendAt

        const existingThreadMode = Boolean(threadId || sessionId)

        if (threadId && sessionId) {
          cliLogger.error('Use either --thread or --session, not both')
          process.exit(EXIT_NO_RESTART)
        }

        if (existingThreadMode && (channelId || projectPath)) {
          cliLogger.error(
            'Cannot combine --thread/--session with --channel/--project',
          )
          process.exit(EXIT_NO_RESTART)
        }

        // Default to current directory if neither --channel nor --project provided
        const resolvedProjectPath = existingThreadMode
          ? undefined
          : projectPath || (!channelId ? '.' : undefined)

        if (!prompt) {
          cliLogger.error('Prompt is required. Use --prompt <prompt>')
          process.exit(EXIT_NO_RESTART)
        }

        if (sendAt) {
          if (options.wait) {
            cliLogger.error('Cannot use --wait with --send-at')
            process.exit(EXIT_NO_RESTART)
          }
          if (prompt.length > 1900) {
            cliLogger.error(
              '--send-at currently supports prompts up to 1900 characters',
            )
            process.exit(EXIT_NO_RESTART)
          }
        }

        const parsedSchedule = (() => {
          if (!sendAt) {
            return null
          }
          return parseSendAtValue({
            value: sendAt,
            now: new Date(),
            timezone: getLocalTimeZone(),
          })
        })()
        if (parsedSchedule instanceof Error) {
          cliLogger.error(parsedSchedule.message)
          if (parsedSchedule.cause instanceof Error) {
            cliLogger.error(parsedSchedule.cause.message)
          }
          process.exit(EXIT_NO_RESTART)
        }

        if (!existingThreadMode && options.worktree && notifyOnly) {
          cliLogger.error('Cannot use --worktree with --notify-only')
          process.exit(EXIT_NO_RESTART)
        }

        if (options.wait && notifyOnly) {
          cliLogger.error('Cannot use --wait with --notify-only')
          process.exit(EXIT_NO_RESTART)
        }

        if (existingThreadMode) {
          const incompatibleFlags: string[] = []
          if (notifyOnly) {
            incompatibleFlags.push('--notify-only')
          }
          if (options.worktree) {
            incompatibleFlags.push('--worktree')
          }
          if (name) {
            incompatibleFlags.push('--name')
          }
          if (options.user) {
            incompatibleFlags.push('--user')
          }
          if (!sendAt && options.agent) {
            incompatibleFlags.push('--agent')
          }
          if (!sendAt && options.model) {
            incompatibleFlags.push('--model')
          }
          if (incompatibleFlags.length > 0) {
            cliLogger.error(
              `Incompatible options with --thread/--session: ${incompatibleFlags.join(', ')}`,
            )
            process.exit(EXIT_NO_RESTART)
          }
        }

        // Initialize database first
        await initDatabase()

        const { token: botToken, appId } = await resolveBotCredentials({
          appIdOverride: optionAppId,
        })

        // If --project provided (or defaulting to cwd), resolve to channel ID
        if (resolvedProjectPath) {
          const absolutePath = path.resolve(resolvedProjectPath)

          if (!fs.existsSync(absolutePath)) {
            cliLogger.error(`Directory does not exist: ${absolutePath}`)
            process.exit(EXIT_NO_RESTART)
          }

          cliLogger.log('Looking up channel for project...')

          // Check if channel already exists for this directory or a parent directory
          // This allows running from subfolders of a registered project
          try {
            // Helper to find channel for a path (prefers current bot's channel)
            const findChannelForPath = async (
              dirPath: string,
            ): Promise<
              { channel_id: string; directory: string } | undefined
            > => {
              const withAppId = appId
                ? await findChannelsByDirectory({
                    directory: dirPath,
                    channelType: 'text',
                    appId,
                  })
                : []
              if (withAppId.length > 0) {
                return withAppId[0]
              }

              const withoutAppId = await findChannelsByDirectory({
                directory: dirPath,
                channelType: 'text',
              })
              return withoutAppId[0]
            }

            // Try exact match first, then walk up parent directories
            let existingChannel:
              | { channel_id: string; directory: string }
              | undefined
            let searchPath = absolutePath
            while (searchPath !== path.dirname(searchPath)) {
              existingChannel = await findChannelForPath(searchPath)
              if (existingChannel) break
              searchPath = path.dirname(searchPath)
            }

            if (existingChannel) {
              channelId = existingChannel.channel_id
              if (existingChannel.directory !== absolutePath) {
                cliLogger.log(
                  `Found parent project channel: ${existingChannel.directory}`,
                )
              } else {
                cliLogger.log(`Found existing channel: ${channelId}`)
              }
            } else {
              // Need to create a new channel
              cliLogger.log('Creating new channel...')

              if (!appId) {
                cliLogger.log('Missing app ID')
                cliLogger.error(
                  'App ID is required to create channels. Use --app-id or run `kimaki` first.',
                )
                process.exit(EXIT_NO_RESTART)
              }

              const client = await createDiscordClient()

              await new Promise<void>((resolve, reject) => {
                client.once(Events.ClientReady, () => {
                  resolve()
                })
                client.once(Events.Error, reject)
                client.login(botToken)
              })

              // Get guild from existing channels or first available
              const guild = await (async () => {
                // Try to find a guild from existing channels belonging to this bot
                const existingChannelId = appId
                  ? await findChannelByAppId(appId)
                  : undefined

                if (existingChannelId) {
                  try {
                    const ch = await client.channels.fetch(existingChannelId)
                    if (ch && 'guild' in ch && ch.guild) {
                      return ch.guild
                    }
                  } catch (error) {
                    cliLogger.debug(
                      'Failed to fetch existing channel while selecting guild:',
                      error instanceof Error ? error.message : String(error),
                    )
                  }
                }
                // Fall back to first guild the bot is in
                let firstGuild = client.guilds.cache.first()
                if (!firstGuild) {
                  // Cache might be empty, try fetching guilds from API
                  const fetched = await client.guilds.fetch()
                  const firstOAuth2Guild = fetched.first()
                  if (firstOAuth2Guild) {
                    firstGuild = await client.guilds.fetch(firstOAuth2Guild.id)
                  }
                }
                if (!firstGuild) {
                  throw new Error(
                    'No guild found. Add the bot to a server first.',
                  )
                }
                return firstGuild
              })()

              const { textChannelId } = await createProjectChannels({
                guild,
                projectDirectory: absolutePath,
                appId,
                botName: client.user?.username,
              })

              channelId = textChannelId
              cliLogger.log(`Created channel: ${channelId}`)

              client.destroy()
            }
          } catch (e) {
            cliLogger.log('Failed to resolve project')
            throw e
          }
        }

        const rest = createDiscordRest(botToken)

        if (existingThreadMode) {
          const targetThreadId = await (async (): Promise<string> => {
            if (threadId) {
              return threadId
            }
            if (!sessionId) {
              throw new Error('Thread ID not resolved')
            }
            const resolvedThreadId = await getThreadIdBySessionId(sessionId)
            if (!resolvedThreadId) {
              throw new Error(
                `No Discord thread found for session: ${sessionId}`,
              )
            }
            return resolvedThreadId
          })()

          const threadData = (await rest.get(
            Routes.channel(targetThreadId),
          )) as {
            id: string
            name: string
            type: number
            parent_id?: string
            guild_id: string
          }

          if (!isThreadChannelType(threadData.type)) {
            throw new Error(`Channel is not a thread: ${targetThreadId}`)
          }

          if (!threadData.parent_id) {
            throw new Error(`Thread has no parent channel: ${targetThreadId}`)
          }

          const channelConfig = await getChannelDirectory(threadData.parent_id)
          if (!channelConfig) {
            throw new Error(
              'Thread parent channel is not configured with a project directory',
            )
          }

          if (parsedSchedule) {
            const payload: ScheduledTaskPayload = {
              kind: 'thread',
              threadId: targetThreadId,
              prompt,
              agent: options.agent || null,
              model: options.model || null,
              username: null,
              userId: null,
            }
            const taskId = await createScheduledTask({
              scheduleKind: parsedSchedule.scheduleKind,
              runAt: parsedSchedule.runAt,
              cronExpr: parsedSchedule.cronExpr,
              timezone: parsedSchedule.timezone,
              nextRunAt: parsedSchedule.nextRunAt,
              payloadJson: serializeScheduledTaskPayload(payload),
              promptPreview: getPromptPreview(prompt),
              channelId: threadData.parent_id,
              threadId: targetThreadId,
              sessionId: sessionId || undefined,
              projectDirectory: channelConfig.directory,
            })

            const threadUrl = `https://discord.com/channels/${threadData.guild_id}/${threadData.id}`
            note(
              `Task ID: ${taskId}\nTarget thread: ${threadData.name}\nSchedule: ${formatTaskScheduleLine(parsedSchedule)}\n\nURL: ${threadUrl}`,
              '✅ Task Scheduled',
            )
            cliLogger.log(threadUrl)
            process.exit(0)
          }

          const channelAppId = channelConfig.appId || undefined
          if (channelAppId && appId && channelAppId !== appId) {
            throw new Error(
              `Thread belongs to a different bot (expected: ${appId}, got: ${channelAppId})`,
            )
          }

          const threadPromptMarker: ThreadStartMarker = {
            cliThreadPrompt: true,
          }
          const promptEmbed = [
            {
              color: 0x2b2d31,
              footer: { text: yaml.dump(threadPromptMarker) },
            },
          ]

          // Prefix the prompt so it's clear who sent it (matches /queue format)
          const prefixedPrompt = `» **kimaki-cli:** ${prompt}`

          await sendDiscordMessageWithOptionalAttachment({
            channelId: targetThreadId,
            prompt: prefixedPrompt,
            botToken,
            embeds: promptEmbed,
            rest,
          })

          const threadUrl = `https://discord.com/channels/${threadData.guild_id}/${threadData.id}`
          note(
            `Prompt sent to thread: ${threadData.name}\n\nURL: ${threadUrl}`,
            '✅ Message Sent',
          )
          cliLogger.log(threadUrl)

          if (options.wait) {
            const { waitAndOutputSession } = await import('./wait-session.js')
            await waitAndOutputSession({
              threadId: targetThreadId,
              projectDirectory: channelConfig.directory,
            })
          }

          process.exit(0)
        }

        cliLogger.log('Fetching channel info...')

        if (!channelId) {
          throw new Error('Channel ID not resolved')
        }

        // Get channel info to extract directory from topic
        const channelData = (await rest.get(Routes.channel(channelId))) as {
          id: string
          name: string
          topic?: string
          guild_id: string
        }

        const channelConfig = await getChannelDirectory(channelData.id)

        if (!channelConfig) {
          cliLogger.log('Channel not configured')
          throw new Error(
            `Channel #${channelData.name} is not configured with a project directory. Run the bot first to sync channel data.`,
          )
        }

        const projectDirectory = channelConfig.directory
        const channelAppId = channelConfig.appId || undefined

        // Verify app ID matches if both are present
        if (channelAppId && appId && channelAppId !== appId) {
          cliLogger.log('Channel belongs to different bot')
          throw new Error(
            `Channel belongs to a different bot (expected: ${appId}, got: ${channelAppId})`,
          )
        }

        // Resolve username to user ID if provided
        const resolvedUser = await (async (): Promise<
          { id: string; username: string } | undefined
        > => {
          if (!options.user) {
            return undefined
          }
          cliLogger.log(`Searching for user "${options.user}" in guild...`)
          const searchResults = (await rest.get(
            Routes.guildMembersSearch(channelData.guild_id),
            {
              query: new URLSearchParams({ query: options.user, limit: '10' }),
            },
          )) as Array<{
            user: { id: string; username: string; global_name?: string }
            nick?: string
          }>

          // Find exact match by display name, nickname, or username
          const exactMatch = searchResults.find((member) => {
            const displayName =
              member.nick || member.user.global_name || member.user.username
            return (
              displayName.toLowerCase() === options.user!.toLowerCase() ||
              member.user.username.toLowerCase() === options.user!.toLowerCase()
            )
          })
          const member = exactMatch || searchResults[0]
          if (!member) {
            throw new Error(`User "${options.user}" not found in guild`)
          }
          const username =
            member.nick || member.user.global_name || member.user.username
          cliLogger.log(`Found user: ${username} (${member.user.id})`)
          return { id: member.user.id, username }
        })()

        cliLogger.log('Creating starter message...')

        // Compute thread name and worktree name early (needed for embed)
        const cleanPrompt = stripMentions(prompt)
        const baseThreadName =
          name ||
          (cleanPrompt.length > 80
            ? cleanPrompt.slice(0, 77) + '...'
            : cleanPrompt)
        const worktreeName = options.worktree
          ? formatWorktreeName(
              typeof options.worktree === 'string'
                ? options.worktree
                : baseThreadName,
            )
          : undefined
        const threadName = worktreeName
          ? `${WORKTREE_PREFIX}${baseThreadName}`
          : baseThreadName

        if (parsedSchedule) {
          const payload: ScheduledTaskPayload = {
            kind: 'channel',
            channelId,
            prompt,
            name: name || null,
            notifyOnly: Boolean(notifyOnly),
            worktreeName: worktreeName || null,
            agent: options.agent || null,
            model: options.model || null,
            username: resolvedUser?.username || null,
            userId: resolvedUser?.id || null,
          }
          const taskId = await createScheduledTask({
            scheduleKind: parsedSchedule.scheduleKind,
            runAt: parsedSchedule.runAt,
            cronExpr: parsedSchedule.cronExpr,
            timezone: parsedSchedule.timezone,
            nextRunAt: parsedSchedule.nextRunAt,
            payloadJson: serializeScheduledTaskPayload(payload),
            promptPreview: getPromptPreview(prompt),
            channelId,
            projectDirectory,
          })

          const channelUrl = `https://discord.com/channels/${channelData.guild_id}/${channelId}`
          note(
            `Task ID: ${taskId}\nTarget channel: #${channelData.name}\nSchedule: ${formatTaskScheduleLine(parsedSchedule)}\n\nURL: ${channelUrl}`,
            '✅ Task Scheduled',
          )
          cliLogger.log(channelUrl)
          process.exit(0)
        }

        // Embed marker for auto-start sessions (unless --notify-only)
        // Bot parses this YAML to know it should start a session, optionally create a worktree, and set initial user
        const embedMarker: ThreadStartMarker | undefined = notifyOnly
          ? undefined
          : {
              start: true,
              ...(worktreeName && { worktree: worktreeName }),
              ...(resolvedUser && {
                username: resolvedUser.username,
                userId: resolvedUser.id,
              }),
              ...(options.agent && { agent: options.agent }),
              ...(options.model && { model: options.model }),
            }
        const autoStartEmbed = embedMarker
          ? [{ color: 0x2b2d31, footer: { text: yaml.dump(embedMarker) } }]
          : undefined

        const starterMessage = await sendDiscordMessageWithOptionalAttachment({
          channelId,
          prompt,
          botToken,
          embeds: autoStartEmbed,
          rest,
        })

        cliLogger.log('Creating thread...')

        const threadData = (await rest.post(
          Routes.threads(channelId, starterMessage.id),
          {
            body: {
              name: threadName.slice(0, 100),
              auto_archive_duration: 1440, // 1 day
            },
          },
        )) as { id: string; name: string }

        cliLogger.log('Thread created!')

        // Add user to thread if specified
        if (resolvedUser) {
          cliLogger.log(`Adding user ${resolvedUser.username} to thread...`)
          await rest.put(Routes.threadMembers(threadData.id, resolvedUser.id))
        }

        const threadUrl = `https://discord.com/channels/${channelData.guild_id}/${threadData.id}`

        const worktreeNote = worktreeName
          ? `\nWorktree: ${worktreeName} (will be created by bot)`
          : ''
        const successMessage = notifyOnly
          ? `Thread: ${threadData.name}\nDirectory: ${projectDirectory}\n\nNotification created. Reply to start a session.\n\nURL: ${threadUrl}`
          : `Thread: ${threadData.name}\nDirectory: ${projectDirectory}${worktreeNote}\n\nThe running bot will pick this up and start the session.\n\nURL: ${threadUrl}`

        note(successMessage, '✅ Thread Created')

        cliLogger.log(threadUrl)

        if (options.wait) {
          const { waitAndOutputSession } = await import('./wait-session.js')
          await waitAndOutputSession({
            threadId: threadData.id,
            projectDirectory,
          })
        }

        process.exit(0)
      } catch (error) {
        cliLogger.error(
          'Error:',
          error instanceof Error ? error.message : String(error),
        )
        process.exit(EXIT_NO_RESTART)
      }
    },
  )

cli
  .command('task list', 'List scheduled tasks created via send --send-at')
  .option('--all', 'Include terminal tasks (completed, cancelled, failed)')
  .action(async (options: { all?: boolean }) => {
    try {
      await initDatabase()

      const statuses = options.all
        ? undefined
        : (['planned', 'running'] as Array<'planned' | 'running'>)
      const tasks = await listScheduledTasks({ statuses })
      if (tasks.length === 0) {
        cliLogger.log('No scheduled tasks found')
        process.exit(0)
      }

      console.log(
        'id | status | message | channelId | projectName | folderName | timeRemaining | firesAt | cron',
      )

      tasks.forEach((task) => {
        const projectDirectory = task.project_directory || ''
        const projectName = projectDirectory
          ? path.basename(projectDirectory)
          : '-'
        const folderName = projectDirectory
          ? path.basename(path.dirname(projectDirectory))
          : '-'
        const firesAt =
          task.schedule_kind === 'at' && task.run_at
            ? task.run_at.toISOString()
            : '-'
        const cronValue =
          task.schedule_kind === 'cron' ? task.cron_expr || '-' : '-'

        console.log(
          `${task.id} | ${task.status} | ${task.prompt_preview} | ${task.channel_id || '-'} | ${projectName} | ${folderName} | ${formatRelativeTime(task.next_run_at)} | ${firesAt} | ${cronValue}`,
        )
      })

      process.exit(0)
    } catch (error) {
      cliLogger.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

cli
  .command('task delete <id>', 'Cancel a scheduled task by ID')
  .action(async (id: string) => {
    try {
      const taskId = Number.parseInt(id, 10)
      if (Number.isNaN(taskId) || taskId < 1) {
        cliLogger.error(`Invalid task ID: ${id}`)
        process.exit(EXIT_NO_RESTART)
      }

      await initDatabase()
      const cancelled = await cancelScheduledTask(taskId)
      if (!cancelled) {
        cliLogger.error(`Task ${taskId} not found or already finalized`)
        process.exit(EXIT_NO_RESTART)
      }

      cliLogger.log(`Cancelled task ${taskId}`)
      process.exit(0)
    } catch (error) {
      cliLogger.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

cli
  .command(
    'project add [directory]',
    'Create Discord channels for a project directory (replaces legacy add-project)',
  )
  .alias('add-project')
  .option(
    '-g, --guild <guildId>',
    'Discord guild/server ID (auto-detects if bot is in only one server)',
  )
  .option(
    '-a, --app-id <appId>',
    'Bot application ID (reads from database if available)',
  )
  .action(
    async (
      directory: string | undefined,
      options: {
        guild?: string
        appId?: string
      },
    ) => {
      const absolutePath = path.resolve(directory || '.')

      if (!fs.existsSync(absolutePath)) {
        cliLogger.error(`Directory does not exist: ${absolutePath}`)
        process.exit(EXIT_NO_RESTART)
      }

      // Initialize database
      await initDatabase()

      const { token: botToken, appId } = await resolveBotCredentials({
        appIdOverride: options.appId,
      })

      if (!appId) {
        cliLogger.error(
          'App ID is required to create channels. Use --app-id or run `kimaki` first.',
        )
        process.exit(EXIT_NO_RESTART)
      }

      cliLogger.log('Connecting to Discord...')
      const client = await createDiscordClient()

      await new Promise<void>((resolve, reject) => {
        client.once(Events.ClientReady, () => {
          resolve()
        })
        client.once(Events.Error, reject)
        client.login(botToken)
      })

      cliLogger.log('Finding guild...')

      // Find guild
      let guild: Guild
      if (options.guild) {
        const guildId = String(options.guild)
        const foundGuild = client.guilds.cache.get(guildId)
        if (!foundGuild) {
          cliLogger.log('Guild not found')
          cliLogger.error(`Guild not found: ${guildId}`)
          client.destroy()
          process.exit(EXIT_NO_RESTART)
        }
        guild = foundGuild
      } else {
        // Auto-detect: prefer guild with existing channels for this bot, else first guild
        const existingChannelId = await findChannelByAppId(appId)

        if (existingChannelId) {
          try {
            const ch = await client.channels.fetch(existingChannelId)
            if (ch && 'guild' in ch && ch.guild) {
              guild = ch.guild
            } else {
              throw new Error('Channel has no guild')
            }
          } catch (error) {
            cliLogger.debug(
              'Failed to fetch existing channel while selecting guild:',
              error instanceof Error ? error.message : String(error),
            )
            let firstGuild = client.guilds.cache.first()
            if (!firstGuild) {
              // Cache might be empty, try fetching guilds from API
              const fetched = await client.guilds.fetch()
              const firstOAuth2Guild = fetched.first()
              if (firstOAuth2Guild) {
                firstGuild = await client.guilds.fetch(firstOAuth2Guild.id)
              }
            }
            if (!firstGuild) {
              cliLogger.log('No guild found')
              cliLogger.error('No guild found. Add the bot to a server first.')
              client.destroy()
              process.exit(EXIT_NO_RESTART)
            }
            guild = firstGuild
          }
        } else {
          let firstGuild = client.guilds.cache.first()
          if (!firstGuild) {
            // Cache might be empty, try fetching guilds from API
            const fetched = await client.guilds.fetch()
            const firstOAuth2Guild = fetched.first()
            if (firstOAuth2Guild) {
              firstGuild = await client.guilds.fetch(firstOAuth2Guild.id)
            }
          }
          if (!firstGuild) {
            cliLogger.log('No guild found')
            cliLogger.error('No guild found. Add the bot to a server first.')
            client.destroy()
            process.exit(EXIT_NO_RESTART)
          }
          guild = firstGuild
        }
      }

      // Check if channel already exists in this guild
      cliLogger.log('Checking for existing channel...')
      try {
        const existingChannels = await findChannelsByDirectory({
          directory: absolutePath,
          channelType: 'text',
          appId,
        })

        for (const existingChannel of existingChannels) {
          try {
            const ch = await client.channels.fetch(existingChannel.channel_id)
            if (ch && 'guild' in ch && ch.guild?.id === guild.id) {
              client.destroy()
              cliLogger.error(
                `Channel already exists for this directory in ${guild.name}. Channel ID: ${existingChannel.channel_id}`,
              )
              process.exit(EXIT_NO_RESTART)
            }
          } catch (error) {
            cliLogger.debug(
              `Failed to fetch channel ${existingChannel.channel_id} while checking existing channels:`,
              error instanceof Error ? error.message : String(error),
            )
          }
        }
      } catch (error) {
        cliLogger.debug(
          'Database lookup failed while checking existing channels:',
          error instanceof Error ? error.message : String(error),
        )
      }

      cliLogger.log(`Creating channels in ${guild.name}...`)

      const { textChannelId, voiceChannelId, channelName } =
        await createProjectChannels({
          guild,
          projectDirectory: absolutePath,
          appId,
          botName: client.user?.username,
        })

      client.destroy()

      cliLogger.log('Channels created!')

      const channelUrl = `https://discord.com/channels/${guild.id}/${textChannelId}`

      note(
        `Created channels for project:\n\n📝 Text: #${channelName}\n🔊 Voice: #${channelName}\n📁 Directory: ${absolutePath}\n\nURL: ${channelUrl}`,
        '✅ Success',
      )

      cliLogger.log(channelUrl)
      process.exit(0)
    },
  )

cli
  .command(
    'project list',
    'List all registered projects with their Discord channels',
  )
  .option('--json', 'Output as JSON')
  .action(async (options: { json?: boolean }) => {
    await initDatabase()

    const prisma = await getPrisma()
    const channels = await prisma.channel_directories.findMany({
      where: { channel_type: 'text' },
      orderBy: { created_at: 'desc' },
    })

    if (channels.length === 0) {
      cliLogger.log('No projects registered')
      process.exit(0)
    }

    // Fetch Discord channel names via REST API
    const botRow = await getBotToken()
    const rest = botRow ? createDiscordRest(botRow.token) : null

    const enriched = await Promise.all(
      channels.map(async (ch) => {
        let channelName = ''
        if (rest) {
          try {
            const data = (await rest.get(Routes.channel(ch.channel_id))) as {
              name?: string
            }
            channelName = data.name || ''
          } catch {
            // Channel may have been deleted from Discord
          }
        }
        return { ...ch, channelName }
      }),
    )

    if (options.json) {
      const output = enriched.map((ch) => ({
        channel_id: ch.channel_id,
        channel_name: ch.channelName,
        directory: ch.directory,
        folder_name: path.basename(ch.directory),
        app_id: ch.app_id,
      }))
      console.log(JSON.stringify(output, null, 2))
      process.exit(0)
    }

    for (const ch of enriched) {
      const folderName = path.basename(ch.directory)
      const channelLabel = ch.channelName ? `#${ch.channelName}` : ch.channel_id
      console.log(`\n${channelLabel}`)
      console.log(`   Folder: ${folderName}`)
      console.log(`   Directory: ${ch.directory}`)
      console.log(`   Channel ID: ${ch.channel_id}`)
      if (ch.app_id) {
        console.log(`   Bot App ID: ${ch.app_id}`)
      }
    }

    process.exit(0)
  })

cli
  .command(
    'project open-in-discord',
    'Open the current project channel in Discord',
  )
  .action(async () => {
    await initDatabase()

    const botRow = await getBotToken()
    if (!botRow) {
      cliLogger.error('No bot configured. Run `kimaki` first.')
      process.exit(EXIT_NO_RESTART)
    }

    const { app_id: appId, token: botToken } = botRow
    const absolutePath = path.resolve('.')

    // Walk up parent directories to find a matching channel
    const findChannelForPath = async (
      dirPath: string,
    ): Promise<{ channel_id: string; directory: string } | undefined> => {
      const withAppId = appId
        ? await findChannelsByDirectory({
            directory: dirPath,
            channelType: 'text',
            appId,
          })
        : []
      if (withAppId.length > 0) {
        return withAppId[0]
      }
      const withoutAppId = await findChannelsByDirectory({
        directory: dirPath,
        channelType: 'text',
      })
      return withoutAppId[0]
    }

    let existingChannel: { channel_id: string; directory: string } | undefined
    let searchPath = absolutePath
    do {
      existingChannel = await findChannelForPath(searchPath)
      if (existingChannel) {
        break
      }
      const parent = path.dirname(searchPath)
      if (parent === searchPath) {
        break
      }
      searchPath = parent
    } while (true)

    if (!existingChannel) {
      cliLogger.error(`No project channel found for ${absolutePath}`)
      process.exit(EXIT_NO_RESTART)
    }

    // Fetch channel from Discord to get guild_id
    const rest = createDiscordRest(botToken)
    const channelData = (await rest.get(
      Routes.channel(existingChannel.channel_id),
    )) as {
      id: string
      guild_id: string
    }

    const channelUrl = `https://discord.com/channels/${channelData.guild_id}/${channelData.id}`
    cliLogger.log(channelUrl)

    // Open in browser if running in a TTY
    if (process.stdout.isTTY) {
      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', channelUrl], {
          detached: true,
          stdio: 'ignore',
        }).unref()
      } else {
        const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
        spawn(openCmd, [channelUrl], {
          detached: true,
          stdio: 'ignore',
        }).unref()
      }
    }

    process.exit(0)
  })

cli
  .command(
    'project create <name>',
    'Create a new project folder with git and Discord channels',
  )
  .option('-g, --guild <guildId>', 'Discord guild ID')
  .action(async (name: string, options: { guild?: string }) => {
    const sanitizedName = name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 100)

    if (!sanitizedName) {
      cliLogger.error('Invalid project name')
      process.exit(EXIT_NO_RESTART)
    }

    await initDatabase()

    const botRow = await getBotToken()
    if (!botRow) {
      cliLogger.error('No bot configured. Run `kimaki` first.')
      process.exit(EXIT_NO_RESTART)
    }

    const { app_id: appId, token: botToken } = botRow

    const projectsDir = getProjectsDir()
    const projectDirectory = path.join(projectsDir, sanitizedName)

    if (!fs.existsSync(projectsDir)) {
      fs.mkdirSync(projectsDir, { recursive: true })
    }

    if (fs.existsSync(projectDirectory)) {
      cliLogger.error(`Directory already exists: ${projectDirectory}`)
      process.exit(EXIT_NO_RESTART)
    }

    fs.mkdirSync(projectDirectory, { recursive: true })
    cliLogger.log(`Created: ${projectDirectory}`)

    execSync('git init', { cwd: projectDirectory, stdio: 'pipe' })
    cliLogger.log('Initialized git')

    cliLogger.log('Connecting to Discord...')
    const client = await createDiscordClient()

    await new Promise<void>((resolve, reject) => {
      client.once(Events.ClientReady, () => {
        resolve()
      })
      client.once(Events.Error, reject)
      client.login(botToken).catch(reject)
    })

    let guild: Guild
    if (options.guild) {
      const found = client.guilds.cache.get(options.guild)
      if (!found) {
        cliLogger.error(`Guild not found: ${options.guild}`)
        client.destroy()
        process.exit(EXIT_NO_RESTART)
      }
      guild = found
    } else {
      const first = client.guilds.cache.first()
      if (!first) {
        cliLogger.error('No guild found. Add the bot to a server first.')
        client.destroy()
        process.exit(EXIT_NO_RESTART)
      }
      guild = first
    }

    const { textChannelId, channelName } = await createProjectChannels({
      guild,
      projectDirectory,
      appId,
      botName: client.user?.username,
    })

    client.destroy()

    const channelUrl = `https://discord.com/channels/${guild.id}/${textChannelId}`

    note(
      `Created project: ${sanitizedName}\n\nDirectory: ${projectDirectory}\nChannel: #${channelName}\nURL: ${channelUrl}`,
      '✅ Success',
    )

    cliLogger.log(channelUrl)
    process.exit(0)
  })

cli
  .command('tunnel', 'Expose a local port via tunnel')
  .option('-p, --port <port>', 'Local port to expose (required)')
  .option(
    '-t, --tunnel-id [id]',
    'Custom tunnel ID (only for services safe to expose publicly; prefer random default)',
  )
  .option('-h, --host [host]', 'Local host (default: localhost)')
  .option('-s, --server [url]', 'Tunnel server URL')
  .action(
    async (options: {
      port?: string
      tunnelId?: string
      host?: string
      server?: string
    }) => {
      const { runTunnel, parseCommandFromArgv, CLI_NAME } = await import(
        'traforo/run-tunnel'
      )

      if (!options.port) {
        cliLogger.error('Error: --port is required')
        cliLogger.error(`\nUsage: kimaki tunnel -p <port> [-- command]`)
        process.exit(EXIT_NO_RESTART)
      }

      const port = parseInt(options.port, 10)
      if (isNaN(port) || port < 1 || port > 65535) {
        cliLogger.error(`Error: Invalid port number: ${options.port}`)
        process.exit(EXIT_NO_RESTART)
      }

      // Parse command after -- from argv
      const { command } = parseCommandFromArgv(process.argv)

      await runTunnel({
        port,
        tunnelId: options.tunnelId,
        localHost: options.host,
        baseDomain: 'kimaki.xyz',
        serverUrl: options.server,
        command: command.length > 0 ? command : undefined,
      })
    },
  )

cli
  .command('sqlitedb', 'Show the location of the SQLite database file')
  .action(() => {
    const dataDir = getDataDir()
    const dbPath = path.join(dataDir, 'discord-sessions.db')
    cliLogger.log(dbPath)
  })

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
      const prisma = await getPrisma()
      const threadSessions = await prisma.thread_sessions.findMany({
        select: { thread_id: true, session_id: true },
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
        error instanceof Error ? error.message : String(error),
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
        if (otherClient instanceof Error) {
          continue
        }
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
        error instanceof Error ? error.message : String(error),
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

      const prisma = await getPrisma()
      const threadSessions = await prisma.thread_sessions.findMany({
        select: { thread_id: true, session_id: true },
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
        error instanceof Error ? error.message : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

cli
  .command(
    'session archive <threadId>',
    'Archive a Discord thread and stop its mapped OpenCode session',
  )
  .action(async (threadId: string) => {
    try {
      await initDatabase()

      const { token: botToken } = await resolveBotCredentials()

      const rest = createDiscordRest(botToken)
      const threadData = (await rest.get(Routes.channel(threadId))) as {
        id: string
        type: number
        name?: string
        parent_id?: string
      }

      if (!isThreadChannelType(threadData.type)) {
        cliLogger.error(`Channel is not a thread: ${threadId}`)
        process.exit(EXIT_NO_RESTART)
      }

      const sessionId = await getThreadSession(threadId)
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
          `No mapped OpenCode session found for thread ${threadId}`,
        )
      }

      await archiveThread({
        rest,
        threadId,
        parentChannelId: threadData.parent_id,
        sessionId,
        client,
      })

      const threadLabel = threadData.name || threadId
      note(
        `Archived thread: ${threadLabel}\nThread ID: ${threadId}`,
        '✅ Archived',
      )
      process.exit(0)
    } catch (error) {
      cliLogger.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

cli
  .command(
    'upgrade',
    'Upgrade kimaki to the latest version and restart the running bot',
  )
  .option('--skip-restart', 'Only upgrade, do not restart the running bot')
  .action(async (options) => {
    try {
      const current = getCurrentVersion()
      cliLogger.log(`Current version: v${current}`)

      const newVersion = await upgrade()
      if (!newVersion) {
        cliLogger.log('Already on latest version')
        process.exit(0)
      }

      cliLogger.log(`Upgraded to v${newVersion}`)

      if (options.skipRestart) {
        process.exit(0)
      }

      // Spawn a new kimaki process without args (starts the bot with default command).
      // The new process kills the old one via the single-instance lock.
      // No args passed to avoid recursively running `upgrade` again.
      const child = spawn('kimaki', [], {
        shell: true,
        stdio: 'ignore',
        detached: true,
      })
      child.unref()
      cliLogger.log('Restarting bot with new version...')
      process.exit(0)
    } catch (error) {
      cliLogger.error(
        'Upgrade failed:',
        error instanceof Error ? error.message : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

cli
  .command(
    'worktree merge',
    'Merge worktree branch into default branch using worktrunk-style pipeline',
  )
  .option('-d, --directory <path>', 'Worktree directory (defaults to cwd)')
  .option(
    '-m, --main-repo <path>',
    'Main repository directory (auto-detected from worktree)',
  )
  .option(
    '-n, --name <name>',
    'Worktree/branch name (auto-detected from branch)',
  )
  .action(
    async (options: {
      directory?: string
      mainRepo?: string
      name?: string
    }) => {
      try {
        const { mergeWorktree } = await import('./worktree-utils.js')
        const worktreeDir = path.resolve(options.directory || '.')

        // Auto-detect main repo: find the main worktree's toplevel.
        // For linked worktrees, --git-common-dir points to the shared .git,
        // and the main worktree's toplevel is one level up from that (non-bare)
        // or the dir itself (bare). We use git's worktree list to get the
        // main worktree path reliably.
        let mainRepoDir = options.mainRepo
        if (!mainRepoDir) {
          try {
            // `git worktree list --porcelain` first line is always the main worktree
            const { stdout } = await execAsync(
              `git -C "${worktreeDir}" worktree list --porcelain`,
            )
            const firstLine = stdout.split('\n')[0] || ''
            // Format: "worktree /path/to/main"
            mainRepoDir = firstLine.replace(/^worktree\s+/, '').trim()
          } catch {
            // Fallback: derive from git common dir
            const { stdout: commonDir } = await execAsync(
              `git -C "${worktreeDir}" rev-parse --git-common-dir`,
            )
            const resolved = path.isAbsolute(commonDir.trim())
              ? commonDir.trim()
              : path.resolve(worktreeDir, commonDir.trim())
            mainRepoDir = path.dirname(resolved)
          }
        }

        // Auto-detect branch name if not provided
        let worktreeName = options.name
        if (!worktreeName) {
          try {
            const { stdout } = await execAsync(
              `git -C "${worktreeDir}" symbolic-ref --short HEAD`,
            )
            worktreeName = stdout.trim()
          } catch {
            worktreeName = path.basename(worktreeDir)
          }
        }

        cliLogger.log(`Worktree: ${worktreeDir}`)
        cliLogger.log(`Main repo: ${mainRepoDir}`)
        cliLogger.log(`Branch: ${worktreeName}`)

        const { RebaseConflictError } = await import('./errors.js')

        const result = await mergeWorktree({
          worktreeDir,
          mainRepoDir,
          worktreeName,
          onProgress: (msg) => {
            cliLogger.log(msg)
          },
        })

        if (result instanceof Error) {
          cliLogger.error(`Merge failed: ${result.message}`)
          if (result instanceof RebaseConflictError) {
            cliLogger.log(
              'Resolve the rebase conflicts, then run this command again.',
            )
          }
          process.exit(1)
        }

        cliLogger.log(
          `Merged ${result.branchName} into ${result.defaultBranch} @ ${result.shortSha} (${result.commitCount} commit${result.commitCount === 1 ? '' : 's'})`,
        )
        process.exit(0)
      } catch (error) {
        cliLogger.error(
          'Merge failed:',
          error instanceof Error ? error.message : String(error),
        )
        process.exit(EXIT_NO_RESTART)
      }
    },
  )

cli.version(getCurrentVersion())
cli.help()
cli.parse()
