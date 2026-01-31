// /fork command - Fork the session from a past user message.

import {
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ChannelType,
  ThreadAutoArchiveDuration,
  type ThreadChannel,
} from 'discord.js'
import { getThreadSession, setThreadSession, setPartMessagesBatch } from '../database.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import { resolveTextChannel, getKimakiMetadata, sendThreadMessage } from '../discord-utils.js'
import { collectLastAssistantParts } from '../message-formatting.js'
import { createLogger, LogPrefix } from '../logger.js'
import * as errore from 'errore'

const sessionLogger = createLogger(LogPrefix.SESSION)
const forkLogger = createLogger(LogPrefix.FORK)

export async function handleForkCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = interaction.channel

  if (!channel) {
    await interaction.reply({
      content: 'This command can only be used in a channel',
      ephemeral: true,
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
      content: 'This command can only be used in a thread with an active session',
      ephemeral: true,
    })
    return
  }

  const textChannel = await resolveTextChannel(channel as ThreadChannel)
  const { projectDirectory: directory } = await getKimakiMetadata(textChannel)

  if (!directory) {
    await interaction.reply({
      content: 'Could not determine project directory for this channel',
      ephemeral: true,
    })
    return
  }

  const sessionId = await getThreadSession(channel.id)

  if (!sessionId) {
    await interaction.reply({
      content: 'No active session in this thread',
      ephemeral: true,
    })
    return
  }

  // Defer reply before API calls to avoid 3-second timeout
  await interaction.deferReply({ ephemeral: true })

  const getClient = await initializeOpencodeForDirectory(directory)
  if (getClient instanceof Error) {
    await interaction.editReply({
      content: `Failed to load messages: ${getClient.message}`,
    })
    return
  }

  try {
    const messagesResponse = await getClient().session.messages({
      path: { id: sessionId },
    })

    if (!messagesResponse.data) {
      await interaction.editReply({
        content: 'Failed to fetch session messages',
      })
      return
    }

    const userMessages = messagesResponse.data.filter((m: { info: { role: string } }) => m.info.role === 'user')

    if (userMessages.length === 0) {
      await interaction.editReply({
        content: 'No user messages found in this session',
      })
      return
    }

    const recentMessages = userMessages.slice(-25)

    const options = recentMessages.map((m: { parts: Array<{ type: string; text?: string }>; info: { id: string; time: { created: number } } }, index: number) => {
      const textPart = m.parts.find((p: { type: string }) => p.type === 'text') as
        | { type: 'text'; text: string }
        | undefined
      const preview = textPart?.text?.slice(0, 80) || '(no text)'
      const label = `${index + 1}. ${preview}${preview.length >= 80 ? '...' : ''}`

      return {
        label: label.slice(0, 100),
        value: m.info.id,
        description: new Date(m.info.time.created).toLocaleString().slice(0, 50),
      }
    })

    const encodedDir = Buffer.from(directory).toString('base64')

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`fork_select:${sessionId}:${encodedDir}`)
      .setPlaceholder('Select a message to fork from')
      .addOptions(options)

    const actionRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)

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

  const [, sessionId, encodedDir] = customId.split(':')
  if (!sessionId || !encodedDir) {
    await interaction.reply({
      content: 'Invalid selection data',
      ephemeral: true,
    })
    return
  }

  const directory = Buffer.from(encodedDir, 'base64').toString('utf-8')
  const selectedMessageId = interaction.values[0]

  if (!selectedMessageId) {
    await interaction.reply({
      content: 'No message selected',
      ephemeral: true,
    })
    return
  }

  await interaction.deferReply({ ephemeral: false })

  const getClient = await initializeOpencodeForDirectory(directory)
  if (getClient instanceof Error) {
    await interaction.editReply(`Failed to fork session: ${getClient.message}`)
    return
  }

  try {
    const forkResponse = await getClient().session.fork({
      path: { id: sessionId },
      body: { messageID: selectedMessageId },
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

    const thread = await textChannel.threads.create({
      name: `Fork: ${forkedSession.title}`.slice(0, 100),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: `Forked from session ${sessionId}`,
    })

    // Add user to thread so it appears in their sidebar
    await thread.members.add(interaction.user.id)

    await setThreadSession(thread.id, forkedSession.id)

    sessionLogger.log(`Created forked session ${forkedSession.id} in thread ${thread.id}`)

    await sendThreadMessage(
      thread,
      `**Forked session created!**\nFrom: \`${sessionId}\`\nNew session: \`${forkedSession.id}\``,
    )

    // Fetch and display the last assistant messages from the forked session
    const messagesResponse = await getClient().session.messages({
      path: { id: forkedSession.id },
    })

    if (messagesResponse.data) {
      const { partIds, content } = collectLastAssistantParts({
        messages: messagesResponse.data,
      })

      if (content.trim()) {
        const discordMessage = await sendThreadMessage(thread, content)

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

    await sendThreadMessage(thread, `You can now continue the conversation from this point.`)

    await interaction.editReply(`Session forked! Continue in ${thread.toString()}`)
  } catch (error) {
    forkLogger.error('Error forking session:', error)
    await interaction.editReply(
      `Failed to fork session: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}
