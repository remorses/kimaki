#!/usr/bin/env node
import {
  intro,
  outro,
  text,
  password,
  note,
  cancel,
  isCancel,
  multiselect,
  spinner,
  select,
} from '@clack/prompts'
import { generateBotInstallUrl } from './utils'
import {
  getChannelsWithDescriptions,
  createDiscordClient,
  getDatabase,
  startDiscordBot,
  initializeOpencodeForDirectory,
  type ChannelWithTags,
} from './discordBot'
import type { OpencodeClient } from '@opencode-ai/sdk'
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  ChannelType,
  type TextChannel,
  type Guild,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js'
import path from 'node:path'
import fs from 'node:fs'

// Parse command line arguments
const args = process.argv.slice(2)
const forceSetup = args.includes('--force')

process.title = 'kimaki'

async function registerCommands(token: string, appId: string) {
  const commands = [
    new SlashCommandBuilder()
      .setName('resume')
      .setDescription('Resume an existing OpenCode session')
      .addStringOption((option) =>
        option
          .setName('session')
          .setDescription('The session to resume')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  ].map((command) => command.toJSON())

  const rest = new REST().setToken(token)

  try {
    // console.log('[COMMANDS] Starting to register slash commands...')

    // Register commands globally
    const data = (await rest.put(Routes.applicationCommands(appId), {
      body: commands,
    })) as any[]

    console.log(
      `[COMMANDS] Successfully registered ${data.length} slash commands`,
    )
  } catch (error) {
    console.error('[COMMANDS] Failed to register slash commands:', error)
    throw error
  }
}

type Project = {
  id: string
  worktree: string
  vcs?: string
  time: {
    created: number
    initialized?: number
  }
}

async function main() {
  console.log()
  intro('🤖 Discord Bot Setup')

  const db = getDatabase()
  let appId: string
  let token: string

  // Check for existing credentials
  const existingBot = db
    .prepare(
      'SELECT app_id, token FROM bot_tokens ORDER BY created_at DESC LIMIT 1',
    )
    .get() as { app_id: string; token: string } | undefined

  if (existingBot && !forceSetup) {
    // Use existing credentials
    appId = existingBot.app_id
    token = existingBot.token
    console.log()
    note(
      `Using saved bot credentials:\nApp ID: ${appId}\n\nTo use different credentials, run with --force`,
      'Existing Bot Found',
    )

    // Show install URL in case they need it
    console.log()
    note(
      `Bot install URL (in case you need to add it to another server):\n${generateBotInstallUrl({ clientId: appId })}`,
      'Install URL',
    )
  } else {
    // Get new credentials
    if (forceSetup && existingBot) {
      console.log()
      note('Ignoring saved credentials due to --force flag', 'Force Setup')
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
        '2. Click "Reset Token" to generate a new bot token\n' +
        "3. Copy the token (you won't be able to see it again!)",
      'Step 2: Get Bot Token',
    )

    const tokenInput = await password({
      message: 'Enter your Discord Bot Token (will be hidden):',
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

    // Save token to database
    db.prepare(
      'INSERT OR REPLACE INTO bot_tokens (app_id, token) VALUES (?, ?)',
    ).run(appId, token)

    console.log()
    note('Token saved to database', 'Credentials Stored')

    // Show install URL and WAIT for installation
    console.log()
    note(
      `Bot install URL:\n${generateBotInstallUrl({ clientId: appId })}\n\nYou MUST install the bot in your Discord server before continuing.`,
      'Step 3: Install Bot to Server',
    )

    const installed = await text({
      message: 'Press Enter AFTER you have installed the bot in your server:',
      placeholder: 'Press Enter to continue',
      validate() {
        return undefined
      },
    })

    if (isCancel(installed)) {
      cancel('Setup cancelled')
      process.exit(0)
    }
  }

  // NOW create Discord client and connect
  const s = spinner()
  s.start('Creating Discord client and connecting...')

  const discordClient = await createDiscordClient()

  let guilds: Guild[] = []
  let kimakiChannels: { guild: Guild; channels: ChannelWithTags[] }[] = []
  let createdChannels: { name: string; id: string; guildId: string }[] = []

  try {
    await new Promise((resolve, reject) => {
      discordClient.once(Events.ClientReady, async (c) => {
        guilds = Array.from(c.guilds.cache.values())

        for (const guild of guilds) {
          const channels = await getChannelsWithDescriptions(guild)
          // Filter channels that have kimaki directory and optionally match current app
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
    console.error(
      'Error:',
      error instanceof Error ? error.message : String(error),
    )
    process.exit(1)
  }

  // Sync existing channels to database
  for (const { guild, channels } of kimakiChannels) {
    for (const channel of channels) {
      if (channel.kimakiDirectory) {
        // Store text channel in database
        db.prepare(
          'INSERT OR IGNORE INTO channel_directories (channel_id, directory, channel_type) VALUES (?, ?, ?)',
        ).run(channel.id, channel.kimakiDirectory, 'text')

        // Check if there's a voice channel with the same name
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

  // Show existing kimaki channels
  let shouldAddChannels = true

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

    // Ask user if they want to add new channels or start the server
    console.log()
    const action = await select({
      message: 'What would you like to do?',
      options: [
        {
          value: 'start',
          label: 'Start the Discord bot with existing channels',
        },
        { value: 'add', label: 'Add new channels before starting' },
      ],
    })

    if (isCancel(action)) {
      cancel('Setup cancelled')
      discordClient.destroy()
      process.exit(0)
    }

    shouldAddChannels = action === 'add'
  }

  // Initialize OpenCode in current directory
  s.start('Starting OpenCode server...')

  let client: OpencodeClient

  try {
    const currentDir = process.cwd()
    client = await initializeOpencodeForDirectory(currentDir)
    s.stop('OpenCode server started!')
  } catch (error) {
    s.stop('Failed to start OpenCode')
    console.error(
      'Error:',
      error instanceof Error ? error.message : String(error),
    )
    discordClient.destroy()
    process.exit(1)
  }

  // Get projects
  s.start('Fetching OpenCode projects...')

  let projects: Project[] = []

  try {
    const projectsResponse = await client.project.list()
    if (!projectsResponse.data) {
      throw new Error('Failed to fetch projects')
    }
    projects = projectsResponse.data
    s.stop(`Found ${projects.length} OpenCode project(s)`)
  } catch (error) {
    s.stop('Failed to fetch projects')
    console.error(
      'Error:',
      error instanceof Error ? error.message : String(error),
    )
    discordClient.destroy()
    process.exit(1)
  }

  // Filter out projects that already have channels
  const existingDirs = kimakiChannels.flatMap(({ channels }) =>
    channels.map((ch) => ch.kimakiDirectory).filter(Boolean),
  )

  const availableProjects = projects.filter(
    (project) => !existingDirs.includes(project.worktree),
  )

  if (availableProjects.length === 0) {
    note(
      'All OpenCode projects already have Discord channels',
      'No New Projects',
    )
  } else if (shouldAddChannels) {
    // Let user select projects
    const selectedProjects = await multiselect({
      message: 'Select projects to create Discord channels for:',
      options: availableProjects.map((project) => ({
        value: project.id,
        label: `${path.basename(project.worktree)} (${project.worktree})`,
      })),
      required: false,
    })

    if (!isCancel(selectedProjects) && selectedProjects.length > 0) {
      // Select guild if multiple
      let targetGuild: Guild
      if (guilds.length === 0) {
        console.error(
          'No Discord servers found! The bot must be installed in at least one server.',
        )
        process.exit(1)
      } else if (guilds.length === 1) {
        targetGuild = guilds[0]!
      } else {
        const guildId = await text({
          message: 'Enter the Discord server ID to create channels in:',
          placeholder: guilds[0]?.id,
          validate(value) {
            if (!value) return 'Server ID is required'
            if (!guilds.find((g) => g.id === value)) return 'Invalid server ID'
          },
        })

        if (isCancel(guildId)) {
          cancel('Setup cancelled')
          process.exit(0)
        }

        targetGuild = guilds.find((g) => g.id === guildId)!
      }

      // Create channels
      s.start('Creating Discord channels...')

      for (const projectId of selectedProjects) {
        const project = projects.find((p) => p.id === projectId)
        if (!project) continue

        const baseName = path.basename(project.worktree)
        const channelName = `kimaki-${baseName}`
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '-')
          .slice(0, 100)

        try {
          // Create text channel
          const textChannel = await targetGuild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            topic: `<kimaki><directory>${project.worktree}</directory><app>${appId}</app></kimaki>`,
          })

          // Create voice channel with same name
          const voiceChannel = await targetGuild.channels.create({
            name: channelName,
            type: ChannelType.GuildVoice,
          })

          // Store both channels in database
          db.prepare(
            'INSERT OR REPLACE INTO channel_directories (channel_id, directory, channel_type) VALUES (?, ?, ?)',
          ).run(textChannel.id, project.worktree, 'text')

          db.prepare(
            'INSERT OR REPLACE INTO channel_directories (channel_id, directory, channel_type) VALUES (?, ?, ?)',
          ).run(voiceChannel.id, project.worktree, 'voice')

          createdChannels.push({
            name: textChannel.name,
            id: textChannel.id,
            guildId: targetGuild.id,
          })
        } catch (error) {
          console.error(`Failed to create channels for ${baseName}:`, error)
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

  // Register slash commands
  console.log()
  s.start('Registering slash commands...')
  try {
    await registerCommands(token, appId)
    s.stop('Slash commands registered!')
  } catch (error) {
    s.stop('Failed to register slash commands')
    console.error(
      'Error:',
      error instanceof Error ? error.message : String(error),
    )
    // Continue anyway as commands might already be registered
  }

  // Start the bot at the very end
  console.log()
  s.start('Starting Discord bot...')
  await startDiscordBot({ token, appId, discordClient })
  s.stop('Discord bot is running!')

  // Show channel links if any were created or exist
  const allChannels: {
    name: string
    id: string
    guildId: string
    directory?: string
  }[] = []

  // Add newly created channels
  allChannels.push(...createdChannels)

  // Add existing kimaki channels
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
    console.log()
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

main().catch(console.error)
