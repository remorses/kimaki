// Project registration and Discord channel management terminal commands.
import { goke } from 'goke'
import { z } from 'zod'
import { note } from '@clack/prompts'
import YAML from 'yaml'
import * as errore from 'errore'
import type { OpencodeClient, Event as OpenCodeEvent } from '@opencode-ai/sdk/v2'
import { Events, ActivityType, type PresenceStatusData, type Guild, type Client, Routes } from 'discord.js'
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

      const guild = await resolveGuildForProjectCommand({ client, guildIdOverride: options.guild })

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

    const guild = await resolveGuildForProjectCommand({ client, guildIdOverride: options.guild })

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


// Resolve the guild for project add/create commands. In gateway mode the
// guild cache only contains authorized guilds, so picking from cache is safe.
// The old approach fetched an existing channel to infer the guild, but that
// breaks when the channel belongs to a different guild (e.g. old self-hosted
// bot channels) and the gateway proxy rejects the REST call. This led to a
// non-deterministic fallback that picked the wrong guild.
async function resolveGuildForProjectCommand({ client, guildIdOverride }: { client: Client; guildIdOverride?: string }): Promise<Guild> {
  if (guildIdOverride) {
    const found = client.guilds.cache.get(guildIdOverride)
    if (!found) {
      cliLogger.error(`Guild not found: ${guildIdOverride}`)
      void client.destroy()
      process.exit(EXIT_NO_RESTART)
    }
    return found
  }

  // Try existing channel lookup to find the guild the user already has channels in.
  // This handles multi-guild setups where we want to add to the same guild.
  const db = await getDb()
  const existingChannels = await db.query.channel_directories.findMany({
    where: { channel_type: 'text' },
    orderBy: { created_at: 'desc' },
    columns: { channel_id: true },
    limit: 20,
  })

  // Log available guilds for debugging guild selection issues
  const cachedGuilds = Array.from(client.guilds.cache.values())
  cliLogger.debug(`Guilds in cache (${cachedGuilds.length}): ${cachedGuilds.map((g) => `${g.name} (${g.id})`).join(', ')}`)

  // When multiple guilds are available, find which guild has the most
  // existing channels. The user's main guild will have far more channels
  // than a test/demo guild.
  const guildHits = new Map<string, { guild: Guild; count: number }>()
  for (const row of existingChannels) {
    try {
      const ch = await client.channels.fetch(row.channel_id)
      if (ch && !ch.isDMBased()) {
        const entry = guildHits.get(ch.guild.id)
        if (entry) {
          entry.count++
        } else {
          guildHits.set(ch.guild.id, { guild: ch.guild, count: 1 })
        }
      }
    } catch {
      // Channel might be in a different guild (gateway proxy rejects) or deleted, skip
    }
  }

  if (guildHits.size > 0) {
    // Pick the guild with the most channels
    const best = Array.from(guildHits.values()).sort((a, b) => b.count - a.count)[0]!
    cliLogger.debug(
      `Guild channel counts: ${Array.from(guildHits.values()).map((e) => `${e.guild.name} (${e.guild.id}): ${e.count}`).join(', ')}`,
    )
    cliLogger.debug(`Selected guild: ${best.guild.name} (${best.guild.id}) with ${best.count} channels`)
    return best.guild
  }

  cliLogger.debug('Could not resolve guild from existing channels, falling back to cache')

  // If only one guild in cache, use it directly (common case).
  // If multiple guilds, error out and ask the user to specify --guild
  // since we can't determine which one to use.
  if (cachedGuilds.length === 1) {
    return cachedGuilds[0]!
  }
  if (cachedGuilds.length > 1) {
    cliLogger.error(
      `Multiple guilds found. Use --guild to specify which one:\n${cachedGuilds.map((g) => `  ${g.id}  ${g.name}`).join('\n')}`,
    )
    void client.destroy()
    process.exit(EXIT_NO_RESTART)
  }

  // Cache empty, try fetching
  const fetched = await client.guilds.fetch()
  if (fetched.size === 1) {
    const firstOAuth2Guild = fetched.first()!
    return await client.guilds.fetch(firstOAuth2Guild.id)
  }
  if (fetched.size > 1) {
    cliLogger.error(
      `Multiple guilds found. Use --guild to specify which one:\n${Array.from(fetched.values()).map((g) => `  ${g.id}  ${g.name}`).join('\n')}`,
    )
    void client.destroy()
    process.exit(EXIT_NO_RESTART)
  }

  cliLogger.error('No guild found. Add the bot to a server first.')
  void client.destroy()
  process.exit(EXIT_NO_RESTART)
}

export default cli
