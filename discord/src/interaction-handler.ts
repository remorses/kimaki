// Discord slash command and interaction handler.
// Processes all slash commands (/session, /resume, /fork, /model, /abort, etc.)
// and manages autocomplete, select menu interactions for the bot.

import {
  ChannelType,
  Events,
  ThreadAutoArchiveDuration,
  type Client,
  type Interaction,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getDatabase } from './database.js'
import { initializeOpencodeForDirectory } from './opencode.js'
import {
  sendThreadMessage,
  resolveTextChannel,
  getKimakiMetadata,
  SILENT_MESSAGE_FLAGS,
} from './discord-utils.js'
import { handleForkCommand, handleForkSelectMenu } from './fork.js'
import {
  handleModelCommand,
  handleProviderSelectMenu,
  handleModelSelectMenu,
} from './model-command.js'
import { collectLastAssistantParts } from './message-formatting.js'
import { createProjectChannels } from './channel-management.js'
import {
  handleOpencodeSession,
  parseSlashCommand,
  abortControllers,
  pendingPermissions,
  addToQueue,
  getQueueLength,
  clearQueue,
} from './session-handler.js'
import { extractTagsArrays } from './xml.js'
import { createLogger } from './logger.js'

const discordLogger = createLogger('DISCORD')
const interactionLogger = createLogger('INTERACTION')

export function registerInteractionHandler({
  discordClient,
  appId,
}: {
  discordClient: Client
  appId: string
}) {
  interactionLogger.log('[REGISTER] Interaction handler registered')

  discordClient.on(
    Events.InteractionCreate,
    async (interaction: Interaction) => {
      try {
        interactionLogger.log(`[INTERACTION] Received: ${interaction.type} - ${interaction.isChatInputCommand() ? interaction.commandName : interaction.isAutocomplete() ? `autocomplete:${interaction.commandName}` : 'other'}`)

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
                if (channelAppId && channelAppId !== appId) {
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
              interactionLogger.error(
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
                  if (channelAppId && channelAppId !== appId) {
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
                interactionLogger.error('[AUTOCOMPLETE] Error fetching files:', error)
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
              interactionLogger.error(
                '[AUTOCOMPLETE] Error fetching projects:',
                error,
              )
              await interaction.respond([])
            }
          }
        }

        if (interaction.isChatInputCommand()) {
          const command = interaction
          interactionLogger.log(`[COMMAND] Processing: ${command.commandName}`)

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

            if (channelAppId && channelAppId !== appId) {
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
                channelId: textChannel.id,
              })
            } catch (error) {
              interactionLogger.error('[SESSION] Error:', error)
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

            if (channelAppId && channelAppId !== appId) {
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

              interactionLogger.log(
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

              const { partIds, content, skippedCount } = collectLastAssistantParts({
                messages,
              })

              if (skippedCount > 0) {
                await sendThreadMessage(
                  thread,
                  `*Skipped ${skippedCount} older assistant parts...*`,
                )
              }

              if (content.trim()) {
                const discordMessage = await sendThreadMessage(thread, content)

                const stmt = getDatabase().prepare(
                  'INSERT OR REPLACE INTO part_messages (part_id, message_id, thread_id) VALUES (?, ?, ?)',
                )

                const transaction = getDatabase().transaction((ids: string[]) => {
                  for (const partId of ids) {
                    stmt.run(partId, discordMessage.id, thread.id)
                  }
                })

                transaction(partIds)
              }

              const messageCount = messages.length

              await sendThreadMessage(
                thread,
                `✅ **Session resumed!** Loaded ${messageCount} messages.\n\nYou can now continue the conversation by sending messages in this thread.`,
              )
            } catch (error) {
              interactionLogger.error('[RESUME] Error:', error)
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
                  appId,
                })

              await command.editReply(
                `✅ Created channels for project:\n📝 Text: <#${textChannelId}>\n🔊 Voice: <#${voiceChannelId}>\n📁 Directory: \`${directory}\``,
              )

              discordLogger.log(
                `Created channels for project ${channelName} at ${directory}`,
              )
            } catch (error) {
              interactionLogger.error('[ADD-PROJECT] Error:', error)
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
                  appId,
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
                channelId: textChannel.id,
              })

              discordLogger.log(
                `Created new project ${channelName} at ${projectDirectory}`,
              )
            } catch (error) {
              interactionLogger.error('[ADD-NEW-PROJECT] Error:', error)
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
              interactionLogger.error('[ACCEPT] Error:', error)
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
              interactionLogger.error('[REJECT] Error:', error)
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
              interactionLogger.error('[ABORT] Error:', error)
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
              interactionLogger.error('[SHARE] Error:', error)
              await command.reply({
                content: `Failed to share session: ${error instanceof Error ? error.message : 'Unknown error'}`,
                ephemeral: true,
                flags: SILENT_MESSAGE_FLAGS,
              })
            }
          } else if (command.commandName === 'fork') {
            await handleForkCommand(command)
          } else if (command.commandName === 'model') {
            await handleModelCommand({ interaction: command, appId })
          } else if (command.commandName === 'queue') {
            const message = command.options.getString('message', true)
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

            const row = getDatabase()
              .prepare('SELECT session_id FROM thread_sessions WHERE thread_id = ?')
              .get(channel.id) as { session_id: string } | undefined

            if (!row?.session_id) {
              await command.reply({
                content: 'No active session in this thread. Send a message directly instead.',
                ephemeral: true,
                flags: SILENT_MESSAGE_FLAGS,
              })
              return
            }

            // Check if there's an active request running
            const hasActiveRequest = abortControllers.has(row.session_id)

            if (!hasActiveRequest) {
              // No active request, send immediately
              const textChannel = await resolveTextChannel(channel as ThreadChannel)
              const { projectDirectory } = getKimakiMetadata(textChannel)

              if (!projectDirectory) {
                await command.reply({
                  content: 'Could not determine project directory',
                  ephemeral: true,
                  flags: SILENT_MESSAGE_FLAGS,
                })
                return
              }

              await command.reply({
                content: `» **${command.user.displayName}:** ${message.slice(0, 100)}${message.length > 100 ? '...' : ''}`,
                flags: SILENT_MESSAGE_FLAGS,
              })

              interactionLogger.log(`[QUEUE] No active request, sending immediately in thread ${channel.id}`)

              handleOpencodeSession({
                prompt: message,
                thread: channel as ThreadChannel,
                projectDirectory,
                channelId: textChannel?.id || channel.id,
              }).catch(async (e) => {
                interactionLogger.error(`[QUEUE] Failed to send message:`, e)
                const errorMsg = e instanceof Error ? e.message : String(e)
                await sendThreadMessage(channel as ThreadChannel, `✗ Failed: ${errorMsg.slice(0, 200)}`)
              })

              return
            }

            // Add to queue
            const queuePosition = addToQueue({
              threadId: channel.id,
              message: {
                prompt: message,
                userId: command.user.id,
                username: command.user.displayName,
                queuedAt: Date.now(),
              },
            })

            await command.reply({
              content: `✅ Message queued (position: ${queuePosition}). Will be sent after current response.`,
              ephemeral: true,
              flags: SILENT_MESSAGE_FLAGS,
            })

            interactionLogger.log(`[QUEUE] User ${command.user.displayName} queued message in thread ${channel.id}`)
          } else if (command.commandName === 'clear-queue') {
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
                content: 'This command can only be used in a thread',
                ephemeral: true,
                flags: SILENT_MESSAGE_FLAGS,
              })
              return
            }

            const queueLength = getQueueLength(channel.id)

            if (queueLength === 0) {
              await command.reply({
                content: 'No messages in queue',
                ephemeral: true,
                flags: SILENT_MESSAGE_FLAGS,
              })
              return
            }

            clearQueue(channel.id)

            await command.reply({
              content: `🗑 Cleared ${queueLength} queued message${queueLength > 1 ? 's' : ''}`,
              flags: SILENT_MESSAGE_FLAGS,
            })

            interactionLogger.log(`[QUEUE] User ${command.user.displayName} cleared queue in thread ${channel.id}`)
          }
        }

        if (interaction.isStringSelectMenu()) {
          if (interaction.customId.startsWith('fork_select:')) {
            await handleForkSelectMenu(interaction)
          } else if (interaction.customId.startsWith('model_provider:')) {
            await handleProviderSelectMenu(interaction)
          } else if (interaction.customId.startsWith('model_select:')) {
            await handleModelSelectMenu(interaction)
          }
        }
      } catch (error) {
        interactionLogger.error('[INTERACTION] Error handling interaction:', error)
        // Try to respond to the interaction if possible
        try {
          if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
            await interaction.reply({
              content: 'An error occurred processing this command.',
              ephemeral: true,
            })
          }
        } catch (replyError) {
          interactionLogger.error('[INTERACTION] Failed to send error reply:', replyError)
        }
      }
    },
  )
}
