// /new-session command - Start a new OpenCode session.
// Works in both text channels and threads. When used in a thread, the new
// session inherits the same working directory (worktree/workspace) so the
// user stays in the same folder context.
// Also owns the fresh-thread creation flow used by voice routing.

import { ChannelType, type TextChannel, type ThreadChannel } from 'discord.js'
import fs from 'node:fs'
import path from 'node:path'
import type { CommandContext, AutocompleteContext } from './types.js'
import {
  getChannelDirectory,
  getThreadWorktreeOrWorkspace,
  createPendingWorkspace,
  setWorkspaceReady,
} from '../database.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import {
  SILENT_MESSAGE_FLAGS,
  resolveProjectDirectoryFromAutocomplete,
  resolveWorkingDirectory,
  resolveTextChannel,
} from '../discord-utils.js'
import { getOrCreateRuntime } from '../session-handler/thread-session-runtime.js'
import { createLogger, LogPrefix } from '../logger.js'
import * as errore from 'errore'
import type { DiscordFileAttachment } from '../message-formatting.js'

const logger = createLogger(LogPrefix.SESSION)

// Shared fresh-session flow for slash commands and voice routing. No history is copied.
export async function createNewSessionThread({
  textChannel,
  projectDirectory,
  sdkDirectory,
  sourceWorkspace,
  prompt,
  files = [],
  images,
  agent,
  userId,
  username,
  appId,
}: {
  textChannel: TextChannel
  projectDirectory: string
  sdkDirectory: string
  sourceWorkspace?: Awaited<ReturnType<typeof getThreadWorktreeOrWorkspace>>
  prompt: string
  files?: string[]
  images?: DiscordFileAttachment[]
  agent?: string
  userId: string
  username: string
  appId?: string
}): Promise<ThreadChannel | Error> {
  const getClient = await initializeOpencodeForDirectory(projectDirectory)
  if (getClient instanceof Error) return getClient

  const starterMessage = await textChannel.send({
    content: `**Starting OpenCode session**\n${prompt}${files.length > 0 ? `\nFiles: ${files.join(', ')}` : ''}`,
    flags: SILENT_MESSAGE_FLAGS,
  })
  const thread = await starterMessage.startThread({
    name: prompt.slice(0, 100),
    autoArchiveDuration: 1440,
    reason: 'OpenCode session',
  })

  // Persist the directory association for later commands and bot restarts.
  if (sourceWorkspace?.status === 'ready' && sourceWorkspace.workspace_directory) {
    await createPendingWorkspace({
      threadId: thread.id,
      workspaceType: sourceWorkspace.workspace_type,
      workspaceName: sourceWorkspace.workspace_name ?? '',
      projectDirectory,
    })
    await setWorkspaceReady({
      threadId: thread.id,
      workspaceId: sourceWorkspace.workspace_id ?? undefined,
      workspaceDirectory: sourceWorkspace.workspace_directory,
    })
  }
  await thread.members.add(userId)
  const runtime = getOrCreateRuntime({
    threadId: thread.id,
    thread,
    projectDirectory,
    sdkDirectory,
    channelId: textChannel.id,
    appId,
  })
  await runtime.enqueueIncoming({
    prompt: files.length > 0 ? `${prompt}\n\n@${files.join(' @')}` : prompt,
    images,
    userId,
    username,
    agent,
    appId,
    mode: 'opencode',
  })
  return thread
}

export async function handleSessionCommand({
  command,
  appId,
}: CommandContext): Promise<void> {
  await command.deferReply()

  const prompt = command.options.getString('prompt', true)
  const filesString = command.options.getString('files') || ''
  const agent = command.options.getString('agent') || undefined
  const channel = command.channel

  const isThread = channel && [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
  ].includes(channel.type)

  if (!channel || (channel.type !== ChannelType.GuildText && !isThread)) {
    await command.editReply('This command can only be used in text channels or threads')
    return
  }

  // Resolve project and working directories.
  // In a thread: inherit from the thread's session (worktree/workspace aware).
  // In a text channel: look up the channel's configured directory.
  let projectDirectory: string
  let sdkDirectory: string
  let textChannel: TextChannel
  let sourceWorkspace: Awaited<ReturnType<typeof getThreadWorktreeOrWorkspace>> | undefined

  if (isThread) {
    const threadChannel = channel as ThreadChannel
    const [resolved, parentChannel, workspace] = await Promise.all([
      resolveWorkingDirectory({ channel: threadChannel }),
      resolveTextChannel(threadChannel),
      getThreadWorktreeOrWorkspace(threadChannel.id),
    ])
    if (!resolved) {
      await command.editReply('Could not determine project directory for this thread')
      return
    }
    if (!parentChannel) {
      await command.editReply('Could not resolve parent text channel')
      return
    }
    projectDirectory = resolved.projectDirectory
    sdkDirectory = resolved.workingDirectory
    textChannel = parentChannel
    sourceWorkspace = workspace
  } else {
    const channelConfig = await getChannelDirectory(channel.id)
    if (!channelConfig?.directory) {
      await command.editReply('This channel is not configured with a project directory')
      return
    }
    projectDirectory = channelConfig.directory
    sdkDirectory = channelConfig.directory
    textChannel = channel as TextChannel
  }

  if (!fs.existsSync(projectDirectory)) {
    await command.editReply(`Directory does not exist: ${projectDirectory}`)
    return
  }

  try {
    const files = filesString
      .split(',')
      .map((f) => f.trim())
      .filter((f) => f)

    const thread = await createNewSessionThread({
      textChannel,
      projectDirectory,
      sdkDirectory,
      sourceWorkspace,
      prompt,
      files,
      userId: command.user.id,
      username: command.user.displayName,
      agent,
      appId,
    })
    if (thread instanceof Error) {
      await command.editReply(thread.message)
      return
    }
    await command.editReply(`Created new session in ${thread.toString()}`)
  } catch (error) {
    logger.error('[SESSION] Error:', error)
    await command.editReply(
      `Failed to create session: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}

async function handleAgentAutocomplete({
  interaction,
}: {
  interaction: AutocompleteContext['interaction']
}): Promise<void> {
  const focusedValue = interaction.options.getFocused()

  // interaction.channel can be null when the channel isn't cached
  // (common with gateway-proxy). Use channelId which is always available
  // from the raw interaction payload.
  const projectDirectory = await resolveProjectDirectoryFromAutocomplete(interaction)

  if (!projectDirectory) {
    await interaction.respond([])
    return
  }

  try {
    const getClient = await initializeOpencodeForDirectory(projectDirectory)
    if (getClient instanceof Error) {
      await interaction.respond([])
      return
    }

    const agentsResponse = await getClient().app.agents({
      directory: projectDirectory,
    })

    if (!agentsResponse.data || agentsResponse.data.length === 0) {
      await interaction.respond([])
      return
    }

    const agents = agentsResponse.data
      .filter((a) => {
        const hidden = (a as { hidden?: boolean }).hidden
        return (a.mode === 'primary' || a.mode === 'all') && !hidden
      })
      .filter((a) => a.name.toLowerCase().includes(focusedValue.toLowerCase()))
      .slice(0, 25)

    const choices = agents.map((agent) => ({
      name: agent.name.slice(0, 100),
      value: agent.name,
    }))

    await interaction.respond(choices)
  } catch (error) {
    logger.error('[AUTOCOMPLETE] Error fetching agents:', error)
    await interaction.respond([])
  }
}

export async function handleSessionAutocomplete({
  interaction,
}: AutocompleteContext): Promise<void> {
  const focusedOption = interaction.options.getFocused(true)

  if (focusedOption.name === 'agent') {
    await handleAgentAutocomplete({ interaction })
    return
  }

  if (focusedOption.name !== 'files') {
    return
  }

  const focusedValue = focusedOption.value

  const parts = focusedValue.split(',')
  const previousFiles = parts
    .slice(0, -1)
    .map((f) => f.trim())
    .filter((f) => f)
  const currentQuery = (parts[parts.length - 1] || '').trim()

  const projectDirectory = await resolveProjectDirectoryFromAutocomplete(interaction)

  if (!projectDirectory) {
    await interaction.respond([])
    return
  }

  try {
    const getClient = await initializeOpencodeForDirectory(projectDirectory)
    if (getClient instanceof Error) {
      await interaction.respond([])
      return
    }

    const response = await getClient().find.files({
      query: currentQuery || '',
    })

    const files = response.data || []

    const prefix =
      previousFiles.length > 0 ? previousFiles.join(', ') + ', ' : ''

    const choices = files
      .map((file: string) => {
        const fullValue = prefix + file
        const allFiles = [...previousFiles, file]
        const allBasenames = allFiles.map((f) => f.split('/').pop() || f)
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
    logger.error('[AUTOCOMPLETE] Error fetching files:', error)
    await interaction.respond([])
  }
}
