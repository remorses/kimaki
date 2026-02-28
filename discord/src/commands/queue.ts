// Queue commands - /queue, /queue-command, /clear-queue

import { ChannelType, MessageFlags, type ThreadChannel } from 'discord.js'
import type { AutocompleteContext, CommandContext } from './types.js'
import { getThreadSession } from '../database.js'
import {
  resolveWorkingDirectory,
  sendThreadMessage,
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import {
  handleOpencodeSession,
  abortControllers,
  addToQueue,
  getQueueLength,
  clearQueue,
  queueOrSendMessage,
} from '../session-handler.js'
import { createLogger, LogPrefix } from '../logger.js'
import { notifyError } from '../sentry.js'
import { registeredUserCommands } from '../config.js'

const logger = createLogger(LogPrefix.QUEUE)

export async function handleQueueCommand({
  command,
  appId,
}: CommandContext): Promise<void> {
  const message = command.options.getString('message', true)
  const channel = command.channel

  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
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
      content:
        'This command can only be used in a thread with an active session',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const result = await queueOrSendMessage({
    thread: channel as ThreadChannel,
    prompt: message,
    userId: command.user.id,
    username: command.user.displayName,
    appId,
  })

  if (result.action === 'no-session') {
    await command.reply({
      content:
        'No active session in this thread. Send a message directly instead.',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  if (result.action === 'no-directory') {
    await command.reply({
      content: 'Could not determine project directory',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  if (result.action === 'sent') {
    await command.reply({
      content: `» **${command.user.displayName}:** ${message.slice(0, 1000)}${message.length > 1000 ? '...' : ''}`,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  await command.reply({
    content: `Message queued (position: ${result.position}). Will be sent after current response.`,
    flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
  })
}

export async function handleClearQueueCommand({
  command,
}: CommandContext): Promise<void> {
  const channel = command.channel

  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
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
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const queueLength = getQueueLength(channel.id)

  if (queueLength === 0) {
    await command.reply({
      content: 'No messages in queue',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  clearQueue(channel.id)

  await command.reply({
    content: `🗑 Cleared ${queueLength} queued message${queueLength > 1 ? 's' : ''}`,
    flags: SILENT_MESSAGE_FLAGS,
  })

  logger.log(
    `[QUEUE] User ${command.user.displayName} cleared queue in thread ${channel.id}`,
  )
}

export async function handleQueueCommandCommand({
  command,
  appId,
}: CommandContext): Promise<void> {
  const commandName = command.options.getString('command', true)
  const args = command.options.getString('arguments') || ''
  const channel = command.channel

  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
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
      content:
        'This command can only be used in a thread with an active session',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const sessionId = await getThreadSession(channel.id)

  if (!sessionId) {
    await command.reply({
      content:
        'No active session in this thread. Send a message directly instead.',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  // Validate command exists in registered user commands
  const isKnownCommand = registeredUserCommands.some((cmd) => {
    return cmd.name === commandName
  })
  if (!isKnownCommand) {
    await command.reply({
      content: `Unknown command: /${commandName}. Use autocomplete to pick from available commands.`,
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const commandPayload = { name: commandName, arguments: args }
  const displayText = `/${commandName}`

  // Check if there's an active request running
  const existingController = abortControllers.get(sessionId)
  const hasActiveRequest = Boolean(
    existingController && !existingController.signal.aborted,
  )
  if (existingController && existingController.signal.aborted) {
    abortControllers.delete(sessionId)
  }

  if (!hasActiveRequest) {
    const resolved = await resolveWorkingDirectory({
      channel: channel as ThreadChannel,
    })

    if (!resolved) {
      await command.reply({
        content: 'Could not determine project directory',
        flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
      })
      return
    }

    await command.reply({
      content: `» **${command.user.displayName}:** ${displayText}`,
      flags: SILENT_MESSAGE_FLAGS,
    })

    logger.log(
      `[QUEUE] No active request, sending command immediately in thread ${channel.id}`,
    )

    handleOpencodeSession({
      prompt: '',
      thread: channel as ThreadChannel,
      projectDirectory: resolved.projectDirectory,
      channelId: (channel as ThreadChannel).parentId || channel.id,
      command: commandPayload,
      appId,
    }).catch(async (e) => {
      logger.error(`[QUEUE] Failed to send command:`, e)
      void notifyError(e, 'Queue: failed to send command')
      const errorMsg = e instanceof Error ? e.message : String(e)
      await sendThreadMessage(
        channel as ThreadChannel,
        `Failed: ${errorMsg.slice(0, 200)}`,
      )
    })

    return
  }

  // Add to queue with command payload
  const queuePosition = addToQueue({
    threadId: channel.id,
    message: {
      prompt: '',
      userId: command.user.id,
      username: command.user.displayName,
      queuedAt: Date.now(),
      appId,
      command: commandPayload,
    },
  })

  await command.reply({
    content: `Command queued (position: ${queuePosition}): ${displayText}`,
    flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
  })

  logger.log(
    `[QUEUE] User ${command.user.displayName} queued command /${commandName} in thread ${channel.id}`,
  )
}

export async function handleQueueCommandAutocomplete({
  interaction,
}: AutocompleteContext): Promise<void> {
  const focused = interaction.options.getFocused(true)

  if (focused.name !== 'command') {
    await interaction.respond([])
    return
  }

  const query = focused.value.toLowerCase()
  const choices = registeredUserCommands
    .filter((cmd) => {
      return cmd.name.toLowerCase().includes(query)
    })
    .slice(0, 25)
    .map((cmd) => ({
      name: `/${cmd.name} - ${cmd.description}`.slice(0, 100),
      value: cmd.name.slice(0, 100),
    }))

  await interaction.respond(choices)
}
