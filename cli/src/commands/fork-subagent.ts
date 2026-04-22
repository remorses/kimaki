// /fork-subagent command - Fork a subagent task session into a new thread.

import {
  ActionRowBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  ThreadAutoArchiveDuration,
  type ThreadChannel,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js'
import {
  getSessionEventSnapshot,
  getThreadSession,
  setThreadSession,
} from '../database.js'
import {
  resolveTextChannel,
  resolveWorkingDirectory,
  sendThreadMessage,
} from '../discord-utils.js'
import {
  collectFullSessionChunks,
  batchChunksForDiscord,
} from '../message-formatting.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import {
  getDerivedSubagentSessions,
  type EventBufferEntry,
} from '../session-handler/event-stream-state.js'
import { createLogger, LogPrefix } from '../logger.js'
import {
  getThreadChannel,
  parsePersistedEventRows,
} from './fork.js'

const forkLogger = createLogger(LogPrefix.FORK)

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

async function replayForkedSessionHistory({
  thread,
  projectDirectory,
  sessionId,
}: {
  thread: ThreadChannel
  projectDirectory: string
  sessionId: string
}): Promise<void> {
  const getClient = await initializeOpencodeForDirectory(projectDirectory)
  if (getClient instanceof Error) {
    throw new Error(`Failed to load session history: ${getClient.message}`, {
      cause: getClient,
    })
  }

  const messagesResponse = await getClient().session.messages({
    sessionID: sessionId,
  })
  if (!messagesResponse.data) {
    throw new Error('Failed to fetch forked session messages')
  }

  const batched = batchChunksForDiscord(
    collectFullSessionChunks({
      messages: messagesResponse.data,
    }),
  )
  for (const batch of batched) {
    await sendThreadMessage(thread, batch.content)
  }
}

export async function handleForkSubagentCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const threadChannel = getThreadChannel(interaction.channel)
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

  const sessionId = await getThreadSession(threadChannel.id)
  if (!sessionId) {
    await interaction.reply({
      content: 'No active session in this thread',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const rows = await getSessionEventSnapshot({ sessionId })
  const events: EventBufferEntry[] = parsePersistedEventRows({ rows })
  const subagentSessions = getDerivedSubagentSessions({
    events,
    mainSessionId: sessionId,
  }).slice(0, 25)

  if (subagentSessions.length === 0) {
    await interaction.editReply({
      content: 'No subagent task sessions found in this thread',
    })
    return
  }

  const options = subagentSessions.map((subagentSession) => ({
    label: getSubagentOptionLabel({
      subagentType: subagentSession.subagentType,
      description: subagentSession.description,
    }),
    value: subagentSession.childSessionId,
    description: new Date(subagentSession.timestamp).toLocaleString().slice(0, 100),
  }))

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`fork_subagent_select:${sessionId}`)
    .setPlaceholder('Select a subagent session to fork')
    .addOptions(options)

  const actionRow =
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)

  await interaction.editReply({
    content:
      '**Fork Subagent Session**\nSelect a subagent task session to fork into a new thread. The new thread will show the full subagent conversation, including the initial prompt:',
    components: [actionRow],
  })
}

export async function handleForkSubagentSelectMenu(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const customId = interaction.customId
  if (!customId.startsWith('fork_subagent_select:')) {
    return
  }

  const [, parentSessionId] = customId.split(':')
  if (!parentSessionId) {
    await interaction.reply({
      content: 'Invalid selection data',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const selectedSessionId = interaction.values[0]
  if (!selectedSessionId) {
    await interaction.reply({
      content: 'No subagent session selected',
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
    await interaction.editReply('Could not determine project directory for this channel')
    return
  }

  const rows = await getSessionEventSnapshot({ sessionId: parentSessionId })
  const events: EventBufferEntry[] = parsePersistedEventRows({ rows })
  const selectedSubagent = getDerivedSubagentSessions({
    events,
    mainSessionId: parentSessionId,
  }).find((candidate) => {
    return candidate.childSessionId === selectedSessionId
  })

  const getClient = await initializeOpencodeForDirectory(
    resolved.projectDirectory,
  )
  if (getClient instanceof Error) {
    await interaction.editReply(`Failed to fork session: ${getClient.message}`)
    return
  }

  const forkResponse = await getClient().session.fork({
    sessionID: selectedSessionId,
  })
  if (!forkResponse.data) {
    await interaction.editReply('Failed to fork session')
    return
  }

  const textChannel = await resolveTextChannel(threadChannel)
  if (!textChannel) {
    await interaction.editReply('Could not resolve parent text channel')
    return
  }

  const forkedSession = forkResponse.data
  const forkedThread = await textChannel.threads.create({
    name: `Fork: ${selectedSubagent?.description || selectedSubagent?.subagentType || 'subagent session'}`.slice(0, 100),
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    reason: `Forked subagent session ${selectedSessionId}`,
  })

  await setThreadSession(forkedThread.id, forkedSession.id)
  await forkedThread.members.add(interaction.user.id)

  forkLogger.log(
    `Created forked subagent session ${forkedSession.id} in thread ${forkedThread.id} from ${selectedSessionId}`,
  )

  const agentLabel = selectedSubagent?.subagentType || 'task'
  const descriptionLabel = selectedSubagent?.description || 'No description'

  await sendThreadMessage(
    forkedThread,
    `**Forked subagent session created!**\nAgent: \`${agentLabel}\`\nTask: ${descriptionLabel}\nSource session: \`${selectedSessionId}\`\nNew session: \`${forkedSession.id}\``,
  )

  try {
    await replayForkedSessionHistory({
      thread: forkedThread,
      projectDirectory: resolved.projectDirectory,
      sessionId: forkedSession.id,
    })
  } catch (error) {
    forkLogger.error('Error replaying forked subagent history:', error)
    await sendThreadMessage(
      forkedThread,
      'Failed to load full conversation history, but the session is connected and ready to continue.',
    )
  }

  await sendThreadMessage(
    forkedThread,
    'You can now continue the conversation from this point.',
  )

  await interaction.editReply(
    `Subagent session forked! Continue in ${forkedThread.toString()}`,
  )
}
