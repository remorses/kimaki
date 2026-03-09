// /fork command - Fork the session from a past user message.

import {
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
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import { collectLastAssistantParts } from '../message-formatting.js'
import { createLogger, LogPrefix } from '../logger.js'
import * as errore from 'errore'
import type { CommandEvent, SelectMenuEvent } from '../platform/types.js'
import { getDefaultRuntimeAdapter } from '../session-handler/thread-session-runtime.js'

const sessionLogger = createLogger(LogPrefix.SESSION)
const forkLogger = createLogger(LogPrefix.FORK)

export async function handleForkCommand(
  interaction: CommandEvent,
): Promise<void> {
  const channel = interaction.channel

  if (!channel) {
    await interaction.reply({
      content: 'This command can only be used in a channel',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const isThread = [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel.type)

  if (!isThread) {
    await interaction.reply({
      content:
        'This command can only be used in a thread with an active session',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const resolved = await resolveWorkingDirectory({
    channel: channel as ThreadChannel,
  })

  if (!resolved) {
    await interaction.reply({
      content: 'Could not determine project directory for this channel',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const { projectDirectory } = resolved

  const sessionId = await getThreadSession(channel.id)

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
          const textPart = m.parts.find(
            (p) => p.type === 'text' && !p.synthetic,
          ) as { type: 'text'; text: string } | undefined
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
      .filter(
        (o): o is NonNullable<typeof o> => o !== null,
      )

    await interaction.editUiReply({
      markdown:
        '**Fork Session**\nSelect the user message to fork from. The forked session will continue as if you had not sent that message:',
      selectMenu: {
        id: `fork_select:${sessionId}`,
        placeholder: 'Select a message to fork from',
        options,
      },
    })
  } catch (error) {
    forkLogger.error('Error loading messages:', error)
    await interaction.editReply({
      content: `Failed to load messages: ${error instanceof Error ? error.message : 'Unknown error'}`,
    })
  }
}

export async function handleForkSelectMenu(
  interaction: SelectMenuEvent,
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

  await interaction.deferReply({ ephemeral: false })

  const threadChannel = interaction.channel
  if (!threadChannel) {
    await interaction.editReply('Could not access thread channel')
    return
  }

  const resolved = await resolveWorkingDirectory({
    channel: threadChannel as ThreadChannel,
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
    const parentChannel = interaction.channel

    if (
      !parentChannel ||
      ![
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ].includes(parentChannel.type)
    ) {
      await interaction.editReply('Could not access parent channel')
      return
    }

    const textChannel = await resolveTextChannel(parentChannel as ThreadChannel)

    if (!textChannel) {
      await interaction.editReply('Could not resolve parent text channel')
      return
    }

    const adapter = getDefaultRuntimeAdapter()
    if (!adapter) {
      throw new Error('No runtime adapter configured')
    }
    const channelTarget = {
      channelId: textChannel.id,
    }
    const starterMessage = await adapter.sendMessage(channelTarget, {
      markdown: `**Forking session:** ${forkedSession.title}`,
      flags: SILENT_MESSAGE_FLAGS,
    })
    const { thread, target: threadTarget } = await adapter.createThread({
      channelId: channelTarget.channelId,
      messageId: starterMessage.id,
      name: `Fork: ${forkedSession.title}`.slice(0, 100),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: `Forked from session ${sessionId}`,
    })

    await adapter.addThreadMember(threadTarget.threadId, interaction.user.id)

    await setThreadSession(thread.id, forkedSession.id)

    sessionLogger.log(
      `Created forked session ${forkedSession.id} in thread ${thread.id}`,
    )

    await adapter.sendMessage(threadTarget, {
      markdown: `**Forked session created!**\nFrom: \`${sessionId}\`\nNew session: \`${forkedSession.id}\``,
    })

    // Fetch and display the last assistant messages from the forked session
    const messagesResponse = await getClient().session.messages({
      sessionID: forkedSession.id,
    })

    if (messagesResponse.data) {
      const { partIds, content } = collectLastAssistantParts({
        messages: messagesResponse.data,
      })

        if (content.trim()) {
        const discordMessage = await adapter.sendMessage(threadTarget, {
          markdown: content,
        })

        // Store part-message mappings atomically
        await setPartMessagesBatch(
          partIds.map((partId) => ({
            partId,
            messageId: discordMessage.id,
            threadId: thread.id,
          })),
        )
      }
    }

    await adapter.sendMessage(threadTarget, {
      markdown: `You can now continue the conversation from this point.`,
    })

    await interaction.editReply(
      `Session forked! Continue in <#${thread.id}>`,
    )
  } catch (error) {
    forkLogger.error('Error forking session:', error)
    await interaction.editReply(
      `Failed to fork session: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}
