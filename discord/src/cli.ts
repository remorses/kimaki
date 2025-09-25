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
} from 'discord.js'
import path from 'node:path'
import fs from 'node:fs'
import { createLogger } from './logger.js'

const cliLogger = createLogger('CLI')
const cli = cac('kimaki')

process.title = 'kimaki'

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

async function ensureKimakiCategory(guild: Guild): Promise<CategoryChannel> {
  const existingCategory = guild.channels.cache.find(
    (channel): channel is CategoryChannel => {
      if (channel.type !== ChannelType.GuildCategory) {
        return false
      }

      return channel.name.toLowerCase() === 'kimaki'
    },
  )

  if (existingCategory) {
    return existingCategory
  }

  return guild.channels.create({
    name: 'Kimaki',
    type: ChannelType.GuildCategory,
  })
}

async function run({ restart, addChannels }: CliOptions) {
  const forceSetup = Boolean(restart)

  intro('🤖 Discord Bot Setup')

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
    const projectsResponse = await getClient().project.list()
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

      s.start('Creating Discord channels...')

      for (const projectId of selectedProjects) {
        const project = projects.find((p) => p.id === projectId)
        if (!project) continue

        const baseName = path.basename(project.worktree)
        const channelName = `${baseName}`
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '-')
          .slice(0, 100)

        try {
          const kimakiCategory = await ensureKimakiCategory(targetGuild)

          const textChannel = await targetGuild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: kimakiCategory,
            topic: `<kimaki><directory>${project.worktree}</directory><app>${appId}</app></kimaki>`,
          })

          const voiceChannel = await targetGuild.channels.create({
            name: channelName,
            type: ChannelType.GuildVoice,
            parent: kimakiCategory,
          })

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
          cliLogger.error(`Failed to create channels for ${baseName}:`, error)
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

cli.help()
cli.parse()
