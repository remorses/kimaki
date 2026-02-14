import {
  ActionRowBuilder,
  ChannelType,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import crypto from 'node:crypto'
import {
  getSessionThinking,
  getThreadSession,
  setSessionThinking,
} from '../database.js'
import { resolveWorkingDirectory } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import {
  getThinkingValuesForModel,
  matchThinkingValue,
} from '../thinking-utils.js'
import { getCurrentModelInfo } from './model.js'

const thinkingLogger = createLogger(LogPrefix.THINKING)

type ThinkingCommandContext = {
  threadId: string
  sessionId: string
  modelDisplay: string
  thinkingValues: string[]
  expiresAt: number
}

const pendingThinkingContexts = new Map<string, ThinkingCommandContext>()
const pendingThinkingContextTimeouts = new Map<string, NodeJS.Timeout>()
const PENDING_THINKING_CONTEXT_TTL_MS = 10 * 60 * 1000

function clearPendingThinkingContext(contextHash: string): void {
  pendingThinkingContexts.delete(contextHash)
  const timeout = pendingThinkingContextTimeouts.get(contextHash)
  if (timeout) {
    clearTimeout(timeout)
  }
  pendingThinkingContextTimeouts.delete(contextHash)
}

function setPendingThinkingContext({
  contextHash,
  context,
}: {
  contextHash: string
  context: ThinkingCommandContext
}): void {
  clearPendingThinkingContext(contextHash)
  pendingThinkingContexts.set(contextHash, context)
  const timeout = setTimeout(() => {
    clearPendingThinkingContext(contextHash)
  }, PENDING_THINKING_CONTEXT_TTL_MS)
  pendingThinkingContextTimeouts.set(contextHash, timeout)
  timeout.unref()
}

function isThreadChannel(channelType: ChannelType): boolean {
  return [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channelType)
}

function getCurrentThinkingText(currentThinking: string | undefined): string {
  if (!currentThinking) {
    return '**Current:** none'
  }
  return `**Current (session override):** \`${currentThinking}\``
}

function buildThinkingSelectMenu({
  contextHash,
  thinkingValues,
}: {
  contextHash: string
  thinkingValues: string[]
}): ActionRowBuilder<StringSelectMenuBuilder> {
  const options = thinkingValues.slice(0, 25).map((thinkingValue, index) => {
    return {
      label: thinkingValue.slice(0, 100),
      value: `v_${index}`,
      description: `Use ${thinkingValue} thinking`.slice(0, 100),
    }
  })

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`thinking_value:${contextHash}`)
    .setPlaceholder('Select a thinking level')
    .addOptions(options)

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    selectMenu,
  )
}

export async function handleThinkingCommand({
  interaction,
  appId,
}: {
  interaction: ChatInputCommandInteraction
  appId: string
}): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  const channel = interaction.channel
  if (!channel) {
    await interaction.editReply({
      content: 'This command can only be used in a channel',
    })
    return
  }
  if (!isThreadChannel(channel.type)) {
    await interaction.editReply({
      content:
        'This command can only be used in a thread with an active session.',
    })
    return
  }

  const thread = channel as ThreadChannel
  const sessionId = await getThreadSession(thread.id)
  if (!sessionId) {
    await interaction.editReply({
      content:
        'No current session in this thread. Start or resume a session first.',
    })
    return
  }

  const resolvedDirectory = await resolveWorkingDirectory({
    channel: thread as ThreadChannel | TextChannel,
  })
  if (!resolvedDirectory) {
    await interaction.editReply({
      content: 'This channel is not configured with a project directory',
    })
    return
  }
  if (
    resolvedDirectory.channelAppId &&
    resolvedDirectory.channelAppId !== appId
  ) {
    await interaction.editReply({
      content: 'This channel is not configured for this bot',
    })
    return
  }

  const getClientResult = await initializeOpencodeForDirectory(
    resolvedDirectory.projectDirectory,
  )
  if (getClientResult instanceof Error) {
    await interaction.editReply({ content: getClientResult.message })
    return
  }
  const getClient = getClientResult

  const modelInfo = await getCurrentModelInfo({
    sessionId,
    channelId: thread.parentId || thread.id,
    appId: resolvedDirectory.channelAppId || appId,
    getClient,
  })
  if (modelInfo.type === 'none') {
    await interaction.editReply({
      content: 'No model selected. Set a model first with `/model`.',
    })
    return
  }

  const providersResponse = await getClient().provider.list({
    query: { directory: resolvedDirectory.workingDirectory },
  })
  if (!providersResponse.data) {
    await interaction.editReply({
      content: 'Failed to load provider metadata.',
    })
    return
  }

  const thinkingValues = getThinkingValuesForModel({
    providers: providersResponse.data.all,
    providerId: modelInfo.providerID,
    modelId: modelInfo.modelID,
  })
  if (thinkingValues.length === 0) {
    await interaction.editReply({
      content: `Current model \`${modelInfo.model}\` does not expose thinking levels.`,
    })
    return
  }

  const requestedValue = interaction.options.getString('value')
  const matchedRequestedValue = requestedValue
    ? matchThinkingValue({
        requestedValue,
        availableValues: thinkingValues,
      })
    : undefined
  if (matchedRequestedValue) {
    const currentSessionId = await getThreadSession(thread.id)
    if (!currentSessionId || currentSessionId !== sessionId) {
      await interaction.editReply({
        content:
          'Session changed while processing this command. Run /thinking again.',
      })
      return
    }

    await setSessionThinking(sessionId, matchedRequestedValue)
    await interaction.editReply({
      content: `Thinking set for this session:\n\`${matchedRequestedValue}\`\nModel: \`${modelInfo.model}\``,
      components: [],
    })
    thinkingLogger.log(
      `[THINK] Set ${matchedRequestedValue} for session ${sessionId}`,
    )
    return
  }

  const currentThinking = await getSessionThinking(sessionId)
  const contextHash = crypto.randomBytes(8).toString('hex')
  setPendingThinkingContext({
    contextHash,
    context: {
      threadId: thread.id,
      sessionId,
      modelDisplay: modelInfo.model,
      thinkingValues,
      expiresAt: Date.now() + PENDING_THINKING_CONTEXT_TTL_MS,
    },
  })

  await interaction.editReply({
    content: `**Set Thinking Level**\n${getCurrentThinkingText(currentThinking)}\n**Current model:** \`${modelInfo.model}\`\nSelect a thinking level:`,
    components: [buildThinkingSelectMenu({ contextHash, thinkingValues })],
  })
}

export async function handleThinkingValueSelectMenu(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const customId = interaction.customId
  if (!customId.startsWith('thinking_value:')) {
    return
  }

  await interaction.deferUpdate()

  const contextHash = customId.replace('thinking_value:', '')
  const context = pendingThinkingContexts.get(contextHash)
  if (!context) {
    await interaction.editReply({
      content: 'Selection expired. Please run /thinking again.',
      components: [],
    })
    return
  }

  if (context.expiresAt <= Date.now()) {
    clearPendingThinkingContext(contextHash)
    await interaction.editReply({
      content: 'Selection expired. Please run /thinking again.',
      components: [],
    })
    return
  }

  const currentSessionId = await getThreadSession(context.threadId)
  if (!currentSessionId || currentSessionId !== context.sessionId) {
    clearPendingThinkingContext(contextHash)
    await interaction.editReply({
      content:
        'Session changed since this menu was opened. Run /thinking again.',
      components: [],
    })
    return
  }

  const selectedOption = interaction.values[0]
  if (!selectedOption) {
    await interaction.editReply({
      content: 'No thinking value selected.',
      components: [],
    })
    return
  }

  const selectedIndexText = selectedOption.replace(/^v_/, '')
  const selectedIndex = Number(selectedIndexText)
  const selectedThinkingValue = Number.isInteger(selectedIndex)
    ? context.thinkingValues[selectedIndex]
    : undefined
  if (!selectedThinkingValue) {
    clearPendingThinkingContext(contextHash)
    await interaction.editReply({
      content: 'Selected value is no longer valid. Please run /thinking again.',
      components: [],
    })
    return
  }

  const matchedThinkingValue = matchThinkingValue({
    requestedValue: selectedThinkingValue,
    availableValues: context.thinkingValues,
  })
  if (!matchedThinkingValue) {
    clearPendingThinkingContext(contextHash)
    await interaction.editReply({
      content: 'Selected value is no longer valid. Please run /thinking again.',
      components: [],
    })
    return
  }

  await setSessionThinking(context.sessionId, matchedThinkingValue)
  clearPendingThinkingContext(contextHash)
  await interaction.editReply({
    content: `Thinking set for this session:\n\`${matchedThinkingValue}\`\nModel: \`${context.modelDisplay}\``,
    components: [],
  })

  thinkingLogger.log(
    `[THINK] Selected ${matchedThinkingValue} for session ${context.sessionId}`,
  )
}
