// /login command - Authenticate with AI providers (OAuth or API key).
// Supports GitHub Copilot (device flow), OpenAI Codex (device flow), and API keys.

import {
  ChannelType,
  type ThreadChannel,
  type TextChannel,
  MessageFlags,
} from 'discord.js'
import crypto from 'node:crypto'
import { initializeOpencodeForDirectory } from '../opencode.js'
import { resolveTextChannel, getKimakiMetadata } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import type {
  CommandEvent,
  ModalSubmitEvent,
  SelectMenuEvent,
  UiModal,
} from '../platform/types.js'

const loginLogger = createLogger(LogPrefix.LOGIN)

// Store context by hash to avoid customId length limits (Discord max: 100 chars).
// TTL'd to prevent unbounded growth when users open /login and never interact.
const LOGIN_CONTEXT_TTL_MS = 10 * 60 * 1000
const pendingLoginContexts = new Map<
  string,
  {
    dir: string
    channelId: string
    providerId?: string
    providerName?: string
    methodIndex?: number
    methodType?: 'oauth' | 'api'
    methodLabel?: string
  }
>()

// Popularity-ordered provider IDs for the select menu.
// Discord select menus cap at 25 options, so we show these first,
// then fill remaining slots with unlisted providers alphabetically.
// IDs sourced from opencode's provider.list() API (scripts/list-providers.ts).
const PROVIDER_POPULARITY_ORDER: string[] = [
  'anthropic',
  'openai',
  'google',
  'github-copilot',
  'xai',
  'groq',
  'deepseek',
  'mistral',
  'openrouter',
  'fireworks-ai',
  'togetherai',
  'amazon-bedrock',
  'azure',
  'google-vertex',
  'google-vertex-anthropic',
  'cohere',
  'cerebras',
  'perplexity',
  'cloudflare-workers-ai',
  'novita-ai',
  'huggingface',
  'deepinfra',
  'github-models',
  'lmstudio',
  'llama',
]

export type ProviderAuthMethod = {
  type: 'oauth' | 'api'
  label: string
}

/**
 * Handle the /login slash command.
 * Shows a select menu with available providers.
 */
export async function handleLoginCommand({
  interaction,
}: {
  interaction: CommandEvent
  appId: string
}): Promise<void> {
  loginLogger.log('[LOGIN] handleLoginCommand called')

  // Defer reply immediately to avoid 3-second timeout
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })
  loginLogger.log('[LOGIN] Deferred reply')

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
  let targetChannelId: string

  if (isThread) {
    const thread = channel as ThreadChannel
    const textChannel = await resolveTextChannel(thread)
    const metadata = await getKimakiMetadata(textChannel)
    projectDirectory = metadata.projectDirectory
    targetChannelId = textChannel?.id || channel.id
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

  try {
    const getClient = await initializeOpencodeForDirectory(projectDirectory)
    if (getClient instanceof Error) {
      await interaction.editReply({ content: getClient.message })
      return
    }

    const providersResponse = await getClient().provider.list({
      directory: projectDirectory,
    })

    if (!providersResponse.data) {
      await interaction.editReply({
        content: 'Failed to fetch providers',
      })
      return
    }

    const { all: allProviders, connected } = providersResponse.data

    if (allProviders.length === 0) {
      await interaction.editReply({
        content: 'No providers available.',
      })
      return
    }

    // Sort by hardcoded popularity order, then alphabetically for unlisted ones.
    // Discord select menus cap at 25, so we show the most popular providers.
    const options = [...allProviders]
      .sort((a, b) => {
        const rankA = PROVIDER_POPULARITY_ORDER.indexOf(a.id)
        const rankB = PROVIDER_POPULARITY_ORDER.indexOf(b.id)
        const posA = rankA === -1 ? Infinity : rankA
        const posB = rankB === -1 ? Infinity : rankB
        if (posA !== posB) {
          return posA - posB
        }
        return a.name.localeCompare(b.name)
      })
      .slice(0, 25)
      .map((provider) => {
        const isConnected = connected.includes(provider.id)
        return {
          label: `${provider.name}${isConnected ? ' ✓' : ''}`.slice(
            0,
            100,
          ),
          value: provider.id,
          description: isConnected
            ? 'Connected - select to re-authenticate'
            : 'Not connected',
        }
      })

    // Store context with a short hash key to avoid customId length limits
    const context = {
      dir: projectDirectory,
      channelId: targetChannelId,
    }
    const contextHash = crypto.randomBytes(8).toString('hex')
    pendingLoginContexts.set(contextHash, context)
    setTimeout(() => {
      pendingLoginContexts.delete(contextHash)
    }, LOGIN_CONTEXT_TTL_MS).unref()

    await interaction.editUiReply({
      markdown: '**Authenticate with Provider**\nSelect a provider:',
      selectMenu: {
        id: `login_provider:${contextHash}`,
        placeholder: 'Select a provider to authenticate',
        options,
      },
    })
  } catch (error) {
    loginLogger.error('Error loading providers:', error)
    await interaction.editReply({
      content: `Failed to load providers: ${error instanceof Error ? error.message : 'Unknown error'}`,
    })
  }
}

/**
 * Handle the provider select menu interaction.
 * Shows a second select menu with auth methods for the chosen provider.
 */
export async function handleLoginProviderSelectMenu(
  interaction: SelectMenuEvent,
): Promise<void> {
  const customId = interaction.customId

  if (!customId.startsWith('login_provider:')) {
    return
  }

  const contextHash = customId.replace('login_provider:', '')
  const context = pendingLoginContexts.get(contextHash)

  if (!context) {
    await interaction.deferUpdate()
    await interaction.editReply({
      content: 'Selection expired. Please run /login again.',
      components: [],
    })
    return
  }

  const selectedProviderId = interaction.values[0]
  if (!selectedProviderId) {
    await interaction.deferUpdate()
    await interaction.editReply({
      content: 'No provider selected',
      components: [],
    })
    return
  }

  try {
    const getClient = await initializeOpencodeForDirectory(context.dir)
    if (getClient instanceof Error) {
      await interaction.deferUpdate()
      await interaction.editReply({
        content: getClient.message,
        components: [],
      })
      return
    }

    // Get provider info for display
    const providersResponse = await getClient().provider.list({
      directory: context.dir,
    })

    const provider = providersResponse.data?.all.find(
      (p) => p.id === selectedProviderId,
    )
    const providerName = provider?.name || selectedProviderId

    // Get auth methods for all providers
    const authMethodsResponse = await getClient().provider.auth({
      directory: context.dir,
    })

    if (!authMethodsResponse.data) {
      await interaction.deferUpdate()
      await interaction.editReply({
        content: 'Failed to fetch authentication methods',
        components: [],
      })
      return
    }

    // Get methods for this specific provider, default to API key if none defined
    const methods: ProviderAuthMethod[] = authMethodsResponse.data[
      selectedProviderId
    ] || [{ type: 'api', label: 'API Key' }]

    if (methods.length === 0) {
      await interaction.deferUpdate()
      await interaction.editReply({
        content: `No authentication methods available for ${providerName}`,
        components: [],
      })
      return
    }

    // Update context with provider info
    context.providerId = selectedProviderId
    context.providerName = providerName
    pendingLoginContexts.set(contextHash, context)

    // If only one method and it's API, show modal directly (no defer)
    if (methods.length === 1 && methods[0]!.type === 'api') {
      const method = methods[0]!
      context.methodIndex = 0
      context.methodType = method.type
      context.methodLabel = method.label
      pendingLoginContexts.set(contextHash, context)
      await showApiKeyModal(interaction, contextHash, providerName)
      return
    }

    // For OAuth or multiple methods, defer and continue
    await interaction.deferUpdate()

    // If only one method and it's OAuth, start flow directly
    if (methods.length === 1) {
      const method = methods[0]!
      context.methodIndex = 0
      context.methodType = method.type
      context.methodLabel = method.label
      pendingLoginContexts.set(contextHash, context)
      await startOAuthFlow(interaction, context, contextHash)
      return
    }

    // Multiple methods - show selection menu
    const options = methods.slice(0, 25).map((method, index) => ({
      label: method.label.slice(0, 100),
      value: String(index),
      description:
        method.type === 'oauth'
          ? 'OAuth authentication'
          : 'Enter API key manually',
    }))

    await interaction.editUiReply({
      markdown: `**Authenticate with ${providerName}**\nSelect authentication method:`,
      selectMenu: {
        id: `login_method:${contextHash}`,
        placeholder: 'Select authentication method',
        options,
      },
    })
  } catch (error) {
    loginLogger.error('Error loading auth methods:', error)
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate()
    }
    await interaction.editReply({
      content: `Failed to load auth methods: ${error instanceof Error ? error.message : 'Unknown error'}`,
      components: [],
    })
  }
}

/**
 * Handle the auth method select menu interaction.
 * Starts OAuth flow or shows API key modal.
 */
export async function handleLoginMethodSelectMenu(
  interaction: SelectMenuEvent,
): Promise<void> {
  const customId = interaction.customId

  if (!customId.startsWith('login_method:')) {
    return
  }

  const contextHash = customId.replace('login_method:', '')
  const context = pendingLoginContexts.get(contextHash)

  if (!context || !context.providerId || !context.providerName) {
    await interaction.deferUpdate()
    await interaction.editReply({
      content: 'Selection expired. Please run /login again.',
      components: [],
    })
    return
  }

  const selectedMethodIndex = parseInt(interaction.values[0] || '0', 10)

  try {
    const getClient = await initializeOpencodeForDirectory(context.dir)
    if (getClient instanceof Error) {
      await interaction.deferUpdate()
      await interaction.editReply({
        content: getClient.message,
        components: [],
      })
      return
    }

    // Get auth methods again to get the selected one
    const authMethodsResponse = await getClient().provider.auth({
      directory: context.dir,
    })

    const methods: ProviderAuthMethod[] = authMethodsResponse.data?.[
      context.providerId
    ] || [{ type: 'api', label: 'API Key' }]

    const selectedMethod = methods[selectedMethodIndex]
    if (!selectedMethod) {
      await interaction.deferUpdate()
      await interaction.editReply({
        content: 'Invalid method selected',
        components: [],
      })
      return
    }

    // Update context
    context.methodIndex = selectedMethodIndex
    context.methodType = selectedMethod.type
    context.methodLabel = selectedMethod.label
    pendingLoginContexts.set(contextHash, context)

    if (selectedMethod.type === 'api') {
      // Show API key modal (don't defer for modals)
      await showApiKeyModal(interaction, contextHash, context.providerName)
    } else {
      // Start OAuth flow
      await interaction.deferUpdate()
      await startOAuthFlow(interaction, context, contextHash)
    }
  } catch (error) {
    loginLogger.error('Error processing auth method:', error)
    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate()
      }
      await interaction.editReply({
        content: `Failed to process auth method: ${error instanceof Error ? error.message : 'Unknown error'}`,
        components: [],
      })
    } catch {
      // Ignore follow-up errors
    }
  }
}

/**
 * Show API key input modal.
 */
async function showApiKeyModal(
  interaction: SelectMenuEvent,
  contextHash: string,
  providerName: string,
): Promise<void> {
  const modal: UiModal = {
    id: `login_apikey:${contextHash}`,
    title: `${providerName} API Key`.slice(0, 45),
    inputs: [
      {
        type: 'text',
        id: 'apikey',
        label: 'API Key',
        placeholder: 'sk-...',
        style: 'short',
        required: true,
      },
    ],
  }

  await interaction.showModal(modal)
}

/**
 * Start OAuth authorization flow.
 */
async function startOAuthFlow(
  interaction: SelectMenuEvent,
  context: {
    dir: string
    providerId?: string
    providerName?: string
    methodIndex?: number
    methodLabel?: string
  },
  contextHash: string,
): Promise<void> {
  if (!context.providerId || context.methodIndex === undefined) {
    await interaction.editReply({
      content: 'Invalid context for OAuth flow',
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

    await interaction.editReply({
      content: `**Authenticating with ${context.providerName}**\nStarting authorization...`,
      components: [],
    })

    // Start OAuth authorization
    const authorizeResponse = await getClient().provider.oauth.authorize({
      providerID: context.providerId,
      method: context.methodIndex,
      directory: context.dir,
    })

    if (!authorizeResponse.data) {
      const errorData = authorizeResponse.error as
        | { data?: { message?: string } }
        | undefined
      await interaction.editReply({
        content: `Failed to start authorization: ${errorData?.data?.message || 'Unknown error'}`,
        components: [],
      })
      return
    }

    const { url, method, instructions } = authorizeResponse.data

    // Show authorization URL and instructions
    let message = `**Authenticating with ${context.providerName}**\n\n`
    message += `Open this URL to authorize:\n${url}\n\n`

    if (instructions) {
      // Extract code from instructions like "Enter code: ABC-123"
      const codeMatch = instructions.match(/code[:\s]+([A-Z0-9-]+)/i)
      if (codeMatch) {
        message += `**Code:** \`${codeMatch[1]}\`\n\n`
      } else {
        message += `${instructions}\n\n`
      }
    }

    if (method === 'auto') {
      message += '_Waiting for authorization to complete..._'
    }

    await interaction.editReply({
      content: message,
      components: [],
    })

    if (method === 'auto') {
      // Poll for completion (device flow)
      const callbackResponse = await getClient().provider.oauth.callback({
        providerID: context.providerId,
        method: context.methodIndex,
        directory: context.dir,
      })

      if (callbackResponse.error) {
        const errorData = callbackResponse.error as
          | { data?: { message?: string } }
          | undefined
        await interaction.editReply({
          content: `**Authentication Failed**\n${errorData?.data?.message || 'Authorization was not completed'}`,
          components: [],
        })
        return
      }

      // Dispose to refresh provider state so new credentials are recognized
      await getClient().instance.dispose({ directory: context.dir })

      await interaction.editReply({
        content: `✅ **Successfully authenticated with ${context.providerName}!**\n\nYou can now use models from this provider.`,
        components: [],
      })
    }
    // For 'code' method, we would need to prompt for code input
    // But Discord modals can't be shown after deferUpdate, so we'd need a different flow
    // For now, most providers use 'auto' (device flow) which works well for Discord

    // Clean up context
    pendingLoginContexts.delete(contextHash)
  } catch (error) {
    loginLogger.error('OAuth flow error:', error)
    await interaction.editReply({
      content: `**Authentication Failed**\n${error instanceof Error ? error.message : 'Unknown error'}`,
      components: [],
    })
  }
}

/**
 * Handle API key modal submission.
 */
export async function handleApiKeyModalSubmit(
  interaction: ModalSubmitEvent,
): Promise<void> {
  const customId = interaction.customId

  if (!customId.startsWith('login_apikey:')) {
    return
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const contextHash = customId.replace('login_apikey:', '')
  const context = pendingLoginContexts.get(contextHash)

  if (!context || !context.providerId || !context.providerName) {
    await interaction.editReply({
      content: 'Session expired. Please run /login again.',
    })
    return
  }

  const apiKey = interaction.fields.getTextInputValue('apikey')

  if (!apiKey?.trim()) {
    await interaction.editReply({
      content: 'API key is required.',
    })
    return
  }

  try {
    const getClient = await initializeOpencodeForDirectory(context.dir)
    if (getClient instanceof Error) {
      await interaction.editReply({
        content: getClient.message,
      })
      return
    }

    // Set the API key
    await getClient().auth.set({
      providerID: context.providerId,
      auth: {
        type: 'api',
        key: apiKey.trim(),
      },
    })

    // Dispose to refresh provider state so new credentials are recognized
    await getClient().instance.dispose({ directory: context.dir })

    await interaction.editReply({
      content: `✅ **Successfully authenticated with ${context.providerName}!**\n\nYou can now use models from this provider.`,
    })

    // Clean up context
    pendingLoginContexts.delete(contextHash)
  } catch (error) {
    loginLogger.error('API key save error:', error)
    await interaction.editReply({
      content: `**Failed to save API key**\n${error instanceof Error ? error.message : 'Unknown error'}`,
    })
  }
}
