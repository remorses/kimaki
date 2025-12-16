#!/usr/bin/env node
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
import { deduplicateByKey, generateBotInstallUrl } from './utils.js'
import {
  getChannelsWithDescriptions,
  createDiscordClient,
  getDatabase,
  startDiscordBot,
  initializeOpencodeForDirectory,
  ensureKimakiCategory,
  createProjectChannels,
  type ChannelWithTags,
} from './discordBot.js'
import type { OpencodeClient } from '@opencode-ai/sdk'
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
import { createRequire } from 'node:module'
import os from 'node:os'
import { createLogger } from './logger.js'
import { spawn, spawnSync, execSync, type ExecSyncOptions } from 'node:child_process'

const cliLogger = createLogger('CLI')
const cli = cac('kimaki')

process.title = 'kimaki'

process.on('SIGUSR2', () => {
  cliLogger.info('Received SIGUSR2, restarting process in 1000ms...')
  setTimeout(() => {
    cliLogger.info('Restarting...')
    spawn(process.argv[0]!, [...process.execArgv, ...process.argv.slice(1)], {
      stdio: 'inherit',
      detached: true,
      cwd: process.cwd(),
      env: process.env,
    }).unref()
    process.exit(0)
  }, 1000)
})

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
}

async function registerCommands(token: string, appId: string) {
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
      .setName('accept')
      .setDescription('Accept a pending permission request (this request only)')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('accept-always')
      .setDescription('Accept and auto-approve future requests matching this pattern')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('reject')
      .setDescription('Reject a pending permission request')
      .toJSON(),
    new SlashCommandBuilder()
      .setName('abort')
      .setDescription('Abort the current OpenCode request in this thread')
      .toJSON(),
  ]

  const rest = new REST().setToken(token)

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



async function run({ restart, addChannels }: CliOptions) {
  const forceSetup = Boolean(restart)

  intro('🤖 Discord Bot Setup')

  // Step 0: Check if OpenCode CLI is available
  const opencodeCheck = spawnSync('which', ['opencode'], { shell: true })

  if (opencodeCheck.status !== 0) {
    note(
      'OpenCode CLI is required but not found in your PATH.',
      '⚠️  OpenCode Not Found',
    )

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
      cliLogger.error(
        'Installation error:',
        error instanceof Error ? error.message : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  }

  const db = getDatabase()
  let appId: string
  let token: string

  const existingBot = db
    .prepare(
      'SELECT app_id, token FROM bot_tokens ORDER BY created_at DESC LIMIT 1',
    )
    .get() as { app_id: string; token: string } | undefined

  const shouldAddChannels =
    !existingBot?.token || forceSetup || Boolean(addChannels)

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
      message:
        'Enter your Discord Bot Token (from "Bot" section - click "Reset Token" if needed):',
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

    note(
      `You can get a Gemini api Key at https://aistudio.google.com/apikey`,
      `Gemini API Key`,
    )

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
      db.prepare(
        'INSERT OR REPLACE INTO bot_api_keys (app_id, gemini_api_key) VALUES (?, ?)',
      ).run(appId, geminiApiKey || null)
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
  s.start('Creating Discord client and connecting...')

  const discordClient = await createDiscordClient()

  const guilds: Guild[] = []
  const kimakiChannels: { guild: Guild; channels: ChannelWithTags[] }[] = []
  const createdChannels: { name: string; id: string; guildId: string }[] = []

  try {
    await new Promise((resolve, reject) => {
      discordClient.once(Events.ClientReady, async (c) => {
        guilds.push(...Array.from(c.guilds.cache.values()))

        for (const guild of guilds) {
          const channels = await getChannelsWithDescriptions(guild)
          const kimakiChans = channels.filter(
            (ch) =>
              ch.kimakiDirectory && (!ch.kimakiApp || ch.kimakiApp === appId),
          )

          if (kimakiChans.length > 0) {
            kimakiChannels.push({ guild, channels: kimakiChans })
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
    cliLogger.error(
      'Error: ' + (error instanceof Error ? error.message : String(error)),
    )
    process.exit(EXIT_NO_RESTART)
  }
  db.prepare(
    'INSERT OR REPLACE INTO bot_tokens (app_id, token) VALUES (?, ?)',
  ).run(appId, token)

  for (const { guild, channels } of kimakiChannels) {
    for (const channel of channels) {
      if (channel.kimakiDirectory) {
        db.prepare(
          'INSERT OR IGNORE INTO channel_directories (channel_id, directory, channel_type) VALUES (?, ?, ?)',
        ).run(channel.id, channel.kimakiDirectory, 'text')

        const voiceChannel = guild.channels.cache.find(
          (ch) =>
            ch.type === ChannelType.GuildVoice && ch.name === channel.name,
        )

        if (voiceChannel) {
          db.prepare(
            'INSERT OR IGNORE INTO channel_directories (channel_id, directory, channel_type) VALUES (?, ?, ?)',
          ).run(voiceChannel.id, channel.kimakiDirectory, 'voice')
        }
      }
    }
  }

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

  s.start('Starting OpenCode server...')

  const currentDir = process.cwd()
  let getClient = await initializeOpencodeForDirectory(currentDir)
  s.stop('OpenCode server started!')

  s.start('Fetching OpenCode projects...')

  let projects: Project[] = []

  try {
    const projectsResponse = await getClient().project.list({})
    if (!projectsResponse.data) {
      throw new Error('Failed to fetch projects')
    }
    projects = projectsResponse.data
    s.stop(`Found ${projects.length} OpenCode project(s)`)
  } catch (error) {
    s.stop('Failed to fetch projects')
    cliLogger.error(
      'Error:',
      error instanceof Error ? error.message : String(error),
    )
    discordClient.destroy()
    process.exit(EXIT_NO_RESTART)
  }

  const existingDirs = kimakiChannels.flatMap(({ channels }) =>
    channels
      .filter((ch) => ch.kimakiDirectory && ch.kimakiApp === appId)
      .map((ch) => ch.kimakiDirectory)
      .filter(Boolean),
  )

  const availableProjects = deduplicateByKey(
    projects.filter((project) => !existingDirs.includes(project.worktree)),
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
        label: `${path.basename(project.worktree)} (${project.worktree})`,
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
          })

          createdChannels.push({
            name: channelName,
            id: textChannelId,
            guildId: targetGuild.id,
          })
        } catch (error) {
          cliLogger.error(`Failed to create channels for ${path.basename(project.worktree)}:`, error)
        }
      }

      s.stop(`Created ${createdChannels.length} channel(s)`)

      if (createdChannels.length > 0) {
        note(
          createdChannels.map((ch) => `#${ch.name}`).join('\n'),
          'Created Channels',
        )
      }
    }
  }

  cliLogger.log('Registering slash commands asynchronously...')
  void registerCommands(token, appId)
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

  outro('✨ Setup complete!')
}

cli
  .command('', 'Set up and run the Kimaki Discord bot')
  .option('--restart', 'Prompt for new credentials even if saved')
  .option(
    '--add-channels',
    'Select OpenCode projects to create Discord channels before starting',
  )
  .action(async (options: { restart?: boolean; addChannels?: boolean }) => {
    try {
      await run({
        restart: options.restart,
        addChannels: options.addChannels,
      })
    } catch (error) {
      cliLogger.error(
        'Unhandled error:',
        error instanceof Error ? error.message : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

cli
  .command(
    'send-to-discord <sessionId>',
    'Send an OpenCode session to Discord and create a thread for it',
  )
  .option('-d, --directory <dir>', 'Project directory (defaults to current working directory)')
  .action(async (sessionId: string, options: { directory?: string }) => {
    try {
      const directory = options.directory || process.cwd()
      
      const db = getDatabase()
      
      const botRow = db
        .prepare(
          'SELECT app_id, token FROM bot_tokens ORDER BY created_at DESC LIMIT 1',
        )
        .get() as { app_id: string; token: string } | undefined

      if (!botRow) {
        cliLogger.error('No bot credentials found. Run `kimaki` first to set up the bot.')
        process.exit(EXIT_NO_RESTART)
      }

      const channelRow = db
        .prepare(
          'SELECT channel_id FROM channel_directories WHERE directory = ? AND channel_type = ?',
        )
        .get(directory, 'text') as { channel_id: string } | undefined

      if (!channelRow) {
        cliLogger.error(
          `No Discord channel found for directory: ${directory}\n` +
            'Run `kimaki --add-channels` to create a channel for this project.',
        )
        process.exit(EXIT_NO_RESTART)
      }

      const s = spinner()
      s.start('Connecting to Discord...')

      const discordClient = await createDiscordClient()

      await new Promise<void>((resolve, reject) => {
        discordClient.once(Events.ClientReady, () => {
          resolve()
        })
        discordClient.once(Events.Error, reject)
        discordClient.login(botRow.token).catch(reject)
      })

      s.stop('Connected to Discord!')

      const channel = await discordClient.channels.fetch(channelRow.channel_id)
      if (!channel || channel.type !== ChannelType.GuildText) {
        cliLogger.error('Could not find the text channel or it is not a text channel')
        discordClient.destroy()
        process.exit(EXIT_NO_RESTART)
      }

      const textChannel = channel as import('discord.js').TextChannel

      s.start('Fetching session from OpenCode...')

      const getClient = await initializeOpencodeForDirectory(directory)
      const sessionResponse = await getClient().session.get({
        path: { id: sessionId },
      })

      if (!sessionResponse.data) {
        s.stop('Session not found')
        discordClient.destroy()
        process.exit(EXIT_NO_RESTART)
      }

      const session = sessionResponse.data
      s.stop(`Found session: ${session.title}`)

      s.start('Creating Discord thread...')

      const thread = await textChannel.threads.create({
        name: `Resume: ${session.title}`.slice(0, 100),
        autoArchiveDuration: 1440,
        reason: `Resuming session ${sessionId} from CLI`,
      })

      db.prepare(
        'INSERT OR REPLACE INTO thread_sessions (thread_id, session_id) VALUES (?, ?)',
      ).run(thread.id, sessionId)

      s.stop('Created Discord thread!')

      s.start('Loading session messages...')

      const messagesResponse = await getClient().session.messages({
        path: { id: sessionId },
      })

      if (!messagesResponse.data) {
        s.stop('Failed to fetch session messages')
        discordClient.destroy()
        process.exit(EXIT_NO_RESTART)
      }

      const messages = messagesResponse.data

      await thread.send(
        `📂 **Resumed session:** ${session.title}\n📅 **Created:** ${new Date(session.time.created).toLocaleString()}\n\n*Loading ${messages.length} messages...*`,
      )

      let messageCount = 0
      for (const message of messages) {
        if (message.info.role === 'user') {
          const userParts = message.parts.filter(
            (p) => p.type === 'text' && !p.synthetic,
          )
          const userTexts = userParts
            .map((p) => {
              if (p.type === 'text') {
                return p.text
              }
              return ''
            })
            .filter((t) => t.trim())

          const userText = userTexts.join('\n\n')
          if (userText) {
            const truncated = userText.length > 1900 ? userText.slice(0, 1900) + '…' : userText
            await thread.send(`**User:**\n${truncated}`)
          }
        } else if (message.info.role === 'assistant') {
          const textParts = message.parts.filter((p) => p.type === 'text')
          const texts = textParts
            .map((p) => {
              if (p.type === 'text') {
                return p.text
              }
              return ''
            })
            .filter((t) => t?.trim())

          if (texts.length > 0) {
            const combinedText = texts.join('\n\n')
            const truncated = combinedText.length > 1900 ? combinedText.slice(0, 1900) + '…' : combinedText
            await thread.send(truncated)
          }
        }
        messageCount++
      }

      await thread.send(
        `✅ **Session resumed!** Loaded ${messageCount} messages.\n\nYou can now continue the conversation by sending messages in this thread.`,
      )

      s.stop(`Loaded ${messageCount} messages`)

      const guildId = textChannel.guildId
      const threadUrl = `https://discord.com/channels/${guildId}/${thread.id}`

      note(
        `Session "${session.title}" has been sent to Discord!\n\nThread: ${threadUrl}`,
        '✅ Success',
      )

      discordClient.destroy()
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
        .prepare(
          'SELECT app_id, token FROM bot_tokens ORDER BY created_at DESC LIMIT 1',
        )
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
        formData.append('payload_json', JSON.stringify({
          attachments: [{ id: 0, filename: path.basename(file) }]
        }))
        formData.append('files[0]', new Blob([buffer]), path.basename(file))

        const response = await fetch(
          `https://discord.com/api/v10/channels/${threadRow.thread_id}/messages`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bot ${botRow.token}`,
            },
            body: formData,
          }
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
      cliLogger.error(
        'Error:',
        error instanceof Error ? error.message : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

cli
  .command('install-plugin', 'Install the OpenCode command for kimaki Discord integration')
  .action(async () => {
    try {
      const require = createRequire(import.meta.url)
      const sendCommandSrc = require.resolve('./opencode-command-send-to-discord.md')

      const opencodeConfig = path.join(os.homedir(), '.config', 'opencode')
      const commandDir = path.join(opencodeConfig, 'command')

      fs.mkdirSync(commandDir, { recursive: true })

      const sendCommandDest = path.join(commandDir, 'send-to-kimaki-discord.md')

      fs.copyFileSync(sendCommandSrc, sendCommandDest)

      note(
        `Command installed:\n- ${sendCommandDest}\n\nUse /send-to-kimaki-discord to send session to Discord.`,
        '✅ Installed',
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

cli.help()
cli.parse()
