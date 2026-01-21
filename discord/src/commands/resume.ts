// /resume command - Resume an existing OpenCode session.

import {
  ChannelType,
  ThreadAutoArchiveDuration,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import fs from 'node:fs'
import type { CommandContext, AutocompleteContext } from './types.js'
import { getDatabase } from '../database.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import { sendThreadMessage, resolveTextChannel, getKimakiMetadata } from '../discord-utils.js'
import { extractTagsArrays } from '../xml.js'
import { collectLastAssistantParts } from '../message-formatting.js'
import { createLogger } from '../logger.js'
import * as errore from 'errore'

const logger = createLogger('RESUME')

export async function handleResumeCommand({ command, appId }: CommandContext): Promise<void> {
  await command.deferReply({ ephemeral: false })

  const sessionId = command.options.getString('session', true)
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
      .prepare('INSERT OR REPLACE INTO thread_sessions (thread_id, session_id) VALUES (?, ?)')
      .run(thread.id, sessionId)

    logger.log(`[RESUME] Created thread ${thread.id} for session ${sessionId}`)

    const messagesResponse = await getClient().session.messages({
      path: { id: sessionId },
    })

    if (!messagesResponse.data) {
      throw new Error('Failed to fetch session messages')
    }

    const messages = messagesResponse.data

    await command.editReply(`Resumed session "${sessionTitle}" in ${thread.toString()}`)

    await sendThreadMessage(
      thread,
      `📂 **Resumed session:** ${sessionTitle}\n📅 **Created:** ${new Date(sessionResponse.data.time.created).toLocaleString()}\n\n*Loading ${messages.length} messages...*`,
    )

    const { partIds, content, skippedCount } = collectLastAssistantParts({
      messages,
    })

    if (skippedCount > 0) {
      await sendThreadMessage(thread, `*Skipped ${skippedCount} older assistant parts...*`)
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
    logger.error('[RESUME] Error:', error)
    await command.editReply(
      `Failed to resume session: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}

export async function handleResumeAutocomplete({
  interaction,
  appId,
}: AutocompleteContext): Promise<void> {
  const focusedValue = interaction.options.getFocused()

  let projectDirectory: string | undefined

  if (interaction.channel) {
    const textChannel = await resolveTextChannel(
      interaction.channel as TextChannel | ThreadChannel | null,
    )
    if (textChannel) {
      const { projectDirectory: directory, channelAppId } = getKimakiMetadata(textChannel)
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
    const getClient = await initializeOpencodeForDirectory(projectDirectory)
    if (errore.isError(getClient)) {
      await interaction.respond([])
      return
    }

    const sessionsResponse = await getClient().session.list()
    if (!sessionsResponse.data) {
      await interaction.respond([])
      return
    }

    const existingSessionIds = new Set(
      (
        getDatabase().prepare('SELECT session_id FROM thread_sessions').all() as {
          session_id: string
        }[]
      ).map((row) => row.session_id),
    )

    const sessions = sessionsResponse.data
      .filter((session) => !existingSessionIds.has(session.id))
      .filter((session) => session.title.toLowerCase().includes(focusedValue.toLowerCase()))
      .slice(0, 25)
      .map((session) => {
        const dateStr = new Date(session.time.updated).toLocaleString()
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
    logger.error('[AUTOCOMPLETE] Error fetching sessions:', error)
    await interaction.respond([])
  }
}
