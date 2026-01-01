import type { FilePartInput } from '@opencode-ai/sdk'
import { getDatabase, closeDatabase } from './database.js'
import { initializeOpencodeForDirectory, getOpencodeServers } from './opencode.js'
import {
  sendThreadMessage,
  resolveTextChannel,
  getKimakiMetadata,
  escapeBackticksInCodeBlocks,
  splitMarkdownForDiscord,
  SILENT_MESSAGE_FLAGS,
} from './discord-utils.js'
import { handleForkCommand, handleForkSelectMenu } from './fork.js'
import { getOpencodeSystemMessage } from './system-message.js'
import { formatPart, getFileAttachments, getTextAttachments } from './message-formatting.js'
import {
  ensureKimakiCategory,
  ensureKimakiAudioCategory,
  createProjectChannels,
  getChannelsWithDescriptions,
  type ChannelWithTags,
} from './channel-management.js'
import {
  voiceConnections,
  setupVoiceHandling,
  cleanupVoiceConnection,
  processVoiceAttachment,
} from './voice-handler.js'
import {
  handleOpencodeSession,
  parseSlashCommand,
  abortControllers,
  pendingPermissions,
} from './session-handler.js'

export { getDatabase, closeDatabase } from './database.js'
export { initializeOpencodeForDirectory } from './opencode.js'
export { escapeBackticksInCodeBlocks, splitMarkdownForDiscord } from './discord-utils.js'
export { getOpencodeSystemMessage } from './system-message.js'
export { ensureKimakiCategory, ensureKimakiAudioCategory, createProjectChannels, getChannelsWithDescriptions } from './channel-management.js'
export type { ChannelWithTags } from './channel-management.js'

import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  ThreadAutoArchiveDuration,
  type Interaction,
  type Message,
  type TextChannel,
  type ThreadChannel,
  type VoiceChannel,
} from 'discord.js'
import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
} from '@discordjs/voice'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractTagsArrays } from './xml.js'
import { createLogger } from './logger.js'
import { setGlobalDispatcher, Agent } from 'undici'

setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }))

const discordLogger = createLogger('DISCORD')
const voiceLogger = createLogger('VOICE')

type StartOptions = {
  token: string
  appId?: string
}

export async function createDiscordClient() {
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
  })
}

export async function startDiscordBot({
  token,
  appId,
  discordClient,
}: StartOptions & { discordClient?: Client }) {
  if (!discordClient) {
    discordClient = await createDiscordClient()
  }

  let currentAppId: string | undefined = appId

  discordClient.once(Events.ClientReady, async (c) => {
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
        (ch) =>
          ch.kimakiDirectory &&
          (!ch.kimakiApp || ch.kimakiApp === currentAppId),
      )

      if (kimakiChannels.length > 0) {
        discordLogger.log(
          `  Found ${kimakiChannels.length} channel(s) for this bot:`,
        )
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
  })

  discordClient.on(Events.MessageCreate, async (message: Message) => {
    try {
      if (message.author?.bot) {
        return
      }
      if (message.partial) {
        discordLogger.log(`Fetching partial message ${message.id}`)
        try {
          await message.fetch()
        } catch (error) {
          discordLogger.log(
            `Failed to fetch partial message ${message.id}:`,
            error,
          )
          return
        }
      }

      if (message.guild && message.member) {
        const isOwner = message.member.id === message.guild.ownerId
        const isAdmin = message.member.permissions.has(
          PermissionsBitField.Flags.Administrator,
        )
        const canManageServer = message.member.permissions.has(
          PermissionsBitField.Flags.ManageGuild,
        )
        const hasKimakiRole = message.member.roles.cache.some(
          (role) => role.name.toLowerCase() === 'kimaki',
        )

        if (!isOwner && !isAdmin && !canManageServer && !hasKimakiRole) {
          await message.react('🔒')
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

        const row = getDatabase()
          .prepare('SELECT session_id FROM thread_sessions WHERE thread_id = ?')
          .get(thread.id) as { session_id: string } | undefined

        if (!row) {
          discordLogger.log(`No session found for thread ${thread.id}`)
          return
        }

        voiceLogger.log(
          `[SESSION] Found session ${row.session_id} for thread ${thread.id}`,
        )

        const parent = thread.parent as TextChannel | null
        let projectDirectory: string | undefined
        let channelAppId: string | undefined

        if (parent?.topic) {
          const extracted = extractTagsArrays({
            xml: parent.topic,
            tags: ['kimaki.directory', 'kimaki.app'],
          })

          projectDirectory = extracted['kimaki.directory']?.[0]?.trim()
          channelAppId = extracted['kimaki.app']?.[0]?.trim()
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

        let messageContent = message.content || ''

        let sessionMessagesText: string | undefined
        if (projectDirectory && row.session_id) {
          try {
            const getClient = await initializeOpencodeForDirectory(projectDirectory)
            const messagesResponse = await getClient().session.messages({
              path: { id: row.session_id },
            })
            const messages = messagesResponse.data || []
            const recentMessages = messages.slice(-10)
            sessionMessagesText = recentMessages
              .map((m) => {
                const role = m.info.role === 'user' ? 'User' : 'Assistant'
                const text = (() => {
                  if (m.info.role === 'user') {
                    const textParts = (m.parts || []).filter((p) => p.type === 'text')
                    return textParts
                      .map((p) => ('text' in p ? p.text : ''))
                      .filter(Boolean)
                      .join('\n')
                  }
                  const assistantInfo = m.info as { text?: string }
                  return assistantInfo.text?.slice(0, 500)
                })()
                return `[${role}]: ${text || '(no text)'}`
              })
              .join('\n\n')
          } catch (e) {
            voiceLogger.log(`Could not get session messages:`, e)
          }
        }

        const transcription = await processVoiceAttachment({
          message,
          thread,
          projectDirectory,
          appId: currentAppId,
          sessionMessages: sessionMessagesText,
        })
        if (transcription) {
          messageContent = transcription
        }

        const fileAttachments = getFileAttachments(message)
        const textAttachmentsContent = await getTextAttachments(message)
        const promptWithAttachments = textAttachmentsContent
          ? `${messageContent}\n\n${textAttachmentsContent}`
          : messageContent
        const parsedCommand = parseSlashCommand(messageContent)
        await handleOpencodeSession({
          prompt: promptWithAttachments,
          thread,
          projectDirectory,
          originalMessage: message,
          images: fileAttachments,
          parsedCommand,
        })
        return
      }

      if (channel.type === ChannelType.GuildText) {
        const textChannel = channel as TextChannel
        voiceLogger.log(
          `[GUILD_TEXT] Message in text channel #${textChannel.name} (${textChannel.id})`,
        )

        if (!textChannel.topic) {
          voiceLogger.log(
            `[IGNORED] Channel #${textChannel.name} has no description`,
          )
          return
        }

        const extracted = extractTagsArrays({
          xml: textChannel.topic,
          tags: ['kimaki.directory', 'kimaki.app'],
        })

        const projectDirectory = extracted['kimaki.directory']?.[0]?.trim()
        const channelAppId = extracted['kimaki.app']?.[0]?.trim()

        if (!projectDirectory) {
          voiceLogger.log(
            `[IGNORED] Channel #${textChannel.name} has no kimaki.directory tag`,
          )
          return
        }

        if (channelAppId && channelAppId !== currentAppId) {
          voiceLogger.log(
            `[IGNORED] Channel belongs to different bot app (expected: ${currentAppId}, got: ${channelAppId})`,
          )
          return
        }

        discordLogger.log(
          `DIRECTORY: Found kimaki.directory: ${projectDirectory}`,
        )
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

        const hasVoice = message.attachments.some((a) =>
          a.contentType?.startsWith('audio/'),
        )

        const threadName = hasVoice
          ? 'Voice Message'
          : message.content?.replace(/\s+/g, ' ').trim() || 'Claude Thread'

        const thread = await message.startThread({
          name: threadName.slice(0, 80),
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
          reason: 'Start Claude session',
        })

        discordLogger.log(`Created thread "${thread.name}" (${thread.id})`)

        let messageContent = message.content || ''

        const transcription = await processVoiceAttachment({
          message,
          thread,
          projectDirectory,
          isNewThread: true,
          appId: currentAppId,
        })
        if (transcription) {
          messageContent = transcription
        }

        const fileAttachments = getFileAttachments(message)
        const textAttachmentsContent = await getTextAttachments(message)
        const promptWithAttachments = textAttachmentsContent
          ? `${messageContent}\n\n${textAttachmentsContent}`
          : messageContent
        const parsedCommand = parseSlashCommand(messageContent)
        await handleOpencodeSession({
          prompt: promptWithAttachments,
          thread,
          projectDirectory,
          originalMessage: message,
          images: fileAttachments,
          parsedCommand,
        })
      } else {
        discordLogger.log(`Channel type ${channel.type} is not supported`)
      }
    } catch (error) {
      voiceLogger.error('Discord handler error:', error)
      try {
        const errMsg = error instanceof Error ? error.message : String(error)
        await message.reply({ content: `Error: ${errMsg}`, flags: SILENT_MESSAGE_FLAGS })
      } catch {
        voiceLogger.error('Discord handler error (fallback):', error)
      }
    }
  })

  discordClient.on(
    Events.InteractionCreate,
    async (interaction: Interaction) => {
      try {
        if (interaction.isAutocomplete()) {
          if (interaction.commandName === 'resume') {
            const focusedValue = interaction.options.getFocused()

            let projectDirectory: string | undefined
            if (interaction.channel) {
              const textChannel = await resolveTextChannel(
                interaction.channel as TextChannel | ThreadChannel | null,
              )
              if (textChannel) {
                const { projectDirectory: directory, channelAppId } =
                  getKimakiMetadata(textChannel)
                if (channelAppId && channelAppId !== currentAppId) {
                  await interaction.respond([])
                  return
                }
                projectDirectory = directory
              }
            }

            if (!projectDirectory) {
              await interaction.respond([])
              return
            }

            try {
              const getClient =
                await initializeOpencodeForDirectory(projectDirectory)

              const sessionsResponse = await getClient().session.list()
              if (!sessionsResponse.data) {
                await interaction.respond([])
                return
              }

              const existingSessionIds = new Set(
                (
                  getDatabase()
                    .prepare('SELECT session_id FROM thread_sessions')
                    .all() as { session_id: string }[]
                ).map((row) => row.session_id),
              )

              const sessions = sessionsResponse.data
                .filter((session) => !existingSessionIds.has(session.id))
                .filter((session) =>
                  session.title
                    .toLowerCase()
                    .includes(focusedValue.toLowerCase()),
                )
                .slice(0, 25)
                .map((session) => {
                  const dateStr = new Date(
                    session.time.updated,
                  ).toLocaleString()
                  const suffix = ` (${dateStr})`
                  const maxTitleLength = 100 - suffix.length

                  let title = session.title
                  if (title.length > maxTitleLength) {
                    title = title.slice(0, Math.max(0, maxTitleLength - 1)) + '…'
                  }

                  return {
                    name: `${title}${suffix}`,
                    value: session.id,
                  }
                })

              await interaction.respond(sessions)
            } catch (error) {
              voiceLogger.error(
                '[AUTOCOMPLETE] Error fetching sessions:',
                error,
              )
              await interaction.respond([])
            }
          } else if (interaction.commandName === 'session') {
            const focusedOption = interaction.options.getFocused(true)

            if (focusedOption.name === 'files') {
              const focusedValue = focusedOption.value

              const parts = focusedValue.split(',')
              const previousFiles = parts
                .slice(0, -1)
                .map((f) => f.trim())
                .filter((f) => f)
              const currentQuery = (parts[parts.length - 1] || '').trim()

              let projectDirectory: string | undefined
              if (interaction.channel) {
                const textChannel = await resolveTextChannel(
                  interaction.channel as TextChannel | ThreadChannel | null,
                )
                if (textChannel) {
                  const { projectDirectory: directory, channelAppId } =
                    getKimakiMetadata(textChannel)
                  if (channelAppId && channelAppId !== currentAppId) {
                    await interaction.respond([])
                    return
                  }
                  projectDirectory = directory
                }
              }

              if (!projectDirectory) {
                await interaction.respond([])
                return
              }

              try {
                const getClient =
                  await initializeOpencodeForDirectory(projectDirectory)

                const response = await getClient().find.files({
                  query: {
                    query: currentQuery || '',
                  },
                })

                const files = response.data || []

                const prefix =
                  previousFiles.length > 0
                    ? previousFiles.join(', ') + ', '
                    : ''

                const choices = files
                  .map((file: string) => {
                    const fullValue = prefix + file
                    const allFiles = [...previousFiles, file]
                    const allBasenames = allFiles.map(
                      (f) => f.split('/').pop() || f,
                    )
                    let displayName = allBasenames.join(', ')
                    if (displayName.length > 100) {
                      displayName = '…' + displayName.slice(-97)
                    }
                    return {
                      name: displayName,
                      value: fullValue,
                    }
                  })
                  .filter((choice) => choice.value.length <= 100)
                  .slice(0, 25)

                await interaction.respond(choices)
              } catch (error) {
                voiceLogger.error('[AUTOCOMPLETE] Error fetching files:', error)
                await interaction.respond([])
              }
            }
          } else if (interaction.commandName === 'add-project') {
            const focusedValue = interaction.options.getFocused()

            try {
              const currentDir = process.cwd()
              const getClient = await initializeOpencodeForDirectory(currentDir)

              const projectsResponse = await getClient().project.list({})
              if (!projectsResponse.data) {
                await interaction.respond([])
                return
              }

              const db = getDatabase()
              const existingDirs = db
                .prepare(
                  'SELECT DISTINCT directory FROM channel_directories WHERE channel_type = ?',
                )
                .all('text') as { directory: string }[]
              const existingDirSet = new Set(
                existingDirs.map((row) => row.directory),
              )

              const availableProjects = projectsResponse.data.filter(
                (project) => !existingDirSet.has(project.worktree),
              )

              const projects = availableProjects
                .filter((project) => {
                  const baseName = path.basename(project.worktree)
                  const searchText = `${baseName} ${project.worktree}`.toLowerCase()
                  return searchText.includes(focusedValue.toLowerCase())
                })
                .sort((a, b) => {
                  const aTime = a.time.initialized || a.time.created
                  const bTime = b.time.initialized || b.time.created
                  return bTime - aTime
                })
                .slice(0, 25)
                .map((project) => {
                  const name = `${path.basename(project.worktree)} (${project.worktree})`
                  return {
                    name: name.length > 100 ? name.slice(0, 99) + '…' : name,
                    value: project.id,
                  }
                })

              await interaction.respond(projects)
            } catch (error) {
              voiceLogger.error(
                '[AUTOCOMPLETE] Error fetching projects:',
                error,
              )
              await interaction.respond([])
            }
          }
        }

        if (interaction.isChatInputCommand()) {
          const command = interaction

          if (command.commandName === 'session') {
            await command.deferReply({ ephemeral: false })

            const prompt = command.options.getString('prompt', true)
            const filesString = command.options.getString('files') || ''
            const channel = command.channel

            if (!channel || channel.type !== ChannelType.GuildText) {
              await command.editReply(
                'This command can only be used in text channels',
              )
              return
            }

            const textChannel = channel as TextChannel

            let projectDirectory: string | undefined
            let channelAppId: string | undefined

            if (textChannel.topic) {
              const extracted = extractTagsArrays({
                xml: textChannel.topic,
                tags: ['kimaki.directory', 'kimaki.app'],
              })

              projectDirectory = extracted['kimaki.directory']?.[0]?.trim()
              channelAppId = extracted['kimaki.app']?.[0]?.trim()
            }

            if (channelAppId && channelAppId !== currentAppId) {
              await command.editReply(
                'This channel is not configured for this bot',
              )
              return
            }

            if (!projectDirectory) {
              await command.editReply(
                'This channel is not configured with a project directory',
              )
              return
            }

            if (!fs.existsSync(projectDirectory)) {
              await command.editReply(
                `Directory does not exist: ${projectDirectory}`,
              )
              return
            }

            try {
              const getClient =
                await initializeOpencodeForDirectory(projectDirectory)

              const files = filesString
                .split(',')
                .map((f) => f.trim())
                .filter((f) => f)

              let fullPrompt = prompt
              if (files.length > 0) {
                fullPrompt = `${prompt}\n\n@${files.join(' @')}`
              }

              const starterMessage = await textChannel.send({
                content: `🚀 **Starting OpenCode session**\n📝 ${prompt.slice(0, 200)}${prompt.length > 200 ? '…' : ''}${files.length > 0 ? `\n📎 Files: ${files.join(', ')}` : ''}`,
                flags: SILENT_MESSAGE_FLAGS,
              })

              const thread = await starterMessage.startThread({
                name: prompt.slice(0, 100),
                autoArchiveDuration: 1440,
                reason: 'OpenCode session',
              })

              await command.editReply(
                `Created new session in ${thread.toString()}`,
              )

              const parsedCommand = parseSlashCommand(fullPrompt)
              await handleOpencodeSession({
                prompt: fullPrompt,
                thread,
                projectDirectory,
                parsedCommand,
              })
            } catch (error) {
              voiceLogger.error('[SESSION] Error:', error)
              await command.editReply(
                `Failed to create session: ${error instanceof Error ? error.message : 'Unknown error'}`,
              )
            }
          } else if (command.commandName === 'resume') {
            await command.deferReply({ ephemeral: false })

            const sessionId = command.options.getString('session', true)
            const channel = command.channel

            if (!channel || channel.type !== ChannelType.GuildText) {
              await command.editReply(
                'This command can only be used in text channels',
              )
              return
            }

            const textChannel = channel as TextChannel

            let projectDirectory: string | undefined
            let channelAppId: string | undefined

            if (textChannel.topic) {
              const extracted = extractTagsArrays({
                xml: textChannel.topic,
                tags: ['kimaki.directory', 'kimaki.app'],
              })

              projectDirectory = extracted['kimaki.directory']?.[0]?.trim()
              channelAppId = extracted['kimaki.app']?.[0]?.trim()
            }

            if (channelAppId && channelAppId !== currentAppId) {
              await command.editReply(
                'This channel is not configured for this bot',
              )
              return
            }

            if (!projectDirectory) {
              await command.editReply(
                'This channel is not configured with a project directory',
              )
              return
            }

            if (!fs.existsSync(projectDirectory)) {
              await command.editReply(
                `Directory does not exist: ${projectDirectory}`,
              )
              return
            }

            try {
              const getClient =
                await initializeOpencodeForDirectory(projectDirectory)

              const sessionResponse = await getClient().session.get({
                path: { id: sessionId },
              })

              if (!sessionResponse.data) {
                await command.editReply('Session not found')
                return
              }

              const sessionTitle = sessionResponse.data.title

              const thread = await textChannel.threads.create({
                name: `Resume: ${sessionTitle}`.slice(0, 100),
                autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
                reason: `Resuming session ${sessionId}`,
              })

              getDatabase()
                .prepare(
                  'INSERT OR REPLACE INTO thread_sessions (thread_id, session_id) VALUES (?, ?)',
                )
                .run(thread.id, sessionId)

              voiceLogger.log(
                `[RESUME] Created thread ${thread.id} for session ${sessionId}`,
              )

              const messagesResponse = await getClient().session.messages({
                path: { id: sessionId },
              })

              if (!messagesResponse.data) {
                throw new Error('Failed to fetch session messages')
              }

              const messages = messagesResponse.data

              await command.editReply(
                `Resumed session "${sessionTitle}" in ${thread.toString()}`,
              )

              await sendThreadMessage(
                thread,
                `📂 **Resumed session:** ${sessionTitle}\n📅 **Created:** ${new Date(sessionResponse.data.time.created).toLocaleString()}\n\n*Loading ${messages.length} messages...*`,
              )

              const allAssistantParts: { id: string; content: string }[] = []
              for (const message of messages) {
                if (message.info.role === 'assistant') {
                  for (const part of message.parts) {
                    const content = formatPart(part)
                    if (content.trim()) {
                      allAssistantParts.push({ id: part.id, content })
                    }
                  }
                }
              }

              const partsToRender = allAssistantParts.slice(-30)
              const skippedCount = allAssistantParts.length - partsToRender.length

              if (skippedCount > 0) {
                await sendThreadMessage(
                  thread,
                  `*Skipped ${skippedCount} older assistant parts...*`,
                )
              }

              if (partsToRender.length > 0) {
                const combinedContent = partsToRender
                  .map((p) => p.content)
                  .join('\n')

                const discordMessage = await sendThreadMessage(
                  thread,
                  combinedContent,
                )

                const stmt = getDatabase().prepare(
                  'INSERT OR REPLACE INTO part_messages (part_id, message_id, thread_id) VALUES (?, ?, ?)',
                )

                const transaction = getDatabase().transaction(
                  (parts: { id: string }[]) => {
                    for (const part of parts) {
                      stmt.run(part.id, discordMessage.id, thread.id)
                    }
                  },
                )

                transaction(partsToRender)
              }

              const messageCount = messages.length

              await sendThreadMessage(
                thread,
                `✅ **Session resumed!** Loaded ${messageCount} messages.\n\nYou can now continue the conversation by sending messages in this thread.`,
              )
            } catch (error) {
              voiceLogger.error('[RESUME] Error:', error)
              await command.editReply(
                `Failed to resume session: ${error instanceof Error ? error.message : 'Unknown error'}`,
              )
            }
          } else if (command.commandName === 'add-project') {
            await command.deferReply({ ephemeral: false })

            const projectId = command.options.getString('project', true)
            const guild = command.guild

            if (!guild) {
              await command.editReply('This command can only be used in a guild')
              return
            }

            try {
              const currentDir = process.cwd()
              const getClient = await initializeOpencodeForDirectory(currentDir)

              const projectsResponse = await getClient().project.list({})
              if (!projectsResponse.data) {
                await command.editReply('Failed to fetch projects')
                return
              }

              const project = projectsResponse.data.find(
                (p) => p.id === projectId,
              )

              if (!project) {
                await command.editReply('Project not found')
                return
              }

              const directory = project.worktree

              if (!fs.existsSync(directory)) {
                await command.editReply(`Directory does not exist: ${directory}`)
                return
              }

              const db = getDatabase()
              const existingChannel = db
                .prepare(
                  'SELECT channel_id FROM channel_directories WHERE directory = ? AND channel_type = ?',
                )
                .get(directory, 'text') as { channel_id: string } | undefined

              if (existingChannel) {
                await command.editReply(
                  `A channel already exists for this directory: <#${existingChannel.channel_id}>`,
                )
                return
              }

              const { textChannelId, voiceChannelId, channelName } =
                await createProjectChannels({
                  guild,
                  projectDirectory: directory,
                  appId: currentAppId!,
                })

              await command.editReply(
                `✅ Created channels for project:\n📝 Text: <#${textChannelId}>\n🔊 Voice: <#${voiceChannelId}>\n📁 Directory: \`${directory}\``,
              )

              discordLogger.log(
                `Created channels for project ${channelName} at ${directory}`,
              )
            } catch (error) {
              voiceLogger.error('[ADD-PROJECT] Error:', error)
              await command.editReply(
                `Failed to create channels: ${error instanceof Error ? error.message : 'Unknown error'}`,
              )
            }
          } else if (command.commandName === 'create-new-project') {
            await command.deferReply({ ephemeral: false })

            const projectName = command.options.getString('name', true)
            const guild = command.guild
            const channel = command.channel

            if (!guild) {
              await command.editReply('This command can only be used in a guild')
              return
            }

            if (!channel || channel.type !== ChannelType.GuildText) {
              await command.editReply('This command can only be used in a text channel')
              return
            }

            const sanitizedName = projectName
              .toLowerCase()
              .replace(/[^a-z0-9-]/g, '-')
              .replace(/-+/g, '-')
              .replace(/^-|-$/g, '')
              .slice(0, 100)

            if (!sanitizedName) {
              await command.editReply('Invalid project name')
              return
            }

            const kimakiDir = path.join(os.homedir(), 'kimaki')
            const projectDirectory = path.join(kimakiDir, sanitizedName)

            try {
              if (!fs.existsSync(kimakiDir)) {
                fs.mkdirSync(kimakiDir, { recursive: true })
                discordLogger.log(`Created kimaki directory: ${kimakiDir}`)
              }

              if (fs.existsSync(projectDirectory)) {
                await command.editReply(`Project directory already exists: ${projectDirectory}`)
                return
              }

              fs.mkdirSync(projectDirectory, { recursive: true })
              discordLogger.log(`Created project directory: ${projectDirectory}`)

              const { execSync } = await import('node:child_process')
              execSync('git init', { cwd: projectDirectory, stdio: 'pipe' })
              discordLogger.log(`Initialized git in: ${projectDirectory}`)

              const { textChannelId, voiceChannelId, channelName } =
                await createProjectChannels({
                  guild,
                  projectDirectory,
                  appId: currentAppId!,
                })

              const textChannel = await guild.channels.fetch(textChannelId) as TextChannel

              await command.editReply(
                `✅ Created new project **${sanitizedName}**\n📁 Directory: \`${projectDirectory}\`\n📝 Text: <#${textChannelId}>\n🔊 Voice: <#${voiceChannelId}>\n\n_Starting session..._`,
              )

              const starterMessage = await textChannel.send({
                content: `🚀 **New project initialized**\n📁 \`${projectDirectory}\``,
                flags: SILENT_MESSAGE_FLAGS,
              })

              const thread = await starterMessage.startThread({
                name: `Init: ${sanitizedName}`,
                autoArchiveDuration: 1440,
                reason: 'New project session',
              })

              await handleOpencodeSession({
                prompt: 'The project was just initialized. Say hi and ask what the user wants to build.',
                thread,
                projectDirectory,
              })

              discordLogger.log(
                `Created new project ${channelName} at ${projectDirectory}`,
              )
            } catch (error) {
              voiceLogger.error('[ADD-NEW-PROJECT] Error:', error)
              await command.editReply(
                `Failed to create new project: ${error instanceof Error ? error.message : 'Unknown error'}`,
              )
            }
          } else if (
            command.commandName === 'accept' ||
            command.commandName === 'accept-always'
          ) {
            const scope = command.commandName === 'accept-always' ? 'always' : 'once'
            const channel = command.channel

            if (!channel) {
              await command.reply({
                content: 'This command can only be used in a channel',
                ephemeral: true,
                flags: SILENT_MESSAGE_FLAGS,
              })
              return
            }

            const isThread = [
              ChannelType.PublicThread,
              ChannelType.PrivateThread,
              ChannelType.AnnouncementThread,
            ].includes(channel.type)

            if (!isThread) {
              await command.reply({
                content: 'This command can only be used in a thread with an active session',
                ephemeral: true,
                flags: SILENT_MESSAGE_FLAGS,
              })
              return
            }

            const pending = pendingPermissions.get(channel.id)
            if (!pending) {
              await command.reply({
                content: 'No pending permission request in this thread',
                ephemeral: true,
                flags: SILENT_MESSAGE_FLAGS,
              })
              return
            }

            try {
              const getClient = await initializeOpencodeForDirectory(pending.directory)
              await getClient().postSessionIdPermissionsPermissionId({
                path: {
                  id: pending.permission.sessionID,
                  permissionID: pending.permission.id,
                },
                body: {
                  response: scope,
                },
              })

              pendingPermissions.delete(channel.id)
              const msg =
                scope === 'always'
                  ? `✅ Permission **accepted** (auto-approve similar requests)`
                  : `✅ Permission **accepted**`
              await command.reply({ content: msg, flags: SILENT_MESSAGE_FLAGS })
              discordLogger.log(
                `Permission ${pending.permission.id} accepted with scope: ${scope}`,
              )
            } catch (error) {
              voiceLogger.error('[ACCEPT] Error:', error)
              await command.reply({
                content: `Failed to accept permission: ${error instanceof Error ? error.message : 'Unknown error'}`,
                ephemeral: true,
                flags: SILENT_MESSAGE_FLAGS,
              })
            }
          } else if (command.commandName === 'reject') {
            const channel = command.channel

            if (!channel) {
              await command.reply({
                content: 'This command can only be used in a channel',
                ephemeral: true,
                flags: SILENT_MESSAGE_FLAGS,
              })
              return
            }

            const isThread = [
              ChannelType.PublicThread,
              ChannelType.PrivateThread,
              ChannelType.AnnouncementThread,
            ].includes(channel.type)

            if (!isThread) {
              await command.reply({
                content: 'This command can only be used in a thread with an active session',
                ephemeral: true,
                flags: SILENT_MESSAGE_FLAGS,
              })
              return
            }

            const pending = pendingPermissions.get(channel.id)
            if (!pending) {
              await command.reply({
                content: 'No pending permission request in this thread',
                ephemeral: true,
                flags: SILENT_MESSAGE_FLAGS,
              })
              return
            }

            try {
              const getClient = await initializeOpencodeForDirectory(pending.directory)
              await getClient().postSessionIdPermissionsPermissionId({
                path: {
                  id: pending.permission.sessionID,
                  permissionID: pending.permission.id,
                },
                body: {
                  response: 'reject',
                },
              })

              pendingPermissions.delete(channel.id)
              await command.reply({ content: `❌ Permission **rejected**`, flags: SILENT_MESSAGE_FLAGS })
              discordLogger.log(`Permission ${pending.permission.id} rejected`)
            } catch (error) {
              voiceLogger.error('[REJECT] Error:', error)
              await command.reply({
                content: `Failed to reject permission: ${error instanceof Error ? error.message : 'Unknown error'}`,
                ephemeral: true,
                flags: SILENT_MESSAGE_FLAGS,
              })
            }
          } else if (command.commandName === 'abort') {
            const channel = command.channel

            if (!channel) {
              await command.reply({
                content: 'This command can only be used in a channel',
                ephemeral: true,
                flags: SILENT_MESSAGE_FLAGS,
              })
              return
            }

            const isThread = [
              ChannelType.PublicThread,
              ChannelType.PrivateThread,
              ChannelType.AnnouncementThread,
            ].includes(channel.type)

            if (!isThread) {
              await command.reply({
                content: 'This command can only be used in a thread with an active session',
                ephemeral: true,
                flags: SILENT_MESSAGE_FLAGS,
              })
              return
            }

            const textChannel = await resolveTextChannel(channel as ThreadChannel)
            const { projectDirectory: directory } = getKimakiMetadata(textChannel)

            if (!directory) {
              await command.reply({
                content: 'Could not determine project directory for this channel',
                ephemeral: true,
                flags: SILENT_MESSAGE_FLAGS,
              })
              return
            }

            const row = getDatabase()
              .prepare('SELECT session_id FROM thread_sessions WHERE thread_id = ?')
              .get(channel.id) as { session_id: string } | undefined

            if (!row?.session_id) {
              await command.reply({
                content: 'No active session in this thread',
                ephemeral: true,
                flags: SILENT_MESSAGE_FLAGS,
              })
              return
            }

            const sessionId = row.session_id

            try {
              const existingController = abortControllers.get(sessionId)
              if (existingController) {
                existingController.abort(new Error('User requested abort'))
                abortControllers.delete(sessionId)
              }

              const getClient = await initializeOpencodeForDirectory(directory)
              await getClient().session.abort({
                path: { id: sessionId },
              })

              await command.reply({ content: `🛑 Request **aborted**`, flags: SILENT_MESSAGE_FLAGS })
              discordLogger.log(`Session ${sessionId} aborted by user`)
            } catch (error) {
              voiceLogger.error('[ABORT] Error:', error)
              await command.reply({
                content: `Failed to abort: ${error instanceof Error ? error.message : 'Unknown error'}`,
                ephemeral: true,
                flags: SILENT_MESSAGE_FLAGS,
              })
            }
          } else if (command.commandName === 'share') {
            const channel = command.channel

            if (!channel) {
              await command.reply({
                content: 'This command can only be used in a channel',
                ephemeral: true,
                flags: SILENT_MESSAGE_FLAGS,
              })
              return
            }

            const isThread = [
              ChannelType.PublicThread,
              ChannelType.PrivateThread,
              ChannelType.AnnouncementThread,
            ].includes(channel.type)

            if (!isThread) {
              await command.reply({
                content: 'This command can only be used in a thread with an active session',
                ephemeral: true,
                flags: SILENT_MESSAGE_FLAGS,
              })
              return
            }

            const textChannel = await resolveTextChannel(channel as ThreadChannel)
            const { projectDirectory: directory } = getKimakiMetadata(textChannel)

            if (!directory) {
              await command.reply({
                content: 'Could not determine project directory for this channel',
                ephemeral: true,
                flags: SILENT_MESSAGE_FLAGS,
              })
              return
            }

            const row = getDatabase()
              .prepare('SELECT session_id FROM thread_sessions WHERE thread_id = ?')
              .get(channel.id) as { session_id: string } | undefined

            if (!row?.session_id) {
              await command.reply({
                content: 'No active session in this thread',
                ephemeral: true,
                flags: SILENT_MESSAGE_FLAGS,
              })
              return
            }

            const sessionId = row.session_id

            try {
              const getClient = await initializeOpencodeForDirectory(directory)
              const response = await getClient().session.share({
                path: { id: sessionId },
              })

              if (!response.data?.share?.url) {
                await command.reply({
                  content: 'Failed to generate share URL',
                  ephemeral: true,
                  flags: SILENT_MESSAGE_FLAGS,
                })
                return
              }

              await command.reply({ content: `🔗 **Session shared:** ${response.data.share.url}`, flags: SILENT_MESSAGE_FLAGS })
              discordLogger.log(`Session ${sessionId} shared: ${response.data.share.url}`)
            } catch (error) {
              voiceLogger.error('[SHARE] Error:', error)
              await command.reply({
                content: `Failed to share session: ${error instanceof Error ? error.message : 'Unknown error'}`,
                ephemeral: true,
                flags: SILENT_MESSAGE_FLAGS,
              })
            }
          } else if (command.commandName === 'fork') {
            await handleForkCommand(command)
          }
        }

        if (interaction.isStringSelectMenu()) {
          if (interaction.customId.startsWith('fork_select:')) {
            await handleForkSelectMenu(interaction)
          }
        }
      } catch (error) {
        voiceLogger.error('[INTERACTION] Error handling interaction:', error)
      }
    },
  )

  discordClient.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    try {
      const member = newState.member || oldState.member
      if (!member) return

      const guild = newState.guild || oldState.guild
      const isOwner = member.id === guild.ownerId
      const isAdmin = member.permissions.has(
        PermissionsBitField.Flags.Administrator,
      )
      const canManageServer = member.permissions.has(
        PermissionsBitField.Flags.ManageGuild,
      )
      const hasKimakiRole = member.roles.cache.some(
        (role) => role.name.toLowerCase() === 'kimaki',
      )

      if (!isOwner && !isAdmin && !canManageServer && !hasKimakiRole) {
        return
      }

      if (oldState.channelId !== null && newState.channelId === null) {
        voiceLogger.log(
          `Admin user ${member.user.tag} left voice channel: ${oldState.channel?.name}`,
        )

        const guildId = guild.id
        const voiceData = voiceConnections.get(guildId)

        if (
          voiceData &&
          voiceData.connection.joinConfig.channelId === oldState.channelId
        ) {
          const voiceChannel = oldState.channel as VoiceChannel
          if (!voiceChannel) return

          const hasOtherAdmins = voiceChannel.members.some((m) => {
            if (m.id === member.id || m.user.bot) return false
            return (
              m.id === guild.ownerId ||
              m.permissions.has(PermissionsBitField.Flags.Administrator) ||
              m.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
              m.roles.cache.some((role) => role.name.toLowerCase() === 'kimaki')
            )
          })

          if (!hasOtherAdmins) {
            voiceLogger.log(
              `No other admins in channel, bot leaving voice channel in guild: ${guild.name}`,
            )

            await cleanupVoiceConnection(guildId)
          } else {
            voiceLogger.log(
              `Other admins still in channel, bot staying in voice channel`,
            )
          }
        }
        return
      }

      if (
        oldState.channelId !== null &&
        newState.channelId !== null &&
        oldState.channelId !== newState.channelId
      ) {
        voiceLogger.log(
          `Admin user ${member.user.tag} moved from ${oldState.channel?.name} to ${newState.channel?.name}`,
        )

        const guildId = guild.id
        const voiceData = voiceConnections.get(guildId)

        if (
          voiceData &&
          voiceData.connection.joinConfig.channelId === oldState.channelId
        ) {
          const oldVoiceChannel = oldState.channel as VoiceChannel
          if (oldVoiceChannel) {
            const hasOtherAdmins = oldVoiceChannel.members.some((m) => {
              if (m.id === member.id || m.user.bot) return false
              return (
                m.id === guild.ownerId ||
                m.permissions.has(PermissionsBitField.Flags.Administrator) ||
                m.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
                m.roles.cache.some((role) => role.name.toLowerCase() === 'kimaki')
              )
            })

            if (!hasOtherAdmins) {
              voiceLogger.log(
                `Following admin to new channel: ${newState.channel?.name}`,
              )
              const voiceChannel = newState.channel as VoiceChannel
              if (voiceChannel) {
                voiceData.connection.rejoin({
                  channelId: voiceChannel.id,
                  selfDeaf: false,
                  selfMute: false,
                })
              }
            } else {
              voiceLogger.log(
                `Other admins still in old channel, bot staying put`,
              )
            }
          }
        }
      }

      if (oldState.channelId === null && newState.channelId !== null) {
        voiceLogger.log(
          `Admin user ${member.user.tag} (Owner: ${isOwner}, Admin: ${isAdmin}) joined voice channel: ${newState.channel?.name}`,
        )
      }

      if (newState.channelId === null) return

      const voiceChannel = newState.channel as VoiceChannel
      if (!voiceChannel) return

      const existingVoiceData = voiceConnections.get(newState.guild.id)
      if (
        existingVoiceData &&
        existingVoiceData.connection.state.status !==
          VoiceConnectionStatus.Destroyed
      ) {
        voiceLogger.log(
          `Bot already connected to a voice channel in guild ${newState.guild.name}`,
        )

        if (
          existingVoiceData.connection.joinConfig.channelId !== voiceChannel.id
        ) {
          voiceLogger.log(
            `Moving bot from channel ${existingVoiceData.connection.joinConfig.channelId} to ${voiceChannel.id}`,
          )
          existingVoiceData.connection.rejoin({
            channelId: voiceChannel.id,
            selfDeaf: false,
            selfMute: false,
          })
        }
        return
      }

      try {
        voiceLogger.log(
          `Attempting to join voice channel: ${voiceChannel.name} (${voiceChannel.id})`,
        )

        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: newState.guild.id,
          adapterCreator: newState.guild.voiceAdapterCreator,
          selfDeaf: false,
          debug: true,
          daveEncryption: false,
          selfMute: false,
        })

        voiceConnections.set(newState.guild.id, { connection })

        await entersState(connection, VoiceConnectionStatus.Ready, 30_000)
        voiceLogger.log(
          `Successfully joined voice channel: ${voiceChannel.name} in guild: ${newState.guild.name}`,
        )

        await setupVoiceHandling({
          connection,
          guildId: newState.guild.id,
          channelId: voiceChannel.id,
          appId: currentAppId!,
          discordClient,
        })

        connection.on(VoiceConnectionStatus.Disconnected, async () => {
          voiceLogger.log(
            `Disconnected from voice channel in guild: ${newState.guild.name}`,
          )
          try {
            await Promise.race([
              entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
              entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
            ])
            voiceLogger.log(`Reconnecting to voice channel`)
          } catch (error) {
            voiceLogger.log(`Failed to reconnect, destroying connection`)
            connection.destroy()
            voiceConnections.delete(newState.guild.id)
          }
        })

        connection.on(VoiceConnectionStatus.Destroyed, async () => {
          voiceLogger.log(
            `Connection destroyed for guild: ${newState.guild.name}`,
          )
          await cleanupVoiceConnection(newState.guild.id)
        })

        connection.on('error', (error) => {
          voiceLogger.error(
            `Connection error in guild ${newState.guild.name}:`,
            error,
          )
        })
      } catch (error) {
        voiceLogger.error(`Failed to join voice channel:`, error)
        await cleanupVoiceConnection(newState.guild.id)
      }
    } catch (error) {
      voiceLogger.error('Error in voice state update handler:', error)
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
