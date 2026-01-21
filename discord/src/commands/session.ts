// /session command - Start a new OpenCode session.

import { ChannelType, type TextChannel } from 'discord.js'
import fs from 'node:fs'
import path from 'node:path'
import type { CommandContext, AutocompleteContext } from './types.js'
import { getDatabase } from '../database.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import { SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { extractTagsArrays } from '../xml.js'
import { handleOpencodeSession } from '../session-handler.js'
import { createLogger } from '../logger.js'
import * as errore from 'errore'

const logger = createLogger('SESSION')

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
    if (errore.isError(getClient)) {
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
      content: `🚀 **Starting OpenCode session**\n📝 ${prompt.slice(0, 200)}${prompt.length > 200 ? '…' : ''}${files.length > 0 ? `\n📎 Files: ${files.join(', ')}` : ''}`,
      flags: SILENT_MESSAGE_FLAGS,
    })

    const thread = await starterMessage.startThread({
      name: prompt.slice(0, 100),
      autoArchiveDuration: 1440,
      reason: 'OpenCode session',
    })

    await command.editReply(`Created new session in ${thread.toString()}`)

    await handleOpencodeSession({
      prompt: fullPrompt,
      thread,
      projectDirectory,
      channelId: textChannel.id,
      agent,
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

  if (interaction.channel) {
    const channel = interaction.channel
    if (channel.type === ChannelType.GuildText) {
      const textChannel = channel as TextChannel
      if (textChannel.topic) {
        const extracted = extractTagsArrays({
          xml: textChannel.topic,
          tags: ['kimaki.directory', 'kimaki.app'],
        })
        const channelAppId = extracted['kimaki.app']?.[0]?.trim()
        if (channelAppId && channelAppId !== appId) {
          await interaction.respond([])
          return
        }
        projectDirectory = extracted['kimaki.directory']?.[0]?.trim()
      }
    }
  }

  if (!projectDirectory) {
    await interaction.respond([])
    return
  }

  try {
    const getClient = await initializeOpencodeForDirectory(projectDirectory)
    if (errore.isError(getClient)) {
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
      .filter((a) => a.mode === 'primary' || a.mode === 'all')
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

  if (interaction.channel) {
    const channel = interaction.channel
    if (channel.type === ChannelType.GuildText) {
      const textChannel = channel as TextChannel
      if (textChannel.topic) {
        const extracted = extractTagsArrays({
          xml: textChannel.topic,
          tags: ['kimaki.directory', 'kimaki.app'],
        })
        const channelAppId = extracted['kimaki.app']?.[0]?.trim()
        if (channelAppId && channelAppId !== appId) {
          await interaction.respond([])
          return
        }
        projectDirectory = extracted['kimaki.directory']?.[0]?.trim()
      }
    }
  }

  if (!projectDirectory) {
    await interaction.respond([])
    return
  }

  try {
    const getClient = await initializeOpencodeForDirectory(projectDirectory)
    if (errore.isError(getClient)) {
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
