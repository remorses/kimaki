// /login command — authenticate with AI providers (OAuth or API key).
//
// Uses a unified select handler (`login_select:<hash>`) for all sequential
// select menus (provider → method → plugin prompts). The context tracks a
// `step` field so one handler drives the whole flow.
//
// CustomId patterns:
//   login_select:<hash>  — all select menus (provider, method, prompts)
//   login_apikey:<hash>  — API key modal submission
//   login_text:<hash>    — text prompt modal submission

import {
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ModalSubmitInteraction,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  ChannelType,
  type ThreadChannel,
  type TextChannel,
  MessageFlags,
} from 'discord.js'
import type { AuthHook } from '@opencode-ai/plugin'
import crypto from 'node:crypto'
import {
  initializeOpencodeForDirectory,
  getOpencodeServerPort,
} from '../opencode.js'
import { resolveTextChannel, getKimakiMetadata } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'

const loginLogger = createLogger(LogPrefix.LOGIN)

// ── Types ───────────────────────────────────────────────────────
// Derive prompt types from the plugin package so they stay in sync.
// Strip runtime-only callback fields (validate, condition) that
// aren't present in the REST response from the opencode server.
// Add `when` rule — the server's zod schema includes it but the
// published plugin package hasn't been updated yet.

type WhenRule = { key: string; op: 'eq' | 'neq'; value: string }

// Extract prompt option type from the plugin's select prompt
type PluginMethod = AuthHook['methods'][number]
type PluginSelectPrompt = Extract<
  NonNullable<PluginMethod['prompts']>[number],
  { type: 'select' }
>
type PromptOption = PluginSelectPrompt['options'][number]

type AuthPromptText = {
  type: 'text'
  key: string
  message: string
  placeholder?: string
  when?: WhenRule
}

type AuthPromptSelect = {
  type: 'select'
  key: string
  message: string
  options: PromptOption[]
  when?: WhenRule
}

type AuthPrompt = AuthPromptText | AuthPromptSelect

type ProviderAuthMethod = {
  type: 'oauth' | 'api'
  label: string
  prompts?: AuthPrompt[]
}

// ── Login step state machine ────────────────────────────────────
// Each step describes what the next select menu should show.
// Steps are built lazily: provider step is set by /login, method
// and prompt steps are added after the provider is selected.

type StepProvider = { type: 'provider' }
type StepMethod = { type: 'method'; methods: ProviderAuthMethod[] }
type StepPrompt = { type: 'prompt'; prompt: AuthPrompt }
type LoginStep = StepProvider | StepMethod | StepPrompt

type LoginContext = {
  dir: string
  channelId: string
  providerId?: string
  providerName?: string
  methodIndex?: number
  methodType?: 'oauth' | 'api'
  steps: LoginStep[]
  stepIndex: number
  inputs: Record<string, string>
}

// ── Context store ───────────────────────────────────────────────
// Keyed by random hash to stay under Discord's 100-char customId limit.
// TTL prevents unbounded growth when users open /login and never interact.

const LOGIN_CONTEXT_TTL_MS = 10 * 60 * 1000
const pendingLoginContexts = new Map<string, LoginContext>()

function createContextHash(context: LoginContext): string {
  const hash = crypto.randomBytes(8).toString('hex')
  pendingLoginContexts.set(hash, context)
  setTimeout(() => {
    pendingLoginContexts.delete(hash)
  }, LOGIN_CONTEXT_TTL_MS).unref()
  return hash
}

// ── Provider popularity order ───────────────────────────────────
// Discord select menus cap at 25 options, so we show popular ones first.
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

// ── Helpers ─────────────────────────────────────────────────────

function extractErrorMessage({
  error,
  fallback,
}: {
  error: unknown
  fallback: string
}): string {
  if (!error || typeof error !== 'object') {
    return fallback
  }
  const parsed = error as { message?: string; data?: { message?: string } }
  return parsed.data?.message || parsed.message || fallback
}

function shouldShowPrompt(
  prompt: AuthPrompt,
  inputs: Record<string, string>,
): boolean {
  if (!prompt.when) {
    return true
  }
  const value = inputs[prompt.when.key]
  if (prompt.when.op === 'eq') {
    return value === prompt.when.value
  }
  if (prompt.when.op === 'neq') {
    return value !== prompt.when.value
  }
  return true
}

function buildSelectMenu({
  customId,
  placeholder,
  options,
}: {
  customId: string
  placeholder: string
  options: Array<{ label: string; value: string; description?: string }>
}): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .addOptions(options)
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)
}

// ── /login command ──────────────────────────────────────────────

export async function handleLoginCommand({
  interaction,
}: {
  interaction: ChatInputCommandInteraction
  appId: string
}): Promise<void> {
  loginLogger.log('[LOGIN] handleLoginCommand called')

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
      await interaction.editReply({ content: 'Failed to fetch providers' })
      return
    }

    const { all: allProviders, connected } = providersResponse.data

    if (allProviders.length === 0) {
      await interaction.editReply({ content: 'No providers available.' })
      return
    }

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
          label: `${provider.name}${isConnected ? ' ✓' : ''}`.slice(0, 100),
          value: provider.id,
          description: isConnected
            ? 'Connected - select to re-authenticate'
            : 'Not connected',
        }
      })

    const context: LoginContext = {
      dir: projectDirectory,
      channelId: targetChannelId,
      steps: [{ type: 'provider' }],
      stepIndex: 0,
      inputs: {},
    }
    const hash = createContextHash(context)

    await interaction.editReply({
      content: '**Authenticate with Provider**\nSelect a provider:',
      components: [
        buildSelectMenu({
          customId: `login_select:${hash}`,
          placeholder: 'Select a provider to authenticate',
          options,
        }),
      ],
    })
  } catch (error) {
    loginLogger.error('Error loading providers:', error)
    await interaction.editReply({
      content: `Failed to load providers: ${error instanceof Error ? error.message : 'Unknown error'}`,
    })
  }
}

// ── Unified select handler ──────────────────────────────────────
// Handles all select menu interactions for the login flow.
// Reads the current step from context, processes the answer,
// then either shows the next step or proceeds to authorize/API key.

export async function handleLoginSelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  if (!interaction.customId.startsWith('login_select:')) {
    return
  }

  const hash = interaction.customId.replace('login_select:', '')
  const ctx = pendingLoginContexts.get(hash)

  if (!ctx) {
    await interaction.deferUpdate()
    await interaction.editReply({
      content: 'Selection expired. Please run /login again.',
      components: [],
    })
    return
  }

  const value = interaction.values[0]
  if (!value) {
    await interaction.deferUpdate()
    await interaction.editReply({
      content: 'No option selected.',
      components: [],
    })
    return
  }

  const step = ctx.steps[ctx.stepIndex]
  if (!step) {
    await interaction.deferUpdate()
    await interaction.editReply({
      content: 'Invalid state. Please run /login again.',
      components: [],
    })
    return
  }

  try {
    if (step.type === 'provider') {
      await handleProviderStep(interaction, ctx, hash, value)
    } else if (step.type === 'method') {
      await handleMethodStep(interaction, ctx, hash, value, step)
    } else if (step.type === 'prompt') {
      await handlePromptStep(interaction, ctx, hash, value, step)
    }
  } catch (error) {
    loginLogger.error('Error in login select:', error)
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate()
    }
    await interaction.editReply({
      content: `Login error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      components: [],
    })
  }
}

// ── Step handlers ───────────────────────────────────────────────

async function handleProviderStep(
  interaction: StringSelectMenuInteraction,
  ctx: LoginContext,
  hash: string,
  providerId: string,
): Promise<void> {
  const getClient = await initializeOpencodeForDirectory(ctx.dir)
  if (getClient instanceof Error) {
    await interaction.deferUpdate()
    await interaction.editReply({ content: getClient.message, components: [] })
    return
  }

  const providersResponse = await getClient().provider.list({
    directory: ctx.dir,
  })
  const provider = providersResponse.data?.all.find(
    (p) => p.id === providerId,
  )
  const providerName = provider?.name || providerId

  const authResponse = await getClient().provider.auth({ directory: ctx.dir })
  if (!authResponse.data) {
    await interaction.deferUpdate()
    await interaction.editReply({
      content: 'Failed to fetch authentication methods',
      components: [],
    })
    return
  }

  const methods: ProviderAuthMethod[] = authResponse.data[providerId] || [
    { type: 'api', label: 'API Key' },
  ]

  if (methods.length === 0) {
    await interaction.deferUpdate()
    await interaction.editReply({
      content: `No authentication methods available for ${providerName}`,
      components: [],
    })
    return
  }

  ctx.providerId = providerId
  ctx.providerName = providerName

  if (methods.length === 1) {
    // Single method — skip method select, go straight to prompts or action
    const method = methods[0]!
    ctx.methodIndex = 0
    ctx.methodType = method.type

    const promptSteps = buildPromptSteps(method)
    if (promptSteps.length > 0) {
      // Has prompts — defer and show first prompt
      ctx.steps = promptSteps
      ctx.stepIndex = 0
      await interaction.deferUpdate()
      await showNextStep(interaction, ctx, hash)
    } else if (method.type === 'api') {
      // API key with no prompts — show modal directly (don't defer)
      await showApiKeyModal(interaction, hash, providerName)
    } else {
      // OAuth with no prompts — defer and authorize
      await interaction.deferUpdate()
      await startOAuthFlow(interaction, ctx, hash)
    }
    return
  }

  // Multiple methods — show method select
  ctx.steps = [
    { type: 'method', methods },
  ]
  ctx.stepIndex = 0
  await interaction.deferUpdate()
  await showNextStep(interaction, ctx, hash)
}

async function handleMethodStep(
  interaction: StringSelectMenuInteraction,
  ctx: LoginContext,
  hash: string,
  value: string,
  step: StepMethod,
): Promise<void> {
  const methodIndex = parseInt(value, 10)
  const method = step.methods[methodIndex]
  if (!method) {
    await interaction.deferUpdate()
    await interaction.editReply({
      content: 'Invalid method selected.',
      components: [],
    })
    return
  }

  ctx.methodIndex = methodIndex
  ctx.methodType = method.type

  const promptSteps = buildPromptSteps(method)
  if (promptSteps.length > 0) {
    // Replace remaining steps with prompt steps
    ctx.steps = promptSteps
    ctx.stepIndex = 0
    await interaction.deferUpdate()
    await showNextStep(interaction, ctx, hash)
  } else if (method.type === 'api') {
    // API key with no prompts — show modal directly (don't defer)
    await showApiKeyModal(interaction, hash, ctx.providerName || '')
  } else {
    // OAuth with no prompts
    await interaction.deferUpdate()
    await startOAuthFlow(interaction, ctx, hash)
  }
}

async function handlePromptStep(
  interaction: StringSelectMenuInteraction,
  ctx: LoginContext,
  hash: string,
  value: string,
  step: StepPrompt,
): Promise<void> {
  // Store the answer
  ctx.inputs[step.prompt.key] = value
  ctx.stepIndex++

  // Find the next prompt step that passes its `when` condition
  await interaction.deferUpdate()
  await showNextStep(interaction, ctx, hash)
}

// ── Step rendering ──────────────────────────────────────────────
// Advances through steps, skipping prompts whose `when` condition
// fails, until it finds one to show or reaches the end.

async function showNextStep(
  interaction: StringSelectMenuInteraction | ModalSubmitInteraction,
  ctx: LoginContext,
  hash: string,
): Promise<void> {
  // Skip prompts whose `when` condition doesn't match
  while (ctx.stepIndex < ctx.steps.length) {
    const step = ctx.steps[ctx.stepIndex]!
    if (step.type === 'prompt' && !shouldShowPrompt(step.prompt, ctx.inputs)) {
      ctx.stepIndex++
      continue
    }
    break
  }

  if (ctx.stepIndex >= ctx.steps.length) {
    // All steps done — proceed to action
    if (ctx.methodType === 'api') {
      // We're deferred, so show a button that opens the API key modal
      const button = new ButtonBuilder()
        .setCustomId(`login_apikey_btn:${hash}`)
        .setLabel('Enter API Key')
        .setStyle(ButtonStyle.Primary)
      await interaction.editReply({
        content: `**Authenticate with ${ctx.providerName}**\nClick to enter your API key.`,
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(button),
        ],
      })
    } else {
      await startOAuthFlow(interaction, ctx, hash)
    }
    return
  }

  const step = ctx.steps[ctx.stepIndex]!
  pendingLoginContexts.set(hash, ctx)

  if (step.type === 'method') {
    const options = step.methods.slice(0, 25).map((method, index) => ({
      label: method.label.slice(0, 100),
      value: String(index),
      description:
        method.type === 'oauth'
          ? 'OAuth authentication'
          : 'Enter API key manually',
    }))

    await interaction.editReply({
      content: `**Authenticate with ${ctx.providerName}**\nSelect authentication method:`,
      components: [
        buildSelectMenu({
          customId: `login_select:${hash}`,
          placeholder: 'Select authentication method',
          options,
        }),
      ],
    })
    return
  }

  if (step.type === 'prompt') {
    const prompt = step.prompt
    if (prompt.type === 'select') {
      const options = prompt.options.slice(0, 25).map((opt) => ({
        label: opt.label.slice(0, 100),
        value: opt.value,
        description: opt.hint?.slice(0, 100),
      }))

      await interaction.editReply({
        content: `**Authenticate with ${ctx.providerName}**\n${prompt.message}`,
        components: [
          buildSelectMenu({
            customId: `login_select:${hash}`,
            placeholder: prompt.message.slice(0, 150),
            options,
          }),
        ],
      })
      return
    }

    if (prompt.type === 'text') {
      // Text prompts need a modal, but we're deferred. Show a button.
      const button = new ButtonBuilder()
        .setCustomId(`login_text_btn:${hash}`)
        .setLabel(prompt.message.slice(0, 80))
        .setStyle(ButtonStyle.Primary)

      await interaction.editReply({
        content: `**Authenticate with ${ctx.providerName}**\n${prompt.message}`,
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(button),
        ],
      })
      return
    }
  }
}

function buildPromptSteps(method: ProviderAuthMethod): StepPrompt[] {
  return (method.prompts || []).map((prompt) => ({
    type: 'prompt' as const,
    prompt,
  }))
}

// ── Text prompt button + modal ──────────────────────────────────
// When a text prompt needs to be shown but we're in a deferred state,
// we show a button. Clicking it opens a modal for text input.

export async function handleLoginTextButton(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!interaction.customId.startsWith('login_text_btn:')) {
    return
  }

  const hash = interaction.customId.replace('login_text_btn:', '')
  const ctx = pendingLoginContexts.get(hash)

  if (!ctx) {
    await interaction.reply({
      content: 'Selection expired. Please run /login again.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const step = ctx.steps[ctx.stepIndex]
  if (!step || step.type !== 'prompt' || step.prompt.type !== 'text') {
    await interaction.reply({
      content: 'Invalid state. Please run /login again.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const modal = new ModalBuilder()
    .setCustomId(`login_text:${hash}`)
    .setTitle(`${ctx.providerName || 'Provider'} Login`.slice(0, 45))

  const textInput = new TextInputBuilder()
    .setCustomId('prompt_value')
    .setLabel(step.prompt.message.slice(0, 45))
    .setPlaceholder(
      step.prompt.type === 'text' ? (step.prompt.placeholder || '') : '',
    )
    .setStyle(TextInputStyle.Short)
    .setRequired(true)

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(textInput),
  )
  await interaction.showModal(modal)
}

export async function handleLoginTextModalSubmit(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  if (!interaction.customId.startsWith('login_text:')) {
    return
  }

  await interaction.deferUpdate()

  const hash = interaction.customId.replace('login_text:', '')
  const ctx = pendingLoginContexts.get(hash)

  if (!ctx) {
    await interaction.editReply({
      content: 'Selection expired. Please run /login again.',
      components: [],
    })
    return
  }

  const step = ctx.steps[ctx.stepIndex]
  if (!step || step.type !== 'prompt' || step.prompt.type !== 'text') {
    await interaction.editReply({
      content: 'Invalid state. Please run /login again.',
      components: [],
    })
    return
  }

  const value = interaction.fields.getTextInputValue('prompt_value')
  if (!value?.trim()) {
    await interaction.editReply({
      content: 'A value is required.',
      components: [],
    })
    return
  }

  ctx.inputs[step.prompt.key] = value.trim()
  ctx.stepIndex++
  await showNextStep(interaction, ctx, hash)
}

// ── API key button + modal ──────────────────────────────────────
// When we're deferred and need an API key modal, show a button first.

export async function handleLoginApiKeyButton(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!interaction.customId.startsWith('login_apikey_btn:')) {
    return
  }

  const hash = interaction.customId.replace('login_apikey_btn:', '')
  const ctx = pendingLoginContexts.get(hash)

  if (!ctx || !ctx.providerName) {
    await interaction.reply({
      content: 'Selection expired. Please run /login again.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  await showApiKeyModal(interaction, hash, ctx.providerName)
}

async function showApiKeyModal(
  interaction: StringSelectMenuInteraction | ButtonInteraction,
  hash: string,
  providerName: string,
): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(`login_apikey:${hash}`)
    .setTitle(`${providerName} API Key`.slice(0, 45))

  const apiKeyInput = new TextInputBuilder()
    .setCustomId('apikey')
    .setLabel('API Key')
    .setPlaceholder('sk-...')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(apiKeyInput),
  )
  await interaction.showModal(modal)
}

// ── OAuth code submission (code mode) ───────────────────────────
// When the OAuth flow returns method="code", the user completes login
// in a browser (possibly on a different machine) and pastes the final
// callback URL or authorization code here.

export async function handleOAuthCodeButton(
  interaction: ButtonInteraction,
): Promise<void> {
  if (!interaction.customId.startsWith('login_oauth_code_btn:')) {
    return
  }

  const hash = interaction.customId.replace('login_oauth_code_btn:', '')
  const ctx = pendingLoginContexts.get(hash)

  if (!ctx || !ctx.providerId || !ctx.providerName) {
    await interaction.reply({
      content: 'Selection expired. Please run /login again.',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const modal = new ModalBuilder()
    .setCustomId(`login_oauth_code:${hash}`)
    .setTitle(`${ctx.providerName} Authorization`.slice(0, 45))

  const codeInput = new TextInputBuilder()
    .setCustomId('oauth_code')
    .setLabel('Authorization code or callback URL')
    .setPlaceholder('Paste the code or full callback URL')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(codeInput),
  )
  await interaction.showModal(modal)
}

export async function handleOAuthCodeModalSubmit(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  if (!interaction.customId.startsWith('login_oauth_code:')) {
    return
  }

  await interaction.deferUpdate()

  const hash = interaction.customId.replace('login_oauth_code:', '')
  const ctx = pendingLoginContexts.get(hash)

  if (!ctx || !ctx.providerId || !ctx.providerName || ctx.methodIndex === undefined) {
    await interaction.editReply({
      content: 'Session expired. Please run /login again.',
      components: [],
    })
    return
  }

  const code = interaction.fields.getTextInputValue('oauth_code')?.trim()
  if (!code) {
    await interaction.editReply({
      content: 'Authorization code is required.',
      components: [],
    })
    return
  }

  try {
    const getClient = await initializeOpencodeForDirectory(ctx.dir)
    if (getClient instanceof Error) {
      await interaction.editReply({
        content: getClient.message,
        components: [],
      })
      return
    }

    await interaction.editReply({
      content: `**Authenticating with ${ctx.providerName}**\nVerifying authorization...`,
      components: [],
    })

    const callbackResponse = await getClient().provider.oauth.callback({
      providerID: ctx.providerId,
      method: ctx.methodIndex,
      code,
      directory: ctx.dir,
    })

    if (callbackResponse.error) {
      pendingLoginContexts.delete(hash)
      await interaction.editReply({
        content: `**Authentication Failed**\n${extractErrorMessage({ error: callbackResponse.error, fallback: 'Authorization code was invalid or expired' })}`,
        components: [],
      })
      return
    }

    await getClient().instance.dispose({ directory: ctx.dir })
    pendingLoginContexts.delete(hash)

    await interaction.editReply({
      content: `✅ **Successfully authenticated with ${ctx.providerName}!**\n\nYou can now use models from this provider.`,
      components: [],
    })
  } catch (error) {
    loginLogger.error('OAuth code submission error:', error)
    pendingLoginContexts.delete(hash)
    await interaction.editReply({
      content: `**Authentication Failed**\n${error instanceof Error ? error.message : 'Unknown error'}`,
      components: [],
    })
  }
}

export async function handleApiKeyModalSubmit(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  if (!interaction.customId.startsWith('login_apikey:')) {
    return
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const hash = interaction.customId.replace('login_apikey:', '')
  const ctx = pendingLoginContexts.get(hash)

  if (!ctx || !ctx.providerId || !ctx.providerName) {
    await interaction.editReply({
      content: 'Session expired. Please run /login again.',
    })
    return
  }

  const apiKey = interaction.fields.getTextInputValue('apikey')

  if (!apiKey?.trim()) {
    await interaction.editReply({ content: 'API key is required.' })
    return
  }

  try {
    const getClient = await initializeOpencodeForDirectory(ctx.dir)
    if (getClient instanceof Error) {
      await interaction.editReply({ content: getClient.message })
      return
    }

    await getClient().auth.set({
      providerID: ctx.providerId,
      auth: { type: 'api', key: apiKey.trim() },
    })

    // Dispose to refresh provider state so new credentials are recognized
    await getClient().instance.dispose({ directory: ctx.dir })

    await interaction.editReply({
      content: `✅ **Successfully authenticated with ${ctx.providerName}!**\n\nYou can now use models from this provider.`,
    })

    pendingLoginContexts.delete(hash)
  } catch (error) {
    loginLogger.error('API key save error:', error)
    await interaction.editReply({
      content: `**Failed to save API key**\n${error instanceof Error ? error.message : 'Unknown error'}`,
    })
  }
}

// ── OAuth flow ──────────────────────────────────────────────────

async function startOAuthFlow(
  interaction: StringSelectMenuInteraction | ModalSubmitInteraction,
  ctx: LoginContext,
  hash: string,
): Promise<void> {
  if (!ctx.providerId || ctx.methodIndex === undefined) {
    await interaction.editReply({
      content: 'Invalid context for OAuth flow',
      components: [],
    })
    return
  }

  try {
    const getClient = await initializeOpencodeForDirectory(ctx.dir)
    if (getClient instanceof Error) {
      await interaction.editReply({
        content: getClient.message,
        components: [],
      })
      return
    }

    await interaction.editReply({
      content: `**Authenticating with ${ctx.providerName}**\nStarting authorization...`,
      components: [],
    })

    // Direct fetch to the server because the SDK's buildClientParams drops
    // unknown keys — `inputs` would be silently stripped. The server accepts
    // `inputs` in the body (see opencode server/routes/provider.ts).
    const port = getOpencodeServerPort()
    if (!port) {
      await interaction.editReply({
        content: 'OpenCode server is not running. Please try again.',
        components: [],
      })
      return
    }

    const hasInputs = Object.keys(ctx.inputs).length > 0
    const authorizeUrl = new URL(
      `/provider/${encodeURIComponent(ctx.providerId)}/oauth/authorize`,
      `http://127.0.0.1:${port}`,
    )
    authorizeUrl.searchParams.set('directory', ctx.dir)

    // Include basic auth if OPENCODE_SERVER_PASSWORD is set,
    // matching the opencode server's optional basicAuth middleware.
    const fetchHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-opencode-directory': ctx.dir,
    }
    const serverPassword = process.env.OPENCODE_SERVER_PASSWORD
    if (serverPassword) {
      const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode'
      fetchHeaders['Authorization'] =
        `Basic ${Buffer.from(`${username}:${serverPassword}`).toString('base64')}`
    }

    const authorizeRes = await fetch(authorizeUrl, {
      method: 'POST',
      headers: fetchHeaders,
      body: JSON.stringify({
        method: ctx.methodIndex,
        ...(hasInputs ? { inputs: ctx.inputs } : {}),
      }),
    })

    if (!authorizeRes.ok) {
      const errorText = await authorizeRes.text().catch(() => '')
      let errorMessage = 'Unknown error'
      try {
        const parsed = JSON.parse(errorText) as {
          message?: string
          data?: { message?: string }
        }
        errorMessage = parsed?.data?.message || parsed?.message || errorMessage
      } catch {
        errorMessage = errorText || errorMessage
      }
      await interaction.editReply({
        content: `Failed to start authorization: ${errorMessage}`,
        components: [],
      })
      return
    }

    const { url, method, instructions } = (await authorizeRes.json()) as {
      url: string
      method: 'auto' | 'code'
      instructions: string
    }

    let message = `**Authenticating with ${ctx.providerName}**\n\n`
    message += `Open this URL to authorize:\n${url}\n\n`

    if (instructions) {
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

    if (method === 'code') {
      // Code mode: show a button to paste the auth code/URL after
      // completing login in a browser (possibly on a different machine).
      const button = new ButtonBuilder()
        .setCustomId(`login_oauth_code_btn:${hash}`)
        .setLabel('Paste authorization code')
        .setStyle(ButtonStyle.Primary)

      await interaction.editReply({
        content: message,
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(button),
        ],
      })
      // Don't delete context — we need it for the code submission
      return
    }

    await interaction.editReply({ content: message, components: [] })

    // Auto mode: poll for completion (device flow / localhost callback)
    const callbackResponse = await getClient().provider.oauth.callback({
      providerID: ctx.providerId,
      method: ctx.methodIndex,
      directory: ctx.dir,
    })

    if (callbackResponse.error) {
      pendingLoginContexts.delete(hash)
      await interaction.editReply({
        content: `**Authentication Failed**\n${extractErrorMessage({ error: callbackResponse.error, fallback: 'Authorization was not completed' })}`,
        components: [],
      })
      return
    }

    await getClient().instance.dispose({ directory: ctx.dir })
    pendingLoginContexts.delete(hash)

    await interaction.editReply({
      content: `✅ **Successfully authenticated with ${ctx.providerName}!**\n\nYou can now use models from this provider.`,
      components: [],
    })
  } catch (error) {
    loginLogger.error('OAuth flow error:', error)
    pendingLoginContexts.delete(hash)
    await interaction.editReply({
      content: `**Authentication Failed**\n${error instanceof Error ? error.message : 'Unknown error'}`,
      components: [],
    })
  }
}
