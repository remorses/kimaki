#!/usr/bin/env node
// Main CLI entrypoint for the Kimaki Discord bot.
// Handles interactive setup, Discord OAuth, slash command registration,
// project channel creation, and launching the bot with opencode integration.
import { cac } from 'cac'
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
  spinner,
} from '@clack/prompts'
import { deduplicateByKey, generateBotInstallUrl, abbreviatePath } from './utils.js'
import {
  getChannelsWithDescriptions,
  createDiscordClient,
  getDatabase,
  startDiscordBot,
  initializeOpencodeForDirectory,
  ensureKimakiCategory,
  createProjectChannels,
  type ChannelWithTags,
} from './discord-bot.js'
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

import { createLogger } from './logger.js'
import { spawn, spawnSync, execSync, type ExecSyncOptions } from 'node:child_process'
import http from 'node:http'
import { setDataDir, getDataDir, getLockPort } from './config.js'
import { extractTagsArrays } from './xml.js'
import { sanitizeAgentName } from './commands/agent.js'

const cliLogger = createLogger('CLI')
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
  } catch {
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
      .toJSON(),
    new SlashCommandBuilder()
      .setName('session')
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
      .toJSON(),
    new SlashCommandBuilder()
      .setName('add-project')
      .setDescription('Create Discord channels for a new OpenCode project')
      .addStringOption((option) => {
        option
          .setName('project')
          .setDescription('Select an OpenCode project')
          .setRequired(true)
          .setAutocomplete(true)

        return option
      })
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
      .toJSON(),
    new SlashCommandBuilder()
      .setName('create-new-project')
      .setDescription('Create a new project folder, initialize git, and start a session')
      .addStringOption((option) => {
        option.setName('name').setDescription('Name for the new project folder').setRequired(true)

        return option
      })
      .toJSON(),
    new SlashCommandBuilder()
      .setName('abort')
      .setDescription('Abort the current OpenCode request in this thread')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('stop')
      .setDescription('Abort the current OpenCode request in this thread')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('share')
      .setDescription('Share the current session as a public URL')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('fork')
      .setDescription('Fork the session from a past user message')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('model')
      .setDescription('Set the preferred model for this channel or session')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('agent')
      .setDescription('Set the preferred agent for this channel or session')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('queue')
      .setDescription('Queue a message to be sent after the current response finishes')
      .addStringOption((option) => {
        option.setName('message').setDescription('The message to queue').setRequired(true)

        return option
      })
      .toJSON(),
    new SlashCommandBuilder()
      .setName('clear-queue')
      .setDescription('Clear all queued messages in this thread')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('undo')
      .setDescription('Undo the last assistant message (revert file changes)')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('redo')
      .setDescription('Redo previously undone changes')
      .toJSON(),
  ]

  // Add user-defined commands with -cmd suffix
  for (const cmd of userCommands) {
    if (SKIP_USER_COMMANDS.includes(cmd.name)) {
      continue
    }

    // Sanitize command name: oh-my-opencode uses MCP commands with colons, which Discord doesn't allow
    const sanitizedName = cmd.name.replace(/:/g, '-')
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

async function run({ restart, addChannels }: CliOptions) {
  const forceSetup = Boolean(restart)

  intro('🤖 Discord Bot Setup')

  // Step 0: Check if OpenCode CLI is available
  const opencodeCheck = spawnSync('which', ['opencode'], { shell: true })

  if (opencodeCheck.status !== 0) {
    note('OpenCode CLI is required but not found in your PATH.', '⚠️  OpenCode Not Found')

    const shouldInstall = await confirm({
      message: 'Would you like to install OpenCode right now?',
    })

    if (isCancel(shouldInstall) || !shouldInstall) {
      cancel('OpenCode CLI is required to run this bot')
      process.exit(0)
    }

    const s = spinner()
    s.start('Installing OpenCode CLI...')

    try {
      execSync('curl -fsSL https://opencode.ai/install | bash', {
        stdio: 'inherit',
        shell: '/bin/bash',
      })
      s.stop('OpenCode CLI installed successfully!')

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
        } catch {
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
      s.stop('Failed to install OpenCode CLI')
      cliLogger.error('Installation error:', error instanceof Error ? error.message : String(error))
      process.exit(EXIT_NO_RESTART)
    }
  }

  const db = getDatabase()
  let appId: string
  let token: string

  const existingBot = db
    .prepare('SELECT app_id, token FROM bot_tokens ORDER BY created_at DESC LIMIT 1')
    .get() as { app_id: string; token: string } | undefined

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
        if (!value) return 'Application ID is required'
        if (!/^\d{17,20}$/.test(value))
          return 'Invalid Application ID format (should be 17-20 digits)'
      },
    })

    if (isCancel(appIdInput)) {
      cancel('Setup cancelled')
      process.exit(0)
    }
    appId = appIdInput

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
        if (!value) return 'Bot token is required'
        if (value.length < 50) return 'Invalid token format (too short)'
      },
    })

    if (isCancel(tokenInput)) {
      cancel('Setup cancelled')
      process.exit(0)
    }
    token = tokenInput

    note(`You can get a Gemini api Key at https://aistudio.google.com/apikey`, `Gemini API Key`)

    const geminiApiKey = await password({
      message:
        'Enter your Gemini API Key for voice channels and audio transcription (optional, press Enter to skip):',
      validate(value) {
        if (value && value.length < 10) return 'Invalid API key format'
        return undefined
      },
    })

    if (isCancel(geminiApiKey)) {
      cancel('Setup cancelled')
      process.exit(0)
    }

    // Store API key in database
    if (geminiApiKey) {
      db.prepare('INSERT OR REPLACE INTO bot_api_keys (app_id, gemini_api_key) VALUES (?, ?)').run(
        appId,
        geminiApiKey || null,
      )
      note('API key saved successfully', 'API Key Stored')
    }

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

  const s = spinner()

  // Start OpenCode server EARLY - let it initialize in parallel with Discord login.
  // This is the biggest startup bottleneck (can take 1-30 seconds to spawn and wait for ready)
  const currentDir = process.cwd()
  s.start('Starting OpenCode server...')
  const opencodePromise = initializeOpencodeForDirectory(currentDir)

  s.message('Connecting to Discord...')
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

    s.stop('Connected to Discord!')
  } catch (error) {
    s.stop('Failed to connect to Discord')
    cliLogger.error('Error: ' + (error instanceof Error ? error.message : String(error)))
    process.exit(EXIT_NO_RESTART)
  }
  db.prepare('INSERT OR REPLACE INTO bot_tokens (app_id, token) VALUES (?, ?)').run(appId, token)

  for (const { guild, channels } of kimakiChannels) {
    for (const channel of channels) {
      if (channel.kimakiDirectory) {
        db.prepare(
          'INSERT OR IGNORE INTO channel_directories (channel_id, directory, channel_type, app_id) VALUES (?, ?, ?, ?)',
        ).run(channel.id, channel.kimakiDirectory, 'text', channel.kimakiApp || null)

        const voiceChannel = guild.channels.cache.find(
          (ch) => ch.type === ChannelType.GuildVoice && ch.name === channel.name,
        )

        if (voiceChannel) {
          db.prepare(
            'INSERT OR IGNORE INTO channel_directories (channel_id, directory, channel_type, app_id) VALUES (?, ?, ?, ?)',
          ).run(voiceChannel.id, channel.kimakiDirectory, 'voice', channel.kimakiApp || null)
        }
      }
    }
  }

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

  // Await the OpenCode server that was started in parallel with Discord login
  s.start('Waiting for OpenCode server...')
  const getClient = await opencodePromise
  s.stop('OpenCode server ready!')

  s.start('Fetching OpenCode data...')

  // Fetch projects, commands, and agents in parallel
  const [projects, allUserCommands, allAgents] = await Promise.all([
    getClient()
      .project.list({})
      .then((r) => r.data || [])
      .catch((error) => {
        s.stop('Failed to fetch projects')
        cliLogger.error('Error:', error instanceof Error ? error.message : String(error))
        discordClient.destroy()
        process.exit(EXIT_NO_RESTART)
      }),
    getClient()
      .command.list({ query: { directory: currentDir } })
      .then((r) => r.data || [])
      .catch(() => []),
    getClient()
      .app.agents({ query: { directory: currentDir } })
      .then((r) => r.data || [])
      .catch(() => []),
  ])

  s.stop(`Found ${projects.length} OpenCode project(s)`)

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

      s.start('Creating Discord channels...')

      for (const projectId of selectedProjects) {
        const project = projects.find((p) => p.id === projectId)
        if (!project) continue

        try {
          const { textChannelId, channelName } = await createProjectChannels({
            guild: targetGuild,
            projectDirectory: project.worktree,
            appId,
            botName: discordClient.user?.username,
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

      s.stop(`Created ${createdChannels.length} channel(s)`)

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

  s.start('Starting Discord bot...')
  await startDiscordBot({ token, appId, discordClient })
  s.stop('Discord bot is running!')

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

  outro('✨ Setup complete! Listening for new messages... do not close this process.')
}

cli
  .command('', 'Set up and run the Kimaki Discord bot')
  .option('--restart', 'Prompt for new credentials even if saved')
  .option('--add-channels', 'Select OpenCode projects to create Discord channels before starting')
  .option('--data-dir <path>', 'Data directory for config and database (default: ~/.kimaki)')
  .option('--install-url', 'Print the bot install URL and exit')
  .action(
    async (options: {
      restart?: boolean
      addChannels?: boolean
      dataDir?: string
      installUrl?: boolean
    }) => {
      try {
        // Set data directory early, before any database access
        if (options.dataDir) {
          setDataDir(options.dataDir)
          cliLogger.log(`Using data directory: ${getDataDir()}`)
        }

        if (options.installUrl) {
          const db = getDatabase()
          const existingBot = db
            .prepare('SELECT app_id FROM bot_tokens ORDER BY created_at DESC LIMIT 1')
            .get() as { app_id: string } | undefined

          if (!existingBot) {
            cliLogger.error('No bot configured yet. Run `kimaki` first to set up.')
            process.exit(EXIT_NO_RESTART)
          }

          console.log(generateBotInstallUrl({ clientId: existingBot.app_id }))
          process.exit(0)
        }

        await checkSingleInstance()
        await startLockServer()
        await run({
          restart: options.restart,
          addChannels: options.addChannels,
          dataDir: options.dataDir,
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

      const db = getDatabase()

      const threadRow = db
        .prepare('SELECT thread_id FROM thread_sessions WHERE session_id = ?')
        .get(sessionId) as { thread_id: string } | undefined

      if (!threadRow) {
        cliLogger.error(`No Discord thread found for session: ${sessionId}`)
        process.exit(EXIT_NO_RESTART)
      }

      const botRow = db
        .prepare('SELECT app_id, token FROM bot_tokens ORDER BY created_at DESC LIMIT 1')
        .get() as { app_id: string; token: string } | undefined

      if (!botRow) {
        cliLogger.error('No bot credentials found. Run `kimaki` first to set up the bot.')
        process.exit(EXIT_NO_RESTART)
      }

      const s = spinner()
      s.start(`Uploading ${resolvedFiles.length} file(s)...`)

      for (const file of resolvedFiles) {
        const buffer = fs.readFileSync(file)

        const formData = new FormData()
        formData.append(
          'payload_json',
          JSON.stringify({
            attachments: [{ id: 0, filename: path.basename(file) }],
          }),
        )
        formData.append('files[0]', new Blob([buffer]), path.basename(file))

        const response = await fetch(
          `https://discord.com/api/v10/channels/${threadRow.thread_id}/messages`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bot ${botRow.token}`,
            },
            body: formData,
          },
        )

        if (!response.ok) {
          const error = await response.text()
          throw new Error(`Discord API error: ${response.status} - ${error}`)
        }
      }

      s.stop(`Uploaded ${resolvedFiles.length} file(s)!`)

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
  .action(
    async (options: {
      channel?: string
      project?: string
      prompt?: string
      name?: string
      appId?: string
      notifyOnly?: boolean
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

      // Get bot token from env var or database
      const envToken = process.env.KIMAKI_BOT_TOKEN
      let botToken: string | undefined
      let appId: string | undefined = optionAppId

      if (envToken) {
        botToken = envToken
        if (!appId) {
          // Try to get app_id from database if available (optional in CI)
          try {
            const db = getDatabase()
            const botRow = db
              .prepare('SELECT app_id FROM bot_tokens ORDER BY created_at DESC LIMIT 1')
              .get() as { app_id: string } | undefined
            appId = botRow?.app_id
          } catch {
            // Database might not exist in CI, that's ok
          }
        }
      } else {
        // Fall back to database
        try {
          const db = getDatabase()
          const botRow = db
            .prepare('SELECT app_id, token FROM bot_tokens ORDER BY created_at DESC LIMIT 1')
            .get() as { app_id: string; token: string } | undefined

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

      const s = spinner()

      // If --project provided, resolve to channel ID
      if (projectPath) {
        const absolutePath = path.resolve(projectPath)

        if (!fs.existsSync(absolutePath)) {
          cliLogger.error(`Directory does not exist: ${absolutePath}`)
          process.exit(EXIT_NO_RESTART)
        }

        s.start('Looking up channel for project...')

        // Check if channel already exists for this directory or a parent directory
        // This allows running from subfolders of a registered project
        try {
          const db = getDatabase()
          
          // Helper to find channel for a path (prefers current bot's channel)
          const findChannelForPath = (dirPath: string): { channel_id: string; directory: string } | undefined => {
            const withAppId = db
              .prepare(
                'SELECT channel_id, directory FROM channel_directories WHERE directory = ? AND channel_type = ? AND app_id = ?',
              )
              .get(dirPath, 'text', appId) as { channel_id: string; directory: string } | undefined
            if (withAppId) return withAppId
            
            return db
              .prepare(
                'SELECT channel_id, directory FROM channel_directories WHERE directory = ? AND channel_type = ?',
              )
              .get(dirPath, 'text') as { channel_id: string; directory: string } | undefined
          }
          
          // Try exact match first, then walk up parent directories
          let existingChannel: { channel_id: string; directory: string } | undefined
          let searchPath = absolutePath
          while (searchPath !== path.dirname(searchPath)) {
            existingChannel = findChannelForPath(searchPath)
            if (existingChannel) break
            searchPath = path.dirname(searchPath)
          }

          if (existingChannel) {
            channelId = existingChannel.channel_id
            if (existingChannel.directory !== absolutePath) {
              s.message(`Found parent project channel: ${existingChannel.directory}`)
            } else {
              s.message(`Found existing channel: ${channelId}`)
            }
          } else {
            // Need to create a new channel
            s.message('Creating new channel...')

            if (!appId) {
              s.stop('Missing app ID')
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
              const existingChannelRow = db
                .prepare(
                  'SELECT channel_id FROM channel_directories WHERE app_id = ? ORDER BY created_at DESC LIMIT 1',
                )
                .get(appId) as { channel_id: string } | undefined

              if (existingChannelRow) {
                try {
                  const ch = await client.channels.fetch(existingChannelRow.channel_id)
                  if (ch && 'guild' in ch && ch.guild) {
                    return ch.guild
                  }
                } catch {
                  // Channel might be deleted, continue
                }
              }
              // Fall back to first guild the bot is in
              const firstGuild = client.guilds.cache.first()
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
            s.message(`Created channel: ${channelId}`)

            client.destroy()
          }
        } catch (e) {
          s.stop('Failed to resolve project')
          throw e
        }
      }

      s.start('Fetching channel info...')

      // Get channel info to extract directory from topic
      const channelResponse = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
        headers: {
          Authorization: `Bot ${botToken}`,
        },
      })

      if (!channelResponse.ok) {
        const error = await channelResponse.text()
        s.stop('Failed to fetch channel')
        throw new Error(`Discord API error: ${channelResponse.status} - ${error}`)
      }

      const channelData = (await channelResponse.json()) as {
        id: string
        name: string
        topic?: string
        guild_id: string
      }

      if (!channelData.topic) {
        s.stop('Channel has no topic')
        throw new Error(
          `Channel #${channelData.name} has no topic. It must have a <kimaki.directory> tag.`,
        )
      }

      const extracted = extractTagsArrays({
        xml: channelData.topic,
        tags: ['kimaki.directory', 'kimaki.app'],
      })

      const projectDirectory = extracted['kimaki.directory']?.[0]?.trim()
      const channelAppId = extracted['kimaki.app']?.[0]?.trim()

      if (!projectDirectory) {
        s.stop('No kimaki.directory tag found')
        throw new Error(`Channel #${channelData.name} has no <kimaki.directory> tag in topic.`)
      }

      // Verify app ID matches if both are present
      if (channelAppId && appId && channelAppId !== appId) {
        s.stop('Channel belongs to different bot')
        throw new Error(
          `Channel belongs to a different bot (expected: ${appId}, got: ${channelAppId})`,
        )
      }

      s.message('Creating starter message...')

      // Create starter message with just the prompt (no prefix)
      const starterMessageResponse = await fetch(
        `https://discord.com/api/v10/channels/${channelId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bot ${botToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: prompt,
          }),
        },
      )

      if (!starterMessageResponse.ok) {
        const error = await starterMessageResponse.text()
        s.stop('Failed to create message')
        throw new Error(`Discord API error: ${starterMessageResponse.status} - ${error}`)
      }

      const starterMessage = (await starterMessageResponse.json()) as { id: string }

      s.message('Creating thread...')

      // Create thread from the message
      const threadName = name || (prompt.length > 80 ? prompt.slice(0, 77) + '...' : prompt)
      const threadResponse = await fetch(
        `https://discord.com/api/v10/channels/${channelId}/messages/${starterMessage.id}/threads`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bot ${botToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: threadName.slice(0, 100),
            auto_archive_duration: 1440, // 1 day
          }),
        },
      )

      if (!threadResponse.ok) {
        const error = await threadResponse.text()
        s.stop('Failed to create thread')
        throw new Error(`Discord API error: ${threadResponse.status} - ${error}`)
      }

      const threadData = (await threadResponse.json()) as { id: string; name: string }

      // Mark thread for auto-start if not notify-only
      // This is optional - only works if local database exists (for local bot auto-start)
      if (!notifyOnly) {
        try {
          const db = getDatabase()
          db.prepare('INSERT OR REPLACE INTO pending_auto_start (thread_id) VALUES (?)').run(
            threadData.id,
          )
        } catch {
          // Database not available (e.g., CI environment) - skip auto-start marking
        }
      }

      s.stop('Thread created!')

      const threadUrl = `https://discord.com/channels/${channelData.guild_id}/${threadData.id}`

      const successMessage = notifyOnly
        ? `Thread: ${threadData.name}\nDirectory: ${projectDirectory}\n\nNotification created. Reply to start a session.\n\nURL: ${threadUrl}`
        : `Thread: ${threadData.name}\nDirectory: ${projectDirectory}\n\nThe running bot will pick this up and start the session.\n\nURL: ${threadUrl}`

      note(successMessage, '✅ Thread Created')

      console.log(threadUrl)

      process.exit(0)
    } catch (error) {
      cliLogger.error('Error:', error instanceof Error ? error.message : String(error))
      process.exit(EXIT_NO_RESTART)
    }
  })

cli.help()
cli.parse()
