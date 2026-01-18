// User-defined OpenCode command handler.
// Handles slash commands that map to user-configured commands in opencode.json.

import type { CommandContext, CommandHandler } from './types.js'
import { ChannelType, type TextChannel, type ThreadChannel } from 'discord.js'
import { extractTagsArrays } from '../xml.js'
import { handleOpencodeSession } from '../session-handler.js'
import { SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { createLogger } from '../logger.js'
import { getDatabase } from '../database.js'
import fs from 'node:fs'

const userCommandLogger = createLogger('USER_CMD')

export const handleUserCommand: CommandHandler = async ({ command, appId }: CommandContext) => {
  const discordCommandName = command.commandName
  // Strip the -cmd suffix to get the actual OpenCode command name
  const commandName = discordCommandName.replace(/-cmd$/, '')
  const args = command.options.getString('arguments') || ''

  userCommandLogger.log(
    `Executing /${commandName} (from /${discordCommandName}) with args: ${args}`,
  )

  const channel = command.channel

  userCommandLogger.log(
    `Channel info: type=${channel?.type}, id=${channel?.id}, isNull=${channel === null}`,
  )

  const isThread =
    channel &&
    [ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread].includes(
      channel.type,
    )

  const isTextChannel = channel?.type === ChannelType.GuildText

  if (!channel || (!isTextChannel && !isThread)) {
    await command.reply({
      content: 'This command can only be used in text channels or threads',
      ephemeral: true,
    })
    return
  }

  let projectDirectory: string | undefined
  let channelAppId: string | undefined
  let textChannel: TextChannel | null = null
  let thread: ThreadChannel | null = null

  if (isThread) {
    // Running in an existing thread - get project directory from parent channel
    thread = channel as ThreadChannel
    textChannel = thread.parent as TextChannel | null

    // Verify this thread has an existing session
    const row = getDatabase()
      .prepare('SELECT session_id FROM thread_sessions WHERE thread_id = ?')
      .get(thread.id) as { session_id: string } | undefined

    if (!row) {
      await command.reply({
        content:
          'This thread does not have an active session. Use this command in a project channel to create a new thread.',
        ephemeral: true,
      })
      return
    }

    if (textChannel?.topic) {
      const extracted = extractTagsArrays({
        xml: textChannel.topic,
        tags: ['kimaki.directory', 'kimaki.app'],
      })

      projectDirectory = extracted['kimaki.directory']?.[0]?.trim()
      channelAppId = extracted['kimaki.app']?.[0]?.trim()
    }
  } else {
    // Running in a text channel - will create a new thread
    textChannel = channel as TextChannel

    if (textChannel.topic) {
      const extracted = extractTagsArrays({
        xml: textChannel.topic,
        tags: ['kimaki.directory', 'kimaki.app'],
      })

      projectDirectory = extracted['kimaki.directory']?.[0]?.trim()
      channelAppId = extracted['kimaki.app']?.[0]?.trim()
    }
  }

  if (channelAppId && channelAppId !== appId) {
    await command.reply({
      content: 'This channel is not configured for this bot',
      ephemeral: true,
    })
    return
  }

  if (!projectDirectory) {
    await command.reply({
      content: 'This channel is not configured with a project directory',
      ephemeral: true,
    })
    return
  }

  if (!fs.existsSync(projectDirectory)) {
    await command.reply({
      content: `Directory does not exist: ${projectDirectory}`,
      ephemeral: true,
    })
    return
  }

  await command.deferReply({ ephemeral: false })

  try {
    // Use the dedicated session.command API instead of formatting as text prompt
    const commandPayload = { name: commandName, arguments: args }

    if (isThread && thread) {
      // Running in existing thread - just send the command
      await command.editReply(`Running /${commandName}...`)

      await handleOpencodeSession({
        prompt: '', // Not used when command is set
        thread,
        projectDirectory,
        channelId: textChannel?.id,
        command: commandPayload,
      })
    } else if (textChannel) {
      // Running in text channel - create a new thread
      const starterMessage = await textChannel.send({
        content: `**/${commandName}**${args ? ` ${args.slice(0, 200)}${args.length > 200 ? '…' : ''}` : ''}`,
        flags: SILENT_MESSAGE_FLAGS,
      })

      const threadName = `/${commandName} ${args.slice(0, 80)}${args.length > 80 ? '…' : ''}`
      const newThread = await starterMessage.startThread({
        name: threadName.slice(0, 100),
        autoArchiveDuration: 1440,
        reason: `OpenCode command: ${commandName}`,
      })

      await command.editReply(`Started /${commandName} in ${newThread.toString()}`)

      await handleOpencodeSession({
        prompt: '', // Not used when command is set
        thread: newThread,
        projectDirectory,
        channelId: textChannel.id,
        command: commandPayload,
      })
    }
  } catch (error) {
    userCommandLogger.error(`Error executing /${commandName}:`, error)

    const errorMessage = error instanceof Error ? error.message : String(error)

    if (command.deferred) {
      await command.editReply({
        content: `Failed to execute /${commandName}: ${errorMessage}`,
      })
    } else {
      await command.reply({
        content: `Failed to execute /${commandName}: ${errorMessage}`,
        ephemeral: true,
      })
    }
  }
}
