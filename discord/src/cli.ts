#!/usr/bin/env node
// Main CLI entrypoint for the Kimaki Discord bot.
// Handles interactive setup, Discord OAuth, slash command registration,
// project channel creation, and launching the bot with opencode integration.
import { cac } from '@xmorse/cac'
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
import { deduplicateByKey, generateBotInstallUrl, abbreviatePath } from './utils.js'
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
} from './database.js'
import { formatWorktreeName } from './commands/worktree.js'
import { WORKTREE_PREFIX } from './commands/merge-worktree.js'
import type { ThreadStartMarker } from './system-message.js'
import yaml from 'js-yaml'
import type { OpencodeClient, Command as OpencodeCommand } from '@opencode-ai/sdk'
import {
  Events,
  ChannelType,
  type CategoryChannel,
  type Guild,
  REST,
  Routes,
  SlashCommandBuilder,
  AttachmentBuilder,
} from 'discord.js'
import path from 'node:path'
import fs from 'node:fs'
import * as errore from 'errore'

import { createLogger, LogPrefix } from './logger.js'
import { uploadFilesToDiscord } from './discord-utils.js'
import { spawn, spawnSync, execSync, type ExecSyncOptions } from 'node:child_process'
import http from 'node:http'
import { setDataDir, getDataDir, getLockPort, setDefaultVerbosity, setDefaultMentionMode } from './config.js'
import { sanitizeAgentName } from './commands/agent.js'

const cliLogger = createLogger(LogPrefix.CLI)

// Strip bracketed paste escape sequences from terminal input.
// iTerm2 and other terminals wrap pasted content with \x1b[200~ and \x1b[201~
// which can cause validation to fail on macOS. See: https://github.com/remorses/kimaki/issues/18
function stripBracketedPaste(value: string | undefined): string {
  if (!value) {
    return ''
  }
  return value.replace(/\x1b\[200~/g, '').replace(/\x1b\[201~/g, '').trim()
}

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
    cliLogger.warn('Failed to spawn caffeinate:', err instanceof Error ? err.message : String(err))
  }
}
const cli = cac('kimaki')

process.title = 'kimaki'

async function killProcessOnPort(port: number): Promise<boolean> {
  const isWindows = process.platform === 'win32'
  const myPid = process.pid

  try {
    if (isWindows) {
      // Windows: find PID using netstat, then kill
      const result = spawnSync(
        'cmd',
        [
          '/c',
          `for /f "tokens=5" %a in ('netstat -ano ^| findstr :${port} ^| findstr LISTENING') do @echo %a`,
        ],
        {
          shell: false,
          encoding: 'utf-8',
        },
      )
      const pids = result.stdout
        ?.trim()
        .split('\n')
        .map((p) => p.trim())
        .filter((p) => /^\d+$/.test(p))
      // Filter out our own PID and take the first (oldest)
      const targetPid = pids?.find((p) => parseInt(p, 10) !== myPid)
      if (targetPid) {
        cliLogger.log(`Killing existing kimaki process (PID: ${targetPid})`)
        spawnSync('taskkill', ['/F', '/PID', targetPid], { shell: false })
        return true
      }
    } else {
      // Unix: use lsof with -sTCP:LISTEN to only find the listening process
      const result = spawnSync('lsof', ['-i', `:${port}`, '-sTCP:LISTEN', '-t'], {
        shell: false,
        encoding: 'utf-8',
      })
      const pids = result.stdout
        ?.trim()
        .split('\n')
        .map((p) => p.trim())
        .filter((p) => /^\d+$/.test(p))
      // Filter out our own PID and take the first (oldest)
      const targetPid = pids?.find((p) => parseInt(p, 10) !== myPid)
      if (targetPid) {
        const pid = parseInt(targetPid, 10)
        cliLogger.log(`Stopping existing kimaki process (PID: ${pid})`)
        process.kill(pid, 'SIGKILL')
        return true
      }
    }
  } catch (e) {
    cliLogger.debug(`Failed to kill process on port ${port}:`, e)
  }
  return false
}

async function checkSingleInstance(): Promise<void> {
  const lockPort = getLockPort()
  try {
    const response = await fetch(`http://127.0.0.1:${lockPort}`, {
      signal: AbortSignal.timeout(1000),
    })
    if (response.ok) {
      cliLogger.log(`Another kimaki instance detected for data dir: ${getDataDir()}`)
      await killProcessOnPort(lockPort)
      // Wait a moment for port to be released
      await new Promise((resolve) => {
        setTimeout(resolve, 500)
      })
    }
  } catch (error) {
    cliLogger.debug(
      'Lock port check failed:',
      error instanceof Error ? error.message : String(error),
    )
    cliLogger.debug('No other kimaki instance detected on lock port')
  }
}

async function startLockServer(): Promise<void> {
  const lockPort = getLockPort()
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200)
      res.end('kimaki')
    })
    server.listen(lockPort, '127.0.0.1')
    server.once('listening', () => {
      cliLogger.debug(`Lock server started on port ${lockPort}`)
      resolve()
    })
    server.on('error', async (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        cliLogger.log('Port still in use, retrying...')
        await killProcessOnPort(lockPort)
        await new Promise((r) => {
          setTimeout(r, 500)
        })
        // Retry once
        server.listen(lockPort, '127.0.0.1')
      } else {
        reject(err)
      }
    })
  })
}

const EXIT_NO_RESTART = 64

type Project = {
  id: string
  worktree: string
  vcs?: string
  time: {
    created: number
    initialized?: number
  }
}

type CliOptions = {
  restart?: boolean
  addChannels?: boolean
  dataDir?: string
  useWorktrees?: boolean
  enableVoiceChannels?: boolean
}

// Commands to skip when registering user commands (reserved names)
const SKIP_USER_COMMANDS = ['init']

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
        option.setName('prompt').setDescription('Prompt content for the session').setRequired(true)

        return option
      })
      .addStringOption((option) => {
        option
          .setName('files')
          .setDescription('Files to mention (comma or space separated; autocomplete)')
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
      .setDescription('Create a new git worktree (in thread: uses thread name if no name given)')
      .addStringOption((option) => {
        option
          .setName('name')
          .setDescription('Name for worktree (optional in threads - uses thread name)')
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
      .setDescription('Toggle automatic git worktree creation for new sessions in this channel')
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('toggle-mention-mode')
      .setDescription('Toggle mention-only mode (bot only responds when @mentioned)')
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('add-project')
      .setDescription('Create Discord channels for a project. Use `npx kimaki add-project` for unlisted projects')
      .addStringOption((option) => {
        option
          .setName('project')
          .setDescription('Select a project. Use `npx kimaki add-project` if not listed')
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
      .setDescription('Create a new project folder, initialize git, and start a session')
      .addStringOption((option) => {
        option.setName('name').setDescription('Name for the new project folder').setRequired(true)

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
      .setDescription('Compact the session context by summarizing conversation history')
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
      .setDescription('Authenticate with an AI provider (OAuth or API key). Use this instead of /connect')
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('agent')
      .setDescription('Set the preferred agent for this channel or session')
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('queue')
      .setDescription('Queue a message to be sent after the current response finishes')
      .addStringOption((option) => {
        option.setName('message').setDescription('The message to queue').setRequired(true)

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
            { name: 'tools-and-text (default)', value: 'tools-and-text' },
            { name: 'text-and-essential-tools', value: 'text-and-essential-tools' },
            { name: 'text-only', value: 'text-only' },
          )
        return option
      })
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('restart-opencode-server')
      .setDescription('Restart the opencode server for this channel only (fixes state/auth/plugins)')
      .setDMPermission(false)
      .toJSON(),
  ]

  // Add user-defined commands with -cmd suffix
  for (const cmd of userCommands) {
    if (SKIP_USER_COMMANDS.includes(cmd.name)) {
      continue
    }

    // Sanitize command name: oh-my-opencode uses MCP commands with colons, which Discord doesn't allow
    // Also convert to lowercase since Discord only allows lowercase in command names
    const sanitizedName = cmd.name.toLowerCase().replace(/:/g, '-')
    const commandName = `${sanitizedName}-cmd`
    const description = cmd.description || `Run /${cmd.name} command`

    commands.push(
      new SlashCommandBuilder()
        .setName(commandName.slice(0, 32)) // Discord limits to 32 chars
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
    const commandName = `${sanitizedName}-agent`
    const description = agent.description || `Switch to ${agent.name} agent`

    commands.push(
      new SlashCommandBuilder()
        .setName(commandName.slice(0, 32)) // Discord limits to 32 chars
        .setDescription(description.slice(0, 100))
        .setDMPermission(false)
        .toJSON(),
    )
  }

  const rest = new REST().setToken(token)

  try {
    const data = (await rest.put(Routes.applicationCommands(appId), {
      body: commands,
    })) as any[]

    cliLogger.info(`COMMANDS: Successfully registered ${data.length} slash commands`)
  } catch (error) {
    cliLogger.error('COMMANDS: Failed to register slash commands: ' + String(error))
    throw error
  }
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
          (ch) => ch.type === ChannelType.GuildVoice && ch.name === channel.name,
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
      .map((ch) => `• #${ch.name}: https://discord.com/channels/${ch.guildId}/${ch.id}`)
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
        .command.list({ query: { directory: currentDir } })
        .then((r) => r.data || [])
        .catch((error) => {
          cliLogger.warn(
            'Failed to load user commands during background init:',
            error instanceof Error ? error.message : String(error),
          )
          return []
        }),
      getClient()
        .app.agents({ query: { directory: currentDir } })
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
  }
}

async function run({ restart, addChannels, useWorktrees, enableVoiceChannels }: CliOptions) {
  startCaffeinate()

  const forceSetup = Boolean(restart)

  intro('🤖 Discord Bot Setup')

  // Step 0: Check if OpenCode CLI is available
  // Skip check if user set OPENCODE_PATH (for custom forks like shuvcode)
  if (!process.env.OPENCODE_PATH) {
    const opencodeCheck = spawnSync(
      process.platform === 'win32' ? 'where' : 'which',
      ['opencode'],
      { shell: true }
    )
    if (opencodeCheck.status !== 0) {
    note('OpenCode CLI is required but not found in your PATH.', '⚠️  OpenCode Not Found')

    const shouldInstall = await confirm({
      message: 'Would you like to install OpenCode right now?',
    })

    if (isCancel(shouldInstall) || !shouldInstall) {
      cancel('OpenCode CLI is required to run this bot')
      process.exit(0)
    }

    cliLogger.log('Installing OpenCode CLI...')

    try {
      execSync('curl -fsSL https://opencode.ai/install | bash', {
        stdio: 'inherit',
        shell: '/bin/bash',
      })
      cliLogger.log('OpenCode CLI installed successfully!')

      // The install script adds opencode to PATH via shell configuration
      // For the current process, we need to check common installation paths
      const possiblePaths = [
        `${process.env.HOME}/.local/bin/opencode`,
        `${process.env.HOME}/.opencode/bin/opencode`,
        '/usr/local/bin/opencode',
        '/opt/opencode/bin/opencode',
      ]

      const installedPath = possiblePaths.find((p) => {
        try {
          fs.accessSync(p, fs.constants.F_OK)
          return true
        } catch (error) {
          cliLogger.debug(
            `OpenCode path not found at ${p}:`,
            error instanceof Error ? error.message : String(error),
          )
          return false
        }
      })

      if (!installedPath) {
        note(
          'OpenCode was installed but may not be available in this session.\n' +
            'Please restart your terminal and run this command again.',
          '⚠️  Restart Required',
        )
        process.exit(0)
      }

      // For subsequent spawn calls in this session, we can use the full path
      process.env.OPENCODE_PATH = installedPath
    } catch (error) {
      cliLogger.log('Failed to install OpenCode CLI')
      cliLogger.error('Installation error:', error instanceof Error ? error.message : String(error))
      process.exit(EXIT_NO_RESTART)
    }
    }
  }

  // Initialize database
  await initDatabase()
  
  let appId: string
  let token: string

  const existingBot = await getBotToken()

  const shouldAddChannels = !existingBot?.token || forceSetup || Boolean(addChannels)

  if (existingBot && !forceSetup) {
    appId = existingBot.app_id
    token = existingBot.token

    note(
      `Using saved bot credentials:\nApp ID: ${appId}\n\nTo use different credentials, run with --restart`,
      'Existing Bot Found',
    )

    note(
      `Bot install URL (in case you need to add it to another server):\n${generateBotInstallUrl({ clientId: appId })}`,
      'Install URL',
    )
  } else {
    if (forceSetup && existingBot) {
      note('Ignoring saved credentials due to --restart flag', 'Restart Setup')
    }

    note(
      '1. Go to https://discord.com/developers/applications\n' +
        '2. Click "New Application"\n' +
        '3. Give your application a name\n' +
        '4. Copy the Application ID from the "General Information" section',
      'Step 1: Create Discord Application',
    )

    const appIdInput = await text({
      message: 'Enter your Discord Application ID:',
      placeholder: 'e.g., 1234567890123456789',
      validate(value) {
        const cleaned = stripBracketedPaste(value)
        if (!cleaned) {
          return 'Application ID is required'
        }
        if (!/^\d{17,20}$/.test(cleaned)) {
          return 'Invalid Application ID format (should be 17-20 digits)'
        }
      },
    })

    if (isCancel(appIdInput)) {
      cancel('Setup cancelled')
      process.exit(0)
    }
    appId = stripBracketedPaste(appIdInput)

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
      message: 'Enter your Discord Bot Token (from "Bot" section - click "Reset Token" if needed):',
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
    token = stripBracketedPaste(tokenInput)

    await setBotToken(appId, token)

    note(
      `Bot install URL:\n${generateBotInstallUrl({ clientId: appId })}\n\nYou MUST install the bot in your Discord server before continuing.`,
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
  }

  // Start OpenCode server EARLY - let it initialize in parallel with Discord login.
  // This is the biggest startup bottleneck (can take 1-30 seconds to spawn and wait for ready)
  const currentDir = process.cwd()
  cliLogger.log('Starting OpenCode server...')
  const opencodePromise = initializeOpencodeForDirectory(currentDir).then((result) => {
    if (result instanceof Error) {
      throw new Error(result.message)
    }
    return result
  })

  cliLogger.log('Connecting to Discord...')
  const discordClient = await createDiscordClient()

  const guilds: Guild[] = []
  const kimakiChannels: { guild: Guild; channels: ChannelWithTags[] }[] = []
  const createdChannels: { name: string; id: string; guildId: string }[] = []

  try {
    await new Promise((resolve, reject) => {
      discordClient.once(Events.ClientReady, async (c) => {
        guilds.push(...Array.from(c.guilds.cache.values()))

        // Process all guilds in parallel for faster startup
        const guildResults = await Promise.all(
          guilds.map(async (guild) => {
            // Create Kimaki role if it doesn't exist, or fix its position (fire-and-forget)
            guild.roles
              .fetch()
              .then(async (roles) => {
                const existingRole = roles.find((role) => role.name.toLowerCase() === 'kimaki')
                if (existingRole) {
                  // Move to bottom if not already there
                  if (existingRole.position > 1) {
                    await existingRole.setPosition(1)
                    cliLogger.info(`Moved "Kimaki" role to bottom in ${guild.name}`)
                  }
                  return
                }
                return guild.roles.create({
                  name: 'Kimaki',
                  position: 1, // Place at bottom so anyone with Manage Roles can assign it
                  reason:
                    'Kimaki bot permission role - assign to users who can start sessions, send messages in threads, and use voice features',
                })
              })
              .then((role) => {
                if (role) {
                  cliLogger.info(`Created "Kimaki" role in ${guild.name}`)
                }
              })
              .catch((error) => {
                cliLogger.warn(
                  `Could not create Kimaki role in ${guild.name}: ${error instanceof Error ? error.message : String(error)}`,
                )
              })

            const channels = await getChannelsWithDescriptions(guild)
            const kimakiChans = channels.filter(
              (ch) => ch.kimakiDirectory && (!ch.kimakiApp || ch.kimakiApp === appId),
            )

            return { guild, channels: kimakiChans }
          }),
        )

        // Collect results
        for (const result of guildResults) {
          if (result.channels.length > 0) {
            kimakiChannels.push(result)
          }
        }

        resolve(null)
      })

      discordClient.once(Events.Error, reject)

      discordClient.login(token).catch(reject)
    })

    cliLogger.log('Connected to Discord!')
  } catch (error) {
    cliLogger.log('Failed to connect to Discord')
    cliLogger.error('Error: ' + (error instanceof Error ? error.message : String(error)))
    process.exit(EXIT_NO_RESTART)
  }
  await setBotToken(appId, token)

  // Store channel-directory mappings
  await storeChannelDirectories({ kimakiChannels })

  if (kimakiChannels.length > 0) {
    const channelList = kimakiChannels
      .flatMap(({ guild, channels }) =>
        channels.map((ch) => {
          const appInfo =
            ch.kimakiApp === appId ? ' (this bot)' : ch.kimakiApp ? ` (app: ${ch.kimakiApp})` : ''
          return `#${ch.name} in ${guild.name}: ${ch.kimakiDirectory}${appInfo}`
        }),
      )
      .join('\n')

    note(channelList, 'Existing Kimaki Channels')
  }

  // Quick start: if setup is already done, start bot immediately and background the rest
  const isQuickStart = existingBot && !forceSetup && !addChannels
  if (isQuickStart) {
    cliLogger.log('Starting Discord bot...')
    await startDiscordBot({ token, appId, discordClient, useWorktrees })
    cliLogger.log('Discord bot is running!')

    // Background: OpenCode init + slash command registration (non-blocking)
    void backgroundInit({ currentDir, token, appId })

    showReadyMessage({ kimakiChannels, createdChannels, appId })
    outro('✨ Bot ready! Listening for messages...')
    return
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
      .project.list({})
      .then((r) => r.data || [])
      .catch((error) => {
        cliLogger.log('Failed to fetch projects')
        cliLogger.error('Error:', error instanceof Error ? error.message : String(error))
        discordClient.destroy()
        process.exit(EXIT_NO_RESTART)
      }),
    getClient()
      .command.list({ query: { directory: currentDir } })
      .then((r) => r.data || [])
      .catch((error) => {
        cliLogger.warn(
          'Failed to load user commands during setup:',
          error instanceof Error ? error.message : String(error),
        )
        return []
      }),
    getClient()
      .app.agents({ query: { directory: currentDir } })
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
    note('All OpenCode projects already have Discord channels', 'No New Projects')
  }

  if ((!existingDirs?.length && availableProjects.length > 0) || shouldAddChannels) {
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
        note(createdChannels.map((ch) => `#${ch.name}`).join('\n'), 'Created Channels')
      }
    }
  }

  // Log available user commands
  const registrableCommands = allUserCommands.filter(
    (cmd) => !SKIP_USER_COMMANDS.includes(cmd.name),
  )

  if (registrableCommands.length > 0) {
    const commandList = registrableCommands
      .map((cmd) => `  /${cmd.name}-cmd - ${cmd.description || 'No description'}`)
      .join('\n')

    note(
      `Found ${registrableCommands.length} user-defined command(s):\n${commandList}`,
      'OpenCode Commands',
    )
  }

  cliLogger.log('Registering slash commands asynchronously...')
  void registerCommands({ token, appId, userCommands: allUserCommands, agents: allAgents })
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
  outro('✨ Setup complete! Listening for new messages... do not close this process.')
}

cli
  .command('', 'Set up and run the Kimaki Discord bot')
  .option('--restart', 'Prompt for new credentials even if saved')
  .option('--add-channels', 'Select OpenCode projects to create Discord channels before starting')
  .option('--data-dir <path>', 'Data directory for config and database (default: ~/.kimaki)')
  .option('--install-url', 'Print the bot install URL and exit')
  .option('--use-worktrees', 'Create git worktrees for all new sessions started from channel messages')
  .option('--enable-voice-channels', 'Create voice channels for projects (disabled by default)')
  .option('--verbosity <level>', 'Default verbosity for all channels (tools-and-text, text-and-essential-tools, or text-only)')
  .option('--mention-mode', 'Bot only responds when @mentioned (default for all channels)')
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
    }) => {
      try {
        // Set data directory early, before any database access
        if (options.dataDir) {
          setDataDir(options.dataDir)
          cliLogger.log(`Using data directory: ${getDataDir()}`)
        }

        if (options.verbosity) {
          const validLevels = ['tools-and-text', 'text-and-essential-tools', 'text-only']
          if (!validLevels.includes(options.verbosity)) {
            cliLogger.error(`Invalid verbosity level: ${options.verbosity}. Use one of: ${validLevels.join(', ')}`)
            process.exit(EXIT_NO_RESTART)
          }
          setDefaultVerbosity(options.verbosity as 'tools-and-text' | 'text-and-essential-tools' | 'text-only')
          cliLogger.log(`Default verbosity: ${options.verbosity}`)
        }

        if (options.mentionMode) {
          setDefaultMentionMode(true)
          cliLogger.log('Default mention mode: enabled (bot only responds when @mentioned)')
        }

        if (options.installUrl) {
          await initDatabase()
          const existingBot = await getBotToken()

          if (!existingBot) {
            cliLogger.error('No bot configured yet. Run `kimaki` first to set up.')
            process.exit(EXIT_NO_RESTART)
          }

          cliLogger.log(generateBotInstallUrl({ clientId: existingBot.app_id }))
          process.exit(0)
        }

        await checkSingleInstance()
        await startLockServer()
        await run({
          restart: options.restart,
          addChannels: options.addChannels,
          dataDir: options.dataDir,
          useWorktrees: options.useWorktrees,
          enableVoiceChannels: options.enableVoiceChannels,
        })
      } catch (error) {
        cliLogger.error('Unhandled error:', error instanceof Error ? error.message : String(error))
        process.exit(EXIT_NO_RESTART)
      }
    },
  )

cli
  .command('upload-to-discord [...files]', 'Upload files to a Discord thread for a session')
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
        cliLogger.error('No bot credentials found. Run `kimaki` first to set up the bot.')
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
      cliLogger.error('Error:', error instanceof Error ? error.message : String(error))
      process.exit(EXIT_NO_RESTART)
    }
  })



cli
  .command(
    'send',
    'Send a message to Discord channel, creating a thread. Use --notify-only to skip AI session.',
  )
  .alias('start-session') // backwards compatibility
  .option('-c, --channel <channelId>', 'Discord channel ID')
  .option('-d, --project <path>', 'Project directory (alternative to --channel)')
  .option('-p, --prompt <prompt>', 'Message content')
  .option('-n, --name [name]', 'Thread name (optional, defaults to prompt preview)')
  .option('-a, --app-id [appId]', 'Bot application ID (required if no local database)')
  .option('--notify-only', 'Create notification thread without starting AI session')
  .option('--worktree [name]', 'Create git worktree for session (name optional, derives from thread name)')
  .option('-u, --user <username>', 'Discord username to add to thread')
  .option('--agent <agent>', 'Agent to use for the session')
  .option('--model <model>', 'Model to use (format: provider/model)')
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
    }) => {
      try {
        let { channel: channelId, prompt, name, appId: optionAppId, notifyOnly } = options
        const { project: projectPath } = options

        // Get raw channel ID from argv to prevent JS number precision loss on large Discord IDs
        // cac parses large numbers and loses precision, so we extract the original string value
        if (channelId) {
          const channelArgIndex = process.argv.findIndex((arg) => arg === '--channel' || arg === '-c')
          if (channelArgIndex !== -1 && process.argv[channelArgIndex + 1]) {
            channelId = process.argv[channelArgIndex + 1]
          }
        }

        if (!channelId && !projectPath) {
          cliLogger.error('Either --channel or --project is required')
          process.exit(EXIT_NO_RESTART)
        }

        if (!prompt) {
          cliLogger.error('Prompt is required. Use --prompt <prompt>')
          process.exit(EXIT_NO_RESTART)
        }

        if (options.worktree && notifyOnly) {
          cliLogger.error('Cannot use --worktree with --notify-only')
          process.exit(EXIT_NO_RESTART)
        }

      // Get bot token from env var or database
      const envToken = process.env.KIMAKI_BOT_TOKEN
      let botToken: string | undefined
      let appId: string | undefined = optionAppId

      // Initialize database first
      await initDatabase()

      if (envToken) {
        botToken = envToken
        if (!appId) {
          // Try to get app_id from database if available (optional in CI)
          try {
            const botRow = await getBotToken()
            appId = botRow?.app_id
          } catch (error) {
            cliLogger.debug(
              'Database lookup failed while resolving app ID:',
              error instanceof Error ? error.message : String(error),
            )
          }
        }
      } else {
        // Fall back to database
        try {
          const botRow = await getBotToken()

          if (botRow) {
            botToken = botRow.token
            appId = appId || botRow.app_id
          }
        } catch (e) {
          // Database error - will fall through to the check below
          cliLogger.error('Database error:', e instanceof Error ? e.message : String(e))
        }
      }

      if (!botToken) {
        cliLogger.error(
          'No bot token found. Set KIMAKI_BOT_TOKEN env var or run `kimaki` first to set up.',
        )
        process.exit(EXIT_NO_RESTART)
      }

      // If --project provided, resolve to channel ID
      if (projectPath) {
        const absolutePath = path.resolve(projectPath)

        if (!fs.existsSync(absolutePath)) {
          cliLogger.error(`Directory does not exist: ${absolutePath}`)
          process.exit(EXIT_NO_RESTART)
        }

        cliLogger.log('Looking up channel for project...')

        // Check if channel already exists for this directory or a parent directory
        // This allows running from subfolders of a registered project
        try {
          // Helper to find channel for a path (prefers current bot's channel)
          const findChannelForPath = async (dirPath: string): Promise<{ channel_id: string; directory: string } | undefined> => {
            const withAppId = appId ? await findChannelsByDirectory({ directory: dirPath, channelType: 'text', appId }) : []
            if (withAppId.length > 0) {
              return withAppId[0]
            }

            const withoutAppId = await findChannelsByDirectory({ directory: dirPath, channelType: 'text' })
            return withoutAppId[0]
          }

          // Try exact match first, then walk up parent directories
          let existingChannel: { channel_id: string; directory: string } | undefined
          let searchPath = absolutePath
          while (searchPath !== path.dirname(searchPath)) {
            existingChannel = await findChannelForPath(searchPath)
            if (existingChannel) break
            searchPath = path.dirname(searchPath)
          }

          if (existingChannel) {
            channelId = existingChannel.channel_id
            if (existingChannel.directory !== absolutePath) {
              cliLogger.log(`Found parent project channel: ${existingChannel.directory}`)
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
              const existingChannelId = appId ? await findChannelByAppId(appId) : undefined

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
                throw new Error('No guild found. Add the bot to a server first.')
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

      cliLogger.log('Fetching channel info...')

      if (!channelId) {
        throw new Error('Channel ID not resolved')
      }

      const rest = new REST().setToken(botToken)

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
      const resolvedUser = await (async (): Promise<{ id: string; username: string } | undefined> => {
        if (!options.user) {
          return undefined
        }
        cliLogger.log(`Searching for user "${options.user}" in guild...`)
        const searchResults = (await rest.get(Routes.guildMembersSearch(channelData.guild_id), {
          query: new URLSearchParams({ query: options.user, limit: '10' }),
        })) as Array<{ user: { id: string; username: string; global_name?: string }; nick?: string }>

        // Find exact match by display name, nickname, or username
        const exactMatch = searchResults.find((member) => {
          const displayName = member.nick || member.user.global_name || member.user.username
          return (
            displayName.toLowerCase() === options.user!.toLowerCase() ||
            member.user.username.toLowerCase() === options.user!.toLowerCase()
          )
        })
        const member = exactMatch || searchResults[0]
        if (!member) {
          throw new Error(`User "${options.user}" not found in guild`)
        }
        const username = member.nick || member.user.global_name || member.user.username
        cliLogger.log(`Found user: ${username} (${member.user.id})`)
        return { id: member.user.id, username }
      })()

      cliLogger.log('Creating starter message...')

      // Discord has a 2000 character limit for messages.
      // If prompt exceeds this, send it as a file attachment instead.
      const DISCORD_MAX_LENGTH = 2000
      let starterMessage: { id: string }

      // Compute thread name and worktree name early (needed for embed)
      const baseThreadName = name || (prompt.length > 80 ? prompt.slice(0, 77) + '...' : prompt)
      const worktreeName = options.worktree
        ? formatWorktreeName(typeof options.worktree === 'string' ? options.worktree : baseThreadName)
        : undefined
      const threadName = worktreeName
        ? `${WORKTREE_PREFIX}${baseThreadName}`
        : baseThreadName

      // Embed marker for auto-start sessions (unless --notify-only)
      // Bot parses this YAML to know it should start a session, optionally create a worktree, and set initial user
      const embedMarker: ThreadStartMarker | undefined = notifyOnly
        ? undefined
        : {
            start: true,
            ...(worktreeName && { worktree: worktreeName }),
            ...(resolvedUser && { username: resolvedUser.username, userId: resolvedUser.id }),
            ...(options.agent && { agent: options.agent }),
            ...(options.model && { model: options.model }),
          }
      const autoStartEmbed = embedMarker
        ? [{ color: 0x2b2d31, footer: { text: yaml.dump(embedMarker) } }]
        : undefined

      if (prompt.length > DISCORD_MAX_LENGTH) {
        // Send as file attachment with a short summary
        const preview = prompt.slice(0, 100).replace(/\n/g, ' ')
        const summaryContent = `📄 **Prompt attached as file** (${prompt.length} chars)\n\n> ${preview}...`

        // Write prompt to a temp file
        const tmpDir = path.join(process.cwd(), 'tmp')
        if (!fs.existsSync(tmpDir)) {
          fs.mkdirSync(tmpDir, { recursive: true })
        }
        const tmpFile = path.join(tmpDir, `prompt-${Date.now()}.md`)
        fs.writeFileSync(tmpFile, prompt)

        try {
          // Using raw fetch for file uploads because discord.js REST client
          // doesn't handle FormData/multipart file attachments correctly
          const formData = new FormData()
          formData.append(
            'payload_json',
            JSON.stringify({
              content: summaryContent,
              attachments: [{ id: 0, filename: 'prompt.md' }],
              embeds: autoStartEmbed,
            }),
          )
          const buffer = fs.readFileSync(tmpFile)
          formData.append('files[0]', new Blob([buffer], { type: 'text/markdown' }), 'prompt.md')

          const starterMessageResponse = await fetch(
            `https://discord.com/api/v10/channels/${channelId}/messages`,
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
            cliLogger.log('Failed to create message')
            throw new Error(`Discord API error: ${starterMessageResponse.status} - ${error}`)
          }

          starterMessage = (await starterMessageResponse.json()) as { id: string }
        } finally {
          // Clean up temp file
          fs.unlinkSync(tmpFile)
        }
      } else {
        // Normal case: send prompt inline
        starterMessage = (await rest.post(Routes.channelMessages(channelId), {
          body: { content: prompt, embeds: autoStartEmbed },
        })) as { id: string }
      }

      cliLogger.log('Creating thread...')

      const threadData = (await rest.post(Routes.threads(channelId, starterMessage.id), {
        body: {
          name: threadName.slice(0, 100),
          auto_archive_duration: 1440, // 1 day
        },
      })) as { id: string; name: string }

      cliLogger.log('Thread created!')

      // Add user to thread if specified
      if (resolvedUser) {
        cliLogger.log(`Adding user ${resolvedUser.username} to thread...`)
        await rest.put(Routes.threadMembers(threadData.id, resolvedUser.id))
      }

      const threadUrl = `https://discord.com/channels/${channelData.guild_id}/${threadData.id}`

      const worktreeNote = worktreeName ? `\nWorktree: ${worktreeName} (will be created by bot)` : ''
      const successMessage = notifyOnly
        ? `Thread: ${threadData.name}\nDirectory: ${projectDirectory}\n\nNotification created. Reply to start a session.\n\nURL: ${threadUrl}`
        : `Thread: ${threadData.name}\nDirectory: ${projectDirectory}${worktreeNote}\n\nThe running bot will pick this up and start the session.\n\nURL: ${threadUrl}`

      note(successMessage, '✅ Thread Created')

      cliLogger.log(threadUrl)

      process.exit(0)
    } catch (error) {
      cliLogger.error('Error:', error instanceof Error ? error.message : String(error))
      process.exit(EXIT_NO_RESTART)
    }
  })

cli
  .command('add-project [directory]', 'Create Discord channels for a project directory (e.g. ./folder)')
  .option('-g, --guild <guildId>', 'Discord guild/server ID (auto-detects if bot is in only one server)')
  .option('-a, --app-id <appId>', 'Bot application ID (reads from database if available)')
  .action(
    async (
      directory: string | undefined,
      options: {
        guild?: string
        appId?: string
      },
    ) => {
      try {
        const absolutePath = path.resolve(directory || '.')

        if (!fs.existsSync(absolutePath)) {
          cliLogger.error(`Directory does not exist: ${absolutePath}`)
          process.exit(EXIT_NO_RESTART)
        }

        // Initialize database
        await initDatabase()

        // Get bot token from env var or database
        const envToken = process.env.KIMAKI_BOT_TOKEN
        let botToken: string | undefined
        let appId: string | undefined = options.appId

        if (envToken) {
          botToken = envToken
          if (!appId) {
            try {
              const botRow = await getBotToken()
              appId = botRow?.app_id
            } catch (error) {
              cliLogger.debug(
                'Database lookup failed while resolving app ID:',
                error instanceof Error ? error.message : String(error),
              )
            }
          }
        } else {
          try {
            const botRow = await getBotToken()

            if (botRow) {
              botToken = botRow.token
              appId = appId || botRow.app_id
            }
          } catch (e) {
            cliLogger.error('Database error:', e instanceof Error ? e.message : String(e))
          }
        }

        if (!botToken) {
          cliLogger.error(
            'No bot token found. Set KIMAKI_BOT_TOKEN env var or run `kimaki` first to set up.',
          )
          process.exit(EXIT_NO_RESTART)
        }

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
          // Get raw guild ID from argv to avoid cac's number coercion losing precision on large IDs
          const guildArgIndex = process.argv.findIndex((arg) => arg === '-g' || arg === '--guild')
          const rawGuildArg = guildArgIndex >= 0 ? process.argv[guildArgIndex + 1] : undefined
          const guildId = rawGuildArg || String(options.guild)
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
                cliLogger.log('Channel already exists')
                note(
                  `Channel already exists for this directory in ${guild.name}.\n\nChannel: <#${existingChannel.channel_id}>\nDirectory: ${absolutePath}`,
                  '⚠️  Already Exists',
                )
                client.destroy()
                process.exit(0)
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

        const { textChannelId, voiceChannelId, channelName } = await createProjectChannels({
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
      } catch (error) {
        cliLogger.error('Error:', error instanceof Error ? error.message : String(error))
        process.exit(EXIT_NO_RESTART)
      }
    },
  )

cli
  .command('tunnel', 'Expose a local port via tunnel')
  .option('-p, --port <port>', 'Local port to expose (required)')
  .option('-t, --tunnel-id [id]', 'Tunnel ID (random if omitted)')
  .option('-h, --host [host]', 'Local host (default: localhost)')
  .option('-s, --server [url]', 'Tunnel server URL')
  .action(
    async (options: {
      port?: string
      tunnelId?: string
      host?: string
      server?: string
    }) => {
      const { runTunnel, parseCommandFromArgv, CLI_NAME } = await import('traforo/run-tunnel')

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
    }
  )

cli
  .command('sqlitedb', 'Show the location of the SQLite database file')
  .action(() => {
    const dataDir = getDataDir()
    const dbPath = path.join(dataDir, 'discord-sessions.db')
    cliLogger.log(dbPath)
  })

cli.help()
cli.parse()
