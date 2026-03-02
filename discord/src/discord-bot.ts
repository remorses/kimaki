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
  getThreadSession,
  setThreadSession,
  getPrisma,
  cancelAllPendingIpcRequests,
} from './database.js'
import {
  initializeOpencodeForDirectory,
  getOpencodeServers,
} from './opencode.js'
import { formatWorktreeName } from './commands/worktree.js'
import { WORKTREE_PREFIX } from './commands/merge-worktree.js'
import { createWorktreeWithSubmodules } from './worktree-utils.js'
import {
  escapeBackticksInCodeBlocks,
  splitMarkdownForDiscord,
  sendThreadMessage,
  SILENT_MESSAGE_FLAGS,
  reactToThread,
  stripMentions,
  hasKimakiBotPermission,
  hasNoKimakiRole,
} from './discord-utils.js'
import {
  getOpencodeSystemMessage,
  type ThreadStartMarker,
} from './system-message.js'
import yaml from 'js-yaml'
import {
  getFileAttachments,
  getTextAttachments,
  resolveMentions,
} from './message-formatting.js'
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
  processVoiceAttachment,
  registerVoiceStateHandler,
} from './voice-handler.js'
import { getCompactSessionContext, getLastSessionId } from './markdown.js'
import {
  type SessionStartSourceContext,
} from './session-handler/model-utils.js'
import {
  getOrCreateRuntime,
} from './session-handler/thread-session-runtime.js'
import { runShellCommand } from './commands/run-command.js'
import { registerInteractionHandler } from './interaction-handler.js'
import { getDiscordRestApiUrl } from './discord-urls.js'
import { stopHranaServer } from './hrana-server.js'
import { notifyError } from './sentry.js'

export {
  initDatabase,
  closeDatabase,
  getChannelDirectory,
  getPrisma,
} from './database.js'
export { initializeOpencodeForDirectory } from './opencode.js'
export {
  escapeBackticksInCodeBlocks,
  splitMarkdownForDiscord,
} from './discord-utils.js'
export { getOpencodeSystemMessage } from './system-message.js'
export {
  ensureKimakiCategory,
  ensureKimakiAudioCategory,
  createProjectChannels,
  getChannelsWithDescriptions,
} from './channel-management.js'
export type { ChannelWithTags } from './channel-management.js'

import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  ThreadAutoArchiveDuration,
  type Message,
  type TextChannel,
  type ThreadChannel,
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

type StartOptions = {
  token: string
  appId?: string
  /** When true, all new sessions from channel messages create git worktrees */
  useWorktrees?: boolean
}

export async function createDiscordClient() {
  // Read REST API URL lazily so built-in mode can set store.discordBaseUrl
  // after module import but before client creation.
  const restApiUrl = getDiscordRestApiUrl()
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [
      Partials.Channel,
      Partials.Message,
      Partials.User,
      Partials.ThreadMember,
    ],
    rest: { api: restApiUrl },
  })
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

    voiceLogger.log(
      `[READY] Bot is ready and will only respond to channels with app ID: ${currentAppId}`,
    )

    registerInteractionHandler({ discordClient: c, appId: currentAppId })
    registerVoiceStateHandler({ discordClient: c, appId: currentAppId })

    // Channel logging is informational only; do it in background so startup stays responsive.
    void (async () => {
      for (const guild of c.guilds.cache.values()) {
        discordLogger.log(`${guild.name} (${guild.id})`)

        const channels = await getChannelsWithDescriptions(guild)
        const kimakiChannels = channels.filter(
          (ch) =>
            ch.kimakiDirectory &&
            (!ch.kimakiApp || ch.kimakiApp === currentAppId),
        )

        if (kimakiChannels.length > 0) {
          discordLogger.log(
            `  Found ${kimakiChannels.length} channel(s) for this bot:`,
          )
          for (const channel of kimakiChannels) {
            discordLogger.log(
              `  - #${channel.name}: ${channel.kimakiDirectory}`,
            )
          }
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

  // Per-thread promise chain to serialize the expensive pre-enqueue work
  // (context fetch, voice transcription) that runs before runtime.enqueueIncoming().
  // Without this, two overlapping messageCreate events can invert arrival order.
  const threadIngressQueue = new Map<string, Promise<void>>()

  discordClient.on(Events.MessageCreate, async (message: Message) => {
    try {
      const isSelfBotMessage = Boolean(
        discordClient.user && message.author?.id === discordClient.user.id,
      )
      const promptMarker = parseEmbedFooterMarker<ThreadStartMarker>({
        footer: message.embeds[0]?.footer?.text,
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
        if (!hasKimakiBotPermission(message.member)) {
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

      if (message.partial) {
        discordLogger.log(`Fetching partial message ${message.id}`)
        const fetched = await errore.tryAsync({
          try: () => message.fetch(),
          catch: (e) => e as Error,
        })
        if (fetched instanceof Error) {
          discordLogger.log(
            `Failed to fetch partial message ${message.id}:`,
            fetched.message,
          )
          return
        }
      }

      // Check mention mode BEFORE permission check for text channels.
      // When mention mode is enabled, users without Kimaki role can message
      // without getting a permission error - we just silently ignore.
      const channel = message.channel
      if (channel.type === ChannelType.GuildText && !isCliInjectedPrompt) {
        const textChannel = channel as TextChannel
        const mentionModeEnabled = await getChannelMentionMode(textChannel.id)
        if (mentionModeEnabled) {
          const botMentioned =
            discordClient.user && message.mentions.has(discordClient.user.id)
          const isShellCommand = message.content?.startsWith('!')
          if (!botMentioned && !isShellCommand) {
            voiceLogger.log(`[IGNORED] Mention mode enabled, bot not mentioned`)
            return
          }
        }
      }

      if (!isCliInjectedPrompt && message.guild && message.member) {
        if (hasNoKimakiRole(message.member)) {
          await message.reply({
            content: `You have the **no-kimaki** role which blocks bot access.\nRemove this role to use Kimaki.`,
            flags: SILENT_MESSAGE_FLAGS,
          })
          return
        }

        if (!hasKimakiBotPermission(message.member)) {
          await message.reply({
            content: `You don't have permission to start sessions.\nTo use Kimaki, ask a server admin to give you the **Kimaki** role.`,
            flags: SILENT_MESSAGE_FLAGS,
          })
          return
        }
      }

      const isThread = [
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ].includes(channel.type)

      if (isThread) {
        const thread = channel as ThreadChannel
        discordLogger.log(`Message in thread ${thread.name} (${thread.id})`)

        const parent = thread.parent as TextChannel | null
        let projectDirectory: string | undefined
        let channelAppId: string | undefined

        if (parent) {
          const channelConfig = await getChannelDirectory(parent.id)
          if (channelConfig) {
            projectDirectory = channelConfig.directory
            channelAppId = channelConfig.appId || undefined
          }
        }

        // Check if this thread is a worktree thread
        const worktreeInfo = await getThreadWorktree(thread.id)
        if (worktreeInfo) {
          if (worktreeInfo.status === 'pending') {
            await message.reply({
              content: '⏳ Worktree is still being created. Please wait...',
              flags: SILENT_MESSAGE_FLAGS,
            })
            return
          }
          if (worktreeInfo.status === 'error') {
            await message.reply({
              content: `❌ Worktree creation failed: ${(worktreeInfo.error_message || '').slice(0, 1900)}`,
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

        if (channelAppId && channelAppId !== currentAppId) {
          voiceLogger.log(
            `[IGNORED] Thread belongs to different bot app (expected: ${currentAppId}, got: ${channelAppId})`,
          )
          return
        }

        if (projectDirectory && !fs.existsSync(projectDirectory)) {
          discordLogger.error(`Directory does not exist: ${projectDirectory}`)
          await message.reply({
            content: `✗ Directory does not exist: ${JSON.stringify(projectDirectory).slice(0, 1900)}`,
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
            const loadingReply = await message.reply({
              content: `Running \`${shellCmd.slice(0, 1900)}\`...`,
            })
            const result = await runShellCommand({
              command: shellCmd,
              directory: shellDir,
            })
            await loadingReply.edit({ content: result })
            return
          }
        }

        const hasVoiceAttachment = message.attachments.some((a) => {
          return a.contentType?.startsWith('audio/')
        })

        // discord.js EventEmitter doesn't await async handlers, so two
        // messageCreate events for the same thread can overlap. The expensive
        // pre-enqueue work (context fetch, voice transcription) runs before
        // runtime.enqueueIncoming(), so arrival order can invert without
        // serialization. This lightweight per-thread promise chain preserves
        // Discord arrival order for the pre-processing; the runtime's
        // dispatchAction handles state serialization after enqueue.
        const prev = threadIngressQueue.get(thread.id) ?? Promise.resolve()
        // Chain must never reject so the next queued call always runs,
        // but we re-throw the error so the outer MessageCreate try/catch
        // can fire notifyError.
        let caughtError: unknown
        const queued = prev
          .then(() => {
            return processThreadMessage()
          })
          .catch((err: unknown) => {
            caughtError = err
          })
          .finally(() => {
            // Clean up resolved entry to avoid unbounded map growth.
            if (threadIngressQueue.get(thread.id) === queued) {
              threadIngressQueue.delete(thread.id)
            }
          })
        threadIngressQueue.set(thread.id, queued)
        await queued
        if (caughtError) {
          throw caughtError
        }
        return

        async function processThreadMessage() {
          const sessionId = await getThreadSession(thread.id)

          // No existing session - start a new one (e.g., replying to a notification thread)
          if (!sessionId) {
            discordLogger.log(
              `No session for thread ${thread.id}, starting new session`,
            )

            if (!projectDirectory) {
              discordLogger.log(
                `Cannot start session: no project directory for thread ${thread.id}`,
              )
              return
            }

            let prompt = resolveMentions(message)
            const voiceResult = await processVoiceAttachment({
              message,
              thread,
              projectDirectory,
              appId: currentAppId,
            })
            if (voiceResult) {
              prompt = `Voice message transcription from Discord user:\n\n${voiceResult.transcription}`
            }

            // If voice transcription failed and there's no text content, bail out
            if (hasVoiceAttachment && !voiceResult && !prompt.trim()) {
              return
            }

            const starterMessage = await thread
              .fetchStarterMessage()
              .catch((error) => {
                discordLogger.warn(
                  `[SESSION] Failed to fetch starter message for thread ${thread.id}:`,
                  error instanceof Error ? error.message : String(error),
                )
                return null
              })
            if (starterMessage && starterMessage.content !== message.content) {
              const starterTextAttachments = await getTextAttachments(starterMessage)
              const starterContent = resolveMentions(starterMessage)
              const starterText = starterTextAttachments
                ? `${starterContent}\n\n${starterTextAttachments}`
                : starterContent
              if (starterText) {
                prompt = `Context from thread:\n${starterText}\n\nUser request:\n${prompt}`
              }
            }

            const sdkDir =
              worktreeInfo?.status === 'ready' &&
              worktreeInfo.worktree_directory
                ? worktreeInfo.worktree_directory
                : projectDirectory
            const runtime = getOrCreateRuntime({
              threadId: thread.id,
              thread,
              projectDirectory,
              sdkDirectory: sdkDir,
              channelId: parent?.id || undefined,
              appId: currentAppId,
            })
            await runtime.enqueueIncoming({
              prompt,
              userId: cliInjectedUserId || message.author.id,
              username:
                cliInjectedUsername ||
                message.member?.displayName ||
                message.author.displayName,
              appId: currentAppId,
              interruptActive: voiceResult?.queueMessage ? false : true,
              agent: cliInjectedAgent,
              model: cliInjectedModel,
              sessionStartSource: sessionStartSource
                ? {
                    scheduleKind: sessionStartSource.scheduleKind,
                    scheduledTaskId: sessionStartSource.scheduledTaskId,
                  }
                : undefined,
            })
            return
          }

          voiceLogger.log(
            `[SESSION] Found session ${sessionId} for thread ${thread.id}`,
          )

          let messageContent = resolveMentions(message)
          if (isCliInjectedPrompt) {
            messageContent = message.content || ''
          }

          let currentSessionContext: string | undefined
          let lastSessionContext: string | undefined

          if (projectDirectory) {
            try {
              const getClient = await initializeOpencodeForDirectory(
                projectDirectory,
                { channelId: parent?.id },
              )
              if (getClient instanceof Error) {
                voiceLogger.error(
                  `[SESSION] Failed to initialize OpenCode client:`,
                  getClient.message,
                )
                throw new Error(getClient.message)
              }
              const client = getClient()

              // get current session context (without system prompt, it would be duplicated)
              const result = await getCompactSessionContext({
                client,
                sessionId: sessionId,
                includeSystemPrompt: false,
                maxMessages: 15,
              })
              if (errore.isOk(result)) {
                currentSessionContext = result
              }

              // get last session context (with system prompt for project context)
              const lastSessionResult = await getLastSessionId({
                client,
                excludeSessionId: sessionId,
              })
              const lastSessionId = errore.unwrapOr(lastSessionResult, null)
              if (lastSessionId) {
                const result = await getCompactSessionContext({
                  client,
                  sessionId: lastSessionId,
                  includeSystemPrompt: true,
                  maxMessages: 10,
                })
                if (errore.isOk(result)) {
                  lastSessionContext = result
                }
              }
            } catch (e) {
              voiceLogger.error(`Could not get session context:`, e)
              void notifyError(e, 'Failed to get session context')
            }
          }

          const voiceResult = await processVoiceAttachment({
            message,
            thread,
            projectDirectory,
            appId: currentAppId,
            currentSessionContext,
            lastSessionContext,
          })
          if (voiceResult) {
            messageContent = `Voice message transcription from Discord user:\n\n${voiceResult.transcription}`
          }

          // If voice transcription failed (returned null) and there's no text content,
          // bail out — don't fire deferred interrupt or send an empty prompt.
          if (hasVoiceAttachment && !voiceResult && !messageContent.trim()) {
            return
          }

          const fileAttachments = await getFileAttachments(message)
          const textAttachmentsContent = await getTextAttachments(message)
          const promptWithAttachments = textAttachmentsContent
            ? `${messageContent}\n\n${textAttachmentsContent}`
            : messageContent

          if (!projectDirectory) {
            discordLogger.log(
              `Cannot process message: no project directory for thread ${thread.id}`,
            )
            return
          }

          const sdkDir =
            worktreeInfo?.status === 'ready' &&
            worktreeInfo.worktree_directory
              ? worktreeInfo.worktree_directory
              : projectDirectory
          const runtime = getOrCreateRuntime({
            threadId: thread.id,
            thread,
            projectDirectory,
            sdkDirectory: sdkDir,
            channelId: parent?.id,
            appId: currentAppId,
          })
          await runtime.enqueueIncoming({
            prompt: promptWithAttachments,
            userId: (isCliInjectedPrompt && cliInjectedUserId)
              ? cliInjectedUserId
              : message.author.id,
            username:
              cliInjectedUsername ||
              message.member?.displayName ||
              message.author.displayName,
            images: fileAttachments,
            appId: currentAppId,
            interruptActive: voiceResult?.queueMessage ? false : true,
            agent: cliInjectedAgent,
            model: cliInjectedModel,
            sessionStartSource: sessionStartSource
              ? {
                  scheduleKind: sessionStartSource.scheduleKind,
                  scheduledTaskId: sessionStartSource.scheduledTaskId,
                }
              : undefined,
          })
        }
      }

      if (channel.type === ChannelType.GuildText) {
        const textChannel = channel as TextChannel
        voiceLogger.log(
          `[GUILD_TEXT] Message in text channel #${textChannel.name} (${textChannel.id})`,
        )

        const channelConfig = await getChannelDirectory(textChannel.id)

        if (!channelConfig) {
          voiceLogger.log(
            `[IGNORED] Channel #${textChannel.name} has no project directory configured`,
          )
          return
        }

        const projectDirectory = channelConfig.directory
        const channelAppId = channelConfig.appId || undefined

        if (channelAppId && channelAppId !== currentAppId) {
          voiceLogger.log(
            `[IGNORED] Channel belongs to different bot app (expected: ${currentAppId}, got: ${channelAppId})`,
          )
          return
        }

        // Note: Mention mode is checked early in the handler (before permission check)
        // to avoid sending permission errors to users who just didn't @mention the bot.

        discordLogger.log(`DIRECTORY: Found kimaki.directory: ${projectDirectory}`)
        if (channelAppId) {
          discordLogger.log(`APP: Channel app ID: ${channelAppId}`)
        }

        if (!fs.existsSync(projectDirectory)) {
          discordLogger.error(`Directory does not exist: ${projectDirectory}`)
          await message.reply({
            content: `✗ Directory does not exist: ${JSON.stringify(projectDirectory).slice(0, 1900)}`,
            flags: SILENT_MESSAGE_FLAGS,
          })
          return
        }

        // ! prefix runs a shell command instead of starting a session
        if (message.content?.startsWith('!')) {
          const shellCmd = message.content.slice(1).trim()
          if (shellCmd) {
            const loadingReply = await message.reply({
              content: `Running \`${shellCmd.slice(0, 1900)}\`...`,
            })
            const result = await runShellCommand({
              command: shellCmd,
              directory: projectDirectory,
            })
            await loadingReply.edit({ content: result })
            return
          }
        }

        const hasVoice = message.attachments.some((a) =>
          a.contentType?.startsWith('audio/'),
        )

        const baseThreadName = hasVoice
          ? 'Voice Message'
          : stripMentions(message.content || '')
              .replace(/\s+/g, ' ')
              .trim() || 'kimaki thread'

        // Check if worktrees should be enabled (CLI flag OR channel setting)
        const shouldUseWorktrees =
          useWorktrees || (await getChannelWorktreesEnabled(textChannel.id))

        // Add worktree prefix if worktrees are enabled
        const threadName = shouldUseWorktrees
          ? `${WORKTREE_PREFIX}${baseThreadName}`
          : baseThreadName

        const thread = await message.startThread({
          name: threadName.slice(0, 80),
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
          reason: 'Start Claude session',
        })

        // Add user to thread so it appears in their sidebar
        await thread.members.add(message.author.id)

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
            await thread.send({
              content: `⚠️ Failed to create worktree: ${errMsg}\nUsing main project directory instead.`,
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
            await reactToThread({
              rest: discordClient.rest,
              threadId: thread.id,
              channelId: thread.parentId || undefined,
              emoji: '🌳',
            })
          }
        }

        let messageContent = resolveMentions(message)
        const voiceResult = await processVoiceAttachment({
          message,
          thread,
          projectDirectory: sessionDirectory,
          isNewThread: true,
          appId: currentAppId,
        })
        if (voiceResult) {
          messageContent = `Voice message transcription from Discord user:\n\n${voiceResult.transcription}`
        }

        // If voice transcription failed and there's no text content, bail out
        if (hasVoice && !voiceResult && !messageContent.trim()) {
          return
        }

        const fileAttachments = await getFileAttachments(message)
        const textAttachmentsContent = await getTextAttachments(message)
        const promptWithAttachments = textAttachmentsContent
          ? `${messageContent}\n\n${textAttachmentsContent}`
          : messageContent
        const channelRuntime = getOrCreateRuntime({
          threadId: thread.id,
          thread,
          projectDirectory: sessionDirectory,
          sdkDirectory: sessionDirectory,
          channelId: textChannel.id,
          appId: currentAppId,
        })
        await channelRuntime.enqueueIncoming({
          prompt: promptWithAttachments,
          userId: message.author.id,
          username:
            message.member?.displayName || message.author.displayName,
          images: fileAttachments,
          appId: currentAppId,
          interruptActive: voiceResult?.queueMessage ? false : true,
        })
      } else {
        discordLogger.log(`Channel type ${channel.type} is not supported`)
      }
    } catch (error) {
      voiceLogger.error('Discord handler error:', error)
      void notifyError(error, 'MessageCreate handler error')
      try {
        const errMsg = (
          error instanceof Error ? error.message : String(error)
        ).slice(0, 1900)
        await message.reply({
          content: `Error: ${errMsg}`,
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
  discordClient.on(Events.ThreadCreate, async (thread, newlyCreated) => {
    try {
      if (!newlyCreated) {
        return
      }

      // Only handle threads in text channels
      const parent = thread.parent as TextChannel | null
      if (!parent || parent.type !== ChannelType.GuildText) {
        return
      }

      // Get the starter message to check for auto-start marker
      const starterMessage = await thread
        .fetchStarterMessage()
        .catch((error) => {
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
      const embedFooter = starterMessage.embeds[0]?.footer?.text
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

      const textAttachmentsContent = await getTextAttachments(starterMessage)
      const messageText = resolveMentions(starterMessage).trim()
      const prompt = textAttachmentsContent
        ? `${messageText}\n\n${textAttachmentsContent}`
        : messageText
      if (!prompt) {
        discordLogger.log(`[BOT_SESSION] No prompt found in starter message`)
        return
      }

      // Get directory from database
      const channelConfig = await getChannelDirectory(parent.id)

      if (!channelConfig) {
        discordLogger.log(
          `[BOT_SESSION] No project directory configured for parent channel`,
        )
        return
      }

      const projectDirectory = channelConfig.directory
      const channelAppId = channelConfig.appId || undefined

      if (channelAppId && channelAppId !== currentAppId) {
        discordLogger.log(`[BOT_SESSION] Channel belongs to different bot app`)
        return
      }

      if (!fs.existsSync(projectDirectory)) {
        discordLogger.error(
          `[BOT_SESSION] Directory does not exist: ${projectDirectory}`,
        )
        await thread.send({
          content: `✗ Directory does not exist: ${JSON.stringify(projectDirectory).slice(0, 1900)}`,
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

        const worktreeStatusMessage = await thread
          .send({
            content: `🌳 Creating worktree: ${marker.worktree}\n⏳ Setting up (this can take a bit)...`,
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
          await (worktreeStatusMessage?.edit({
            content: `⚠️ Failed to create worktree: ${worktreeResult.message}\nUsing main project directory instead.`,
            flags: SILENT_MESSAGE_FLAGS,
          }) ||
            thread.send({
              content: `⚠️ Failed to create worktree: ${worktreeResult.message}\nUsing main project directory instead.`,
              flags: SILENT_MESSAGE_FLAGS,
            }))
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
        await reactToThread({
          rest: discordClient.rest,
          threadId: thread.id,
          channelId: thread.parentId || undefined,
          emoji: '🌳',
        })
        await (worktreeStatusMessage?.edit({
          content: `🌳 **Worktree ready: ${marker.worktree}**\n📁 \`${worktreeResult.directory}\`\n🌿 Branch: \`${worktreeResult.branch}\``,
          flags: SILENT_MESSAGE_FLAGS,
        }) ||
          thread.send({
            content: `🌳 **Worktree ready: ${marker.worktree}**\n📁 \`${worktreeResult.directory}\`\n🌿 Branch: \`${worktreeResult.branch}\``,
            flags: SILENT_MESSAGE_FLAGS,
          }))
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
        channelId: parent.id,
        appId: currentAppId,
      })
      await runtime.enqueueIncoming({
        prompt,
        userId: marker.userId || '',
        username: marker.username || 'bot',
        appId: currentAppId,
        agent: marker.agent,
        model: marker.model,
        interruptActive: true,
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
        await thread.send({
          content: `Error: ${errMsg}`,
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

  await discordClient.login(token)

  startHeapMonitor()
  const stopTaskRunner = startTaskRunner({ token })

  const handleShutdown = async (signal: string, { skipExit = false } = {}) => {
    discordLogger.log(`Received ${signal}, cleaning up...`)

    if ((global as any).shuttingDown) {
      discordLogger.log('Already shutting down, ignoring duplicate signal')
      return
    }
    ;(global as any).shuttingDown = true

    try {
      await stopTaskRunner()

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

      for (const [dir, server] of getOpencodeServers()) {
        if (!server.process.killed) {
          voiceLogger.log(
            `[SHUTDOWN] Stopping OpenCode server on port ${server.port} for ${dir}`,
          )
          server.process.kill('SIGTERM')
        }
      }
      getOpencodeServers().clear()

      discordLogger.log('Closing database...')
      await closeDatabase()

      discordLogger.log('Stopping hrana server...')
      await stopHranaServer()

      discordLogger.log('Destroying Discord client...')
      discordClient.destroy()

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
    try {
      writeHeapSnapshot()
    } catch (e) {
      discordLogger.error(
        'Failed to write heap snapshot:',
        e instanceof Error ? e.message : String(e),
      )
    }
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
