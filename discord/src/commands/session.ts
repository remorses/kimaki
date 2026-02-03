// /new-session command - Start a new OpenCode session.

import { ChannelType, type TextChannel } from 'discord.js'
import fs from 'node:fs'
import path from 'node:path'
import type { CommandContext, AutocompleteContext } from './types.js'
import { getChannelDirectory } from '../database.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import { SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { handleOpencodeSession } from '../session-handler.js'
import { createLogger, LogPrefix } from '../logger.js'
import * as errore from 'errore'

const logger = createLogger(LogPrefix.SESSION)

export async function handleSessionCommand({ command, appId }: CommandContext): Promise<void> {
  await command.deferReply({ ephemeral: false })

  const prompt = command.options.getString('prompt', true)
  const filesString = command.options.getString('files') || ''
  const agent = command.options.getString('agent') || undefined
  const channel = command.channel

  if (!channel || channel.type !== ChannelType.GuildText) {
    await command.editReply('This command can only be used in text channels')
    return
  }

  const textChannel = channel as TextChannel

  const channelConfig = await getChannelDirectory(textChannel.id)
  const projectDirectory = channelConfig?.directory
  const channelAppId = channelConfig?.appId || undefined

  if (channelAppId && channelAppId !== appId) {
    await command.editReply('This channel is not configured for this bot')
    return
  }

  if (!projectDirectory) {
    await command.editReply('This channel is not configured with a project directory')
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

    const starterMessage = await textChannel.send({
      content: `🚀 **Starting OpenCode session**\n📝 ${prompt}${files.length > 0 ? `\n📎 Files: ${files.join(', ')}` : ''}`,
      flags: SILENT_MESSAGE_FLAGS,
    })

    const thread = await starterMessage.startThread({
      name: prompt.slice(0, 100),
      autoArchiveDuration: 1440,
      reason: 'OpenCode session',
    })

    // Add user to thread so it appears in their sidebar
    await thread.members.add(command.user.id)

    await command.editReply(`Created new session in ${thread.toString()}`)

    await handleOpencodeSession({
      prompt: fullPrompt,
      thread,
      projectDirectory,
      channelId: textChannel.id,
      agent,
      appId,
    })
  } catch (error) {
    logger.error('[SESSION] Error:', error)
    await command.editReply(
      `Failed to create session: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}

async function handleAgentAutocomplete({ interaction, appId }: AutocompleteContext): Promise<void> {
  const focusedValue = interaction.options.getFocused()

  let projectDirectory: string | undefined

  if (interaction.channel && interaction.channel.type === ChannelType.GuildText) {
    const channelConfig = await getChannelDirectory(interaction.channel.id)
    if (channelConfig) {
      if (channelConfig.appId && channelConfig.appId !== appId) {
        await interaction.respond([])
        return
      }
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
      query: { directory: projectDirectory },
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
  appId,
}: AutocompleteContext): Promise<void> {
  const focusedOption = interaction.options.getFocused(true)

  if (focusedOption.name === 'agent') {
    await handleAgentAutocomplete({ interaction, appId })
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

  let projectDirectory: string | undefined

  if (interaction.channel && interaction.channel.type === ChannelType.GuildText) {
    const channelConfig = await getChannelDirectory(interaction.channel.id)
    if (channelConfig) {
      if (channelConfig.appId && channelConfig.appId !== appId) {
        await interaction.respond([])
        return
      }
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
      query: {
        query: currentQuery || '',
      },
    })

    const files = response.data || []

    const prefix = previousFiles.length > 0 ? previousFiles.join(', ') + ', ' : ''

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
