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
  .option('--all', 'Include remote projects from other machines (scans Kimaki category in Discord)')
  .option('-g, --guild <guildId>', 'Discord guild/server ID to scan (used with --all when no local projects exist)')
  .option('--prune', 'Remove stale entries whose Discord channel no longer exists')
  .action(async (options) => {
    await initDatabase()

    const db = await getDb()
    const channels = await db.query.channel_directories.findMany({
      where: { channel_type: 'text' },
      orderBy: { created_at: 'desc' },
    })

    // Fetch Discord channel names and guild IDs via REST API
    const botRow = await getBotTokenWithMode()
    const rest = botRow ? createDiscordRest(botRow.token) : null

    const localChannelIds = new Set(channels.map((ch) => ch.channel_id))

    const enriched = await Promise.all(
      channels.map(async (ch) => {
        let channelName = ''
        let guildId = ''
        let deleted = false
        if (rest) {
          try {
            const data = (await rest.get(Routes.channel(ch.channel_id))) as {
              name?: string
              guild_id?: string
            }
            channelName = data.name || ''
            guildId = data.guild_id || ''
          } catch (error) {
            // Only mark as deleted for Unknown Channel (10003) or 404,
            // not transient errors like rate limits or 5xx
            const code = error instanceof Error ? Reflect.get(error, 'code') : undefined
            const status = error instanceof Error ? Reflect.get(error, 'status') : undefined
            const isUnknownChannel = code === 10003 || status === 404
            deleted = isUnknownChannel
          }
        }
        return { ...ch, channelName, guildId, deleted, isLocal: true as boolean }
      }),
    )

    // Fetch guild names for unique guild IDs (deduplicated to save API calls)
    const guildNameMap = new Map<string, string>()
    // Collect guild IDs from local channels + explicit --guild flag
    const guildIdsFromChannels = enriched.map((ch) => ch.guildId).filter(Boolean)
    if (options.guild) {
      guildIdsFromChannels.push(options.guild)
    }
    const uniqueGuildIds = [...new Set(guildIdsFromChannels)]
    if (rest) {
      await Promise.all(
        uniqueGuildIds.map(async (guildId) => {
          try {
            const data = (await rest.get(Routes.guild(guildId))) as { name?: string }
            guildNameMap.set(guildId, data.name || '')
          } catch (error) {
            cliLogger.debug(
              `Failed to fetch guild ${guildId}:`,
              error instanceof Error ? error.stack : String(error),
            )
          }
        }),
      )
    }

    // When --all is passed, scan each guild's channels to find Kimaki category
    // text channels not in our local DB (projects from other machines).
    // Fail explicitly when prerequisites are missing so the user doesn't
    // confuse "scan never ran" with "no remote projects found".
    let remoteEntries: typeof enriched = []
    if (options.all) {
      if (!rest) {
        cliLogger.error('Discord credentials are required to scan remote projects. Run `kimaki` first.')
        process.exit(EXIT_NO_RESTART)
      }
      if (uniqueGuildIds.length === 0) {
        cliLogger.error(
          'Cannot determine which Discord server to scan. Pass `--guild <guildId>` or register a local project first.',
        )
        process.exit(EXIT_NO_RESTART)
      }

      let guildScanFailures = 0
      for (const guildId of uniqueGuildIds) {
        try {
          const guildChannels = (await rest.get(Routes.guildChannels(guildId))) as Array<{
            id: string
            name: string
            type: number
            parent_id: string | null
          }>

          // Find Kimaki category channels (type 4 = GuildCategory)
          const kimakiCategoryIds = new Set(
            guildChannels
              .filter((ch) => ch.type === 4 && /^kimaki(\s|$)/i.test(ch.name))
              .map((ch) => ch.id),
          )

          // Find text channels (type 0) in Kimaki categories that are not in our local DB
          for (const ch of guildChannels) {
            if (
              ch.type === 0 &&
              ch.parent_id &&
              kimakiCategoryIds.has(ch.parent_id) &&
              !localChannelIds.has(ch.id)
            ) {
              remoteEntries.push({
                channel_id: ch.id,
                directory: '',
                channel_type: 'text' as const,
                created_at: null,
                channelName: ch.name,
                guildId,
                deleted: false,
                isLocal: false,
              })
            }
          }
        } catch (error) {
          guildScanFailures++
          cliLogger.warn(
            `Failed to scan guild ${guildNameMap.get(guildId) || guildId}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      if (guildScanFailures === uniqueGuildIds.length) {
        cliLogger.error('Failed to scan all guilds. Check bot permissions or try again.')
        process.exit(EXIT_NO_RESTART)
      }
    }

    // Build final enriched entries with guild names resolved
    const allEntries = [...enriched, ...remoteEntries]
    const enrichedWithGuild = allEntries.map((ch) => ({
      ...ch,
      guildName: ch.guildId ? (guildNameMap.get(ch.guildId) || '') : '',
    }))

    // Warn on stderr if the same directory appears in multiple channels (multi-guild duplicates)
    const directoryCounts = new Map<string, number>()
    for (const ch of enrichedWithGuild) {
      if (!ch.deleted && ch.directory) {
        directoryCounts.set(ch.directory, (directoryCounts.get(ch.directory) || 0) + 1)
      }
    }
    for (const [dir, count] of directoryCounts) {
      if (count > 1) {
        cliLogger.warn(
          `Directory "${dir}" is registered in ${count} channels. Use channel_id to disambiguate.`,
        )
      }
    }

    // Prune stale entries if requested
    let finalEntries = enrichedWithGuild
    if (options.prune) {
      const stale = finalEntries.filter((ch) => ch.deleted && ch.isLocal)
      if (stale.length === 0) {
        cliLogger.log('No stale channels to prune')
      } else {
        for (const ch of stale) {
          await deleteChannelDirectoryById(ch.channel_id)
          cliLogger.log(`Pruned stale channel ${ch.channel_id} (${path.basename(ch.directory)})`)
        }
        cliLogger.log(`Pruned ${stale.length} stale channel(s)`)
      }
      finalEntries = finalEntries.filter((ch) => !ch.deleted)
      if (finalEntries.length === 0) {
        cliLogger.log('No projects registered')
        process.exit(0)
      }
    }

    if (finalEntries.length === 0) {
      cliLogger.log('No projects registered')
      process.exit(0)
    }

    if (options.json) {
      const output = finalEntries.map((ch) => ({
        channel_id: ch.channel_id,
        channel_name: ch.channelName,
        guild_id: ch.guildId,
        guild_name: ch.guildName,
        directory: ch.directory || null,
        folder_name: ch.directory ? path.basename(ch.directory) : null,
        deleted: ch.deleted,
        is_local: ch.isLocal,
      }))
      console.log(JSON.stringify(output, null, 2))
      process.exit(0)
    }

    for (const ch of finalEntries) {
      const deletedTag = ch.deleted ? ' (deleted from Discord)' : ''
      const remoteTag = !ch.isLocal ? ' [remote]' : ''
      const channelLabel = ch.channelName ? `#${ch.channelName}` : ch.channel_id
      const guildLabel = ch.guildName || ch.guildId || ''
      const guildSuffix = guildLabel ? ` (${guildLabel})` : ''
      console.log(`\n${channelLabel}${guildSuffix}${deletedTag}${remoteTag}`)
      if (ch.isLocal && ch.directory) {
        const folderName = path.basename(ch.directory)
        console.log(`   Folder: ${folderName}`)
        console.log(`   Directory: ${ch.directory}`)
      } else if (!ch.isLocal) {
        console.log(`   (Not registered on this machine)`)
      }
      console.log(`   Channel ID: ${ch.channel_id}`)
      if (ch.guildId) {
        console.log(`   Guild ID: ${ch.guildId}`)
      }
    }

    process.exit(0)
  })

cli
  .command(
    'project remove <channelId>',
    'Remove a project channel mapping from the local database (does not delete the Discord channel)',
  )
  .action(async (channelId: string) => {
    await initDatabase()

    const db = await getDb()
    const row = await db.query.channel_directories.findFirst({
      where: { channel_id: channelId },
    })

    if (!row) {
      cliLogger.error(`No channel mapping found for channel ID: ${channelId}`)
      process.exit(EXIT_NO_RESTART)
    }

    const removed = await deleteChannelDirectoryById(channelId)
    if (!removed) {
      cliLogger.error(`Channel mapping disappeared before it could be removed: ${channelId}`)
      process.exit(EXIT_NO_RESTART)
    }
    cliLogger.log(`Removed channel mapping:`)
    cliLogger.log(`  Channel ID: ${channelId}`)
    cliLogger.log(`  Directory: ${row.directory}`)
    cliLogger.log(`  Type: ${row.channel_type}`)
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
