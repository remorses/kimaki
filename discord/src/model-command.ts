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
import { getDatabase, setChannelModel, setSessionModel, runModelMigrations } from './database.js'
import { initializeOpencodeForDirectory } from './opencode.js'
import { resolveTextChannel, getKimakiMetadata } from './discord-utils.js'
import { createLogger } from './logger.js'

const modelLogger = createLogger('MODEL')

// Store context by hash to avoid customId length limits (Discord max: 100 chars)
const pendingModelContexts = new Map<string, {
  dir: string
  channelId: string
  sessionId?: string
  isThread: boolean
  providerId?: string
  providerName?: string
}>()

type ProviderInfo = {
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

  // Ensure migrations are run
  runModelMigrations()

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
    const metadata = getKimakiMetadata(textChannel)
    projectDirectory = metadata.projectDirectory
    channelAppId = metadata.channelAppId
    targetChannelId = textChannel?.id || channel.id

    // Get session ID for this thread
    const row = getDatabase()
      .prepare('SELECT session_id FROM thread_sessions WHERE thread_id = ?')
      .get(thread.id) as { session_id: string } | undefined
    sessionId = row?.session_id
  } else if (channel.type === ChannelType.GuildText) {
    const textChannel = channel as TextChannel
    const metadata = getKimakiMetadata(textChannel)
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
          'No providers with credentials found. Use `/connect` in OpenCode TUI to add provider credentials.',
      })
      return
    }

    // Store context with a short hash key to avoid customId length limits
    const context = {
      dir: projectDirectory,
      channelId: targetChannelId,
      sessionId: sessionId,
      isThread: isThread,
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
      content: '**Set Model Preference**\nSelect a provider:',
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
  interaction: StringSelectMenuInteraction
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
  interaction: StringSelectMenuInteraction
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
      setSessionModel(context.sessionId, fullModelId)
      modelLogger.log(`Set model ${fullModelId} for session ${context.sessionId}`)

      await interaction.editReply({
        content: `Model preference set for this session:\n**${context.providerName}** / **${selectedModelId}**\n\n\`${fullModelId}\``,
        components: [],
      })
    } else {
      // Store for channel
      setChannelModel(context.channelId, fullModelId)
      modelLogger.log(`Set model ${fullModelId} for channel ${context.channelId}`)

      await interaction.editReply({
        content: `Model preference set for this channel:\n**${context.providerName}** / **${selectedModelId}**\n\n\`${fullModelId}\`\n\nAll new sessions in this channel will use this model.`,
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
