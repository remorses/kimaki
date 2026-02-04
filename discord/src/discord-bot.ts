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
  getChannelDirectory,
  getThreadSession,
  setThreadSession,
  getPrisma,
} from './database.js'
import { initializeOpencodeForDirectory, getOpencodeServers, getOpencodeClientV2 } from './opencode.js'
import { formatWorktreeName } from './commands/worktree.js'
import { WORKTREE_PREFIX } from './commands/merge-worktree.js'
import { createWorktreeWithSubmodules } from './worktree-utils.js'
import {
  escapeBackticksInCodeBlocks,
  splitMarkdownForDiscord,
  SILENT_MESSAGE_FLAGS,
} from './discord-utils.js'
import { getOpencodeSystemMessage } from './system-message.js'
import { getFileAttachments, getTextAttachments } from './message-formatting.js'
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
import { handleOpencodeSession } from './session-handler.js'
import { registerInteractionHandler } from './interaction-handler.js'

export { initDatabase, closeDatabase, getChannelDirectory, getPrisma } from './database.js'
export { initializeOpencodeForDirectory } from './opencode.js'
export { escapeBackticksInCodeBlocks, splitMarkdownForDiscord } from './discord-utils.js'
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
  PermissionsBitField,
  ThreadAutoArchiveDuration,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import fs from 'node:fs'
import * as errore from 'errore'
import { createLogger, LogPrefix } from './logger.js'
import { setGlobalDispatcher, Agent } from 'undici'

// Increase connection pool to prevent deadlock when multiple sessions have open SSE streams.
// Each session's event.subscribe() holds a connection; without enough connections,
// regular HTTP requests (question.reply, session.prompt) get blocked → deadlock.
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0, connections: 500 }))

const discordLogger = createLogger(LogPrefix.DISCORD)
const voiceLogger = createLogger(LogPrefix.VOICE)

type StartOptions = {
  token: string
  appId?: string
  /** When true, all new sessions from channel messages create git worktrees */
  useWorktrees?: boolean
}

export async function createDiscordClient() {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User, Partials.ThreadMember],
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

    for (const guild of c.guilds.cache.values()) {
      discordLogger.log(`${guild.name} (${guild.id})`)

      const channels = await getChannelsWithDescriptions(guild)
      const kimakiChannels = channels.filter(
        (ch) => ch.kimakiDirectory && (!ch.kimakiApp || ch.kimakiApp === currentAppId),
      )

      if (kimakiChannels.length > 0) {
        discordLogger.log(`  Found ${kimakiChannels.length} channel(s) for this bot:`)
        for (const channel of kimakiChannels) {
          discordLogger.log(`  - #${channel.name}: ${channel.kimakiDirectory}`)
        }
      } else {
        discordLogger.log(`  No channels for this bot`)
      }
    }

    voiceLogger.log(
      `[READY] Bot is ready and will only respond to channels with app ID: ${currentAppId}`,
    )

    registerInteractionHandler({ discordClient: c, appId: currentAppId })
    registerVoiceStateHandler({ discordClient: c, appId: currentAppId })
  }

  // If client is already ready (was logged in before being passed to us),
  // run setup immediately. Otherwise wait for the ClientReady event.
  if (discordClient.isReady()) {
    await setupHandlers(discordClient)
  } else {
    discordClient.once(Events.ClientReady, setupHandlers)
  }

  discordClient.on(Events.MessageCreate, async (message: Message) => {
    try {
      if (message.author?.bot) {
        return
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
          discordLogger.log(`Failed to fetch partial message ${message.id}:`, fetched.message)
          return
        }
      }

      if (message.guild && message.member) {
        // Check for "no-kimaki" role first - blocks user regardless of other permissions.
        // This implements the "four-eyes principle": even owners must remove this role
        // to use the bot, adding friction to prevent accidental usage.
        const hasNoKimakiRole = message.member.roles.cache.some(
          (role) => role.name.toLowerCase() === 'no-kimaki',
        )
        if (hasNoKimakiRole) {
          await message.reply({
            content: `You have the **no-kimaki** role which blocks bot access.\nRemove this role to use Kimaki.`,
            flags: SILENT_MESSAGE_FLAGS,
          })
          return
        }

        const isOwner = message.member.id === message.guild.ownerId
        const isAdmin = message.member.permissions.has(PermissionsBitField.Flags.Administrator)
        const canManageServer = message.member.permissions.has(
          PermissionsBitField.Flags.ManageGuild,
        )
        const hasKimakiRole = message.member.roles.cache.some(
          (role) => role.name.toLowerCase() === 'kimaki',
        )

        if (!isOwner && !isAdmin && !canManageServer && !hasKimakiRole) {
          await message.reply({
            content: `You don't have permission to start sessions.\nTo use Kimaki, ask a server admin to give you the **Kimaki** role.`,
            flags: SILENT_MESSAGE_FLAGS,
          })
          return
        }
      }

      const channel = message.channel
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
              content: `❌ Worktree creation failed: ${worktreeInfo.error_message}`,
              flags: SILENT_MESSAGE_FLAGS,
            })
            return
          }
          // Use original project directory for OpenCode server (session lives there)
          // The worktree directory is passed via query.directory in prompt/command calls
          if (worktreeInfo.project_directory) {
            projectDirectory = worktreeInfo.project_directory
            discordLogger.log(`Using project directory: ${projectDirectory} (worktree: ${worktreeInfo.worktree_directory})`)
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
            content: `✗ Directory does not exist: ${JSON.stringify(projectDirectory)}`,
            flags: SILENT_MESSAGE_FLAGS,
          })
          return
        }

        const sessionId = await getThreadSession(thread.id)

        // No existing session - start a new one (e.g., replying to a notification thread)
        if (!sessionId) {
          discordLogger.log(`No session for thread ${thread.id}, starting new session`)
          
          if (!projectDirectory) {
            discordLogger.log(`Cannot start session: no project directory for thread ${thread.id}`)
            return
          }

          // Include starter message as context for the session
          let prompt = message.content
          const starterMessage = await thread.fetchStarterMessage().catch((error) => {
            discordLogger.warn(
              `[SESSION] Failed to fetch starter message for thread ${thread.id}:`,
              error instanceof Error ? error.message : String(error),
            )
            return null
          })
          if (starterMessage?.content && starterMessage.content !== message.content) {
            prompt = `Context from thread:\n${starterMessage.content}\n\nUser request:\n${message.content}`
          }

          await handleOpencodeSession({
            prompt,
            thread,
            projectDirectory,
            channelId: parent?.id || '',
            username: message.member?.displayName || message.author.displayName,
            appId: currentAppId,
          })
          return
        }

        voiceLogger.log(`[SESSION] Found session ${sessionId} for thread ${thread.id}`)

        let messageContent = message.content || ''

        let currentSessionContext: string | undefined
        let lastSessionContext: string | undefined

        if (projectDirectory) {
          try {
            const getClient = await initializeOpencodeForDirectory(projectDirectory)
            if (getClient instanceof Error) {
              voiceLogger.error(`[SESSION] Failed to initialize OpenCode client:`, getClient.message)
              throw new Error(getClient.message)
            }
            const client = getClient()

            // get current session context (without system prompt, it would be duplicated)
            if (sessionId) {
              const result = await getCompactSessionContext({
                client,
                sessionId: sessionId,
                includeSystemPrompt: false,
                maxMessages: 15,
              })
              if (errore.isOk(result)) {
                currentSessionContext = result
              }
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
          }
        }

        const transcription = await processVoiceAttachment({
          message,
          thread,
          projectDirectory,
          appId: currentAppId,
          currentSessionContext,
          lastSessionContext,
        })
        if (transcription) {
          messageContent = transcription
        }

        const fileAttachments = await getFileAttachments(message)
        const textAttachmentsContent = await getTextAttachments(message)
        const promptWithAttachments = textAttachmentsContent
          ? `${messageContent}\n\n${textAttachmentsContent}`
          : messageContent
        await handleOpencodeSession({
          prompt: promptWithAttachments,
          thread,
          projectDirectory,
          originalMessage: message,
          images: fileAttachments,
          channelId: parent?.id,
          username: message.member?.displayName || message.author.displayName,
          appId: currentAppId,
        })
        return
      }

      if (channel.type === ChannelType.GuildText) {
        const textChannel = channel as TextChannel
        voiceLogger.log(
          `[GUILD_TEXT] Message in text channel #${textChannel.name} (${textChannel.id})`,
        )

        const channelConfig = await getChannelDirectory(textChannel.id)

        if (!channelConfig) {
          voiceLogger.log(`[IGNORED] Channel #${textChannel.name} has no project directory configured`)
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

        discordLogger.log(`DIRECTORY: Found kimaki.directory: ${projectDirectory}`)
        if (channelAppId) {
          discordLogger.log(`APP: Channel app ID: ${channelAppId}`)
        }

        if (!fs.existsSync(projectDirectory)) {
          discordLogger.error(`Directory does not exist: ${projectDirectory}`)
          await message.reply({
            content: `✗ Directory does not exist: ${JSON.stringify(projectDirectory)}`,
            flags: SILENT_MESSAGE_FLAGS,
          })
          return
        }

        const hasVoice = message.attachments.some((a) => a.contentType?.startsWith('audio/'))

        const baseThreadName = hasVoice
          ? 'Voice Message'
          : message.content?.replace(/\s+/g, ' ').trim() || 'Claude Thread'

        // Check if worktrees should be enabled (CLI flag OR channel setting)
        const shouldUseWorktrees = useWorktrees || await getChannelWorktreesEnabled(textChannel.id)

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

          // Initialize OpenCode and create worktree
          const getClient = await initializeOpencodeForDirectory(projectDirectory)
          if (getClient instanceof Error) {
            discordLogger.error(`[WORKTREE] Failed to init OpenCode: ${getClient.message}`)
            await setWorktreeError({ threadId: thread.id, errorMessage: getClient.message })
            await thread.send({
              content: `⚠️ Failed to create worktree: ${getClient.message}\nUsing main project directory instead.`,
              flags: SILENT_MESSAGE_FLAGS,
            })
          } else {
            const clientV2 = getOpencodeClientV2(projectDirectory)
            if (!clientV2) {
              discordLogger.error(`[WORKTREE] No v2 client for ${projectDirectory}`)
              await setWorktreeError({ threadId: thread.id, errorMessage: 'No OpenCode v2 client' })
            } else {
              const worktreeResult = await createWorktreeWithSubmodules({
                clientV2,
                directory: projectDirectory,
                name: worktreeName,
              })

              if (worktreeResult instanceof Error) {
                const errMsg = worktreeResult.message
                discordLogger.error(`[WORKTREE] Creation failed: ${errMsg}`)
                await setWorktreeError({ threadId: thread.id, errorMessage: errMsg })
                await thread.send({
                  content: `⚠️ Failed to create worktree: ${errMsg}\nUsing main project directory instead.`,
                  flags: SILENT_MESSAGE_FLAGS,
                })
              } else {
                await setWorktreeReady({ threadId: thread.id, worktreeDirectory: worktreeResult.directory })
                sessionDirectory = worktreeResult.directory
                discordLogger.log(`[WORKTREE] Created: ${worktreeResult.directory} (branch: ${worktreeResult.branch})`)
              }
            }
          }
        }

        let messageContent = message.content || ''

        const transcription = await processVoiceAttachment({
          message,
          thread,
          projectDirectory: sessionDirectory,
          isNewThread: true,
          appId: currentAppId,
        })
        if (transcription) {
          messageContent = transcription
        }

        const fileAttachments = await getFileAttachments(message)
        const textAttachmentsContent = await getTextAttachments(message)
        const promptWithAttachments = textAttachmentsContent
          ? `${messageContent}\n\n${textAttachmentsContent}`
          : messageContent
        await handleOpencodeSession({
          prompt: promptWithAttachments,
          thread,
          projectDirectory: sessionDirectory,
          originalMessage: message,
          images: fileAttachments,
          channelId: textChannel.id,
          username: message.member?.displayName || message.author.displayName,
          appId: currentAppId,
        })
      } else {
        discordLogger.log(`Channel type ${channel.type} is not supported`)
      }
    } catch (error) {
      voiceLogger.error('Discord handler error:', error)
      try {
        const errMsg = error instanceof Error ? error.message : String(error)
        await message.reply({ content: `Error: ${errMsg}`, flags: SILENT_MESSAGE_FLAGS })
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
      const starterMessage = await thread.fetchStarterMessage().catch((error) => {
        discordLogger.warn(
          `[THREAD_CREATE] Failed to fetch starter message for thread ${thread.id}:`,
          error instanceof Error ? error.message : String(error),
        )
        return null
      })
      if (!starterMessage) {
        discordLogger.log(`[THREAD_CREATE] Could not fetch starter message for thread ${thread.id}`)
        return
      }

      // Parse JSON marker from embed footer
      // Format: { start: true, worktree?: string }
      const embedFooter = starterMessage.embeds[0]?.footer?.text
      if (!embedFooter) {
        return
      }

      let marker: { start?: boolean; worktree?: string }
      try {
        marker = JSON.parse(embedFooter)
      } catch {
        return // Not a valid JSON marker
      }

      if (!marker.start) {
        return // Not an auto-start thread
      }

      discordLogger.log(`[BOT_SESSION] Detected bot-initiated thread: ${thread.name}`)

      const prompt = starterMessage.content.trim()
      if (!prompt) {
        discordLogger.log(`[BOT_SESSION] No prompt found in starter message`)
        return
      }

      // Get directory from database
      const channelConfig = await getChannelDirectory(parent.id)

      if (!channelConfig) {
        discordLogger.log(`[BOT_SESSION] No project directory configured for parent channel`)
        return
      }

      const projectDirectory = channelConfig.directory
      const channelAppId = channelConfig.appId || undefined

      if (channelAppId && channelAppId !== currentAppId) {
        discordLogger.log(`[BOT_SESSION] Channel belongs to different bot app`)
        return
      }

      if (!fs.existsSync(projectDirectory)) {
        discordLogger.error(`[BOT_SESSION] Directory does not exist: ${projectDirectory}`)
        await thread.send({
          content: `✗ Directory does not exist: ${JSON.stringify(projectDirectory)}`,
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

        await createPendingWorktree({
          threadId: thread.id,
          worktreeName: marker.worktree,
          projectDirectory,
        })

        const getClient = await initializeOpencodeForDirectory(projectDirectory)
        if (errore.isError(getClient)) {
          discordLogger.error(`[BOT_SESSION] Failed to init OpenCode: ${getClient.message}`)
          await setWorktreeError({ threadId: thread.id, errorMessage: getClient.message })
          await thread.send({
            content: `⚠️ Failed to create worktree: ${getClient.message}\nUsing main project directory instead.`,
            flags: SILENT_MESSAGE_FLAGS,
          })
          return projectDirectory
        }

        const clientV2 = getOpencodeClientV2(projectDirectory)
        if (!clientV2) {
          discordLogger.error(`[BOT_SESSION] No v2 client for ${projectDirectory}`)
          await setWorktreeError({ threadId: thread.id, errorMessage: 'No OpenCode v2 client' })
          await thread.send({
            content: `⚠️ Failed to create worktree: No OpenCode v2 client\nUsing main project directory instead.`,
            flags: SILENT_MESSAGE_FLAGS,
          })
          return projectDirectory
        }

        const worktreeResult = await createWorktreeWithSubmodules({
          clientV2,
          directory: projectDirectory,
          name: marker.worktree,
        })

        if (errore.isError(worktreeResult)) {
          discordLogger.error(`[BOT_SESSION] Worktree creation failed: ${worktreeResult.message}`)
          await setWorktreeError({ threadId: thread.id, errorMessage: worktreeResult.message })
          await thread.send({
            content: `⚠️ Failed to create worktree: ${worktreeResult.message}\nUsing main project directory instead.`,
            flags: SILENT_MESSAGE_FLAGS,
          })
          return projectDirectory
        }

        await setWorktreeReady({ threadId: thread.id, worktreeDirectory: worktreeResult.directory })
        discordLogger.log(`[BOT_SESSION] Worktree created: ${worktreeResult.directory}`)
        await thread.send({
          content: `🌳 **Worktree: ${marker.worktree}**\n📁 \`${worktreeResult.directory}\`\n🌿 Branch: \`${worktreeResult.branch}\``,
          flags: SILENT_MESSAGE_FLAGS,
        })
        return worktreeResult.directory
      })()

      discordLogger.log(
        `[BOT_SESSION] Starting session for thread ${thread.id} with prompt: "${prompt.slice(0, 50)}..."`,
      )

      await handleOpencodeSession({
        prompt,
        thread,
        projectDirectory: sessionDirectory,
        channelId: parent.id,
        appId: currentAppId,
      })
    } catch (error) {
      voiceLogger.error('[BOT_SESSION] Error handling bot-initiated thread:', error)
      try {
        const errMsg = error instanceof Error ? error.message : String(error)
        await thread.send({ content: `Error: ${errMsg}`, flags: SILENT_MESSAGE_FLAGS })
      } catch (sendError) {
        voiceLogger.error(
          '[BOT_SESSION] Failed to send error message:',
          sendError instanceof Error ? sendError.message : String(sendError),
        )
      }
    }
  })

  await discordClient.login(token)

  const handleShutdown = async (signal: string, { skipExit = false } = {}) => {
    discordLogger.log(`Received ${signal}, cleaning up...`)

    if ((global as any).shuttingDown) {
      discordLogger.log('Already shutting down, ignoring duplicate signal')
      return
    }
    ;(global as any).shuttingDown = true

    try {
      const cleanupPromises: Promise<void>[] = []
      for (const [guildId] of voiceConnections) {
        voiceLogger.log(`[SHUTDOWN] Cleaning up voice connection for guild ${guildId}`)
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
          voiceLogger.log(`[SHUTDOWN] Stopping OpenCode server on port ${server.port} for ${dir}`)
          server.process.kill('SIGTERM')
        }
      }
      getOpencodeServers().clear()

      discordLogger.log('Closing database...')
      closeDatabase()

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

  process.on('SIGUSR2', async () => {
    discordLogger.log('Received SIGUSR2, restarting after cleanup...')
    try {
      await handleShutdown('SIGUSR2', { skipExit: true })
    } catch (error) {
      voiceLogger.error('[SIGUSR2] Error during shutdown:', error)
    }
    const { spawn } = await import('node:child_process')
    spawn(process.argv[0]!, [...process.execArgv, ...process.argv.slice(1)], {
      stdio: 'inherit',
      detached: true,
      cwd: process.cwd(),
      env: process.env,
    }).unref()
    process.exit(0)
  })

  process.on('unhandledRejection', (reason, promise) => {
    if ((global as any).shuttingDown) {
      discordLogger.log('Ignoring unhandled rejection during shutdown:', reason)
      return
    }
    discordLogger.error('Unhandled Rejection at:', promise, 'reason:', reason)
  })
}
