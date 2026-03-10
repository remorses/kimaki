// /fork command - Fork the session from a past user message.

// ThreadAutoArchiveDuration.OneDay = 1440 minutes
const THREAD_AUTO_ARCHIVE_ONE_DAY = 1440
import { PLATFORM_MESSAGE_FLAGS } from '../platform/message-flags.js'
import {
  getThreadSession,
  setThreadSession,
  setPartMessagesBatch,
} from '../database.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import {
  resolveWorkingDirectory,
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import { collectLastAssistantParts } from '../message-formatting.js'
import { createLogger, LogPrefix } from '../logger.js'
import * as errore from 'errore'
import type { CommandEvent, SelectMenuEvent } from '../platform/types.js'
import { getDefaultRuntimeAdapter } from '../session-handler/thread-session-runtime.js'
import { isThreadChannel, getRootChannelId } from './channel-ref.js'

const sessionLogger = createLogger(LogPrefix.SESSION)
const forkLogger = createLogger(LogPrefix.FORK)

export async function handleForkCommand(
  interaction: CommandEvent,
): Promise<void> {
  const channel = interaction.channel

  if (!channel) {
    await interaction.reply({
      content: 'This command can only be used in a channel',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL,
    })
    return
  }

  if (!isThreadChannel(channel)) {
    await interaction.reply({
      content:
        'This command can only be used in a thread with an active session',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL,
    })
    return
  }

  const resolved = await resolveWorkingDirectory({ channel })

  if (!resolved) {
    await interaction.reply({
      content: 'Could not determine project directory for this channel',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL,
    })
    return
  }

  const { projectDirectory } = resolved

  const sessionId = await getThreadSession(channel.id)

  if (!sessionId) {
    await interaction.reply({
      content: 'No active session in this thread',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL,
    })
    return
  }

  // Defer reply before API calls to avoid 3-second timeout
  await interaction.deferReply({ flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL })

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
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL,
    })
    return
  }
  const selectedMessageId = interaction.values[0]

  if (!selectedMessageId) {
    await interaction.reply({
      content: 'No message selected',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL,
    })
    return
  }

  await interaction.deferReply({ ephemeral: false })

    const threadChannel = interaction.channel
    if (!threadChannel) {
    await interaction.editReply('Could not access thread channel')
    return
  }

    const resolved = await resolveWorkingDirectory({ channel: threadChannel })
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

    if (!isThreadChannel(parentChannel)) {
      await interaction.editReply('Could not access parent channel')
      return
    }

    const rootChannelId = getRootChannelId(parentChannel)
    if (!rootChannelId) {
      await interaction.editReply('Could not resolve parent text channel')
      return
    }

    const adapter = getDefaultRuntimeAdapter()
    if (!adapter) {
      throw new Error('No runtime adapter configured')
    }
    const channelTarget = {
      channelId: rootChannelId,
    }
    const starterMessage = await adapter.conversation(channelTarget).send({
      markdown: `**Forking session:** ${forkedSession.title}`,
      flags: SILENT_MESSAGE_FLAGS,
    })
    const { thread, target: threadTarget } = await adapter
      .conversation(channelTarget)
      .message(starterMessage.id)
      .then((messageHandle) => {
        return messageHandle.startThread({
          name: `Fork: ${forkedSession.title}`.slice(0, 100),
          autoArchiveDuration: THREAD_AUTO_ARCHIVE_ONE_DAY,
          reason: `Forked from session ${sessionId}`,
        })
      })

    const threadHandle = await adapter.thread({
      threadId: threadTarget.threadId,
      parentId: thread.parentId,
    })
    if (!threadHandle) {
      throw new Error(`Thread not found: ${threadTarget.threadId}`)
    }
    await threadHandle.addMember(interaction.user.id)

    await setThreadSession(thread.id, forkedSession.id)

    sessionLogger.log(
      `Created forked session ${forkedSession.id} in thread ${thread.id}`,
    )

    await adapter.conversation(threadTarget).send({
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
        const discordMessage = await adapter.conversation(threadTarget).send({
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

    await adapter.conversation(threadTarget).send({
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
