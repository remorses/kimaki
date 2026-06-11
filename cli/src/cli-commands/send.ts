// Terminal send command for creating Discord threads and scheduling prompts.
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
import { getProjectEmoji, prefixNameWithEmoji } from '../project-emojis.js'
import { setDataDir, setProjectsDir, getDataDir, getProjectsDir } from '../config.js'
import { execAsync, resolveSessionWorkingDirectory } from '../worktrees.js'
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
    'send',
    'Send a message to a Discord channel/thread. Default creates a thread; use --thread/--session to continue existing.',
  )
  .alias('start-session') // backwards compatibility
  .option('-c, --channel <channelId>', 'Discord channel ID')
  .option(
    '-d, --project <path>',
    'Project directory (alternative to --channel)',
  )
  .option('-p, --prompt <prompt>', 'Message content')
  .option(
    '-n, --name [name]',
    'Thread name (optional, defaults to prompt preview)',
  )
  .option(
    '-a, --app-id [appId]',
    'Bot application ID (required if no local database)',
  )
  .option(
    '--notify-only',
    'Create notification thread without starting AI session',
  )
  .option(
    '--worktree [name]',
    'Create git worktree for session (name optional, derives from thread name)',
  )
  .option(
    '--cwd <path>',
    'Start session in an existing project subfolder or git worktree directory',
  )
  .option('-u, --user <user>', 'Discord user ID, mention, or username to add to thread')
  .option('--agent <agent>', 'Agent to use for the session')
  .option('--model <model>', 'Model to use (format: provider/model)')
  .option(
    '--permission <rule>',
    z.array(z.string()).describe(
      'Session permission rule (repeatable). Format: "tool:action" or "tool:pattern:action". ' +
      'Actions: allow, deny, ask. Examples: --permission "bash:deny" --permission "edit:deny"',
    ),
  )
  .option(
    '--injection-guard <pattern>',
    z.array(z.string()).describe(
      'Injection guard scan pattern (repeatable). Enables prompt injection detection for this session. ' +
      'Format: "tool:argsGlob". Examples: --injection-guard "bash:*" --injection-guard "webfetch:*"',
    ),
  )
  .option(
    '--send-at <schedule>',
    'Schedule send for future (UTC ISO date/time ending in Z, or cron expression)',
  )
  .option('--thread <threadId>', 'Post prompt to an existing thread')
  .option(
    '--session <sessionId>',
    'Post prompt to thread mapped to an existing session',
  )
  .option(
    '--wait',
    'Wait for session to complete, then print session text to stdout',
  )
  .action(async (options) => {
      try {
        // `--name` / `--app-id` are optional-value flags: `undefined` when
        // omitted, `''` when passed bare, a real string when given a value.
        // `||` collapses `''` to `undefined` for downstream consumers.
        const optionAppId = options.appId || undefined
        let {
          channel: channelId,
          prompt,
          notifyOnly,
          thread: threadId,
          session: sessionId,
        } = options
        let name: string | undefined = options.name || undefined
        const { project: projectPath } = options
        const sendAt = options.sendAt

        const existingThreadMode = Boolean(threadId || sessionId)

        if (threadId && sessionId) {
          cliLogger.error('Use either --thread or --session, not both')
          process.exit(EXIT_NO_RESTART)
        }

        if (existingThreadMode && (channelId || projectPath)) {
          cliLogger.error(
            'Cannot combine --thread/--session with --channel/--project',
          )
          process.exit(EXIT_NO_RESTART)
        }

        // Default to current directory if neither --channel nor --project provided
        const resolvedProjectPath = existingThreadMode
          ? undefined
          : projectPath || (!channelId ? '.' : undefined)

        if (!prompt) {
          cliLogger.error('Prompt is required. Use --prompt <prompt>')
          process.exit(EXIT_NO_RESTART)
        }

        if (sendAt) {
          if (options.wait) {
            cliLogger.error('Cannot use --wait with --send-at')
            process.exit(EXIT_NO_RESTART)
          }
          if (prompt.length > 1900) {
            cliLogger.error(
              '--send-at currently supports prompts up to 1900 characters',
            )
            process.exit(EXIT_NO_RESTART)
          }
        }

        const parsedSchedule = (() => {
          if (!sendAt) {
            return null
          }
          // Cron expressions use UTC so the schedule is consistent regardless of
          // which machine runs the bot. The system message tells the model to use UTC.
          return parseSendAtValue({
            value: sendAt,
            now: new Date(),
            timezone: 'UTC',
          })
        })()
        if (parsedSchedule instanceof Error) {
          cliLogger.error(parsedSchedule.message)
          if (parsedSchedule.cause instanceof Error) {
            cliLogger.error(parsedSchedule.cause.message)
          }
          process.exit(EXIT_NO_RESTART)
        }

        const waitStartedAtMs = options.wait ? Date.now() : undefined

        if (!existingThreadMode && options.worktree && notifyOnly) {
          cliLogger.error('Cannot use --worktree with --notify-only')
          process.exit(EXIT_NO_RESTART)
        }

        if (options.cwd && options.worktree) {
          cliLogger.error('Cannot use --cwd with --worktree')
          process.exit(EXIT_NO_RESTART)
        }

        if (options.cwd && notifyOnly) {
          cliLogger.error('Cannot use --cwd with --notify-only')
          process.exit(EXIT_NO_RESTART)
        }

        if (options.wait && notifyOnly) {
          cliLogger.error('Cannot use --wait with --notify-only')
          process.exit(EXIT_NO_RESTART)
        }

        if (existingThreadMode) {
          const incompatibleFlags: string[] = []
          if (notifyOnly) {
            incompatibleFlags.push('--notify-only')
          }
          if (options.worktree) {
            incompatibleFlags.push('--worktree')
          }
          if (options.cwd) {
            incompatibleFlags.push('--cwd')
          }
          if (name) {
            incompatibleFlags.push('--name')
          }
          if (options.user) {
            incompatibleFlags.push('--user')
          }

          if (incompatibleFlags.length > 0) {
            cliLogger.error(
              `Incompatible options with --thread/--session: ${incompatibleFlags.join(', ')}`,
            )
            process.exit(EXIT_NO_RESTART)
          }
        }

        // Initialize database first
        await initDatabase()

        const { token: botToken, appId } = await resolveBotCredentials({
          appIdOverride: optionAppId,
        })

        // If --project provided (or defaulting to cwd), resolve to channel ID
        if (resolvedProjectPath) {
          const absolutePath = path.resolve(resolvedProjectPath)

          if (!fs.existsSync(absolutePath)) {
            cliLogger.error(`Directory does not exist: ${absolutePath}`)
            process.exit(EXIT_NO_RESTART)
          }

          cliLogger.log('Looking up channel for project...')

          // Check if channel already exists for this directory or a parent directory
          // This allows running from subfolders of a registered project
          try {
            // Helper to find channel for a path.
            const findChannelForPath = async (
              dirPath: string,
            ): Promise<
              { channel_id: string; directory: string } | undefined
            > => {
              const channels = await findChannelsByDirectory({
                directory: dirPath,
                channelType: 'text',
              })
              return channels[0]
            }

            // Try exact match first, then walk up parent directories
            let existingChannel:
              | { channel_id: string; directory: string }
              | undefined
            let searchPath = absolutePath
            while (searchPath !== path.dirname(searchPath)) {
              existingChannel = await findChannelForPath(searchPath)
              if (existingChannel) break
              searchPath = path.dirname(searchPath)
            }

            if (existingChannel) {
              channelId = existingChannel.channel_id
              if (existingChannel.directory !== absolutePath) {
                cliLogger.log(
                  `Found parent project channel: ${existingChannel.directory}`,
                )
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
                void client.login(botToken)
              })

              // Get guild from existing channels or first available
              const guild = await (async () => {
                const existingChannelId = await (await getDb()).query.channel_directories.findFirst({
                  where: { channel_type: 'text' },
                  orderBy: { created_at: 'desc' },
                  columns: { channel_id: true },
                }).then((row) => row?.channel_id)

                if (existingChannelId) {
                  try {
                    const ch = await client.channels.fetch(existingChannelId)
                    if (ch && !ch.isDMBased()) {
                      return ch.guild
                    }
                  } catch (error) {
                    cliLogger.debug(
                      'Failed to fetch existing channel while selecting guild:',
                      error instanceof Error ? error.stack : String(error),
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
                  throw new Error(
                    'No guild found. Add the bot to a server first.',
                  )
                }
                return firstGuild
              })()

              const { textChannelId } = await createProjectChannels({
                guild,
                projectDirectory: absolutePath,
                botName: client.user?.username,
              })

              channelId = textChannelId
              cliLogger.log(`Created channel: ${channelId}`)

              void client.destroy()
            }
          } catch (e) {
            cliLogger.log('Failed to resolve project')
            throw e
          }
        }

        const rest = createDiscordRest(botToken)

        if (existingThreadMode) {
          const targetThreadId = await (async (): Promise<string> => {
            if (threadId) {
              return threadId
            }
            if (!sessionId) {
              throw new Error('Thread ID not resolved')
            }
            const resolvedThreadId = await getThreadIdBySessionId(sessionId)
            if (!resolvedThreadId) {
              throw new Error(
                `No Discord thread found for session: ${sessionId}`,
              )
            }
            return resolvedThreadId
          })()

          const threadData = (await rest.get(
            Routes.channel(targetThreadId),
          )) as {
            id: string
            name: string
            type: number
            parent_id?: string
            guild_id: string
          }

          if (!isThreadChannelType(threadData.type)) {
            throw new Error(`Channel is not a thread: ${targetThreadId}`)
          }

          if (!threadData.parent_id) {
            throw new Error(`Thread has no parent channel: ${targetThreadId}`)
          }

          const channelConfig = await getChannelDirectory(threadData.parent_id)
          if (!channelConfig) {
            throw new Error(
              'Thread parent channel is not configured with a project directory',
            )
          }

          if (parsedSchedule) {
            const payload: ScheduledTaskPayload = {
              kind: 'thread',
              threadId: targetThreadId,
              prompt,
              agent: options.agent || null,
              model: options.model || null,
              username: null,
              userId: null,
              permissions: options.permission?.length ? options.permission : null,
              injectionGuardPatterns: options.injectionGuard?.length ? options.injectionGuard : null,
            }
            const taskId = await createScheduledTask({
              scheduleKind: parsedSchedule.scheduleKind,
              runAt: parsedSchedule.runAt,
              cronExpr: parsedSchedule.cronExpr,
              timezone: parsedSchedule.timezone,
              nextRunAt: parsedSchedule.nextRunAt,
              payloadJson: serializeScheduledTaskPayload(payload),
              promptPreview: getPromptPreview(prompt),
              channelId: threadData.parent_id,
              threadId: targetThreadId,
              sessionId: sessionId || undefined,
              projectDirectory: channelConfig.directory,
            })

            const threadUrl = `https://discord.com/channels/${threadData.guild_id}/${threadData.id}`
            note(
              `Task ID: ${taskId}\nTarget thread: ${threadData.name}\nSchedule: ${formatTaskScheduleLine(parsedSchedule)}\n\nURL: ${threadUrl}`,
              '✅ Task Scheduled',
            )
            cliLogger.log(threadUrl)
            process.exit(0)
          }

          const threadPromptMarker: ThreadStartMarker = {
            start: true,
            ...(options.agent && { agent: options.agent }),
            ...(options.model && { model: options.model }),
            ...(options.permission?.length ? { permissions: options.permission } : {}),
            ...(options.injectionGuard?.length ? { injectionGuardPatterns: options.injectionGuard } : {}),
          }
          const promptEmbed = [
            {
              color: 0x2b2d31,
              footer: { text: YAML.stringify(threadPromptMarker) },
            },
          ]

          // Prefix the prompt so it's clear who sent it (matches /queue format).
          // Use a newline between prefix and prompt so leading /command
          // detection can find the command on its own line.
          const prefixedPrompt = `» **kimaki-cli:**\n${prompt}`

          await sendDiscordMessageWithOptionalAttachment({
            channelId: targetThreadId,
            prompt: prefixedPrompt,
            botToken,
            embeds: promptEmbed,
            rest,
          })

          const threadUrl = `https://discord.com/channels/${threadData.guild_id}/${threadData.id}`
          const existingSessionId = sessionId || await getThreadSession(targetThreadId)
          const sessionLine = existingSessionId ? `Session: ${existingSessionId}\n` : ''
          note(
            `Prompt sent to thread: ${threadData.name}\n${sessionLine}\nURL: ${threadUrl}`,
            '✅ Message Sent',
          )
          if (existingSessionId) process.stdout.write(`Session: ${existingSessionId}\n`)
          process.stdout.write(`${threadUrl}\n`)

          if (options.wait) {
            const { waitAndOutputSession } = await import('../wait-session.js')
            await waitAndOutputSession({
              threadId: targetThreadId,
              projectDirectory: channelConfig.directory,
              waitStartedAtMs,
            })
          }

          process.exit(0)
        }

        cliLogger.log('Fetching channel info...')

        if (!channelId) {
          throw new Error('Channel ID not resolved')
        }

        // Get channel info to extract directory from topic
        const channelData = (await rest.get(Routes.channel(channelId))) as {
          id: string
          name: string
          topic?: string
          guild_id: string
        }

        const channelConfig = await getChannelDirectory(channelData.id)

        if (!channelConfig && !notifyOnly) {
          cliLogger.log('Channel not configured')
          throw new Error(
            `Channel #${channelData.name} is not configured with a project directory. Run the bot first to sync channel data.`,
          )
        }

        const projectDirectory = channelConfig?.directory

        // Validate --cwd is inside the project or an existing git worktree.
        let resolvedCwd: string | undefined
        if (options.cwd) {
          // projectDirectory is guaranteed here: --cwd is incompatible with --notify-only,
          // and non-notify sends already require channelConfig above.
          const cwdResult = await resolveSessionWorkingDirectory({
            projectDirectory: projectDirectory!,
            candidatePath: options.cwd,
          })
          if (cwdResult instanceof Error) {
            cliLogger.error(cwdResult.message)
            process.exit(EXIT_NO_RESTART)
          }
          resolvedCwd = cwdResult.directory
        }

        const resolvedUser = await resolveDiscordUserOption({
          user: options.user,
          guildId: channelData.guild_id,
          rest,
        })
        if (resolvedUser instanceof Error) {
          cliLogger.error(resolvedUser.message)
          process.exit(EXIT_NO_RESTART)
        }

        cliLogger.log('Creating starter message...')

        // Compute thread name and worktree name early (needed for embed)
        const cleanPrompt = stripMentions(prompt)
        const projectEmoji = getProjectEmoji(projectDirectory)
        const baseThreadName =
          name ||
          (cleanPrompt.length > 80
            ? cleanPrompt.slice(0, 77) + '...'
            : cleanPrompt)
        // Explicit string => use as-is via formatWorktreeName (no vowel strip).
        // Boolean true => derived from thread/prompt, compress via formatAutoWorktreeName.
        const worktreeName = options.worktree
          ? typeof options.worktree === 'string'
            ? formatWorktreeName(options.worktree)
            : formatAutoWorktreeName(baseThreadName)
          : undefined
        // Project emoji always prefixes the visible thread name. The worktree
        // prefix is inserted between the emoji and the thread name so the
        // thread reads as `<emoji> <🌳worktree> actual task name`.
        const worktreePrefixed = worktreeName
          ? `${WORKTREE_PREFIX}${baseThreadName}`
          : baseThreadName
        const threadName = prefixNameWithEmoji(
          worktreePrefixed,
          projectEmoji,
        )

        if (parsedSchedule) {
          const payload: ScheduledTaskPayload = {
            kind: 'channel',
            channelId,
            prompt,
            name: name || null,
            notifyOnly: Boolean(notifyOnly),
            worktreeName: worktreeName || null,
            cwd: resolvedCwd || null,
            agent: options.agent || null,
            model: options.model || null,
            username: resolvedUser?.username || null,
            userId: resolvedUser?.id || null,
            permissions: options.permission?.length ? options.permission : null,
            injectionGuardPatterns: options.injectionGuard?.length ? options.injectionGuard : null,
          }
          const taskId = await createScheduledTask({
            scheduleKind: parsedSchedule.scheduleKind,
            runAt: parsedSchedule.runAt,
            cronExpr: parsedSchedule.cronExpr,
            timezone: parsedSchedule.timezone,
            nextRunAt: parsedSchedule.nextRunAt,
            payloadJson: serializeScheduledTaskPayload(payload),
            promptPreview: getPromptPreview(prompt),
            channelId,
            projectDirectory,
          })

          const channelUrl = `https://discord.com/channels/${channelData.guild_id}/${channelId}`
          note(
            `Task ID: ${taskId}\nTarget channel: #${channelData.name}\nSchedule: ${formatTaskScheduleLine(parsedSchedule)}\n\nURL: ${channelUrl}`,
            '✅ Task Scheduled',
          )
          cliLogger.log(channelUrl)
          process.exit(0)
        }

        // Embed marker for auto-start sessions (unless --notify-only)
        // Bot parses this YAML to know it should start a session, optionally create a worktree, and set initial user
        const embedMarker: ThreadStartMarker | undefined = notifyOnly
          ? undefined
          : {
              start: true,
              ...(worktreeName && { worktree: worktreeName }),
              ...(resolvedCwd && { cwd: resolvedCwd }),
              ...(resolvedUser && {
                username: resolvedUser.username,
                userId: resolvedUser.id,
              }),
              ...(options.agent && { agent: options.agent }),
              ...(options.model && { model: options.model }),
              ...(options.permission?.length && { permissions: options.permission }),
              ...(options.injectionGuard?.length && { injectionGuardPatterns: options.injectionGuard }),
            }
        const autoStartEmbed = embedMarker
          ? [{ color: 0x2b2d31, footer: { text: YAML.stringify(embedMarker) } }]
          : undefined

        const starterMessage = await sendDiscordMessageWithOptionalAttachment({
          channelId,
          prompt,
          botToken,
          embeds: autoStartEmbed,
          rest,
        })

        // For notify-only on non-project channels, just post the message without
        // creating a thread. There's no session to start, so a thread is unnecessary.
        if (notifyOnly && !channelConfig) {
          const messageUrl = `https://discord.com/channels/${channelData.guild_id}/${channelId}/${starterMessage.id}`
          note(
            `Channel: #${channelData.name}\n\nMessage sent.\n\nURL: ${messageUrl}`,
            '✅ Message Sent',
          )
          process.stdout.write(`${messageUrl}\n`)
          process.exit(0)
        }

        cliLogger.log('Creating thread...')

        const threadData = (await rest.post(
          Routes.threads(channelId, starterMessage.id),
          {
            body: {
              name: threadName.slice(0, 100),
              auto_archive_duration: 1440, // 1 day
            },
          },
        )) as { id: string; name: string }

        cliLogger.log('Thread created!')

        // Add user to thread if specified
        if (resolvedUser) {
          cliLogger.log(`Adding user ${resolvedUser.username} to thread...`)
          await rest.put(Routes.threadMembers(threadData.id, resolvedUser.id))
        }

        const threadUrl = `https://discord.com/channels/${channelData.guild_id}/${threadData.id}`

        // Poll for session ID if the bot is expected to auto-start (not --notify-only).
        // The bot picks up the thread and creates a session asynchronously;
        // we wait briefly so the caller can reference the session immediately.
        let newSessionId: string | undefined
        if (!notifyOnly) {
          const { waitForSessionId } = await import('../wait-session.js')
          newSessionId = await waitForSessionId({
            threadId: threadData.id,
            timeoutMs: 15_000,
          }).catch((e) => {
            cliLogger.warn(`Could not resolve session ID: ${e instanceof Error ? e.message : String(e)}`)
            return undefined
          })
        }

        const worktreeNote = worktreeName
          ? `\nWorktree: ${worktreeName} (will be created by bot)`
          : resolvedCwd
            ? `\nWorking directory: ${resolvedCwd}`
            : ''
        const sessionLine = newSessionId ? `\nSession: ${newSessionId}` : ''
        const directoryLine = projectDirectory ? `\nDirectory: ${projectDirectory}` : ''
        const successMessage = notifyOnly
          ? `Thread: ${threadData.name}${directoryLine}\n\nNotification created. Reply to start a session.\n\nURL: ${threadUrl}`
          : `Thread: ${threadData.name}${directoryLine}${worktreeNote}${sessionLine}\n\nThe running bot will pick this up and start the session.\n\nURL: ${threadUrl}`

        note(successMessage, '✅ Thread Created')

        if (newSessionId) process.stdout.write(`Session: ${newSessionId}\n`)
        process.stdout.write(`${threadUrl}\n`)

        if (options.wait) {
          // projectDirectory is guaranteed here: --wait is incompatible with --notify-only,
          // and non-notify sends already require channelConfig above.
          const { waitAndOutputSession } = await import('../wait-session.js')
          await waitAndOutputSession({
            threadId: threadData.id,
            projectDirectory: projectDirectory!,
            waitStartedAtMs,
          })
        }

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


export default cli
