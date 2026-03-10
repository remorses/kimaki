// /model command - Set the preferred model for this channel or session.


import crypto from 'node:crypto'
import { PLATFORM_MESSAGE_FLAGS } from '../platform/message-flags.js'
import {
  setChannelModel,
  setSessionModel,
  setSessionAgent,
  getChannelModel,
  getSessionModel,
  getSessionAgent,
  getChannelAgent,
  getThreadSession,
  getGlobalModel,
  setGlobalModel,
  getVariantCascade,
  getChannelDirectory,
} from '../database.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import { getDefaultModel } from '../session-handler/model-utils.js'
import { getRuntime } from '../session-handler/thread-session-runtime.js'
import { getThinkingValuesForModel } from '../thinking-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import * as errore from 'errore'
import type { CommandEvent, PlatformThread, SelectMenuEvent } from '../platform/types.js'
import { getRootChannelId, isTextChannel, isThreadChannel } from './channel-ref.js'

const modelLogger = createLogger(LogPrefix.MODEL)

// Store context by hash to avoid customId length limits (Discord max: 100 chars).
// Entries are TTL'd to prevent unbounded growth when users open /model and never
// interact with the select menu.
const MODEL_CONTEXT_TTL_MS = 10 * 60 * 1000

type PendingModelContext = {
  dir: string
  channelId: string
  sessionId?: string
  isThread: boolean
  providerId?: string
  providerName?: string
  thread?: PlatformThread
  appId?: string
  selectedModelId?: string
  selectedVariant?: string | null
  availableVariants?: string[]
}

const pendingModelContexts = new Map<string, PendingModelContext>()

function setModelContext(contextHash: string, context: PendingModelContext): void {
  pendingModelContexts.set(contextHash, context)
  setTimeout(() => {
    pendingModelContexts.delete(contextHash)
  }, MODEL_CONTEXT_TTL_MS).unref()
}

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
  | {
      type: 'agent'
      model: string
      providerID: string
      modelID: string
      agentName: string
    }
  | { type: 'channel'; model: string; providerID: string; modelID: string }
  | { type: 'global'; model: string; providerID: string; modelID: string }
  | {
      type: 'opencode-config'
      model: string
      providerID: string
      modelID: string
    }
  | {
      type: 'opencode-recent'
      model: string
      providerID: string
      modelID: string
    }
  | {
      type: 'opencode-provider-default'
      model: string
      providerID: string
      modelID: string
    }
  | { type: 'none' }

function parseModelId(
  modelString: string,
): { providerID: string; modelID: string } | undefined {
  const [providerID, ...modelParts] = modelString.split('/')
  const modelID = modelParts.join('/')
  if (providerID && modelID) {
    return { providerID, modelID }
  }
  return undefined
}

export async function ensureSessionPreferencesSnapshot({
  sessionId,
  channelId,
  appId,
  getClient,
  agentOverride,
  modelOverride,
  force,
}: {
  sessionId: string
  channelId?: string
  appId?: string
  getClient: Awaited<ReturnType<typeof initializeOpencodeForDirectory>>
  agentOverride?: string
  modelOverride?: string
  force?: boolean
}): Promise<void> {
  const [sessionAgentPreference, sessionModelPreference] = await Promise.all([
    getSessionAgent(sessionId),
    getSessionModel(sessionId),
  ])
  const shouldBootstrapSessionPreferences =
    force || (!sessionAgentPreference && !sessionModelPreference)
  if (!shouldBootstrapSessionPreferences) {
    return
  }

  const bootstrappedAgent =
    agentOverride ||
    sessionAgentPreference ||
    (channelId ? await getChannelAgent(channelId) : undefined)
  if (!sessionAgentPreference && bootstrappedAgent) {
    await setSessionAgent(sessionId, bootstrappedAgent)
    modelLogger.log(
      `[MODEL] Snapshotted session agent ${bootstrappedAgent} for session ${sessionId}`,
    )
  }

  if (sessionModelPreference) {
    return
  }

  if (modelOverride) {
    const parsedModelOverride = parseModelId(modelOverride)
    if (parsedModelOverride) {
      const bootstrappedVariant = await getVariantCascade({
        sessionId,
        channelId,
        appId,
      })
      await setSessionModel({
        sessionId,
        modelId: modelOverride,
        variant: bootstrappedVariant ?? null,
      })
      modelLogger.log(
        `[MODEL] Snapshotted explicit session model ${modelOverride} for session ${sessionId}`,
      )
      return
    }
    modelLogger.warn(
      `[MODEL] Ignoring invalid explicit model override "${modelOverride}" for session ${sessionId}`,
    )
  }

  const bootstrappedModel = await getCurrentModelInfo({
    sessionId,
    channelId,
    appId,
    agentPreference: bootstrappedAgent,
    getClient,
  })
  if (bootstrappedModel.type === 'none') {
    return
  }

  const bootstrappedVariant = await getVariantCascade({
    sessionId,
    channelId,
    appId,
  })
  await setSessionModel({
    sessionId,
    modelId: bootstrappedModel.model,
    variant: bootstrappedVariant ?? null,
  })
  modelLogger.log(
    `[MODEL] Snapshotted session model ${bootstrappedModel.model} for session ${sessionId}`,
  )
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
    const sessionPref = await getSessionModel(sessionId)
    if (sessionPref) {
      const parsed = parseModelId(sessionPref.modelId)
      if (parsed) {
        return { type: 'session', model: sessionPref.modelId, ...parsed }
      }
    }
  }

  // 2. Check agent's configured model
  const effectiveAgent =
    agentPreference ??
    (sessionId
      ? (await getSessionAgent(sessionId)) ||
        (channelId ? await getChannelAgent(channelId) : undefined)
      : channelId
        ? await getChannelAgent(channelId)
        : undefined)
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
    const channelPref = await getChannelModel(channelId)
    if (channelPref) {
      const parsed = parseModelId(channelPref.modelId)
      if (parsed) {
        return { type: 'channel', model: channelPref.modelId, ...parsed }
      }
    }
  }

  // 4. Check global model preference
  if (appId) {
    const globalPref = await getGlobalModel(appId)
    if (globalPref) {
      const parsed = parseModelId(globalPref.modelId)
      if (parsed) {
        return { type: 'global', model: globalPref.modelId, ...parsed }
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
  interaction: CommandEvent
  appId: string
}): Promise<void> {
  modelLogger.log('[MODEL] handleModelCommand called')

  // Defer reply immediately to avoid 3-second timeout
  await interaction.deferReply({ flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL })
  modelLogger.log('[MODEL] Deferred reply')

  const channel = interaction.channel

  if (!channel) {
    await interaction.editReply({
      content: 'This command can only be used in a channel',
    })
    return
  }

  // Determine if we're in a thread or text channel
  const isThread = isThreadChannel(channel)

  let projectDirectory: string | undefined
  let targetChannelId: string
  let sessionId: string | undefined

  if (isThread) {
    targetChannelId = getRootChannelId(channel) || channel.id
    const [channelConfig, threadSessionId] = await Promise.all([
      getChannelDirectory(targetChannelId),
      getThreadSession(channel.id),
    ])
    projectDirectory = channelConfig?.directory
    sessionId = threadSessionId
  } else if (isTextChannel(channel)) {
    projectDirectory = (await getChannelDirectory(channel.id))?.directory
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

  try {
    const getClient = await initializeOpencodeForDirectory(projectDirectory)
    if (getClient instanceof Error) {
      await interaction.editReply({ content: getClient.message })
      return
    }

    const effectiveAppId = appId

    if (isThread && sessionId) {
      await ensureSessionPreferencesSnapshot({
        sessionId,
        channelId: targetChannelId,
        appId: effectiveAppId,
        getClient,
      })
    }

    // Parallelize: fetch providers, current model info, and variant cascade at the same time.
    // getCurrentModelInfo does DB lookups first (fast) and only hits provider.list as fallback.
    const [providersResponse, currentModelInfo, cascadeVariant] =
      await Promise.all([
        getClient().provider.list({ directory: projectDirectory }),
        getCurrentModelInfo({
          sessionId,
          channelId: targetChannelId,
          appId: effectiveAppId,
          getClient,
        }),
        getVariantCascade({
          sessionId,
          channelId: targetChannelId,
          appId: effectiveAppId,
        }),
      ])

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

    const currentModelText = (() => {
      switch (currentModelInfo.type) {
        case 'session':
          return `**Current (this thread):** \`${currentModelInfo.model}\``
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

    const variantText = (() => {
      if (currentModelInfo.type === 'none' || !cascadeVariant) {
        return ''
      }
      return `\n**Variant:** \`${cascadeVariant}\``
    })()

    // Store context with a short hash key to avoid customId length limits.
    const context = {
      dir: projectDirectory,
      channelId: targetChannelId,
      sessionId: sessionId,
      isThread: isThread,
      thread: isThread ? channel : undefined,
      appId,
    }
    const contextHash = crypto.randomBytes(8).toString('hex')
    setModelContext(contextHash, context)

    const options = [...availableProviders]
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 25)
      .map((provider) => {
        const modelCount = Object.keys(provider.models || {}).length
        return {
          label: provider.name.slice(0, 100),
          value: provider.id,
          description:
            `${modelCount} model${modelCount !== 1 ? 's' : ''} available`.slice(
              0,
              100,
            ),
        }
      })

    await interaction.editUiReply({
      markdown: `**Set Model Preference**\n${currentModelText}${variantText}\nSelect a provider:`,
      selectMenu: {
        id: `model_provider:${contextHash}`,
        placeholder: 'Select a provider',
        options,
      },
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
  interaction: SelectMenuEvent,
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
      directory: context.dir,
    })

    if (!providersResponse.data) {
      await interaction.editReply({
        content: 'Failed to fetch providers',
        components: [],
      })
      return
    }

    const provider = providersResponse.data.all.find(
      (p) => p.id === selectedProviderId,
    )

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
      .sort((a, b) => a.name.localeCompare(b.name))

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
    setModelContext(contextHash, context)

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

    await interaction.editUiReply({
      markdown: `**Set Model Preference**\nProvider: **${provider.name}**\nSelect a model:`,
      selectMenu: {
        id: `model_select:${contextHash}`,
        placeholder: 'Select a model',
        options,
      },
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
  interaction: SelectMenuEvent,
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
    context.selectedModelId = fullModelId
    setModelContext(contextHash, context)

    // Check if model has variants (thinking levels) - if so, show variant picker first
    const getClient = await initializeOpencodeForDirectory(context.dir)
    if (!(getClient instanceof Error)) {
      const providersResponse = await getClient().provider.list({
        directory: context.dir,
      })
      if (providersResponse.data) {
        const variants = getThinkingValuesForModel({
          providers: providersResponse.data.all,
          providerId: context.providerId!,
          modelId: selectedModelId,
        })
        if (variants.length > 0) {
          context.availableVariants = variants
          setModelContext(contextHash, context)

          const variantOptions = [
            {
              label: 'None (default)',
              value: '__none__',
              description: 'Use the model without a specific thinking level',
            },
            ...variants.slice(0, 24).map((v: string) => ({
              label: v.slice(0, 100),
              value: v,
              description: `Use ${v} thinking`.slice(0, 100),
            })),
          ]

          await interaction.editUiReply({
            markdown: `**Set Model Preference**\nModel: **${context.providerName}** / **${selectedModelId}**\n\`${fullModelId}\`\nSelect a thinking level:`,
            selectMenu: {
              id: `model_variant:${contextHash}`,
              placeholder: 'Select a thinking level',
              options: variantOptions,
            },
          })
          return
        }
      }
    }

    // No variants available - skip to scope
    context.selectedVariant = null
    setModelContext(contextHash, context)
    await showScopeMenu({ interaction, contextHash, context })
  } catch (error) {
    modelLogger.error('Error saving model preference:', error)
    await interaction.editReply({
      content: `Failed to save model preference: ${error instanceof Error ? error.message : 'Unknown error'}`,
      components: [],
    })
  }
}

/**
 * Handle the variant select menu interaction.
 * Stores the selected variant and shows the scope menu.
 */
export async function handleModelVariantSelectMenu(
  interaction: SelectMenuEvent,
): Promise<void> {
  const customId = interaction.customId
  if (!customId.startsWith('model_variant:')) {
    return
  }

  await interaction.deferUpdate()

  const contextHash = customId.replace('model_variant:', '')
  const context = pendingModelContexts.get(contextHash)

  if (!context || !context.selectedModelId) {
    await interaction.editReply({
      content: 'Selection expired. Please run /model again.',
      components: [],
    })
    return
  }

  const selectedValue = interaction.values[0]
  if (!selectedValue) {
    await interaction.editReply({
      content: 'No variant selected',
      components: [],
    })
    return
  }

  context.selectedVariant = selectedValue === '__none__' ? null : selectedValue
  setModelContext(contextHash, context)

  await showScopeMenu({ interaction, contextHash, context })
}

async function showScopeMenu({
  interaction,
  contextHash,
  context,
}: {
  interaction: SelectMenuEvent
  contextHash: string
  context: NonNullable<ReturnType<typeof pendingModelContexts.get>>
}): Promise<void> {
  const modelId = context.selectedModelId!
  const modelDisplay = modelId.split('/')[1] || modelId
  const variantSuffix = context.selectedVariant
    ? ` (${context.selectedVariant})`
    : ''

  const scopeOptions = [
    ...(context.isThread && context.sessionId
      ? [
          {
            label: 'This session only',
            value: 'session',
            description: 'Override for this session only',
          },
        ]
      : []),
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

  await interaction.editUiReply({
    markdown: `**Set Model Preference**\nModel: **${context.providerName}** / **${modelDisplay}**${variantSuffix}\n\`${modelId}\`\nApply to:`,
    selectMenu: {
      id: `model_scope:${contextHash}`,
      placeholder: 'Apply to...',
      options: scopeOptions,
    },
  })
}

/**
 * Handle the scope select menu interaction.
 * Applies the model to either the channel or globally.
 */
export async function handleModelScopeSelectMenu(
  interaction: SelectMenuEvent,
): Promise<void> {
  const customId = interaction.customId

  if (!customId.startsWith('model_scope:')) {
    return
  }

  // Defer update immediately
  await interaction.deferUpdate()

  const contextHash = customId.replace('model_scope:', '')
  const context = pendingModelContexts.get(contextHash)

  if (
    !context ||
    !context.providerId ||
    !context.providerName ||
    !context.selectedModelId
  ) {
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
  const variant = context.selectedVariant ?? null
  const variantSuffix = variant ? ` (${variant})` : ''
  const agentTip =
    '\n_Tip: create [agent .md files](https://github.com/remorses/kimaki/blob/main/docs/model-switching.md) in .opencode/agent/ for one-command model switching_'

  try {
    if (selectedScope === 'session') {
      if (!context.sessionId) {
        pendingModelContexts.delete(contextHash)
        await interaction.editReply({
          content:
            'No active session in this thread. Please run /model in a thread with a session.',
          components: [],
        })
        return
      }
      await setSessionModel({ sessionId: context.sessionId, modelId, variant })
      modelLogger.log(
        `Set model ${modelId}${variantSuffix} for session ${context.sessionId}`,
      )

      let retried = false
      if (context.thread) {
        const runtime = getRuntime(context.thread.id)
        if (runtime) {
          retried = await runtime.retryLastUserPrompt()
        }
      }

      const retryNote = retried
        ? '\n_Restarting current request with new model..._'
        : ''
      await interaction.editReply({
        content: `Model set for this session:\n**${context.providerName}** / **${modelDisplay}**${variantSuffix}\n\`${modelId}\`${retryNote}${agentTip}`,
        flags: PLATFORM_MESSAGE_FLAGS.SUPPRESS_EMBEDS,
        components: [],
      })
    } else if (selectedScope === 'global') {
      if (!context.appId) {
        pendingModelContexts.delete(contextHash)
        await interaction.editReply({
          content: 'Cannot set global model: channel is not linked to a bot',
          components: [],
        })
        return
      }
      await setGlobalModel({ appId: context.appId, modelId, variant })
      await setChannelModel({ channelId: context.channelId, modelId, variant })
      modelLogger.log(
        `Set global model ${modelId}${variantSuffix} for app ${context.appId} and channel ${context.channelId}`,
      )

      await interaction.editReply({
        content: `Model set for this channel and as global default:\n**${context.providerName}** / **${modelDisplay}**${variantSuffix}\n\`${modelId}\`\nAll channels will use this model (unless they have their own override).${agentTip}`,
        flags: PLATFORM_MESSAGE_FLAGS.SUPPRESS_EMBEDS,
        components: [],
      })
    } else {
      // channel scope
      await setChannelModel({ channelId: context.channelId, modelId, variant })
      modelLogger.log(
        `Set model ${modelId}${variantSuffix} for channel ${context.channelId}`,
      )

      await interaction.editReply({
        content: `Model preference set for this channel:\n**${context.providerName}** / **${modelDisplay}**${variantSuffix}\n\`${modelId}\`\nAll new sessions in this channel will use this model.${agentTip}`,
        flags: PLATFORM_MESSAGE_FLAGS.SUPPRESS_EMBEDS,
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
