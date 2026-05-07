// Project registration and Discord channel management terminal commands.
import { goke } from 'goke'
import { z } from 'zod'
import { note } from '@clack/prompts'
import YAML from 'yaml'
import * as errore from 'errore'
import type { OpencodeClient, Event as OpenCodeEvent } from '@opencode-ai/sdk/v2'
import { Events, ActivityType, type PresenceStatusData, type Guild, Routes } from 'discord.js'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawn, execSync } from 'node:child_process'
import { createLogger, LogPrefix, initLogFile } from '../logger.js'
import { createDiscordClient, initDatabase, getChannelDirectory, initializeOpencodeForDirectory, createProjectChannels } from '../discord-bot.js'
import { getBotTokenWithMode, getThreadSession, getThreadIdBySessionId, getSessionEventSnapshot, getDb, createScheduledTask, listScheduledTasks, cancelScheduledTask, getScheduledTask, updateScheduledTask, getSessionStartSourcesBySessionIds, deleteChannelDirectoryById, findChannelsByDirectory } from '../database.js'
import { ShareMarkdown } from '../markdown.js'
import { parseSessionSearchPattern, findFirstSessionSearchHit, buildSessionSearchSnippet, getPartSearchTexts } from '../session-search.js'
import { formatWorktreeName, formatAutoWorktreeName } from '../commands/new-worktree.js'
import { WORKTREE_PREFIX } from '../commands/merge-worktree.js'
import type { ThreadStartMarker } from '../system-message.js'
import { buildOpencodeEventLogLine } from '../session-handler/opencode-session-event-log.js'
import { createDiscordRest } from '../discord-urls.js'
import { archiveThread, uploadFilesToDiscord, stripMentions } from '../discord-utils.js'
import { setDataDir, setProjectsDir, getDataDir, getProjectsDir } from '../config.js'
import { execAsync, validateWorktreeDirectory } from '../worktrees.js'
import { upgrade, getCurrentVersion } from '../upgrade.js'
import { getPromptPreview, parseSendAtValue, parseScheduledTaskPayload, serializeScheduledTaskPayload, type ScheduledTaskPayload } from '../task-schedule.js'
import {
  EXIT_NO_RESTART,
  formatMemberLookupUnavailableMessage,
  formatRelativeTime,
  formatTaskScheduleLine,
  isDiscordMemberLookupUnavailable,
  isGuildMemberSearchResult,
  isThreadChannelType,
  printDiscordInstallUrlAndExit,
  resolveBotCredentials,
  resolveDiscordUserOption,
  sendDiscordMessageWithOptionalAttachment,
} from '../cli-runner.js'

const cliLogger = createLogger(LogPrefix.CLI)
const cli = goke()

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
        void client.login(botToken)
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
          void client.destroy()
          process.exit(EXIT_NO_RESTART)
        }
        guild = foundGuild
      } else {
        const existingChannelId = await (await getDb()).query.channel_directories.findFirst({
          where: { channel_type: 'text' },
          orderBy: { created_at: 'desc' },
          columns: { channel_id: true },
        }).then((row) => row?.channel_id)

        if (existingChannelId) {
          try {
            const ch = await client.channels.fetch(existingChannelId)
            if (ch && !ch.isDMBased()) {
              guild = ch.guild
            } else {
              throw new Error('Channel has no guild')
            }
          } catch (error) {
            cliLogger.debug(
              'Failed to fetch existing channel while selecting guild:',
              error instanceof Error ? error.stack : String(error),
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
              void client.destroy()
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
            void client.destroy()
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
        })

        for (const existingChannel of existingChannels) {
          try {
            const ch = await client.channels.fetch(existingChannel.channel_id)
            if (ch && !ch.isDMBased() && ch.guild.id === guild.id) {
              void client.destroy()
              cliLogger.error(
                `Channel already exists for this directory in ${guild.name}. Channel ID: ${existingChannel.channel_id}`,
              )
              process.exit(EXIT_NO_RESTART)
            }
          } catch (error) {
            cliLogger.debug(
              `Failed to fetch channel ${existingChannel.channel_id} while checking existing channels:`,
              error instanceof Error ? error.stack : String(error),
            )
          }
        }
      } catch (error) {
        cliLogger.debug(
          'Database lookup failed while checking existing channels:',
          error instanceof Error ? error.stack : String(error),
        )
      }

      const { textChannelId, voiceChannelId, channelName } =
        await createProjectChannels({
          guild,
          projectDirectory: absolutePath,
          botName: client.user?.username,
        })

      void client.destroy()

      if (textChannelId || voiceChannelId) {
        cliLogger.log('Channels created!')
      }

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
  .option('--prune', 'Remove stale entries whose Discord channel no longer exists')
  .action(async (options: { json?: boolean; prune?: boolean }) => {
    await initDatabase()

    const db = await getDb()
    const channels = await db.query.channel_directories.findMany({
      where: { channel_type: 'text' },
      orderBy: { created_at: 'desc' },
    })

    if (channels.length === 0) {
      cliLogger.log('No projects registered')
      process.exit(0)
    }

    // Fetch Discord channel names via REST API
    const botRow = await getBotTokenWithMode()
    const rest = botRow ? createDiscordRest(botRow.token) : null

    const enriched = await Promise.all(
      channels.map(async (ch) => {
        let channelName = ''
        let deleted = false
        if (rest) {
          try {
            const data = (await rest.get(Routes.channel(ch.channel_id))) as {
              name?: string
            }
            channelName = data.name || ''
          } catch (error) {
            // Only mark as deleted for Unknown Channel (10003) or 404,
            // not transient errors like rate limits or 5xx
            const code = error instanceof Error ? Reflect.get(error, 'code') : undefined
            const status = error instanceof Error ? Reflect.get(error, 'status') : undefined
            const isUnknownChannel = code === 10003 || status === 404
            deleted = isUnknownChannel
          }
        }
        return { ...ch, channelName, deleted }
      }),
    )

    // Prune stale entries if requested
    if (options.prune) {
      const stale = enriched.filter((ch) => {
        return ch.deleted
      })
      if (stale.length === 0) {
        cliLogger.log('No stale channels to prune')
      } else {
        for (const ch of stale) {
          await deleteChannelDirectoryById(ch.channel_id)
          cliLogger.log(`Pruned stale channel ${ch.channel_id} (${path.basename(ch.directory)})`)
        }
        cliLogger.log(`Pruned ${stale.length} stale channel(s)`)
      }
      // Re-filter to only show live entries after pruning
      const live = enriched.filter((ch) => {
        return !ch.deleted
      })
      if (live.length === 0) {
        cliLogger.log('No projects registered')
        process.exit(0)
      }
      enriched.length = 0
      enriched.push(...live)
    }

    if (options.json) {
      const output = enriched.map((ch) => ({
        channel_id: ch.channel_id,
        channel_name: ch.channelName,
        directory: ch.directory,
        folder_name: path.basename(ch.directory),
        deleted: ch.deleted,
      }))
      console.log(JSON.stringify(output, null, 2))
      process.exit(0)
    }

    for (const ch of enriched) {
      const folderName = path.basename(ch.directory)
      const deletedTag = ch.deleted ? ' (deleted from Discord)' : ''
      const channelLabel = ch.channelName ? `#${ch.channelName}` : ch.channel_id
      console.log(`\n${channelLabel}${deletedTag}`)
      console.log(`   Folder: ${folderName}`)
      console.log(`   Directory: ${ch.directory}`)
      console.log(`   Channel ID: ${ch.channel_id}`)
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

    const botRow = await getBotTokenWithMode()
    if (!botRow) {
      cliLogger.error('No bot configured. Run `kimaki` first.')
      process.exit(EXIT_NO_RESTART)
    }

    const { token: botToken } = botRow
    const absolutePath = path.resolve('.')

    // Walk up parent directories to find a matching channel
    const findChannelForPath = async (
      dirPath: string,
    ): Promise<{ channel_id: string; directory: string } | undefined> => {
      const channels = await findChannelsByDirectory({
        directory: dirPath,
        channelType: 'text',
      })
      return channels[0]
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
  .option(
    '--projects-dir <path>',
    'Directory where new projects are created (default: <data-dir>/projects)',
  )
  .action(async (name: string, options: { guild?: string; projectsDir?: string }) => {
    if (options.projectsDir) {
      setProjectsDir(options.projectsDir)
    }
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

    const botRow = await getBotTokenWithMode()
    if (!botRow) {
      cliLogger.error('No bot configured. Run `kimaki` first.')
      process.exit(EXIT_NO_RESTART)
    }

    const { token: botToken } = botRow

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
        void client.destroy()
        process.exit(EXIT_NO_RESTART)
      }
      guild = found
    } else {
      const first = client.guilds.cache.first()
      if (!first) {
        cliLogger.error('No guild found. Add the bot to a server first.')
        void client.destroy()
        process.exit(EXIT_NO_RESTART)
      }
      guild = first
    }

    const { textChannelId, channelName } = await createProjectChannels({
      guild,
      projectDirectory,
      botName: client.user?.username,
    })

    void client.destroy()

    const channelUrl = `https://discord.com/channels/${guild.id}/${textChannelId}`

    note(
      `Created project: ${sanitizedName}\n\nDirectory: ${projectDirectory}\nChannel: #${channelName}\nURL: ${channelUrl}`,
      '✅ Success',
    )

    cliLogger.log(channelUrl)
    process.exit(0)
  })


export default cli
