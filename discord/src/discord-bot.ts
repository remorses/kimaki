// Core Discord bot module that handles message events and bot lifecycle.
// Bridges Discord messages to OpenCode sessions, manages voice connections,
// and orchestrates the main event loop for the Kimaki bot.

import {
  initDatabase,
  closeDatabase,
  getThreadWorktree,
  createPendingWorktree,
  setWorktreeReady,
  setWorktreeError,
  getChannelWorktreesEnabled,
  getChannelMentionMode,
  getChannelDirectory,
  getPrisma,
  cancelAllPendingIpcRequests,
} from './database.js'
import {
  stopOpencodeServer,
} from './opencode.js'
import { formatWorktreeName } from './commands/new-worktree.js'
import { WORKTREE_PREFIX } from './commands/merge-worktree.js'
import { createWorktreeWithSubmodules } from './worktrees.js'
import {
  escapeBackticksInCodeBlocks,
  splitMarkdownForDiscord,
  SILENT_MESSAGE_FLAGS,
  stripMentions,
} from './discord-utils.js'
import {
  type ThreadStartMarker,
} from './system-message.js'
import yaml from 'js-yaml'
import {
  preprocessExistingThreadMessage,
  preprocessNewThreadMessage,
} from './message-preprocessing.js'
import { cancelPendingActionButtons } from './commands/action-buttons.js'
import { cancelPendingQuestion, type CancelQuestionResult } from './commands/ask-question.js'
import { cancelPendingFileUpload } from './commands/file-upload.js'
import { cancelHtmlActionsForThread } from './html-actions.js'
import {
  ensureKimakiCategory,
  ensureKimakiAudioCategory,
  createProjectChannels,
  getChannelsWithDescriptions,
  type ChannelWithTags,
} from './channel-management.js'
import {
  voiceConnections,
  cleanupVoiceConnection,
  registerVoiceStateHandler,
} from './voice-handler.js'
import {
  type SessionStartSourceContext,
} from './session-handler/model-utils.js'
import {
  getOrCreateRuntime,
  disposeRuntime,
  setDefaultRuntimeAdapter,
} from './session-handler/thread-session-runtime.js'
import { runShellCommand } from './commands/run-command.js'
import { registerInteractionHandler } from './interaction-handler.js'
import { stopHranaServer } from './hrana-server.js'
import { notifyError } from './sentry.js'
import { flushDebouncedProcessCallbacks } from './debounced-process-flush.js'
import { startRuntimeIdleSweeper } from './runtime-idle-sweeper.js'
import {
  createDiscordAdapter,
  createDiscordClient,
} from './platform/discord-adapter.js'
import type { MessageTarget, PlatformMessage, PlatformThread } from './platform/types.js'

export {
  initDatabase,
  closeDatabase,
  getChannelDirectory,
  getPrisma,
} from './database.js'
export { initializeOpencodeForDirectory } from './opencode.js'
export { createDiscordClient } from './platform/discord-adapter.js'
export {
  escapeBackticksInCodeBlocks,
  splitMarkdownForDiscord,
} from './discord-utils.js'
export { getOpencodeSystemMessage } from './system-message.js'
export {
  ensureKimakiCategory,
  ensureKimakiAudioCategory,
  createProjectChannels,
  createDefaultKimakiChannel,
  getChannelsWithDescriptions,
} from './channel-management.js'
export type { ChannelWithTags } from './channel-management.js'

import {
  Client,
  Events,
  ThreadAutoArchiveDuration,
} from 'discord.js'
import fs from 'node:fs'
import * as errore from 'errore'
import { createLogger, formatErrorWithStack, LogPrefix } from './logger.js'
import { writeHeapSnapshot, startHeapMonitor } from './heap-monitor.js'
import { startTaskRunner } from './task-runner.js'
import { setGlobalDispatcher, Agent } from 'undici'

// Increase connection pool to prevent deadlock when multiple sessions have open SSE streams.
// Each session's event.subscribe() holds a connection; without enough connections,
// regular HTTP requests (question.reply, session.prompt) get blocked → deadlock.
setGlobalDispatcher(
  new Agent({ headersTimeout: 0, bodyTimeout: 0, connections: 500 }),
)

const discordLogger = createLogger(LogPrefix.DISCORD)
const voiceLogger = createLogger(LogPrefix.VOICE)

// Well-known WebSocket and Discord Gateway close codes for diagnostic logging.
// Gateway proxy redeploys cause an abrupt TCP drop (code 1006) because the proxy
// doesn't send a close frame to clients before shutting down. discord.js then
// enters reconnection mode. The ShardReconnecting event intentionally strips the
// close code for recoverable disconnects, so we track it ourselves from the
// lower-level ShardDisconnect and ShardError events and correlate by shard ID.
function describeCloseCode(code: number): string {
  const codes: Record<number, string> = {
    1000: 'normal closure',
    1001: 'going away',
    1006: 'abnormal closure (no close frame received)',
    1011: 'unexpected server error',
    1012: 'service restart',
    4000: 'unknown error',
    4001: 'unknown opcode',
    4002: 'decode error',
    4003: 'not authenticated',
    4004: 'authentication failed',
    4005: 'already authenticated',
    4007: 'invalid seq',
    4008: 'rate limited',
    4009: 'session timed out',
    4010: 'invalid shard',
    4011: 'sharding required',
    4012: 'invalid API version',
    4013: 'invalid intents',
    4014: 'disallowed intents',
  }
  return codes[code] || 'unknown'
}

// Per-shard state for tracking reconnection context.
// When discord.js fires ShardReconnecting it only provides the shard ID.
// We stash the last error / close code from preceding events so the
// reconnecting log line can include the actual cause.
interface ShardReconnectInfo {
  lastError?: Error
  lastDisconnectCode?: number
  attempts: number
}
const shardReconnectState = new Map<number, ShardReconnectInfo>()

function getOrCreateShardState(shardId: number): ShardReconnectInfo {
  let state = shardReconnectState.get(shardId)
  if (!state) {
    state = { attempts: 0 }
    shardReconnectState.set(shardId, state)
  }
  return state
}

function parseEmbedFooterMarker<T extends Record<string, unknown>>({
  footer,
}: {
  footer: string | undefined
}): T | undefined {
  if (!footer) {
    return undefined
  }
  try {
    const parsed = yaml.load(footer)
    if (!parsed || typeof parsed !== 'object') {
      return undefined
    }
    return parsed as T
  } catch {
    return undefined
  }
}

function parseSessionStartSourceFromMarker(
  marker: ThreadStartMarker | undefined,
): SessionStartSourceContext | undefined {
  if (!marker?.scheduledKind) {
    return undefined
  }
  if (marker.scheduledKind !== 'at' && marker.scheduledKind !== 'cron') {
    return undefined
  }
  if (
    typeof marker.scheduledTaskId !== 'number' ||
    !Number.isInteger(marker.scheduledTaskId) ||
    marker.scheduledTaskId < 1
  ) {
    return { scheduleKind: marker.scheduledKind }
  }
  return {
    scheduleKind: marker.scheduledKind,
    scheduledTaskId: marker.scheduledTaskId,
  }
}

function getThreadTarget({
  thread,
  channelId,
}: {
  thread: PlatformThread
  channelId?: string
}): MessageTarget & { threadId: string } {
  return {
    channelId: channelId || thread.parentId || thread.id,
    threadId: thread.id,
  }
}

type StartOptions = {
  token: string
  appId?: string
  /** When true, all new sessions from channel messages create git worktrees */
  useWorktrees?: boolean
}

export async function startDiscordBot({
  token,
  appId,
  discordClient,
  useWorktrees,
}: StartOptions & { discordClient?: Client }) {
  if (!discordClient) {
    discordClient = await createDiscordClient()
  }
  const adapter = await createDiscordAdapter({ client: discordClient })
  setDefaultRuntimeAdapter(adapter)

  const sendThreadMarkdown = async ({
    target,
    markdown,
    flags = SILENT_MESSAGE_FLAGS,
    replyToMessageId,
  }: {
    target: MessageTarget
    markdown: string
    flags?: number
    replyToMessageId?: string
  }) => {
    return adapter.sendMessage(target, {
      markdown,
      flags,
      replyToMessageId,
    })
  }

  const replyToIncomingMessage = async ({
    target,
    message,
    markdown,
    flags = SILENT_MESSAGE_FLAGS,
  }: {
    target: MessageTarget
    message: PlatformMessage
    markdown: string
    flags?: number
  }) => {
    return adapter.sendMessage(target, {
      markdown,
      flags,
      replyToMessageId: message.id,
    })
  }

  let currentAppId: string | undefined = appId

  const setupHandlers = async (c: Client<true>) => {
    discordLogger.log(`Discord bot logged in as ${c.user.tag}`)
    discordLogger.log(`Connected to ${c.guilds.cache.size} guild(s)`)
    discordLogger.log(`Bot user ID: ${c.user.id}`)

    if (!currentAppId) {
      await c.application?.fetch()
      currentAppId = c.application?.id

      if (!currentAppId) {
        discordLogger.error('Could not get application ID')
        throw new Error('Failed to get bot application ID')
      }
      discordLogger.log(`Bot Application ID (fetched): ${currentAppId}`)
    } else {
      discordLogger.log(`Bot Application ID (provided): ${currentAppId}`)
    }

    voiceLogger.log('[READY] Bot is ready')

    registerInteractionHandler({ discordAdapter: adapter, appId: currentAppId })
    registerVoiceStateHandler({ discordClient: c, appId: currentAppId })

    // Channel logging is informational only; do it in background so startup stays responsive.
    void (async () => {
      for (const guild of c.guilds.cache.values()) {
        discordLogger.log(`${guild.name} (${guild.id})`)

        const channels = await getChannelsWithDescriptions(guild)
        const kimakiChannels = channels.filter((ch) => ch.kimakiDirectory)

        if (kimakiChannels.length > 0) {
          discordLogger.log(
            `  Found ${kimakiChannels.length} channel(s) for this bot`,
          )
          continue
        }

        discordLogger.log('  No channels for this bot')
      }
    })().catch((error) => {
      discordLogger.warn(
        `Background guild channel scan failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }

  // If client is already ready (was logged in before being passed to us),
  // run setup immediately. Otherwise wait for the ClientReady event.
  if (discordClient.isReady()) {
    await setupHandlers(discordClient)
  } else {
    discordClient.once(Events.ClientReady, setupHandlers)
  }

  discordClient.on(Events.Error, (error) => {
    discordLogger.error('[GATEWAY] Client error:', formatErrorWithStack(error))
  })

  discordClient.on(Events.ShardError, (error, shardId) => {
    const state = getOrCreateShardState(shardId)
    state.lastError = error
    discordLogger.error(
      `[GATEWAY] Shard ${shardId} error: ${formatErrorWithStack(error)}`,
    )
  })

  discordClient.on(Events.ShardDisconnect, (event, shardId) => {
    // ShardDisconnect fires for unrecoverable close codes (4004, 4010-4014).
    // For recoverable codes discord.js fires ShardReconnecting instead.
    const state = getOrCreateShardState(shardId)
    state.lastDisconnectCode = event.code
    discordLogger.warn(
      `[GATEWAY] Shard ${shardId} disconnected: code=${event.code} (${describeCloseCode(event.code)})`,
    )
  })

  discordClient.on(Events.ShardReconnecting, (shardId) => {
    // discord.js strips the close code before emitting this event.
    // We log whatever context we captured from preceding ShardError events.
    const state = getOrCreateShardState(shardId)
    state.attempts++

    const parts: string[] = [`attempt #${state.attempts}`]
    if (state.lastDisconnectCode !== undefined) {
      parts.push(`close code=${state.lastDisconnectCode} (${describeCloseCode(state.lastDisconnectCode)})`)
    }
    if (state.lastError) {
      parts.push(`last error: ${state.lastError.message}`)
    }
    discordLogger.warn(
      `[GATEWAY] Shard ${shardId} reconnecting: ${parts.join(', ')}`,
    )
  })

  discordClient.on(Events.ShardResume, (shardId, replayedEvents) => {
    const state = shardReconnectState.get(shardId)
    if (state?.attempts) {
      discordLogger.log(
        `[GATEWAY] Shard ${shardId} resumed after ${state.attempts} reconnect attempt(s), ${replayedEvents} replayed events`,
      )
    } else {
      discordLogger.log(
        `[GATEWAY] Shard ${shardId} resumed, ${replayedEvents} replayed events`,
      )
    }
    shardReconnectState.delete(shardId)
  })

  // ShardReady fires when a shard completes a fresh IDENTIFY (not RESUME).
  // After a gateway proxy redeploy, sessions are lost (in-memory), so RESUME
  // fails with INVALID_SESSION and discord.js falls back to fresh IDENTIFY.
  discordClient.on(Events.ShardReady, (shardId) => {
    const state = shardReconnectState.get(shardId)
    if (state?.attempts) {
      discordLogger.log(
        `[GATEWAY] Shard ${shardId} ready after ${state.attempts} reconnect attempt(s)`,
      )
    }
    shardReconnectState.delete(shardId)
  })

  discordClient.on(Events.Invalidated, () => {
    discordLogger.error('[GATEWAY] Session invalidated by Discord')
  })

  adapter.onMessage(async ({
    message,
    thread: platformThread,
    target,
    kind,
    isMention,
    isSelf,
  }) => {
    try {
      const isSelfBotMessage = Boolean(isSelf)
      const promptMarker = parseEmbedFooterMarker<ThreadStartMarker>({
        footer: message.embeds[0]?.data?.footer?.text,
      })
      const isCliInjectedPrompt = Boolean(
        isSelfBotMessage && promptMarker?.cliThreadPrompt,
      )
      const sessionStartSource = isCliInjectedPrompt
        ? parseSessionStartSourceFromMarker(promptMarker)
        : undefined
      const cliInjectedUsername = isCliInjectedPrompt
        ? promptMarker?.username || 'kimaki-cli'
        : undefined
      const cliInjectedUserId = isCliInjectedPrompt
        ? promptMarker?.userId
        : undefined
      const cliInjectedAgent = isCliInjectedPrompt
        ? promptMarker?.agent
        : undefined
      const cliInjectedModel = isCliInjectedPrompt
        ? promptMarker?.model
        : undefined

      // Always ignore our own messages (unless CLI-injected prompt above).
      // Without this, assigning the Kimaki role to the bot itself would loop.
      if (isSelfBotMessage && !isCliInjectedPrompt) {
        return
      }

      // Allow bot messages through if the bot has the "Kimaki" role assigned.
      // This enables multi-agent orchestration where other bots (e.g. an
      // orchestrator) can @mention Kimaki and trigger sessions like a human.
      if (message.author?.bot) {
        const access = adapter.getMessageAccess
          ? await adapter.getMessageAccess(message)
          : 'denied'
        if (access !== 'allowed') {
          return
        }
      }

      // Ignore messages that start with a mention of another user (not the bot).
      // These are likely users talking to each other, not the bot.
      const leadingMentionMatch = message.content?.match(/^<@!?(\d+)>/)
      if (leadingMentionMatch) {
        const mentionedUserId = leadingMentionMatch[1]
        if (mentionedUserId !== discordClient.user?.id) {
          return
        }
      }

      // Check mention mode BEFORE permission check for text channels.
      // When mention mode is enabled, users without Kimaki role can message
      // without getting a permission error - we just silently ignore.
      if (kind === 'channel' && !isCliInjectedPrompt) {
        const mentionModeEnabled = await getChannelMentionMode(target.channelId)
        if (mentionModeEnabled) {
          const isShellCommand = message.content?.startsWith('!')
          if (!isMention && !isShellCommand) {
            voiceLogger.log(`[IGNORED] Mention mode enabled, bot not mentioned`)
            return
          }
        }
      }

      if (!isCliInjectedPrompt && message.author?.bot !== true) {
        const access = adapter.getMessageAccess
          ? await adapter.getMessageAccess(message)
          : 'denied'
        if (access === 'blocked') {
          await replyToIncomingMessage({
            target,
            message,
            markdown: `You have the **no-kimaki** role which blocks bot access.\nRemove this role to use Kimaki.`,
            flags: SILENT_MESSAGE_FLAGS,
          })
          return
        }

        if (access === 'denied') {
          await replyToIncomingMessage({
            target,
            message,
            markdown: `You don't have permission to start sessions.\nTo use Kimaki, ask a server admin to give you the **Kimaki** role.`,
            flags: SILENT_MESSAGE_FLAGS,
          })
          return
        }
      }

      if (kind === 'thread') {
        if (!platformThread) {
          throw new Error('Missing platform thread for thread message event')
        }
        const thread = platformThread
        const threadTarget = getThreadTarget({
          thread,
          channelId: target.channelId,
        })
        discordLogger.log(`Message in thread ${thread.name} (${thread.id})`)

        // Cancel interactive UI when a real user sends a message.
        // If a question was pending and answered with the user's text,
        // early-return: the message was consumed as the question answer
        // and must NOT also be sent as a new prompt (causes abort loops).
        if (!message.author.bot && !isCliInjectedPrompt) {
          cancelPendingActionButtons(thread.id)
          cancelHtmlActionsForThread(thread.id)
          const questionResult = await cancelPendingQuestion(
            platformThread.id,
            message.content || undefined,
          )
          void cancelPendingFileUpload(platformThread.id)
          if (questionResult === 'replied') {
            return
          }
        }

        let projectDirectory: string | undefined
        const channelConfig = await getChannelDirectory(target.channelId)
        if (channelConfig) {
          projectDirectory = channelConfig.directory
        }

        // Check if this thread is a worktree thread
        const worktreeInfo = await getThreadWorktree(thread.id)
        if (worktreeInfo) {
          if (worktreeInfo.status === 'pending') {
            await replyToIncomingMessage({
              target,
              message,
              markdown: '⏳ Worktree is still being created. Please wait...',
              flags: SILENT_MESSAGE_FLAGS,
            })
            return
          }
          if (worktreeInfo.status === 'error') {
            await replyToIncomingMessage({
              target,
              message,
              markdown: `❌ Worktree creation failed: ${(worktreeInfo.error_message || '').slice(0, 1900)}`,
              flags: SILENT_MESSAGE_FLAGS,
            })
            return
          }
          // Use original project directory for OpenCode server (session lives there)
          // The worktree directory is passed via query.directory in prompt/command calls
          if (worktreeInfo.project_directory) {
            projectDirectory = worktreeInfo.project_directory
            discordLogger.log(
              `Using project directory: ${projectDirectory} (worktree: ${worktreeInfo.worktree_directory})`,
            )
          }
        }

        if (projectDirectory && !fs.existsSync(projectDirectory)) {
          discordLogger.error(`Directory does not exist: ${projectDirectory}`)
          await replyToIncomingMessage({
            target,
            message,
            markdown: `✗ Directory does not exist: ${JSON.stringify(projectDirectory).slice(0, 1900)}`,
            flags: SILENT_MESSAGE_FLAGS,
          })
          return
        }

        // ! prefix runs a shell command instead of starting/continuing a session
        // Use worktree directory if available, so commands run in the worktree cwd
        if (message.content?.startsWith('!') && projectDirectory) {
          const shellCmd = message.content.slice(1).trim()
          if (shellCmd) {
            const shellDir =
              worktreeInfo?.status === 'ready' &&
              worktreeInfo.worktree_directory
                ? worktreeInfo.worktree_directory
                : projectDirectory
            const loadingReply = await replyToIncomingMessage({
              target,
              message,
              markdown: `Running \`${shellCmd.slice(0, 1900)}\`...`,
            })
            const result = await runShellCommand({
              command: shellCmd,
              directory: shellDir,
            })
            await adapter.updateMessage(threadTarget, loadingReply.id, {
              markdown: result,
            })
            return
          }
        }

        const hasVoiceAttachment = Array.from(message.attachments.values()).some((a) => {
          return a.contentType?.startsWith('audio/')
        })

        if (!projectDirectory) {
          discordLogger.log(
            `Cannot process message: no project directory for thread ${thread.id}`,
          )
          return
        }

        // Capture narrowed non-undefined value for use in the preprocess closure
        const resolvedProjectDir = projectDirectory
        const sdkDir =
          worktreeInfo?.status === 'ready' &&
          worktreeInfo.worktree_directory
            ? worktreeInfo.worktree_directory
            : resolvedProjectDir
        const runtime = getOrCreateRuntime({
          threadId: thread.id,
          thread,
          projectDirectory: resolvedProjectDir,
          sdkDirectory: sdkDir,
          channelId: target.channelId,
          appId: currentAppId,
        })

        // Expensive pre-processing (voice transcription, context fetch,
        // attachment download) runs inside the runtime's serialized
        // preprocess chain, preserving Discord arrival order without
        // blocking SSE event handling in dispatchAction.
        const enqueueResult = await runtime.enqueueIncoming({
          prompt: '',
          userId: cliInjectedUserId || message.author.id,
          username:
            cliInjectedUsername ||
            message.author.displayName ||
            message.author.username,
          appId: currentAppId,
          agent: cliInjectedAgent,
          model: cliInjectedModel,
          sessionStartSource: sessionStartSource
            ? {
                scheduleKind: sessionStartSource.scheduleKind,
                scheduledTaskId: sessionStartSource.scheduledTaskId,
              }
            : undefined,
          preprocess: () => {
            return preprocessExistingThreadMessage({
              adapter,
              message,
              thread: platformThread,
              projectDirectory: resolvedProjectDir,
              channelId: target.channelId,
              isCliInjected: isCliInjectedPrompt,
              hasVoiceAttachment,
              appId: currentAppId,
            })
          },
        })

        // Notify when a voice message was queued instead of sent immediately
        if (enqueueResult.queued && enqueueResult.position) {
          await sendThreadMarkdown({
            target: threadTarget,
            markdown: `Queued at position ${enqueueResult.position}`,
          })
        }
      }

      if (kind === 'channel') {
        voiceLogger.log(
          `[GUILD_TEXT] Message in text channel ${target.channelId}`,
        )

        const channelConfig = await getChannelDirectory(target.channelId)

        if (!channelConfig) {
          if (isMention) {
            // TODO: Consider creating/using a session for any text channel when Kimaki is
            // explicitly @mentioned, so the bot can answer quick questions even before
            // the channel is linked to a project.
            await replyToIncomingMessage({
              target,
              message,
              markdown:
                'This channel is not connected to an OpenCode project.\nSend your message in a project channel, or use `/add-project` for an existing project, or `/create-new-project` to make a new one.',
              flags: SILENT_MESSAGE_FLAGS,
            })
            return
          }
          voiceLogger.log(
            `[IGNORED] Channel ${target.channelId} has no project directory configured`,
          )
          return
        }

        const projectDirectory = channelConfig.directory

        // Note: Mention mode is checked early in the handler (before permission check)
        // to avoid sending permission errors to users who just didn't @mention the bot.

        discordLogger.log(`DIRECTORY: Found kimaki.directory: ${projectDirectory}`)

        if (!fs.existsSync(projectDirectory)) {
          discordLogger.error(`Directory does not exist: ${projectDirectory}`)
          await replyToIncomingMessage({
            target,
            message,
            markdown: `✗ Directory does not exist: ${JSON.stringify(projectDirectory).slice(0, 1900)}`,
            flags: SILENT_MESSAGE_FLAGS,
          })
          return
        }

        // ! prefix runs a shell command instead of starting a session
        if (message.content?.startsWith('!')) {
          const shellCmd = message.content.slice(1).trim()
          if (shellCmd) {
            const loadingReply = await replyToIncomingMessage({
              target,
              message,
              markdown: `Running \`${shellCmd.slice(0, 1900)}\`...`,
            })
            const result = await runShellCommand({
              command: shellCmd,
              directory: projectDirectory,
            })
            await adapter.updateMessage(target, loadingReply.id, { markdown: result })
            return
          }
        }

        const hasVoice = Array.from(message.attachments.values()).some((a) =>
          a.contentType?.startsWith('audio/'),
        )

        const baseThreadName = hasVoice
          ? 'Voice Message'
          : stripMentions(message.content || '')
              .replace(/\s+/g, ' ')
              .trim() || 'kimaki thread'

        // Check if worktrees should be enabled (CLI flag OR channel setting)
        const shouldUseWorktrees =
          useWorktrees || (await getChannelWorktreesEnabled(target.channelId))

        // Add worktree prefix if worktrees are enabled
        const threadName = shouldUseWorktrees
          ? `${WORKTREE_PREFIX}${baseThreadName}`
          : baseThreadName

        const { thread, target: threadTarget } = await adapter.createThreadFromMessage({
          message,
          name: threadName.slice(0, 80),
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
          reason: 'Start Claude session',
        })

        // Add user to thread so it appears in their sidebar
        await adapter.addThreadMember(threadTarget.threadId, message.author.id)

        discordLogger.log(`Created thread "${thread.name}" (${thread.id})`)

        // Create worktree if worktrees are enabled (CLI flag OR channel setting)
        let sessionDirectory = projectDirectory
        if (shouldUseWorktrees) {
          const worktreeName = formatWorktreeName(
            hasVoice ? `voice-${Date.now()}` : threadName.slice(0, 50),
          )
          discordLogger.log(`[WORKTREE] Creating worktree: ${worktreeName}`)

          // Store pending worktree immediately so bot knows about it
          await createPendingWorktree({
            threadId: thread.id,
            worktreeName,
            projectDirectory,
          })

          const worktreeResult = await createWorktreeWithSubmodules({
            directory: projectDirectory,
            name: worktreeName,
          })

          if (worktreeResult instanceof Error) {
            const errMsg = worktreeResult.message
            discordLogger.error(`[WORKTREE] Creation failed: ${errMsg}`)
            await setWorktreeError({
              threadId: thread.id,
              errorMessage: errMsg,
            })
            await sendThreadMarkdown({
              target: threadTarget,
              markdown: `⚠️ Failed to create worktree: ${errMsg}\nUsing main project directory instead.`,
              flags: SILENT_MESSAGE_FLAGS,
            })
          } else {
            await setWorktreeReady({
              threadId: thread.id,
              worktreeDirectory: worktreeResult.directory,
            })
            sessionDirectory = worktreeResult.directory
            discordLogger.log(
              `[WORKTREE] Created: ${worktreeResult.directory} (branch: ${worktreeResult.branch})`,
            )
            // React with tree emoji to mark as worktree thread
            await adapter.addThreadStarterReaction(threadTarget, '🌳')
          }
        }

        const channelRuntime = getOrCreateRuntime({
          threadId: thread.id,
          thread,
          projectDirectory: sessionDirectory,
          sdkDirectory: sessionDirectory,
          channelId: target.channelId,
          appId: currentAppId,
        })
        await channelRuntime.enqueueIncoming({
          prompt: '',
          userId: message.author.id,
          username: message.author.displayName || message.author.username,
          appId: currentAppId,
          preprocess: () => {
            return preprocessNewThreadMessage({
              adapter,
              message,
              thread,
              projectDirectory: sessionDirectory,
              hasVoiceAttachment: hasVoice,
              appId: currentAppId,
            })
          },
        })
      } else {
        discordLogger.log(`Channel kind ${kind} is not supported`)
      }
    } catch (error) {
      voiceLogger.error('Discord handler error:', error)
      void notifyError(error, 'MessageCreate handler error')
      try {
        const errMsg = (
          error instanceof Error ? error.message : String(error)
        ).slice(0, 1900)
        await replyToIncomingMessage({
          target,
          message,
          markdown: `Error: ${errMsg}`,
          flags: SILENT_MESSAGE_FLAGS,
        })
      } catch (sendError) {
        voiceLogger.error(
          'Discord handler error (fallback):',
          sendError instanceof Error ? sendError.message : String(sendError),
        )
      }
    }
  })

  // Handle bot-initiated threads created by `kimaki send` (without --notify-only)
  // Uses JSON embed marker to pass options (start, worktree name)
  adapter.onThreadCreate(async ({ thread, target: threadRef, newlyCreated }) => {
    try {
      if (!newlyCreated) {
        return
      }

      // Get the starter message to check for auto-start marker
      const starterMessage = await adapter.fetchStarterMessage(thread.id).catch((error) => {
        discordLogger.warn(
          `[THREAD_CREATE] Failed to fetch starter message for thread ${thread.id}:`,
          error instanceof Error ? error.message : String(error),
        )
        return null
      })
      if (!starterMessage) {
        discordLogger.log(
          `[THREAD_CREATE] Could not fetch starter message for thread ${thread.id}`,
        )
        return
      }

      // Parse JSON marker from embed footer
      const embedFooter = starterMessage.embeds[0]?.data?.footer?.text
      if (!embedFooter) {
        return
      }

      const marker = parseEmbedFooterMarker<ThreadStartMarker>({
        footer: embedFooter,
      })
      if (!marker) {
        return
      }

      if (!marker.start) {
        return // Not an auto-start thread
      }

      discordLogger.log(
        `[BOT_SESSION] Detected bot-initiated thread: ${thread.name}`,
      )

      const textAttachmentsContent = await adapter.getTextAttachments?.(starterMessage) || ''
      const messageText = ((await adapter.resolveMentions?.(starterMessage)) || starterMessage.content || '').trim()
      const prompt = textAttachmentsContent
        ? `${messageText}\n\n${textAttachmentsContent}`
        : messageText
      if (!prompt) {
        discordLogger.log(`[BOT_SESSION] No prompt found in starter message`)
        return
      }

      // Get directory from database
      const channelConfig = await getChannelDirectory(threadRef.channelId)

      if (!channelConfig) {
        discordLogger.log(
          `[BOT_SESSION] No project directory configured for parent channel`,
        )
        return
      }

      const projectDirectory = channelConfig.directory
      const threadTarget = {
        channelId: threadRef.channelId,
        threadId: threadRef.threadId,
      }

      if (!fs.existsSync(projectDirectory)) {
        discordLogger.error(
          `[BOT_SESSION] Directory does not exist: ${projectDirectory}`,
        )
        await sendThreadMarkdown({
          target: threadRef,
          markdown: `✗ Directory does not exist: ${JSON.stringify(projectDirectory).slice(0, 1900)}`,
          flags: SILENT_MESSAGE_FLAGS,
        })
        return
      }

      // Create worktree if requested
      const sessionDirectory: string = await (async () => {
        if (!marker.worktree) {
          return projectDirectory
        }

        discordLogger.log(`[BOT_SESSION] Creating worktree: ${marker.worktree}`)

        const worktreeStatusMessage = await sendThreadMarkdown({
          target: threadRef,
          markdown: `🌳 Creating worktree: ${marker.worktree}\n⏳ Setting up (this can take a bit)...`,
          flags: SILENT_MESSAGE_FLAGS,
        })
          .catch(() => {
            return null
          })

        await createPendingWorktree({
          threadId: thread.id,
          worktreeName: marker.worktree,
          projectDirectory,
        })

        const worktreeResult = await createWorktreeWithSubmodules({
          directory: projectDirectory,
          name: marker.worktree,
        })

        if (errore.isError(worktreeResult)) {
          discordLogger.error(
            `[BOT_SESSION] Worktree creation failed: ${worktreeResult.message}`,
          )
          await setWorktreeError({
            threadId: thread.id,
            errorMessage: worktreeResult.message,
          })
          if (worktreeStatusMessage) {
            await adapter.updateMessage(threadTarget, worktreeStatusMessage.id, {
              markdown: `⚠️ Failed to create worktree: ${worktreeResult.message}\nUsing main project directory instead.`,
              flags: SILENT_MESSAGE_FLAGS,
            })
          } else {
            await sendThreadMarkdown({
              target: threadRef,
              markdown: `⚠️ Failed to create worktree: ${worktreeResult.message}\nUsing main project directory instead.`,
              flags: SILENT_MESSAGE_FLAGS,
            })
          }
          return projectDirectory
        }

        await setWorktreeReady({
          threadId: thread.id,
          worktreeDirectory: worktreeResult.directory,
        })
        discordLogger.log(
          `[BOT_SESSION] Worktree created: ${worktreeResult.directory}`,
        )
        // React with tree emoji to mark as worktree thread
        await adapter.addThreadStarterReaction(threadTarget, '🌳')
        if (worktreeStatusMessage) {
          await adapter.updateMessage(threadTarget, worktreeStatusMessage.id, {
            markdown: `🌳 **Worktree ready: ${marker.worktree}**\n📁 \`${worktreeResult.directory}\`\n🌿 Branch: \`${worktreeResult.branch}\``,
            flags: SILENT_MESSAGE_FLAGS,
          })
        } else {
          await sendThreadMarkdown({
            target: threadRef,
            markdown: `🌳 **Worktree ready: ${marker.worktree}**\n📁 \`${worktreeResult.directory}\`\n🌿 Branch: \`${worktreeResult.branch}\``,
            flags: SILENT_MESSAGE_FLAGS,
          })
        }
        return worktreeResult.directory
      })()

      discordLogger.log(
        `[BOT_SESSION] Starting session for thread ${thread.id} with prompt: "${prompt.slice(0, 50)}..."`,
      )

      const botThreadStartSource = parseSessionStartSourceFromMarker(marker)

      const runtime = getOrCreateRuntime({
        threadId: thread.id,
        thread,
        projectDirectory,
        sdkDirectory: sessionDirectory,
        channelId: threadRef.channelId,
        appId: currentAppId,
      })
      await runtime.enqueueIncoming({
        prompt,
        userId: marker.userId || '',
        username: marker.username || 'bot',
        appId: currentAppId,
        agent: marker.agent,
        model: marker.model,
        mode: 'opencode',
        sessionStartSource: botThreadStartSource
          ? {
              scheduleKind: botThreadStartSource.scheduleKind,
              scheduledTaskId: botThreadStartSource.scheduledTaskId,
            }
          : undefined,
      })
    } catch (error) {
      voiceLogger.error(
        '[BOT_SESSION] Error handling bot-initiated thread:',
        error,
      )
      void notifyError(error, 'ThreadCreate handler error')
      try {
        const errMsg = (
          error instanceof Error ? error.message : String(error)
        ).slice(0, 1900)
        await sendThreadMarkdown({
          target: threadRef,
          markdown: `Error: ${errMsg}`,
          flags: SILENT_MESSAGE_FLAGS,
        })
      } catch (sendError) {
        voiceLogger.error(
          '[BOT_SESSION] Failed to send error message:',
          sendError instanceof Error ? sendError.message : String(sendError),
        )
      }
    }
  })

  // Dispose runtime when a thread is deleted so memory is freed immediately
  // instead of waiting for the idle sweeper (1 hour default).
  adapter.onThreadDelete((threadId) => {
    disposeRuntime(threadId)
  })

  await adapter.login(token)

  startHeapMonitor()
  const stopTaskRunner = startTaskRunner({ token })
  const stopRuntimeIdleSweeper = startRuntimeIdleSweeper()

  const handleShutdown = async (signal: string, { skipExit = false } = {}) => {
    discordLogger.log(`Received ${signal}, cleaning up...`)

    if ((global as any).shuttingDown) {
      discordLogger.log('Already shutting down, ignoring duplicate signal')
      return
    }
    ;(global as any).shuttingDown = true

    try {
      await stopRuntimeIdleSweeper()
      await stopTaskRunner()

      await flushDebouncedProcessCallbacks().catch((error) => {
        discordLogger.warn(
          'Failed to flush debounced process callbacks:',
          error instanceof Error ? error.message : String(error),
        )
      })

      // Cancel pending IPC requests so plugin tools don't hang
      await cancelAllPendingIpcRequests().catch((e) => {
        discordLogger.warn(
          'Failed to cancel pending IPC requests:',
          (e as Error).message,
        )
      })

      const cleanupPromises: Promise<void>[] = []
      for (const [guildId] of voiceConnections) {
        voiceLogger.log(
          `[SHUTDOWN] Cleaning up voice connection for guild ${guildId}`,
        )
        cleanupPromises.push(cleanupVoiceConnection(guildId))
      }

      if (cleanupPromises.length > 0) {
        voiceLogger.log(
          `[SHUTDOWN] Waiting for ${cleanupPromises.length} voice connection(s) to clean up...`,
        )
        await Promise.allSettled(cleanupPromises)
        discordLogger.log(`All voice connections cleaned up`)
      }

      voiceLogger.log('[SHUTDOWN] Stopping OpenCode server')
      await stopOpencodeServer()

      discordLogger.log('Closing database...')
      await closeDatabase()

      discordLogger.log('Stopping hrana server...')
      await stopHranaServer()

      discordLogger.log('Destroying Discord client...')
      adapter.destroy()

      discordLogger.log('Cleanup complete.')
      if (!skipExit) {
        process.exit(0)
      }
    } catch (error) {
      voiceLogger.error('[SHUTDOWN] Error during cleanup:', error)
      if (!skipExit) {
        process.exit(1)
      }
    }
  }

  process.on('SIGTERM', async () => {
    try {
      await handleShutdown('SIGTERM')
    } catch (error) {
      voiceLogger.error('[SIGTERM] Error during shutdown:', error)
      process.exit(1)
    }
  })

  process.on('SIGINT', async () => {
    try {
      await handleShutdown('SIGINT')
    } catch (error) {
      voiceLogger.error('[SIGINT] Error during shutdown:', error)
      process.exit(1)
    }
  })

  process.on('SIGUSR1', () => {
    discordLogger.log('Received SIGUSR1, writing heap snapshot...')
    writeHeapSnapshot().catch((e) => {
      discordLogger.error(
        'Failed to write heap snapshot:',
        e instanceof Error ? e.message : String(e),
      )
    })
  })

  process.on('SIGUSR2', async () => {
    discordLogger.log('Received SIGUSR2, restarting after cleanup...')
    try {
      await handleShutdown('SIGUSR2', { skipExit: true })
    } catch (error) {
      voiceLogger.error('[SIGUSR2] Error during shutdown:', error)
    }
    const { spawn } = await import('node:child_process')
    // Strip __KIMAKI_CHILD so the new process goes through the respawn wrapper in bin.js.
    // V8 heap flags are already in process.execArgv from the initial spawn, and bin.ts
    // will re-inject them if missing, so no need to add them here.
    const env = { ...process.env }
    delete env.__KIMAKI_CHILD
    spawn(process.argv[0]!, [...process.execArgv, ...process.argv.slice(1)], {
      stdio: 'inherit',
      detached: true,
      cwd: process.cwd(),
      env,
    }).unref()
    process.exit(0)
  })

  process.on('uncaughtException', (error) => {
    discordLogger.error('Uncaught exception:', formatErrorWithStack(error))
    notifyError(error, 'Uncaught exception in bot process')
    void handleShutdown('uncaughtException', { skipExit: true }).catch(
      (shutdownError) => {
        discordLogger.error(
          '[uncaughtException] shutdown failed:',
          formatErrorWithStack(shutdownError),
        )
      },
    )
    setTimeout(() => {
      process.exit(1)
    }, 250).unref()
  })

  process.on('unhandledRejection', (reason, promise) => {
    if ((global as any).shuttingDown) {
      discordLogger.log('Ignoring unhandled rejection during shutdown:', reason)
      return
    }
    discordLogger.error(
      'Unhandled rejection:',
      formatErrorWithStack(reason),
      'at promise:',
      promise,
    )
    const error =
      reason instanceof Error
        ? reason
        : new Error(formatErrorWithStack(reason))
    void notifyError(error, 'Unhandled rejection in bot process')
  })
}
