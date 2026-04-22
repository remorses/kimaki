// /fork command - Fork the session from a past user message.

import {
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ChannelType,
  ThreadAutoArchiveDuration,
  type ThreadChannel,
  MessageFlags,
} from 'discord.js'
import {
  getThreadSession,
  setThreadSession,
  setPartMessagesBatch,
} from '../database.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import {
  resolveWorkingDirectory,
  resolveTextChannel,
  sendThreadMessage,
} from '../discord-utils.js'
import {
  collectSessionChunks,
  batchChunksForDiscord,
} from '../message-formatting.js'
import { createLogger, LogPrefix } from '../logger.js'
import * as errore from 'errore'

const sessionLogger = createLogger(LogPrefix.SESSION)
const forkLogger = createLogger(LogPrefix.FORK)

function isTruthy<T>(value: T): value is NonNullable<T> {
  return Boolean(value)
}

function getThreadChannelFromCommand(
  interaction: ChatInputCommandInteraction,
): ThreadChannel | Error {
  return getThreadChannel(interaction.channel)
}

function getThreadChannel(
  channel: ChatInputCommandInteraction['channel'] | StringSelectMenuInteraction['channel'],
): ThreadChannel | Error {
  if (!channel) {
    return new Error('This command can only be used in a channel')
  }

  if (
    channel.type !== ChannelType.PublicThread
    && channel.type !== ChannelType.PrivateThread
    && channel.type !== ChannelType.AnnouncementThread
  ) {
    return new Error('This command can only be used in a thread with an active session')
  }

  return channel
}

function parsePersistedEventRows({
  rows,
}: {
  rows: Array<{ event_json: string; timestamp: bigint; event_index: number; id: number }>
}) {
  return rows.flatMap((row) => {
    const parsed = errore.try({
      try: () => {
        return JSON.parse(row.event_json)
      },
      catch: (error) => {
        return new Error('Failed to parse persisted event JSON', {
          cause: error,
        })
      },
    })
    if (parsed instanceof Error) {
      forkLogger.warn(
        `[fork] Skipping invalid persisted event row ${row.id}: ${parsed.message}`,
      )
      return []
    }

    return [{
      event: parsed,
      timestamp: Number(row.timestamp),
      eventIndex: Number(row.event_index),
    }]
  })
}

function truncateLabelPart(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text
  }
  if (maxLength <= 1) {
    return text.slice(0, maxLength)
  }
  return `${text.slice(0, maxLength - 1)}…`
}

function getSubagentOptionLabel({
  subagentType,
  description,
}: {
  subagentType?: string
  description?: string
}): string {
  const agent = truncateLabelPart(subagentType || 'task', 24)
  const cleanedDescription = description?.trim() || 'No description'
  const descriptionBudget = Math.max(1, 100 - agent.length - 3)
  const truncatedDescription = truncateLabelPart(
    cleanedDescription,
    descriptionBudget,
  )
  return `${agent} · ${truncatedDescription}`
}

export async function handleForkCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const threadChannel = getThreadChannelFromCommand(interaction)
  if (threadChannel instanceof Error) {
    await interaction.reply({
      content: threadChannel.message,
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const resolved = await resolveWorkingDirectory({
    channel: threadChannel,
  })

  if (!resolved) {
    await interaction.reply({
      content: 'Could not determine project directory for this channel',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const { projectDirectory } = resolved

  const sessionId = await getThreadSession(threadChannel.id)

  if (!sessionId) {
    await interaction.reply({
      content: 'No active session in this thread',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  // Defer reply before API calls to avoid 3-second timeout
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const getClient = await initializeOpencodeForDirectory(projectDirectory)
  if (getClient instanceof Error) {
    await interaction.editReply({
      content: `Failed to load messages: ${getClient.message}`,
    })
    return
  }

  try {
    const messagesResponse = await getClient().session.messages({
      sessionID: sessionId,
    })

    if (!messagesResponse.data) {
      await interaction.editReply({
        content: 'Failed to fetch session messages',
      })
      return
    }

    const userMessages = messagesResponse.data.filter(
      (m: { info: { role: string } }) => m.info.role === 'user',
    )

    if (userMessages.length === 0) {
      await interaction.editReply({
        content: 'No user messages found in this session',
      })
      return
    }

    const recentMessages = userMessages.slice(-25)

    // Filter out synthetic parts (branch context, memory reminders, etc.)
    // injected by the opencode plugin — they clutter the dropdown preview.
    const options = recentMessages
      .map(
        (
          m: {
            parts: Array<{ type: string; text?: string; synthetic?: boolean }>
            info: { id: string; time: { created: number } }
          },
          index: number,
        ) => {
          const textPart = m.parts.find((p) => {
            return p.type === 'text' && !p.synthetic && typeof p.text === 'string'
          })
          if (!textPart?.text) {
            return null
          }
          const preview = textPart.text.slice(0, 80)
          const label = `${index + 1}. ${preview}${preview.length >= 80 ? '...' : ''}`

          return {
            label: label.slice(0, 100),
            value: m.info.id,
            description: new Date(m.info.time.created)
              .toLocaleString()
              .slice(0, 50),
          }
        },
      )
      .filter(isTruthy)

    const selectMenu = new StringSelectMenuBuilder()
      // Discord component custom_id max length is 100 chars.
      // Avoid embedding long directory paths (or base64 of them) in the custom ID.
      // handleForkSelectMenu resolves the directory from the current thread instead.
      .setCustomId(`fork_select:${sessionId}`)
      .setPlaceholder('Select a message to fork from')
      .addOptions(options)

    const actionRow =
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)

    await interaction.editReply({
      content:
        '**Fork Session**\nSelect the user message to fork from. The forked session will continue as if you had not sent that message:',
      components: [actionRow],
    })
  } catch (error) {
    forkLogger.error('Error loading messages:', error)
    await interaction.editReply({
      content: `Failed to load messages: ${error instanceof Error ? error.message : 'Unknown error'}`,
    })
  }
}

export async function handleForkSelectMenu(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const customId = interaction.customId

  if (!customId.startsWith('fork_select:')) {
    return
  }

  const [, sessionId] = customId.split(':')
  if (!sessionId) {
    await interaction.reply({
      content: 'Invalid selection data',
      flags: MessageFlags.Ephemeral,
    })
    return
  }
  const selectedMessageId = interaction.values[0]

  if (!selectedMessageId) {
    await interaction.reply({
      content: 'No message selected',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await interaction.deferReply()

  const threadChannel = getThreadChannel(interaction.channel)
  if (threadChannel instanceof Error) {
    await interaction.editReply(threadChannel.message)
    return
  }

  const resolved = await resolveWorkingDirectory({
    channel: threadChannel,
  })
  if (!resolved) {
    await interaction.editReply(
      'Could not determine project directory for this channel',
    )
    return
  }

  const { projectDirectory } = resolved

  const getClient = await initializeOpencodeForDirectory(projectDirectory)
  if (getClient instanceof Error) {
    await interaction.editReply(`Failed to fork session: ${getClient.message}`)
    return
  }

  try {
    const forkResponse = await getClient().session.fork({
      sessionID: sessionId,
      messageID: selectedMessageId,
    })

    if (!forkResponse.data) {
      await interaction.editReply('Failed to fork session')
      return
    }

    const forkedSession = forkResponse.data
    const parentChannel = getThreadChannel(interaction.channel)
    if (parentChannel instanceof Error) {
      await interaction.editReply(parentChannel.message)
      return
    }

    const textChannel = await resolveTextChannel(parentChannel)

    if (!textChannel) {
      await interaction.editReply('Could not resolve parent text channel')
      return
    }

    const thread = await textChannel.threads.create({
      name: `Fork: ${forkedSession.title}`.slice(0, 100),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: `Forked from session ${sessionId}`,
    })

    // Claim the forked session immediately so external polling does not race
    // and create a duplicate Sync thread before the rest of this setup runs.
    await setThreadSession(thread.id, forkedSession.id)

    // Add user to thread so it appears in their sidebar
    await thread.members.add(interaction.user.id)

    sessionLogger.log(
      `Created forked session ${forkedSession.id} in thread ${thread.id}`,
    )

    await sendThreadMessage(
      thread,
      `**Forked session created!**\nFrom: \`${sessionId}\`\nNew session: \`${forkedSession.id}\``,
    )

    // Fetch and display the last assistant messages from the forked session
    const messagesResponse = await getClient().session.messages({
      sessionID: forkedSession.id,
    })

    if (messagesResponse.data) {
      const { chunks } = collectSessionChunks({
        messages: messagesResponse.data,
        limit: 30,
      })
      const batched = batchChunksForDiscord(chunks)
      for (const batch of batched) {
        const discordMessage = await sendThreadMessage(thread, batch.content)
        await setPartMessagesBatch(
          batch.partIds.map((partId) => ({
            partId,
            messageId: discordMessage.id,
            threadId: thread.id,
          })),
        )
      }
    }

    await sendThreadMessage(
      thread,
      `You can now continue the conversation from this point.`,
    )

    await interaction.editReply(
      `Session forked! Continue in ${thread.toString()}`,
    )
  } catch (error) {
    forkLogger.error('Error forking session:', error)
    await interaction.editReply(
      `Failed to fork session: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}

export { getThreadChannel, parsePersistedEventRows }
