// Queue commands - /queue, /queue-command
// Clear/remove actions live as buttons on each queue confirmation message.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  type ButtonInteraction,
  type ThreadChannel,
} from 'discord.js'
import type { AutocompleteContext, CommandContext } from './types.js'
import { deleteThreadQueueItem, getThreadSession } from '../database.js'
import {
  resolveWorkingDirectory,
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import {
  getOrCreateRuntime,
  getRuntime,
} from '../session-handler/thread-session-runtime.js'
import { createLogger, LogPrefix } from '../logger.js'
import { asSubtext, QUEUE_PREFIX } from '../message-formatting.js'
import { store } from '../store.js'

const logger = createLogger(LogPrefix.QUEUE)

export const QUEUE_REMOVE_CUSTOM_ID_PREFIX = 'queue_remove:'

async function deleteThreadQueueItemWithoutRuntime(queueId: string) {
  const row = await deleteThreadQueueItem(queueId).catch((error) => {
    logger.error(
      `[QUEUE] Failed to delete persisted queue item ${queueId}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return undefined
  })
  if (!row) {
    return undefined
  }
  try {
    const parsed = JSON.parse(row.payload_json) as {
      prompt?: string
      username?: string
      command?: { name: string }
    }
    return {
      prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
      username: typeof parsed.username === 'string' ? parsed.username : '',
      command: parsed.command,
    }
  } catch {
    return { prompt: '', username: '' }
  }
}

export function buildQueueRemoveCustomId({
  threadId,
  queueId,
}: {
  threadId: string
  queueId: string
}): string {
  return `${QUEUE_REMOVE_CUSTOM_ID_PREFIX}${threadId}:${queueId}`
}

export function parseQueueRemoveCustomId(customId: string): {
  threadId: string
  queueId: string
} | undefined {
  if (!customId.startsWith(QUEUE_REMOVE_CUSTOM_ID_PREFIX)) {
    return undefined
  }
  const rest = customId.slice(QUEUE_REMOVE_CUSTOM_ID_PREFIX.length)
  const separator = rest.indexOf(':')
  if (separator <= 0 || separator >= rest.length - 1) {
    return undefined
  }
  return {
    threadId: rest.slice(0, separator),
    queueId: rest.slice(separator + 1),
  }
}

function buildQueueRemoveRow({
  threadId,
  queueId,
}: {
  threadId: string
  queueId: string
}) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildQueueRemoveCustomId({ threadId, queueId }))
      .setLabel('Remove from queue')
      .setStyle(ButtonStyle.Secondary),
  )
}

export async function handleQueueRemoveButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const parsed = parseQueueRemoveCustomId(interaction.customId)
  if (!parsed) {
    await interaction.reply({
      content: 'Invalid queue remove button',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  if (interaction.channelId && interaction.channelId !== parsed.threadId) {
    await interaction.reply({
      content: 'This queue button does not belong to this thread',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await interaction.deferUpdate()
  const runtime = getRuntime(parsed.threadId)
  const removed = runtime
    ? await runtime.removeQueueItemById(parsed.queueId)
    : await deleteThreadQueueItemWithoutRuntime(parsed.queueId)
  if (!removed) {
    await interaction.editReply({
      content: asSubtext('Queued message is no longer in the queue'),
      components: [],
    })
    return
  }

  const label = removed.command
    ? `/${removed.command.name}`
    : removed.prompt.slice(0, 120)
  await interaction.editReply({
    content: asSubtext(`Removed queued message: ${label}`),
    components: [],
  })
  logger.log(
    `[QUEUE] User ${interaction.user.displayName} removed queued item ${parsed.queueId} in thread ${parsed.threadId}`,
  )
}

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

  const thread = channel as ThreadChannel
  const sessionId = await getThreadSession(thread.id)
  if (!sessionId) {
    await command.reply({
      content:
        'No active session in this thread. Send a message directly instead.',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const resolved = await resolveWorkingDirectory({ channel: thread })
  if (!resolved) {
    await command.reply({
      content: 'Could not determine project directory',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
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

  if (enqueueResult.queued && enqueueResult.queueId) {
    const responseText = asSubtext(`Queued message${enqueueResult.position ? ` (position ${enqueueResult.position})` : ''}`)
    await command.reply({
      content: responseText,
      components: [
        buildQueueRemoveRow({
          threadId: thread.id,
          queueId: enqueueResult.queueId,
        }),
      ],
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const responseText = `${QUEUE_PREFIX}**${command.user.displayName}:** ${message.slice(0, 1000)}${message.length > 1000 ? '...' : ''}`
  await command.reply({
    content: responseText,
    flags: SILENT_MESSAGE_FLAGS,
  })
}

export async function handleClearQueueCommand({
  command,
}: CommandContext): Promise<void> {
  const channel = command.channel
  const position = command.options.getInteger('position') ?? undefined

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

  const runtime = getRuntime(channel.id)
  const queueLength = runtime?.getQueueLength() ?? 0

  if (queueLength === 0) {
    await command.reply({
      content: 'No messages in queue',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  if (position !== undefined) {
    const removed = await runtime?.removeQueuePosition(position)
    if (!removed) {
      await command.reply({
        content: `No queued message at position ${position}`,
        flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
      })
      return
    }

    await command.reply({
      content: asSubtext(`Cleared queued message at position ${position}`),
      flags: SILENT_MESSAGE_FLAGS,
    })

    logger.log(
      `[QUEUE] User ${command.user.displayName} cleared queued position ${position} in thread ${channel.id}`,
    )
    return
  }

  const cleared = await runtime?.clearQueue() ?? []

  const lines = cleared.map((item, i) => {
    const label = item.command
      ? `/${item.command.name}`
      : item.prompt
    return `${i + 1}. ${label}`
  })
  let list = lines.join('\n')
  if (list.length > 600) {
    list = list.slice(0, 597) + '...'
  }

  await command.reply({
    content: asSubtext(`Cleared ${cleared.length} queued message${cleared.length > 1 ? 's' : ''}:\n${list}`),
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
  const isKnownCommand = store.getState().registeredUserCommands.some((cmd) => {
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
  const thread = channel as ThreadChannel

  const resolved = await resolveWorkingDirectory({ channel: thread })
  if (!resolved) {
    await command.reply({
      content: 'Could not determine project directory',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
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

  if (enqueueResult.queued && enqueueResult.queueId) {
    const responseText = asSubtext(`Queued message${enqueueResult.position ? ` (position ${enqueueResult.position})` : ''}`)
    await command.reply({
      content: responseText,
      components: [
        buildQueueRemoveRow({
          threadId: thread.id,
          queueId: enqueueResult.queueId,
        }),
      ],
      flags: SILENT_MESSAGE_FLAGS,
    })
    logger.log(
      `[QUEUE] User ${command.user.displayName} queued command /${commandName} in thread ${channel.id}`,
    )
    return
  }

  const responseText = `${QUEUE_PREFIX}**${command.user.displayName}:** ${displayText}`
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

  if (focused.name !== 'command') {
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
