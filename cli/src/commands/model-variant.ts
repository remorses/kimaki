// /model-variant command — quickly change the thinking level variant for the current model.
// Shows both the variant picker and scope picker in a single reply (two action rows)
// so the user can select both without waiting for sequential menus.
//
// Cross-menu state: Discord doesn't expose already-selected values on sibling
// select menus in the same message. We track partial selections in the context
// Map. Whichever menu fires second sees the first selection stored and applies.

import {
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ChannelType,
  type ThreadChannel,
  type TextChannel,
  MessageFlags,
} from 'discord.js'
import crypto from 'node:crypto'
import {
  setChannelModel,
  setSessionModel,
  getThreadSession,
  setGlobalModel,
  getVariantCascade,
} from '../database.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import { resolveTextChannel, getKimakiMetadata } from '../discord-utils.js'
import {
  getCurrentModelInfo,
  ensureSessionPreferencesSnapshot,
  type CurrentModelInfo,
} from './model.js'
import { getRuntime } from '../session-handler/thread-session-runtime.js'
import { getThinkingValuesForModel } from '../thinking-utils.js'
import { createLogger, LogPrefix } from '../logger.js'

const logger = createLogger(LogPrefix.MODEL)

type PendingVariantContext = {
  dir: string
  channelId: string
  sessionId?: string
  isThread: boolean
  thread?: ThreadChannel
  appId: string
  /** Full model ID (provider/model) that stays constant */
  modelId: string
  providerId: string
  modelName: string
  providerName: string
  availableVariants: string[]
  currentVariant?: string
  /** Partial selection tracking — set when user picks variant before scope */
  selectedVariant?: string | null
  /** Partial selection tracking — set when user picks scope before variant */
  selectedScope?: string
}

const pendingVariantContexts = new Map<string, PendingVariantContext>()

/** 10 minute TTL for pending contexts to prevent unbounded map growth */
const CONTEXT_TTL_MS = 10 * 60 * 1000

type VariantScope = 'session' | 'channel' | 'global'

function isVariantScope(value: string): value is VariantScope {
  return value === 'session' || value === 'channel' || value === 'global'
}

function formatSourceLabel(info: CurrentModelInfo): string {
  switch (info.type) {
    case 'session':
      return 'thread override'
    case 'agent':
      return `agent "${info.agentName}"`
    case 'channel':
      return 'channel override'
    case 'global':
      return 'global default'
    case 'opencode-config':
    case 'opencode-recent':
    case 'opencode-provider-default':
      return 'opencode default'
    case 'none':
      return 'none'
  }
}

export async function handleModelVariantCommand({
  interaction,
  appId,
}: {
  interaction: ChatInputCommandInteraction
  appId: string
}): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const channel = interaction.channel
  if (!channel) {
    await interaction.editReply({
      content: 'This command can only be used in a channel',
    })
    return
  }

  const isThread = [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel.type)

  let projectDirectory: string | undefined
  let targetChannelId: string
  let sessionId: string | undefined

  if (isThread) {
    const thread = channel as ThreadChannel
    const [textChannel, threadSessionId] = await Promise.all([
      resolveTextChannel(thread),
      getThreadSession(thread.id),
    ])
    const metadata = await getKimakiMetadata(textChannel)
    projectDirectory = metadata.projectDirectory
    targetChannelId = textChannel?.id || channel.id
    sessionId = threadSessionId
  } else if (channel.type === ChannelType.GuildText) {
    const textChannel = channel as TextChannel
    const metadata = await getKimakiMetadata(textChannel)
    projectDirectory = metadata.projectDirectory
    targetChannelId = channel.id
  } else {
    await interaction.editReply({
      content: 'This command can only be used in text channels or threads',
    })
    return
  }

  if (!projectDirectory) {
    await interaction.editReply({
      content: 'This channel is not configured with a project directory',
    })
    return
  }

  const getClient = await initializeOpencodeForDirectory(projectDirectory)
  if (getClient instanceof Error) {
    await interaction.editReply({ content: getClient.message })
    return
  }

  if (isThread && sessionId) {
    await ensureSessionPreferencesSnapshot({
      sessionId,
      channelId: targetChannelId,
      appId,
      getClient,
    })
  }

  const [currentModelInfo, cascadeVariant, providersResponse] =
    await Promise.all([
      getCurrentModelInfo({
        sessionId,
        channelId: targetChannelId,
        appId,
        getClient,
      }),
      getVariantCascade({
        sessionId,
        channelId: targetChannelId,
        appId,
      }),
      getClient().provider.list({ directory: projectDirectory }),
    ])

  if (currentModelInfo.type === 'none') {
    await interaction.editReply({
      content: 'No model configured. Use `/model` to set one first.',
    })
    return
  }

  if (!providersResponse.data) {
    await interaction.editReply({ content: 'Failed to fetch providers' })
    return
  }

  const { providerID, modelID, model: fullModelId } = currentModelInfo
  const sourceLabel = formatSourceLabel(currentModelInfo)
  const variantLabel = cascadeVariant ? ` (${cascadeVariant})` : ''

  const provider = providersResponse.data.all.find((p) => {
    return p.id === providerID
  })
  const providerName = provider?.name || providerID

  const variants = getThinkingValuesForModel({
    providers: providersResponse.data.all,
    providerId: providerID,
    modelId: modelID,
  })

  const statusText = `**Current model:** \`${fullModelId}\`${variantLabel} — ${sourceLabel}`

  if (variants.length === 0) {
    await interaction.editReply({
      content: `${statusText}\nThis model doesn't support thinking level variants.`,
    })
    return
  }

  const contextHash = crypto.randomBytes(8).toString('hex')
  pendingVariantContexts.set(contextHash, {
    dir: projectDirectory,
    channelId: targetChannelId,
    sessionId,
    isThread,
    thread: isThread ? (channel as ThreadChannel) : undefined,
    appId,
    modelId: fullModelId,
    providerId: providerID,
    modelName: modelID,
    providerName,
    availableVariants: variants,
    currentVariant: cascadeVariant,
  })
  setTimeout(() => {
    pendingVariantContexts.delete(contextHash)
  }, CONTEXT_TTL_MS)

  const variantOptions = [
    {
      label: 'None (default)',
      value: '__none__',
      description: 'Use the model without a specific thinking level',
      default: !cascadeVariant,
    },
    ...variants.slice(0, 24).map((v: string) => ({
      label: v.slice(0, 100),
      value: v,
      description: `Use ${v} thinking`.slice(0, 100),
      default: cascadeVariant === v,
    })),
  ]

  const variantMenu = new StringSelectMenuBuilder()
    .setCustomId(`variant_quick:${contextHash}`)
    .setPlaceholder('Select a thinking level')
    .addOptions(variantOptions)

  const scopeOptions = [
    ...(isThread && sessionId
      ? [
          {
            label: 'This session only',
            value: 'session',
            description: 'Override for this thread session only',
          },
        ]
      : []),
    {
      label: 'This channel',
      value: 'channel',
      description: 'Override for this channel (all new sessions)',
    },
    {
      label: 'Global default',
      value: 'global',
      description: 'Set for this channel and as default for all others',
    },
  ]

  const scopeMenu = new StringSelectMenuBuilder()
    .setCustomId(`variant_scope:${contextHash}`)
    .setPlaceholder('Apply to...')
    .addOptions(scopeOptions)

  const variantRow =
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(variantMenu)
  const scopeRow =
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(scopeMenu)

  await interaction.editReply({
    content: `${statusText}\nSelect a thinking level and where to apply it:`,
    components: [variantRow, scopeRow],
  })
}

/**
 * Handle the variant quick-select interaction.
 * Stores the chosen variant in context. If scope was already picked, applies immediately.
 */
export async function handleVariantQuickSelectMenu(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const contextHash = interaction.customId.replace('variant_quick:', '')
  const context = pendingVariantContexts.get(contextHash)

  if (!context) {
    await interaction.reply({
      content: 'Selection expired. Please run /model-variant again.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await interaction.deferUpdate()

  const selected = interaction.values[0]
  if (!selected) {
    return
  }

  const chosenVariant = selected === '__none__' ? null : selected
  if (chosenVariant !== null && !context.availableVariants.includes(chosenVariant)) {
    pendingVariantContexts.delete(contextHash)
    await interaction.editReply({
      content: 'Invalid variant selection. Please run /model-variant again.',
      components: [],
    })
    return
  }

  context.selectedVariant = chosenVariant

  if (context.selectedScope) {
    await applyVariant({
      interaction,
      context,
      variant: chosenVariant,
      scope: context.selectedScope,
      contextHash,
    })
  }
  // Otherwise wait — scope select will see selectedVariant and trigger applyVariant
}

/**
 * Handle the scope select interaction.
 * Stores the chosen scope in context. If variant was already picked, applies immediately.
 */
export async function handleVariantScopeSelectMenu(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const contextHash = interaction.customId.replace('variant_scope:', '')
  const context = pendingVariantContexts.get(contextHash)

  if (!context) {
    await interaction.reply({
      content: 'Selection expired. Please run /model-variant again.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await interaction.deferUpdate()

  const selected = interaction.values[0]
  if (!selected) {
    return
  }

  if (!isVariantScope(selected)) {
    pendingVariantContexts.delete(contextHash)
    await interaction.editReply({
      content: 'Invalid scope selection. Please run /model-variant again.',
      components: [],
    })
    return
  }

  context.selectedScope = selected

  if (context.selectedVariant !== undefined) {
    await applyVariant({
      interaction,
      context,
      variant: context.selectedVariant,
      scope: selected,
      contextHash,
    })
  }
  // Otherwise wait — variant select will see selectedScope and trigger applyVariant
}

async function applyVariant({
  interaction,
  context,
  variant,
  scope,
  contextHash,
}: {
  interaction: StringSelectMenuInteraction
  context: PendingVariantContext
  variant: string | null
  scope: string
  contextHash: string
}): Promise<void> {
  const modelId = context.modelId
  const variantSuffix = variant ? ` (${variant})` : ''
  const agentTip =
    '\n_Tip: create [agent .md files](https://github.com/remorses/kimaki/blob/main/docs/model-switching.md) in .opencode/agent/ for one-command model switching_'

  try {
    if (scope === 'session') {
      if (!context.sessionId) {
        pendingVariantContexts.delete(contextHash)
        await interaction.editReply({
          content:
            'No active session in this thread. Please run /model-variant in a thread with a session.',
          components: [],
        })
        return
      }
      await setSessionModel({
        sessionId: context.sessionId,
        modelId,
        variant,
      })
      logger.log(
        `Set variant ${variant ?? 'none'} for session ${context.sessionId} (model ${modelId})`,
      )

      let retried = false
      if (context.thread) {
        const runtime = getRuntime(context.thread.id)
        if (runtime) {
          retried = await runtime.retryLastUserPrompt()
        }
      }

      const retryNote = retried
        ? '\n_Restarting current request with new variant..._'
        : ''
      await interaction.editReply({
        content: `Variant set for this session:\n**${context.providerName}** / **${context.modelName}**${variantSuffix}\n\`${modelId}\`${retryNote}${agentTip}`,
        flags: MessageFlags.SuppressEmbeds,
        components: [],
      })
    } else if (scope === 'global') {
      await setGlobalModel({ appId: context.appId, modelId, variant })
      await setChannelModel({
        channelId: context.channelId,
        modelId,
        variant,
      })
      logger.log(
        `Set global variant ${variant ?? 'none'} for app ${context.appId} and channel ${context.channelId} (model ${modelId})`,
      )

      await interaction.editReply({
        content: `Variant set for this channel and as global default:\n**${context.providerName}** / **${context.modelName}**${variantSuffix}\n\`${modelId}\`\nAll channels will use this variant (unless they have their own override).${agentTip}`,
        flags: MessageFlags.SuppressEmbeds,
        components: [],
      })
    } else {
      // channel scope
      await setChannelModel({
        channelId: context.channelId,
        modelId,
        variant,
      })
      logger.log(
        `Set channel variant ${variant ?? 'none'} for channel ${context.channelId} (model ${modelId})`,
      )

      await interaction.editReply({
        content: `Variant set for this channel:\n**${context.providerName}** / **${context.modelName}**${variantSuffix}\n\`${modelId}\`\nAll new sessions in this channel will use this variant.${agentTip}`,
        flags: MessageFlags.SuppressEmbeds,
        components: [],
      })
    }

    pendingVariantContexts.delete(contextHash)
  } catch (error) {
    logger.error('Error applying variant:', error)
    await interaction.editReply({
      content: `Failed to apply variant: ${error instanceof Error ? error.message : 'Unknown error'}`,
      components: [],
    })
  }
}
