// /new-session command - Start a new OpenCode session.

import fs from 'node:fs'
import path from 'node:path'
import type { CommandContext, AutocompleteContext } from './types.js'
import { getChannelDirectory } from '../database.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import { SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { isTextChannel } from './channel-ref.js'
import {
  getDefaultRuntimeAdapter,
  getOrCreateRuntime,
} from '../session-handler/thread-session-runtime.js'
import { createLogger, LogPrefix } from '../logger.js'
import * as errore from 'errore'

const logger = createLogger(LogPrefix.SESSION)

export async function handleSessionCommand({
  command,
  appId,
}: CommandContext): Promise<void> {
  await command.deferReply({ ephemeral: false })

  const prompt = command.options.getString('prompt', true)
  const filesString = command.options.getString('files') || ''
  const agent = command.options.getString('agent') || undefined
  const channel = command.channel

  if (!isTextChannel(channel)) {
    await command.editReply('This command can only be used in text channels')
    return
  }
  const textChannel = channel

  const channelConfig = await getChannelDirectory(textChannel.id)
  const projectDirectory = channelConfig?.directory

  if (!projectDirectory) {
    await command.editReply(
      'This channel is not configured with a project directory',
    )
    return
  }

  if (!fs.existsSync(projectDirectory)) {
    await command.editReply(`Directory does not exist: ${projectDirectory}`)
    return
  }

  try {
    const getClient = await initializeOpencodeForDirectory(projectDirectory)
    if (getClient instanceof Error) {
      await command.editReply(getClient.message)
      return
    }

    const files = filesString
      .split(',')
      .map((f) => f.trim())
      .filter((f) => f)

    let fullPrompt = prompt
    if (files.length > 0) {
      fullPrompt = `${prompt}\n\n@${files.join(' @')}`
    }

    const adapter = getDefaultRuntimeAdapter()
    if (!adapter) {
      throw new Error('No runtime adapter configured')
    }
    const channelTarget = {
      channelId: textChannel.id,
    }
    const starterMessage = await adapter.conversation(channelTarget).send({
      markdown: `🚀 **Starting OpenCode session**\n📝 ${prompt}${files.length > 0 ? `\n📎 Files: ${files.join(', ')}` : ''}`,
      flags: SILENT_MESSAGE_FLAGS,
    })

    const { thread, target: threadTarget } = await adapter
      .conversation(channelTarget)
      .message(starterMessage.id)
      .then((messageHandle) => {
        return messageHandle.startThread({
          name: prompt.slice(0, 100),
          autoArchiveDuration: 1440,
          reason: 'OpenCode session',
        })
      })

    const threadHandle = await adapter.thread({
      threadId: threadTarget.threadId,
      parentId: thread.parentId,
    })
    if (!threadHandle) {
      throw new Error(`Thread not found: ${threadTarget.threadId}`)
    }
    await threadHandle.addMember(command.user.id)

    const threadReference = threadHandle.reference()
    await command.editReply(`Created new session in ${threadReference}`)

    const runtime = getOrCreateRuntime({
      threadId: thread.id,
      thread,
      projectDirectory,
      sdkDirectory: projectDirectory,
      channelId: textChannel.id,
      appId,
    })
    await runtime.enqueueIncoming({
      prompt: fullPrompt,
      userId: command.user.id,
      username: command.user.displayName,
      agent,
      appId,
      mode: 'opencode',
    })
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
  const focused = interaction.options.getFocused()
  const focusedValue = typeof focused === 'string' ? focused : focused.value

  let projectDirectory: string | undefined

  if (
    interaction.channel &&
    interaction.channel.kind === 'text'
  ) {
    const channelConfig = await getChannelDirectory(interaction.channel.id)
    if (channelConfig) {
      projectDirectory = channelConfig.directory
    }
  }

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
  if (typeof focusedOption === 'string') {
    await interaction.respond([])
    return
  }

  if (focusedOption.name === 'agent') {
    await handleAgentAutocomplete({ interaction })
    return
  }

  if (focusedOption.name !== 'files') {
    return
  }

  const focusedValue = focusedOption.value

  const parts = focusedValue.split(',')
  const previousFiles: string[] = parts
    .slice(0, -1)
    .map((f: string) => f.trim())
    .filter((f: string) => f.length > 0)
  const currentQuery = (parts[parts.length - 1] || '').trim()

  let projectDirectory: string | undefined

  if (
    interaction.channel &&
    interaction.channel.kind === 'text'
  ) {
    const channelConfig = await getChannelDirectory(interaction.channel.id)
    if (channelConfig) {
      projectDirectory = channelConfig.directory
    }
  }

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
