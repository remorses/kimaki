// Queue commands - /queue, /queue-command, /clear-queue


import type { AutocompleteContext, CommandContext } from './types.js'
import { PLATFORM_MESSAGE_FLAGS } from '../platform/message-flags.js'
import { getThreadSession } from '../database.js'
import {
  resolveWorkingDirectory,
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import { isThreadChannel } from './channel-ref.js'
import {
  getRuntime,
  getOrCreateRuntime,
} from '../session-handler/thread-session-runtime.js'
import { createLogger, LogPrefix } from '../logger.js'
import { notifyError } from '../sentry.js'
import { store } from '../store.js'

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
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  if (!isThreadChannel(channel)) {
    await command.reply({
      content:
        'This command can only be used in a thread with an active session',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const thread = channel
  const sessionId = await getThreadSession(thread.id)
  if (!sessionId) {
    await command.reply({
      content:
        'No active session in this thread. Send a message directly instead.',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const resolved = await resolveWorkingDirectory({ channel: thread })
  if (!resolved) {
    await command.reply({
      content: 'Could not determine project directory',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const runtime = getOrCreateRuntime({
    threadId: thread.id,
    thread,
    projectDirectory: resolved.projectDirectory,
    sdkDirectory: resolved.workingDirectory,
    channelId: thread.parentId || thread.id,
    appId,
  })

  // /queue explicitly uses kimaki local queue mode.
  const enqueueResult = await runtime.enqueueIncoming({
    prompt: message,
    userId: command.user.id,
    username: command.user.displayName,
    appId,
    mode: 'local-queue',
  })

  const responseText = enqueueResult.queued
    ? `Queued message${enqueueResult.position ? ` (position ${enqueueResult.position})` : ''}`
    : `» **${command.user.displayName}:** ${message.slice(0, 1000)}${message.length > 1000 ? '...' : ''}`

  await command.reply({
    content: responseText,
    flags: SILENT_MESSAGE_FLAGS,
  })
}

export async function handleClearQueueCommand({
  command,
}: CommandContext): Promise<void> {
  const channel = command.channel

  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  if (!isThreadChannel(channel)) {
    await command.reply({
      content: 'This command can only be used in a thread',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const runtime = getRuntime(channel.id)
  const queueLength = runtime?.getQueueLength() ?? 0

  if (queueLength === 0) {
    await command.reply({
      content: 'No messages in queue',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  runtime?.clearQueue()

  await command.reply({
    content: `Cleared ${queueLength} queued message${queueLength > 1 ? 's' : ''}`,
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
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  if (!isThreadChannel(channel)) {
    await command.reply({
      content:
        'This command can only be used in a thread with an active session',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const sessionId = await getThreadSession(channel.id)

  if (!sessionId) {
    await command.reply({
      content:
        'No active session in this thread. Send a message directly instead.',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  // Validate command exists in registered user commands
  const isKnownCommand = store.getState().registeredUserCommands.some((cmd) => {
    return cmd.name === commandName
  })
  if (!isKnownCommand) {
    await command.reply({
      content: `Unknown command: /${commandName}. Use autocomplete to pick from available commands.`,
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const commandPayload = { name: commandName, arguments: args }
  const displayText = `/${commandName}`
  const thread = channel

  const resolved = await resolveWorkingDirectory({ channel: thread })
  if (!resolved) {
    await command.reply({
      content: 'Could not determine project directory',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const runtime = getOrCreateRuntime({
    threadId: thread.id,
    thread,
    projectDirectory: resolved.projectDirectory,
    sdkDirectory: resolved.workingDirectory,
    channelId: thread.parentId || thread.id,
    appId,
  })

  // /queue-command explicitly uses kimaki local queue mode.
  const enqueueResult = await runtime.enqueueIncoming({
    prompt: '',
    userId: command.user.id,
    username: command.user.displayName,
    appId,
    command: commandPayload,
    mode: 'local-queue',
  })

  const responseText = enqueueResult.queued
    ? `Queued message${enqueueResult.position ? ` (position ${enqueueResult.position})` : ''}`
    : `» **${command.user.displayName}:** ${displayText}`

  await command.reply({
    content: responseText,
    flags: SILENT_MESSAGE_FLAGS,
  })

  logger.log(
    `[QUEUE] User ${command.user.displayName} queued command /${commandName} in thread ${channel.id}`,
  )
}

export async function handleQueueCommandAutocomplete({
  interaction,
}: AutocompleteContext): Promise<void> {
  const focused = interaction.options.getFocused(true)
  if (typeof focused === 'string' || focused.name !== 'command') {
    await interaction.respond([])
    return
  }

  const query = focused.value.toLowerCase()
  const choices = store.getState().registeredUserCommands
    .filter((cmd) => {
      return cmd.name.toLowerCase().includes(query)
    })
    .slice(0, 25)
    .map((cmd) => ({
      name: `/${cmd.name} [${cmd.source === 'skill' ? 'skill' : cmd.source === 'mcp' ? 'mcp' : 'cmd'}] - ${cmd.description}`.slice(0, 100),
      value: cmd.name.slice(0, 100),
    }))

  await interaction.respond(choices)
}
