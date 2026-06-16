// Utility terminal commands for Discord users, tunnels, screenshares, and database paths.
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
import { getBotTokenWithMode, getThreadSession, getThreadIdBySessionId, getSessionEventSnapshot, createScheduledTask, listScheduledTasks, cancelScheduledTask, getScheduledTask, updateScheduledTask, getSessionStartSourcesBySessionIds, deleteChannelDirectoryById, findChannelsByDirectory } from '../database.js'
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
    'user list',
    'Search for Discord users in a guild/server. Returns user IDs for mentions.',
  )
  .option('-g, --guild <guildId>', 'Discord guild/server ID (required)')
  .option('-q, --query [query]', 'Search query to filter users by name')
  .action(async (options) => {
    try {
      if (!options.guild) {
        cliLogger.error('Guild ID is required. Use --guild <guildId>')
        process.exit(EXIT_NO_RESTART)
      }
      const guildId = String(options.guild)
      // Bare `--query` comes through as `''`; collapse it to undefined
      const query = options.query || undefined

      await initDatabase()
      const { token: botToken } = await resolveBotCredentials()
      const rest = createDiscordRest(botToken)

      const membersResult = await (async () => {
        if (query) {
          return await rest.get(Routes.guildMembersSearch(guildId), {
            query: new URLSearchParams({ query, limit: '20' }),
          })
        }
        return await rest.get(Routes.guildMembers(guildId), {
          query: new URLSearchParams({ limit: '20' }),
        })
      })().catch((error) => new Error('Discord member list failed', { cause: error }))

      if (membersResult instanceof Error) {
        if (isDiscordMemberLookupUnavailable(membersResult)) {
          cliLogger.error(formatMemberLookupUnavailableMessage())
          process.exit(EXIT_NO_RESTART)
        }
        cliLogger.error(membersResult.message)
        process.exit(EXIT_NO_RESTART)
      }

      const members = Array.isArray(membersResult)
        ? membersResult.filter(isGuildMemberSearchResult)
        : []

      if (members.length === 0) {
        const msg = query
          ? `No users found matching "${query}"`
          : 'No users found in guild'
        cliLogger.log(msg)
        process.exit(0)
      }

      const userList = members
        .map((m) => {
          const displayName = m.nick || m.user.global_name || m.user.username
          return `- ${displayName} (ID: ${m.user.id}) - mention: <@${m.user.id}>`
        })
        .join('\n')

      const header = query
        ? `Found ${members.length} users matching "${query}":`
        : `Found ${members.length} users:`

      console.log(`${header}\n${userList}`)
      process.exit(0)
    } catch (error) {
      cliLogger.error(
        'Error:',
        error instanceof Error ? error.stack : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

cli
  .command('tunnel', 'Expose a local port via tunnel')
  .option('-p, --port <port>', 'Local port to expose (optional when command output reveals one)')
  .option(
    '-t, --tunnel-id [id]',
    'Custom tunnel ID (only for services safe to expose publicly; prefer random default)',
  )
  .option('-h, --host [host]', 'Local host (default: localhost)')
  .option('-s, --server [url]', 'Tunnel server URL')
  .option('-k, --kill', 'Kill any existing process on the port before starting')
  .action(async (options) => {
      const { runTunnel, parseCommandFromArgv } = await import(
        'traforo/run-tunnel'
      )
      const { command } = parseCommandFromArgv(process.argv)

      if (!options.port && command.length === 0) {
        cliLogger.error('Error: --port is required unless a command is provided after --')
        cliLogger.error(`\nUsage: kimaki tunnel [-- command]`)
        cliLogger.error(`   or: kimaki tunnel --port <port>`)
        process.exit(EXIT_NO_RESTART)
      }

      const port = options.port ? parseInt(options.port, 10) : undefined
      if (options.port && (!port || port < 1 || port > 65535)) {
        cliLogger.error(`Error: Invalid port number: ${options.port}`)
        process.exit(EXIT_NO_RESTART)
      }

      await runTunnel({
        port,
        tunnelId: options.tunnelId || undefined,
        localHost: options.host || undefined,
        baseDomain: 'kimaki.dev',
        serverUrl: options.server || undefined,
        command: command.length > 0 ? command : undefined,
        kill: options.kill,
      })
    },
  )

cli
  .command(
    'screenshare',
    'Share your screen via VNC tunnel. Auto-stops after 30 minutes. Runs until Ctrl+C. For background usage, start with bunx tuistory --help, then run it in a tuistory session.',
  )
  .action(async () => {
    const { startScreenshare } = await import(
      '../commands/screenshare.js'
    )
    try {
      const session = await startScreenshare({
        sessionKey: 'cli',
        startedBy: 'cli',
      })
      cliLogger.log(`Screen sharing started: ${session.noVncUrl}`)
      cliLogger.log('Press Ctrl+C to stop')
    } catch (err) {
      cliLogger.error(
        'Failed to start screen share:',
        err instanceof Error ? err.message : String(err),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

cli
  .command('sqlitedb', 'Show the location of the SQLite database file')
  .action(() => {
    const dataDir = getDataDir()
    const dbPath = path.join(dataDir, 'discord-sessions.db')
    cliLogger.log(dbPath)
  })


export default cli
