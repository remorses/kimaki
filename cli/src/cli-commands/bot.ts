// Bot configuration terminal commands for install URLs and Discord presence.
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
  .command('discord-install-url', 'Print the bot install URL and exit')
  .option(
    '--data-dir <path>',
    'Data directory for config and database (default: ~/.kimaki)',
  )
  .option(
    '--gateway',
    'Print the gateway install URL and create local gateway credentials if missing',
  )
  .option(
    '--gateway-callback-url <url>',
    'After gateway OAuth install, redirect to this URL instead of the default success page (appends ?guild_id=<id>)',
  )
  .action(async (options) => {
    try {
      if (options.dataDir) {
        setDataDir(options.dataDir)
        cliLogger.log(`Using data directory: ${getDataDir()}`)
      }

      initLogFile(getDataDir())
      await printDiscordInstallUrlAndExit({
        gateway: options.gateway,
        gatewayCallbackUrl: options.gatewayCallbackUrl,
      })
    } catch (error) {
      cliLogger.error(
        'Error:',
        error instanceof Error ? error.stack : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

// ── bot command group ────────────────────────────────────────────────────

const ACTIVITY_TYPE_MAP: Record<string, ActivityType> = {
  playing: ActivityType.Playing,
  watching: ActivityType.Watching,
  listening: ActivityType.Listening,
  competing: ActivityType.Competing,
  custom: ActivityType.Custom,
}

const STATUS_MAP: Record<string, PresenceStatusData> = {
  online: 'online',
  idle: 'idle',
  dnd: 'dnd',
  invisible: 'invisible',
}

cli
  .command(
    'bot install-url',
    'Print the bot install URL',
  )
  .option(
    '--data-dir <path>',
    'Data directory for config and database (default: ~/.kimaki)',
  )
  .option(
    '--gateway',
    'Print the gateway install URL and create local gateway credentials if missing',
  )
  .option(
    '--gateway-callback-url <url>',
    'After gateway OAuth install, redirect to this URL instead of the default success page (appends ?guild_id=<id>)',
  )
  .action(async (options) => {
    try {
      if (options.dataDir) {
        setDataDir(options.dataDir)
        cliLogger.log(`Using data directory: ${getDataDir()}`)
      }

      initLogFile(getDataDir())
      await printDiscordInstallUrlAndExit({
        gateway: options.gateway,
        gatewayCallbackUrl: options.gatewayCallbackUrl,
      })
    } catch (error) {
      cliLogger.error(
        'Error:',
        error instanceof Error ? error.stack : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })

// Max length for activity name/state — Discord silently truncates beyond 128 chars.
const MAX_STATUS_TEXT_LENGTH = 128

// Login timeout for temporary discord.js clients (10s).
const BOT_LOGIN_TIMEOUT_MS = 10_000

// Wait for gateway opcode 3 websocket frame to flush before destroying the client.
const PRESENCE_FLUSH_DELAY_MS = 1200

/**
 * Create a temporary discord.js client, connect to gateway, run a callback,
 * then tear down. Includes a login timeout so the command doesn't hang forever.
 */
async function withTempDiscordClient({
  token,
  onReady,
}: {
  token: string
  onReady: (client: import('discord.js').Client<true>) => Promise<void>
}) {
  const client = await createDiscordClient()
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        client.once(Events.ClientReady, () => {
          resolve()
        })
        client.once(Events.Error, reject)
        client.login(token).catch(reject)
      }),
      new Promise<void>((_, reject) => {
        setTimeout(() => {
          reject(new Error('Discord login timed out (10s)'))
        }, BOT_LOGIN_TIMEOUT_MS)
      }),
    ])
    if (!client.isReady() || !client.user) {
      throw new Error('Discord client ready but user is missing')
    }
    await onReady(client)
  } finally {
    void client.destroy()
  }
}

cli
  .command('bot status set <text>', 'Set the bot presence/status in Discord')
  .option(
    '--data-dir <path>',
    'Data directory for config and database (default: ~/.kimaki)',
  )
  .option(
    '--type <activityType>',
    'Activity type: playing, watching, listening, competing, custom (default: custom)',
  )
  .option(
    '--status <onlineStatus>',
    'Online status: online, idle, dnd, invisible (default: online)',
  )
  .action(
    async (
      text: string,
      options: {
        dataDir?: string
        type?: string
        status?: string
      },
    ) => {
      try {
        if (options.dataDir) {
          setDataDir(options.dataDir)
        }
        initLogFile(getDataDir())
        await initDatabase()

        const botRow = await getBotTokenWithMode()
        if (!botRow) {
          cliLogger.error('No bot configured. Run `kimaki` first.')
          process.exit(EXIT_NO_RESTART)
        }
        if (botRow.mode === 'gateway') {
          cliLogger.error(
            'Cannot set status in gateway mode — it would change the shared bot status for all users.',
          )
          process.exit(EXIT_NO_RESTART)
        }

        if (text.length > MAX_STATUS_TEXT_LENGTH) {
          cliLogger.error(
            `Status text too long (${text.length} chars, max ${MAX_STATUS_TEXT_LENGTH}).`,
          )
          process.exit(EXIT_NO_RESTART)
        }

        const activityTypeKey = (options.type || 'custom').toLowerCase()
        const activityType = ACTIVITY_TYPE_MAP[activityTypeKey]
        if (activityType === undefined) {
          cliLogger.error(
            `Unknown activity type: ${options.type}. Use: playing, watching, listening, competing, custom`,
          )
          process.exit(EXIT_NO_RESTART)
        }

        const statusKey = (options.status || 'online').toLowerCase()
        const onlineStatus = STATUS_MAP[statusKey]
        if (!onlineStatus) {
          cliLogger.error(
            `Unknown status: ${options.status}. Use: online, idle, dnd, invisible`,
          )
          process.exit(EXIT_NO_RESTART)
        }

        cliLogger.log('Connecting to Discord...')
        await withTempDiscordClient({
          token: botRow.token,
          onReady: async (client) => {
            // For custom activity type, use state field (shows as the status text).
            // For other types, use name field (shows as "Playing X", "Watching X", etc).
            const activity =
              activityType === ActivityType.Custom
                ? { name: 'Custom Status', type: activityType, state: text }
                : { name: text, type: activityType }

            client.user.setPresence({
              activities: [activity],
              status: onlineStatus,
            })

            // setPresence queues a gateway opcode 3 over websocket.
            // Wait so the frame flushes before we tear down the connection.
            await new Promise((resolve) => {
              setTimeout(resolve, PRESENCE_FLUSH_DELAY_MS)
            })

            cliLogger.log(
              `Status set: ${activityTypeKey === 'custom' ? text : `${activityTypeKey} ${text}`} (${statusKey})`,
            )
          },
        })

        process.exit(0)
      } catch (error) {
        cliLogger.error(
          'Error:',
          error instanceof Error ? error.stack : String(error),
        )
        process.exit(EXIT_NO_RESTART)
      }
    },
  )

cli
  .command('bot token', 'Print the bot token for use in CI and automation (KIMAKI_BOT_TOKEN)')
  .option(
    '--data-dir <path>',
    'Data directory for config and database (default: ~/.kimaki)',
  )
  .action(async (options) => {
    try {
      if (options.dataDir) {
        setDataDir(options.dataDir)
      }
      initLogFile(getDataDir())
      await initDatabase()

      const botRow = await getBotTokenWithMode()
      if (!botRow) {
        cliLogger.error('No bot configured. Run `kimaki` first.')
        process.exit(EXIT_NO_RESTART)
      }

      // Print the token to stdout so it can be captured by scripts.
      // Use process.stdout.write to avoid extra newline from console.log
      // when piping to other commands.
      process.stdout.write(botRow.token + '\n')
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
  .command('bot status clear', 'Clear the bot presence/status')
  .option(
    '--data-dir <path>',
    'Data directory for config and database (default: ~/.kimaki)',
  )
  .action(async (options: { dataDir?: string }) => {
    try {
      if (options.dataDir) {
        setDataDir(options.dataDir)
      }
      initLogFile(getDataDir())
      await initDatabase()

      const botRow = await getBotTokenWithMode()
      if (!botRow) {
        cliLogger.error('No bot configured. Run `kimaki` first.')
        process.exit(EXIT_NO_RESTART)
      }
      if (botRow.mode === 'gateway') {
        cliLogger.error(
          'Cannot clear status in gateway mode — it would change the shared bot status for all users.',
        )
        process.exit(EXIT_NO_RESTART)
      }

      cliLogger.log('Connecting to Discord...')
      await withTempDiscordClient({
        token: botRow.token,
        onReady: async (client) => {
          client.user.setPresence({
            activities: [],
            status: 'online',
          })

          await new Promise((resolve) => {
            setTimeout(resolve, PRESENCE_FLUSH_DELAY_MS)
          })

          cliLogger.log('Status cleared')
        },
      })

      process.exit(0)
    } catch (error) {
      cliLogger.error(
        'Error:',
        error instanceof Error ? error.stack : String(error),
      )
      process.exit(EXIT_NO_RESTART)
    }
  })


export default cli
