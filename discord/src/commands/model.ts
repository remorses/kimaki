// /model command - Set the preferred model for this channel or session.

import {
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ChannelType,
  type ThreadChannel,
  type TextChannel,
} from 'discord.js'
import crypto from 'node:crypto'
import {
  setChannelModel,
  setSessionModel,
  getChannelModel,
  getSessionModel,
  getSessionAgent,
  getChannelAgent,
  getThreadSession,
  getGlobalModel,
  setGlobalModel,
} from '../database.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import { resolveTextChannel, getKimakiMetadata } from '../discord-utils.js'
import { abortAndRetrySession, getDefaultModel, type DefaultModelSource } from '../session-handler.js'
import { createLogger, LogPrefix } from '../logger.js'
import * as errore from 'errore'

const modelLogger = createLogger(LogPrefix.MODEL)

// Store context by hash to avoid customId length limits (Discord max: 100 chars)
const pendingModelContexts = new Map<
  string,
  {
    dir: string
    channelId: string
    sessionId?: string
    isThread: boolean
    providerId?: string
    providerName?: string
    thread?: ThreadChannel
    appId?: string
    selectedModelId?: string
  }
>()

export type ProviderInfo = {
  id: string
  name: string
  models: Record<
    string,
    {
      id: string
      name: string
      release_date: string
    }
  >
}

export type ModelSource =
  | 'session'
  | 'agent'
  | 'channel'
  | 'global'
  | 'opencode-config'
  | 'opencode-recent'
  | 'opencode-provider-default'

export type CurrentModelInfo =
  | { type: 'session'; model: string; providerID: string; modelID: string }
  | { type: 'agent'; model: string; providerID: string; modelID: string; agentName: string }
  | { type: 'channel'; model: string; providerID: string; modelID: string }
  | { type: 'global'; model: string; providerID: string; modelID: string }
  | { type: 'opencode-config'; model: string; providerID: string; modelID: string }
  | { type: 'opencode-recent'; model: string; providerID: string; modelID: string }
  | { type: 'opencode-provider-default'; model: string; providerID: string; modelID: string }
  | { type: 'none' }

function parseModelId(modelString: string): { providerID: string; modelID: string } | undefined {
  const [providerID, ...modelParts] = modelString.split('/')
  const modelID = modelParts.join('/')
  if (providerID && modelID) {
    return { providerID, modelID }
  }
  return undefined
}

/**
 * Get the current model info for a channel/session, including where it comes from.
 * Priority: session > agent > channel > global > opencode default
 */
export async function getCurrentModelInfo({
  sessionId,
  channelId,
  appId,
  agentPreference,
  getClient,
}: {
  sessionId?: string
  channelId?: string
  appId?: string
  agentPreference?: string
  getClient: Awaited<ReturnType<typeof initializeOpencodeForDirectory>>
}): Promise<CurrentModelInfo> {
  if (getClient instanceof Error) {
    return { type: 'none' }
  }

  // 1. Check session model preference
  if (sessionId) {
    const sessionModel = await getSessionModel(sessionId)
    if (sessionModel) {
      const parsed = parseModelId(sessionModel)
      if (parsed) {
        return { type: 'session', model: sessionModel, ...parsed }
      }
    }
  }

  // 2. Check agent's configured model
  const effectiveAgent = agentPreference ?? (sessionId
    ? (await getSessionAgent(sessionId)) || (channelId ? await getChannelAgent(channelId) : undefined)
    : (channelId ? await getChannelAgent(channelId) : undefined))
  if (effectiveAgent) {
    const agentsResponse = await getClient().app.agents({})
    if (agentsResponse.data) {
      const agent = agentsResponse.data.find((a) => a.name === effectiveAgent)
      if (agent?.model) {
        const model = `${agent.model.providerID}/${agent.model.modelID}`
        return {
          type: 'agent',
          model,
          providerID: agent.model.providerID,
          modelID: agent.model.modelID,
          agentName: effectiveAgent,
        }
      }
    }
  }

  // 3. Check channel model preference
  if (channelId) {
    const channelModel = await getChannelModel(channelId)
    if (channelModel) {
      const parsed = parseModelId(channelModel)
      if (parsed) {
        return { type: 'channel', model: channelModel, ...parsed }
      }
    }
  }

  // 4. Check global model preference
  if (appId) {
    const globalModel = await getGlobalModel(appId)
    if (globalModel) {
      const parsed = parseModelId(globalModel)
      if (parsed) {
        return { type: 'global', model: globalModel, ...parsed }
      }
    }
  }

  // 5. Get opencode default (config > recent > provider default)
  const defaultModel = await getDefaultModel({ getClient })
  if (defaultModel) {
    const model = `${defaultModel.providerID}/${defaultModel.modelID}`
    return {
      type: defaultModel.source,
      model,
      providerID: defaultModel.providerID,
      modelID: defaultModel.modelID,
    }
  }

  return { type: 'none' }
}

/**
 * Handle the /model slash command.
 * Shows a select menu with available providers.
 */
export async function handleModelCommand({
  interaction,
  appId,
}: {
  interaction: ChatInputCommandInteraction
  appId: string
}): Promise<void> {
  modelLogger.log('[MODEL] handleModelCommand called')

  // Defer reply immediately to avoid 3-second timeout
  await interaction.deferReply({ ephemeral: true })
  modelLogger.log('[MODEL] Deferred reply')

  const channel = interaction.channel

  if (!channel) {
    await interaction.editReply({
      content: 'This command can only be used in a channel',
    })
    return
  }

  // Determine if we're in a thread or text channel
  const isThread = [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel.type)

  let projectDirectory: string | undefined
  let channelAppId: string | undefined
  let targetChannelId: string
  let sessionId: string | undefined

  if (isThread) {
    const thread = channel as ThreadChannel
    const textChannel = await resolveTextChannel(thread)
    const metadata = await getKimakiMetadata(textChannel)
    projectDirectory = metadata.projectDirectory
    channelAppId = metadata.channelAppId
    targetChannelId = textChannel?.id || channel.id

    // Get session ID for this thread
    sessionId = await getThreadSession(thread.id)
  } else if (channel.type === ChannelType.GuildText) {
    const textChannel = channel as TextChannel
    const metadata = await getKimakiMetadata(textChannel)
    projectDirectory = metadata.projectDirectory
    channelAppId = metadata.channelAppId
    targetChannelId = channel.id
  } else {
    await interaction.editReply({
      content: 'This command can only be used in text channels or threads',
    })
    return
  }

  if (channelAppId && channelAppId !== appId) {
    await interaction.editReply({
      content: 'This channel is not configured for this bot',
    })
    return
  }

  if (!projectDirectory) {
    await interaction.editReply({
      content: 'This channel is not configured with a project directory',
    })
    return
  }

  try {
    const getClient = await initializeOpencodeForDirectory(projectDirectory)
    if (getClient instanceof Error) {
      await interaction.editReply({ content: getClient.message })
      return
    }

    const providersResponse = await getClient().provider.list({
      query: { directory: projectDirectory },
    })

    if (!providersResponse.data) {
      await interaction.editReply({
        content: 'Failed to fetch providers',
      })
      return
    }

    const { all: allProviders, connected } = providersResponse.data

    // Filter to only connected providers (have credentials)
    const availableProviders = allProviders.filter((p) => {
      return connected.includes(p.id)
    })

    if (availableProviders.length === 0) {
      await interaction.editReply({
        content:
          'No providers with credentials found. Use `/login` to connect a provider and add credentials.',
      })
      return
    }

    // Get current model info to display
    const currentModelInfo = await getCurrentModelInfo({
      sessionId,
      channelId: targetChannelId,
      appId: channelAppId || appId,
      getClient,
    })

    const currentModelText = (() => {
      switch (currentModelInfo.type) {
        case 'session':
          return `**Current (session override):** \`${currentModelInfo.model}\``
        case 'agent':
          return `**Current (agent "${currentModelInfo.agentName}"):** \`${currentModelInfo.model}\``
        case 'channel':
          return `**Current (channel override):** \`${currentModelInfo.model}\``
        case 'global':
          return `**Current (global default):** \`${currentModelInfo.model}\``
        case 'opencode-config':
        case 'opencode-recent':
        case 'opencode-provider-default':
          return `**Current (opencode default):** \`${currentModelInfo.model}\``
        case 'none':
          return '**Current:** none'
      }
    })()

    // Store context with a short hash key to avoid customId length limits
    // Use bot's appId if channel doesn't have one stored (older channels or channels migrated before appId tracking)
    const context = {
      dir: projectDirectory,
      channelId: targetChannelId,
      sessionId: sessionId,
      isThread: isThread,
      thread: isThread ? (channel as ThreadChannel) : undefined,
      appId: channelAppId || appId,
    }
    const contextHash = crypto.randomBytes(8).toString('hex')
    pendingModelContexts.set(contextHash, context)

    const options = availableProviders.slice(0, 25).map((provider) => {
      const modelCount = Object.keys(provider.models || {}).length
      return {
        label: provider.name.slice(0, 100),
        value: provider.id,
        description: `${modelCount} model${modelCount !== 1 ? 's' : ''} available`.slice(0, 100),
      }
    })

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`model_provider:${contextHash}`)
      .setPlaceholder('Select a provider')
      .addOptions(options)

    const actionRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)

    await interaction.editReply({
      content: `**Set Model Preference**\n${currentModelText}\nSelect a provider:`,
      components: [actionRow],
    })
  } catch (error) {
    modelLogger.error('Error loading providers:', error)
    await interaction.editReply({
      content: `Failed to load providers: ${error instanceof Error ? error.message : 'Unknown error'}`,
    })
  }
}

/**
 * Handle the provider select menu interaction.
 * Shows a second select menu with models for the chosen provider.
 */
export async function handleProviderSelectMenu(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const customId = interaction.customId

  if (!customId.startsWith('model_provider:')) {
    return
  }

  // Defer update immediately to avoid timeout
  await interaction.deferUpdate()

  const contextHash = customId.replace('model_provider:', '')
  const context = pendingModelContexts.get(contextHash)

  if (!context) {
    await interaction.editReply({
      content: 'Selection expired. Please run /model again.',
      components: [],
    })
    return
  }

  const selectedProviderId = interaction.values[0]
  if (!selectedProviderId) {
    await interaction.editReply({
      content: 'No provider selected',
      components: [],
    })
    return
  }

  try {
    const getClient = await initializeOpencodeForDirectory(context.dir)
    if (getClient instanceof Error) {
      await interaction.editReply({
        content: getClient.message,
        components: [],
      })
      return
    }

    const providersResponse = await getClient().provider.list({
      query: { directory: context.dir },
    })

    if (!providersResponse.data) {
      await interaction.editReply({
        content: 'Failed to fetch providers',
        components: [],
      })
      return
    }

    const provider = providersResponse.data.all.find((p) => p.id === selectedProviderId)

    if (!provider) {
      await interaction.editReply({
        content: 'Provider not found',
        components: [],
      })
      return
    }

    const models = Object.entries(provider.models || {})
      .map(([modelId, model]) => ({
        id: modelId,
        name: model.name,
        releaseDate: model.release_date,
      }))
      // Sort by release date descending (most recent first)
      .sort((a, b) => {
        const dateA = a.releaseDate ? new Date(a.releaseDate).getTime() : 0
        const dateB = b.releaseDate ? new Date(b.releaseDate).getTime() : 0
        return dateB - dateA
      })

    if (models.length === 0) {
      await interaction.editReply({
        content: `No models available for ${provider.name}`,
        components: [],
      })
      return
    }

    // Take first 25 models (most recent since sorted descending)
    const recentModels = models.slice(0, 25)

    // Update context with provider info and reuse the same hash
    context.providerId = selectedProviderId
    context.providerName = provider.name
    pendingModelContexts.set(contextHash, context)

    const options = recentModels.map((model) => {
      const dateStr = model.releaseDate
        ? new Date(model.releaseDate).toLocaleDateString()
        : 'Unknown date'
      return {
        label: model.name.slice(0, 100),
        value: model.id,
        description: dateStr.slice(0, 100),
      }
    })

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`model_select:${contextHash}`)
      .setPlaceholder('Select a model')
      .addOptions(options)

    const actionRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)

    await interaction.editReply({
      content: `**Set Model Preference**\nProvider: **${provider.name}**\nSelect a model:`,
      components: [actionRow],
    })
  } catch (error) {
    modelLogger.error('Error loading models:', error)
    await interaction.editReply({
      content: `Failed to load models: ${error instanceof Error ? error.message : 'Unknown error'}`,
      components: [],
    })
  }
}

/**
 * Handle the model select menu interaction.
 * Stores the model preference in the database.
 */
export async function handleModelSelectMenu(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const customId = interaction.customId

  if (!customId.startsWith('model_select:')) {
    return
  }

  // Defer update immediately
  await interaction.deferUpdate()

  const contextHash = customId.replace('model_select:', '')
  const context = pendingModelContexts.get(contextHash)

  if (!context || !context.providerId || !context.providerName) {
    await interaction.editReply({
      content: 'Selection expired. Please run /model again.',
      components: [],
    })
    return
  }

  const selectedModelId = interaction.values[0]
  if (!selectedModelId) {
    await interaction.editReply({
      content: 'No model selected',
      components: [],
    })
    return
  }

  // Build full model ID: provider_id/model_id
  const fullModelId = `${context.providerId}/${selectedModelId}`

  try {
    // Store in appropriate table based on context
    if (context.isThread && context.sessionId) {
      // Store for session
      await setSessionModel(context.sessionId, fullModelId)
      modelLogger.log(`Set model ${fullModelId} for session ${context.sessionId}`)

      // Check if there's a running request and abort+retry with new model
      let retried = false
      if (context.thread) {
        retried = await abortAndRetrySession({
          sessionId: context.sessionId,
          thread: context.thread,
          projectDirectory: context.dir,
          appId: context.appId,
        })
      }

      if (retried) {
        await interaction.editReply({
          content: `Model changed for this session:\n**${context.providerName}** / **${selectedModelId}**\n\`${fullModelId}\`\n_Retrying current request with new model..._`,
          components: [],
        })
      } else {
        await interaction.editReply({
          content: `Model preference set for this session:\n**${context.providerName}** / **${selectedModelId}**\n\`${fullModelId}\``,
          components: [],
        })
      }

      // Clean up the context from memory
      pendingModelContexts.delete(contextHash)
    } else {
      // Channel context - show scope selection menu
      context.selectedModelId = fullModelId
      pendingModelContexts.set(contextHash, context)

      const scopeOptions = [
        {
          label: 'This channel only',
          value: 'channel',
          description: 'Override for this channel only',
        },
        {
          label: 'Global default',
          value: 'global',
          description: 'Set for this channel and as default for all others',
        },
      ]

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`model_scope:${contextHash}`)
        .setPlaceholder('Apply to...')
        .addOptions(scopeOptions)

      const actionRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)

      await interaction.editReply({
        content: `**Set Model Preference**\nModel: **${context.providerName}** / **${selectedModelId}**\n\`${fullModelId}\`\nApply to:`,
        components: [actionRow],
      })
    }
  } catch (error) {
    modelLogger.error('Error saving model preference:', error)
    await interaction.editReply({
      content: `Failed to save model preference: ${error instanceof Error ? error.message : 'Unknown error'}`,
      components: [],
    })
  }
}

/**
 * Handle the scope select menu interaction.
 * Applies the model to either the channel or globally.
 */
export async function handleModelScopeSelectMenu(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const customId = interaction.customId

  if (!customId.startsWith('model_scope:')) {
    return
  }

  // Defer update immediately
  await interaction.deferUpdate()

  const contextHash = customId.replace('model_scope:', '')
  const context = pendingModelContexts.get(contextHash)

  if (!context || !context.providerId || !context.providerName || !context.selectedModelId) {
    await interaction.editReply({
      content: 'Selection expired. Please run /model again.',
      components: [],
    })
    return
  }

  const selectedScope = interaction.values[0]
  if (!selectedScope) {
    await interaction.editReply({
      content: 'No scope selected',
      components: [],
    })
    return
  }

  const modelId = context.selectedModelId
  const modelDisplay = modelId.split('/')[1] || modelId

  try {
    if (selectedScope === 'global') {
      if (!context.appId) {
        await interaction.editReply({
          content: 'Cannot set global model: channel is not linked to a bot',
          components: [],
        })
        return
      }
      // Set both global default and current channel
      await setGlobalModel(context.appId, modelId)
      await setChannelModel(context.channelId, modelId)
      modelLogger.log(`Set global model ${modelId} for app ${context.appId} and channel ${context.channelId}`)

      await interaction.editReply({
        content: `Model set for this channel and as global default:\n**${context.providerName}** / **${modelDisplay}**\n\`${modelId}\`\nAll channels will use this model (unless they have their own override).`,
        components: [],
      })
    } else {
      // channel scope
      await setChannelModel(context.channelId, modelId)
      modelLogger.log(`Set model ${modelId} for channel ${context.channelId}`)

      await interaction.editReply({
        content: `Model preference set for this channel:\n**${context.providerName}** / **${modelDisplay}**\n\`${modelId}\`\nAll new sessions in this channel will use this model.`,
        components: [],
      })
    }

    // Clean up the context from memory
    pendingModelContexts.delete(contextHash)
  } catch (error) {
    modelLogger.error('Error saving model preference:', error)
    await interaction.editReply({
      content: `Failed to save model preference: ${error instanceof Error ? error.message : 'Unknown error'}`,
      components: [],
    })
  }
}
