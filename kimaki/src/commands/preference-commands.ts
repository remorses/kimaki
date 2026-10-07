// Agent, model and display preferences. In a session thread they change the
// session in OpenCode (switchAgent / switchModel, applied from the next
// step); in a project channel they set the default for new sessions
// (channel_agents / channel_models). /model can also set the default of
// channels without their own model (global_models). Verbosity is always per channel.
//
//   /agent          ─▶ agent select ─▶ session or channel
//   /<agent>-agent  ─▶ same, without the select
//   /model          ─▶ provider ─▶ model ─▶ variant (if any) ─▶ scope: session | channel | global
//   /model-variant  ─▶ variant of the current model ─▶ scope
//   /verbosity      ─▶ text | tools for the channel
//
// The /model wizard keeps its picks in the createPreferenceRoutes closure
// keyed by a short hash (custom IDs max 100 chars), dropped after 10 minutes.

import crypto from 'node:crypto'
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js'

import { globalModel, oc, parseModel, type Bot, type ModelChoice } from '../bot.ts'
import { verbosityFromV1, verbosityToV1, type Verbosity } from '../db.ts'
import { ConfigError, DbError } from '../errors.ts'
import { paginate, selectedPage, selectRow } from '../format-parts.ts'
import { replyError, resolveTarget, type InteractionRoutes, type InteractionTarget } from '../interaction-context.ts'
import * as schema from '../schema.ts'
import { agentSelection, primaryAgents, switchAgent } from '../sessions.ts'

const AGENT_PREFIX = 'agent:'
const MODEL_PREFIX = 'model:'
const VERBOSITY_PREFIX = 'verbosity:'
const WIZARD_TTL_MS = 10 * 60 * 1_000
const NONE_VARIANT = '__none__'

const VERBOSITY_OPTIONS: ReadonlyArray<{ value: Verbosity; label: string; description: string }> = [
  { value: 'tools', label: 'Text and tools', description: 'Text, edits and tools with side effects. Hides reads and searches.' },
  { value: 'text', label: 'Text only', description: 'Text, file edits and errors. Hides the other tools.' },
]

type ModelWizard = {
  target: InteractionTarget
  providerID: string | null
  providerName: string | null
  modelID: string | null
  variant: string | null
}

type Step = 'provider' | 'model' | 'variant' | 'scope'

function modelLabel(model: { providerID: string; id: string; variant?: string | null }): string {
  return `${model.providerID}/${model.id}${model.variant ? ` (${model.variant})` : ''}`
}

// --- Writes, shared with `kimaki channel` (lock-routes.ts) and `kimaki send --model`.

// From the next step of the session.
export async function switchModel(bot: Bot, { sessionId, model }: { sessionId: string; model: ModelChoice }) {
  const choice = { providerID: model.providerID, id: model.id, ...(model.variant && { variant: model.variant }) }
  const result = await oc(bot, 'session.switchModel', (client) => client.session.switchModel({ sessionID: sessionId, model: choice }))
  if (result instanceof Error) return result
}

// Default model of new sessions in the channel.
export async function setChannelModel(bot: Bot, { channelId, model }: { channelId: string; model: ModelChoice }): Promise<DbError | void> {
  const values = { model_id: `${model.providerID}/${model.id}`, variant: model.variant ?? null }
  const result = await bot.db
    .insert(schema.channel_models)
    .values({ channel_id: channelId, ...values })
    .onConflictDoUpdate({ target: schema.channel_models.channel_id, set: values })
    .catch((cause) => new DbError({ operation: 'write channel_models', cause }))
  if (result instanceof Error) return result
}

// Default model of new sessions in channels without a channel model.
export async function setGlobalModel(bot: Bot, { model }: { model: ModelChoice }): Promise<DbError | void> {
  const values = { model_id: `${model.providerID}/${model.id}`, variant: model.variant ?? null }
  const result = await bot.db
    .insert(schema.global_models)
    .values({ app_id: bot.appId, ...values })
    .onConflictDoUpdate({ target: schema.global_models.app_id, set: values })
    .catch((cause) => new DbError({ operation: 'write global_models', cause }))
  if (result instanceof Error) return result
}

// Applies to running sessions of the channel too, from their next event.
export async function setVerbosity(bot: Bot, { channelId, verbosity }: { channelId: string; verbosity: Verbosity }): Promise<DbError | void> {
  const value = verbosityToV1(verbosity)
  const result = await bot.db
    .insert(schema.channel_verbosity)
    .values({ channel_id: channelId, verbosity: value })
    .onConflictDoUpdate({ target: schema.channel_verbosity.channel_id, set: { verbosity: value } })
    .catch((cause) => new DbError({ operation: 'write channel_verbosity', cause }))
  if (result instanceof Error) return result
  bot.store.setState((current) => ({ verbosity: { ...current.verbosity, [channelId]: verbosity } }))
}

export async function setChannelAgent(bot: Bot, { channelId, agent }: { channelId: string; agent: string }): Promise<DbError | void> {
  const result = await bot.db
    .insert(schema.channel_agents)
    .values({ channel_id: channelId, agent_name: agent })
    .onConflictDoUpdate({ target: schema.channel_agents.channel_id, set: { agent_name: agent } })
    .catch((cause) => new DbError({ operation: 'write channel_agents', cause }))
  if (result instanceof Error) return result
}

// --- Reads

// The agent and model a session or channel uses now, for the menu headers.
// A channel without its own model shows the global one (modelScope 'global').
async function current(bot: Bot, target: InteractionTarget) {
  const sessionId = target.sessionId
  if (sessionId) {
    const info = await oc(bot, 'session.get', (client) => client.session.get({ sessionID: sessionId }))
    if (info instanceof Error) return info
    return { scope: 'session' as const, modelScope: 'session' as const, agent: info.agent ?? null, model: info.model ?? null }
  }
  const row = await bot.db.query.channel_directories
    .findFirst({ where: { channel_id: target.channelId }, with: { channel_agent: true, channel_model: true } })
    .catch((cause) => new DbError({ operation: 'read channel preferences', cause }))
  if (row instanceof Error) return row
  const agent = row?.channel_agent?.agent_name ?? null
  const model = parseModel(row?.channel_model?.model_id, row?.channel_model?.variant)
  if (model) return { scope: 'channel' as const, modelScope: 'channel' as const, agent, model }
  const global = await globalModel(bot)
  if (global instanceof Error) return global
  return { scope: 'channel' as const, modelScope: 'global' as const, agent, model: global }
}

async function enabledModels(bot: Bot, directory: string) {
  const location = { directory }
  const [models, providers] = await Promise.all([
    oc(bot, 'model.list', (client) => client.model.list({ location })),
    oc(bot, 'provider.list', (client) => client.provider.list({ location })),
  ])
  if (models instanceof Error) return models
  if (providers instanceof Error) return providers
  const names = new Map(providers.data.map((provider) => [provider.id, provider.name]))
  return models.data
    .filter((model) => model.enabled)
    .map((model) => ({ ...model, providerName: names.get(model.providerID) ?? model.providerID }))
}

// An agent shortcut uses its configured model; /model-variant uses the current model.
async function baseModel(bot: Bot, { target, agent }: { target: InteractionTarget; agent?: string }) {
  const selected = agent ? await agentSelection(bot, { directory: target.directory, agent }) : null
  if (selected instanceof Error) return selected
  const [now, models, fallback] = await Promise.all([
    current(bot, target),
    enabledModels(bot, target.directory),
    oc(bot, 'model.default', (client) => client.model.default({ location: { directory: target.directory } })),
  ])
  if (now instanceof Error) return now
  if (models instanceof Error) return models
  if (fallback instanceof Error) return fallback
  const model = selected?.model ?? now.model ?? (fallback.data ? { providerID: fallback.data.providerID, id: fallback.data.id } : null)
  const info = model ? models.find((candidate) => candidate.providerID === model.providerID && candidate.id === model.id) : null
  if (!model || !info) return new ConfigError({ reason: 'No model configured. Use /model to set one first.' })
  return { model, info }
}

// The base model with thinking level `variant`, for `/<agent>-agent variant:`.
export async function variantModel(bot: Bot, { target, variant, agent }: { target: InteractionTarget; variant: string; agent?: string }): Promise<Error | ModelChoice> {
  const base = await baseModel(bot, { target, agent })
  if (base instanceof Error) return base
  const { info } = base
  if (!info.variants.some((candidate) => candidate.id === variant)) {
    const known = info.variants.map((candidate) => `\`${candidate.id}\``).join(', ') || 'none'
    return new ConfigError({ reason: `\`${info.providerID}/${info.id}\` has no thinking level \`${variant}\`. Available: ${known}` })
  }
  return { providerID: info.providerID, id: info.id, variant }
}

// Autocomplete of `variant`: the thinking levels of the model in use.
export async function variantChoices(bot: Bot, { target, query, agent }: { target: InteractionTarget; query: string; agent?: string }): Promise<Error | Array<{ name: string; value: string }>> {
  const base = await baseModel(bot, { target, agent })
  if (base instanceof Error) return base
  return base.info.variants
    .filter((variant) => variant.id.includes(query.toLowerCase()))
    .map((variant) => ({ name: `${variant.id} (${base.info.providerID}/${base.info.id})`, value: variant.id }))
}

// --- /agent and /<agent>-agent

async function setAgent(bot: Bot, { target, agent, model }: { target: InteractionTarget; agent: string; model?: ModelChoice | null }): Promise<Error | string> {
  const before = await current(bot, target)
  if (before instanceof Error) return before
  const sessionId = target.sessionId
  const selected = sessionId
    ? await switchAgent(bot, { sessionId, directory: target.directory, agent, model })
    : await agentSelection(bot, { directory: target.directory, agent })
  if (selected instanceof Error) return selected
  if (!sessionId) {
    const choice = model ?? selected.model
    if (choice) {
      const written = await setChannelModel(bot, { channelId: target.channelId, model: choice })
      if (written instanceof Error) return written
    }
    const written = await setChannelAgent(bot, { channelId: target.channelId, agent: selected.agent })
    if (written instanceof Error) return written
  }
  const choice = model ?? selected.model
  const modelText = choice ? `\nModel: \`${modelLabel(choice)}\`` : ''
  const previous = before.agent && before.agent !== agent ? ` (was **${before.agent}**)` : ''
  const verb = before.agent === agent ? 'Using' : 'Switched to'
  if (before.scope === 'session') {
    return `${verb} **${agent}** agent for this session${previous}${modelText}\nThe agent changes from the next step.`
  }
  return `${verb} **${agent}** agent for this channel${previous}${modelText}\nAll new sessions will use this agent.`
}

// /<agent>-agent without a prompt: agent and thinking level for the session or channel.
export async function applyAgent(
  bot: Bot,
  { interaction, target, agent, model }: { interaction: ChatInputCommandInteraction; target: InteractionTarget; agent: string; model: ModelChoice | null },
): Promise<void> {
  await interaction.deferReply()
  const content = await setAgent(bot, { target, agent, model })
  if (content instanceof Error) return replyError(interaction, content)
  const thinking = model ? `\nThinking level: **${model.variant}** (\`${modelLabel(model)}\`)` : ''
  await interaction.editReply({ content: `${content}${thinking}` })
}

async function agentMenu(bot: Bot, interaction: ChatInputCommandInteraction) {
  const target = await resolveTarget(bot, interaction.channelId)
  if (target instanceof Error) return replyError(interaction, target)
  await interaction.deferReply()
  const [agents, now] = await Promise.all([primaryAgents(bot, target.directory), current(bot, target)])
  if (agents instanceof Error) return replyError(interaction, agents)
  if (now instanceof Error) return replyError(interaction, now)
  if (agents.length === 0) return replyError(interaction, new ConfigError({ reason: 'No primary agents available' }))
  const currentText = now.agent ? `**Current (${now.scope}):** \`${now.agent}\`` : '**Current:** default'
  await interaction.editReply({
    content: `**Set Agent Preference**\n${currentText}\nSelect an agent:`,
    components: [
      selectRow({
        customId: `${AGENT_PREFIX}${interaction.channelId}`,
        placeholder: 'Select an agent',
        options: agents.map((agent) => ({
          label: agent.name,
          value: agent.id,
          description: agent.description || `${agent.mode} agent`,
          default: agent.id === now.agent,
        })),
      }),
    ],
  })
}

async function handleAgentSelect(bot: Bot, interaction: StringSelectMenuInteraction) {
  const agent = interaction.values[0]
  const target = await resolveTarget(bot, interaction.channelId)
  if (target instanceof Error) return replyError(interaction, target)
  if (!agent) return
  await interaction.deferUpdate()
  const content = await setAgent(bot, { target, agent })
  if (content instanceof Error) return replyError(interaction, content)
  await interaction.editReply({ content, components: [] })
}

// --- /model and /model-variant

async function renderStep(
  bot: Bot,
  {
    interaction,
    hash,
    wizard,
    step,
    page = 0,
  }: {
    interaction: ChatInputCommandInteraction | MessageComponentInteraction
    hash: string
    wizard: ModelWizard
    step: Step
    page?: number
  },
) {
  const models = await enabledModels(bot, wizard.target.directory)
  if (models instanceof Error) return replyError(interaction, models)
  const customId = `${MODEL_PREFIX}${hash}:${step}`
  const header = '**Set Model Preference**'
  const selected = wizard.providerID && wizard.modelID ? `${wizard.providerID}/${wizard.modelID}` : ''
  const reply = async (content: string, options: ReadonlyArray<{ label: string; value: string; description?: string }>, placeholder: string) => {
    await interaction.editReply({ content, components: [selectRow({ customId, placeholder, options: paginate(options, page) })] })
  }
  if (step === 'provider') {
    const providers = [...new Map(models.map((model) => [model.providerID, model.providerName]))].sort((a, b) =>
      a[1].localeCompare(b[1]),
    )
    if (providers.length === 0) {
      return replyError(interaction, new ConfigError({ reason: 'No providers with credentials found. Connect one with `opencode auth login`.' }))
    }
    const now = await current(bot, wizard.target)
    if (now instanceof Error) return replyError(interaction, now)
    const currentText = now.model ? `**Current (${now.modelScope}):** \`${modelLabel(now.model)}\`` : '**Current:** OpenCode default'
    return reply(
      `${header}\n${currentText}\nSelect a provider:`,
      providers.map(([id, name]) => {
        const count = models.filter((model) => model.providerID === id).length
        return { label: name, value: id, description: `${count} model${count === 1 ? '' : 's'} available` }
      }),
      'Select a provider',
    )
  }
  if (step === 'model') {
    const options = models
      .filter((model) => model.providerID === wizard.providerID)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((model) => ({ label: model.name, value: model.id, description: model.id }))
    return reply(`${header}\nProvider: **${wizard.providerName}**\nSelect a model:`, options, 'Select a model')
  }
  if (step === 'variant') {
    const model = models.find((candidate) => candidate.providerID === wizard.providerID && candidate.id === wizard.modelID)
    const options = [
      { label: 'None (default)', value: NONE_VARIANT, description: 'Use the model without a specific thinking level' },
      ...(model?.variants ?? []).map((variant) => ({ label: variant.id, value: variant.id, description: `Use ${variant.id} thinking` })),
    ]
    return reply(`${header}\nModel: **${wizard.providerName}** / **${wizard.modelID}**\n\`${selected}\`\nSelect a thinking level:`, options, 'Select a thinking level')
  }
  const variant = wizard.variant ? ` (${wizard.variant})` : ''
  return reply(
    `${header}\nModel: **${wizard.providerName}** / **${wizard.modelID}**${variant}\n\`${selected}\`\nApply to:`,
    [
      ...(wizard.target.sessionId ? [{ label: 'This session', value: 'session', description: 'From the next step of this session' }] : []),
      { label: 'This channel', value: 'channel', description: 'New sessions in this channel' },
      { label: 'All channels', value: 'global', description: 'New sessions in channels without their own model' },
    ],
    'Apply to...',
  )
}

async function applyModel(
  bot: Bot,
  { interaction, wizard, scope }: { interaction: StringSelectMenuInteraction; wizard: ModelWizard; scope: string },
) {
  if (!wizard.providerID || !wizard.modelID || !wizard.providerName) return
  const model: ModelChoice = { providerID: wizard.providerID, id: wizard.modelID, variant: wizard.variant }
  const sessionId = wizard.target.sessionId
  const result =
    scope === 'session' && sessionId
      ? await switchModel(bot, { sessionId, model })
      : scope === 'global'
        ? await setGlobalModel(bot, { model })
        : await setChannelModel(bot, { channelId: wizard.target.channelId, model })
  if (result instanceof Error) return replyError(interaction, result)
  const label = `**${wizard.providerName}** / **${wizard.modelID}**${model.variant ? ` (${model.variant})` : ''}\n\`${modelLabel(model)}\``
  const content =
    scope === 'session'
      ? `Model set for this session:\n${label}\nApplies from the next step.`
      : scope === 'global'
        ? `Model preference set for all channels:\n${label}\nNew sessions use this model, except in channels with their own model.`
        : `Model preference set for this channel:\n${label}\nAll new sessions in this channel will use this model.`
  await interaction.editReply({ content, components: [] })
}

// --- /verbosity

async function verbosityMenu(bot: Bot, interaction: ChatInputCommandInteraction) {
  const target = await resolveTarget(bot, interaction.channelId)
  if (target instanceof Error) return replyError(interaction, target)
  const now = bot.store.getState().verbosity[target.channelId] ?? verbosityFromV1(null)
  await interaction.reply({
    content: `**Verbosity**\nCurrent: \`${now}\``,
    components: [
      selectRow({
        customId: `${VERBOSITY_PREFIX}${target.channelId}`,
        placeholder: 'Select verbosity',
        options: VERBOSITY_OPTIONS.map((option) => ({ ...option, default: option.value === now })),
      }),
    ],
  })
}

async function handleVerbositySelect(bot: Bot, interaction: StringSelectMenuInteraction) {
  const target = await resolveTarget(bot, interaction.channelId)
  if (target instanceof Error) return replyError(interaction, target)
  const channelId = target.channelId
  if (interaction.customId.slice(VERBOSITY_PREFIX.length) !== channelId) {
    return replyError(interaction, new ConfigError({ reason: 'Run /verbosity in the target channel' }))
  }
  const option = VERBOSITY_OPTIONS.find((candidate) => candidate.value === interaction.values[0])
  if (!option) return
  await interaction.deferUpdate()
  const now = bot.store.getState().verbosity[channelId] ?? verbosityFromV1(null)
  if (now === option.value) {
    await interaction.editReply({ content: `Verbosity is already \`${now}\` for this channel.`, components: [] })
    return
  }
  const result = await setVerbosity(bot, { channelId, verbosity: option.value })
  if (result instanceof Error) return replyError(interaction, result)
  await interaction.editReply({
    content: `Verbosity set to \`${option.value}\` for this channel.\n${option.description}\nApplies immediately, including active sessions.`,
    components: [],
  })
}

// --- Routes

// /agent, /model, /model-variant, /verbosity and their selects. One per bot:
// the /model wizard picks stay in this closure.
export function createPreferenceRoutes(): InteractionRoutes {
  const wizards = new Map<string, ModelWizard>()

  function remember(wizard: ModelWizard): string {
    const hash = crypto.randomBytes(6).toString('hex')
    wizards.set(hash, wizard)
    setTimeout(() => wizards.delete(hash), WIZARD_TTL_MS).unref()
    return hash
  }

  async function modelMenu(bot: Bot, interaction: ChatInputCommandInteraction) {
    const target = await resolveTarget(bot, interaction.channelId)
    if (target instanceof Error) return replyError(interaction, target)
    await interaction.deferReply()
    const wizard: ModelWizard = { target, providerID: null, providerName: null, modelID: null, variant: null }
    return renderStep(bot, { interaction, hash: remember(wizard), wizard, step: 'provider' })
  }

  // The variants of the model in use now.
  async function variantMenu(bot: Bot, interaction: ChatInputCommandInteraction) {
    const target = await resolveTarget(bot, interaction.channelId)
    if (target instanceof Error) return replyError(interaction, target)
    await interaction.deferReply()
    const base = await baseModel(bot, { target })
    if (base instanceof Error) return replyError(interaction, base)
    const { model, info } = base
    if (info.variants.length === 0) {
      await interaction.editReply({ content: `**Current model:** \`${modelLabel(model)}\`\nThis model has no thinking level variants.` })
      return
    }
    const wizard: ModelWizard = { target, providerID: info.providerID, providerName: info.providerName, modelID: info.id, variant: null }
    return renderStep(bot, { interaction, hash: remember(wizard), wizard, step: 'variant' })
  }

  async function modelSelect(bot: Bot, interaction: StringSelectMenuInteraction) {
    const [hash, step] = interaction.customId.slice(MODEL_PREFIX.length).split(':')
    const wizard = hash ? wizards.get(hash) : undefined
    const value = interaction.values[0]
    if (!hash || !wizard || !value) {
      await interaction.update({ content: 'Selection expired. Please run /model again.', components: [] })
      return
    }
    await interaction.deferUpdate()
    const page = selectedPage(value)
    if (page !== null && (step === 'provider' || step === 'model' || step === 'variant')) {
      return renderStep(bot, { interaction, hash, wizard, step, page })
    }
    if (step === 'provider') {
      const models = await enabledModels(bot, wizard.target.directory)
      if (models instanceof Error) return replyError(interaction, models)
      const providerName = models.find((model) => model.providerID === value)?.providerName ?? value
      const next = { ...wizard, providerID: value, providerName }
      wizards.set(hash, next)
      return renderStep(bot, { interaction, hash, wizard: next, step: 'model' })
    }
    if (step === 'model') {
      const models = await enabledModels(bot, wizard.target.directory)
      if (models instanceof Error) return replyError(interaction, models)
      const info = models.find((model) => model.providerID === wizard.providerID && model.id === value)
      const next = { ...wizard, modelID: value, variant: null }
      wizards.set(hash, next)
      return renderStep(bot, { interaction, hash, wizard: next, step: info && info.variants.length > 0 ? 'variant' : 'scope' })
    }
    if (step === 'variant') {
      const next = { ...wizard, variant: value === NONE_VARIANT ? null : value }
      wizards.set(hash, next)
      return renderStep(bot, { interaction, hash, wizard: next, step: 'scope' })
    }
    wizards.delete(hash)
    return applyModel(bot, { interaction, wizard, scope: value })
  }

  return {
    commands: {
      agent: { definition: new SlashCommandBuilder().setName('agent').setDescription('Set the agent for this session or channel'), run: agentMenu },
      model: { definition: new SlashCommandBuilder().setName('model').setDescription('Set the model for this session, channel or all channels'), run: modelMenu },
      'model-variant': {
        definition: new SlashCommandBuilder().setName('model-variant').setDescription('Change the thinking level of the current model'),
        run: variantMenu,
      },
      verbosity: { definition: new SlashCommandBuilder().setName('verbosity').setDescription('Set what the bot shows in this channel'), run: verbosityMenu },
    },
    selects: { [AGENT_PREFIX]: handleAgentSelect, [MODEL_PREFIX]: modelSelect, [VERBOSITY_PREFIX]: handleVerbositySelect },
  }
}
