// Agent, model and display preferences. In a session thread they change the
// session in OpenCode (switchAgent / switchModel, applied from the next
// step); in a project channel they set the default for new sessions
// (channel_agents / channel_models). Verbosity is always per channel.
//
//   /agent          ─▶ agent select ─▶ session or channel
//   /<agent>-agent  ─▶ same, without the select
//   /model          ─▶ provider ─▶ model ─▶ variant (if any) ─▶ scope: session | channel
//   /model-variant  ─▶ variant of the current model ─▶ scope
//   /verbosity      ─▶ text | tools for the channel
//
// The /model wizard keeps its picks in a closure map keyed by a short hash
// (custom IDs max 100 chars), dropped after 10 minutes.

import crypto from 'node:crypto'
import type {
  ChatInputCommandInteraction,
  MessageComponentInteraction,
  StringSelectMenuInteraction,
} from 'discord.js'

import type { ModelChoice } from '../actions.ts'
import { readChannelVerbosity, type Verbosity } from '../db.ts'
import { ConfigError, DbError, OpenCodeError } from '../errors.ts'
import type { CommandContext, InteractionTarget } from '../slash-commands.ts'
import { selectRow } from './session-commands.ts'

const AGENT_PREFIX = 'agent:'
const MODEL_PREFIX = 'model:'
const VERBOSITY_PREFIX = 'verbosity:'
const WIZARD_TTL_MS = 10 * 60 * 1_000
const NONE_VARIANT = '__none__'
const PAGE_PREFIX = '__page:'
// 23 items plus previous/next entries fit Discord's 25 options.
const PAGE_SIZE = 23

const VERBOSITY_OPTIONS: ReadonlyArray<{ value: Verbosity; label: string; description: string }> = [
  { value: 'tools', label: 'Text and tools', description: 'Text, edits and tools with side effects. Hides reads and searches.' },
  { value: 'text', label: 'Text only', description: 'Text, file edits and errors. Hides the other tools.' },
]

type Wizard = {
  target: InteractionTarget
  providerID: string | null
  providerName: string | null
  modelID: string | null
  variant: string | null
}

type Step = 'provider' | 'model' | 'variant' | 'scope'

type Option = { label: string; value: string; description?: string }

// One page of options with previous/next entries when they do not fit.
export function paginate(options: readonly Option[], page: number): Option[] {
  if (options.length <= 25) return [...options]
  const pages = Math.ceil(options.length / PAGE_SIZE)
  const current = Math.max(0, Math.min(page, pages - 1))
  return [
    ...(current > 0 ? [{ label: `← Previous page (${current}/${pages})`, value: `${PAGE_PREFIX}${current - 1}` }] : []),
    ...options.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE),
    ...(current < pages - 1 ? [{ label: `Next page → (${current + 2}/${pages})`, value: `${PAGE_PREFIX}${current + 1}` }] : []),
  ]
}

function modelLabel(model: { providerID: string; id: string; variant?: string | null }): string {
  return `${model.providerID}/${model.id}${model.variant ? ` (${model.variant})` : ''}`
}

export function createPreferenceCommands({ db, actions, readClient, resolveTarget, replyError }: CommandContext) {
  const wizards = new Map<string, Wizard>()

  function remember(wizard: Wizard): string {
    const hash = crypto.randomBytes(6).toString('hex')
    wizards.set(hash, wizard)
    setTimeout(() => wizards.delete(hash), WIZARD_TTL_MS).unref()
    return hash
  }

  // The agent and model a session or channel uses now, for the menu headers.
  async function current(target: InteractionTarget) {
    const client = readClient()
    if (client instanceof Error) return client
    if (target.sessionId) {
      const info = await client.session
        .get({ sessionID: target.sessionId })
        .catch((e) => new OpenCodeError({ operation: 'session.get', cause: e }))
      if (info instanceof Error) return info
      return { scope: 'session' as const, agent: info.agent ?? null, model: info.model ?? null }
    }
    const row = await db.query.channel_directories
      .findFirst({ where: { channel_id: target.channelId }, with: { channel_agent: true, channel_model: true } })
      .catch((e) => new DbError({ operation: 'read channel preferences', cause: e }))
    if (row instanceof Error) return row
    const saved = row?.channel_model?.model_id.split('/') ?? []
    const [providerID, ...rest] = saved
    const model = providerID && rest.length > 0 ? { providerID, id: rest.join('/'), variant: row?.channel_model?.variant ?? undefined } : null
    return { scope: 'channel' as const, agent: row?.channel_agent?.agent_name ?? null, model }
  }

  async function primaryAgents(directory: string) {
    const client = readClient()
    if (client instanceof Error) return client
    const agents = await client.agent
      .list({ location: { directory } })
      .catch((e) => new OpenCodeError({ operation: 'agent.list', cause: e }))
    if (agents instanceof Error) return agents
    return agents.data.filter((agent) => agent.mode !== 'subagent' && !agent.hidden)
  }

  async function enabledModels(directory: string) {
    const client = readClient()
    if (client instanceof Error) return client
    const location = { directory }
    const [models, providers] = await Promise.all([
      client.model.list({ location }).catch((e) => new OpenCodeError({ operation: 'model.list', cause: e })),
      client.provider.list({ location }).catch((e) => new OpenCodeError({ operation: 'provider.list', cause: e })),
    ])
    if (models instanceof Error) return models
    if (providers instanceof Error) return providers
    const names = new Map(providers.data.map((provider) => [provider.id, provider.name]))
    return models.data
      .filter((model) => model.enabled)
      .map((model) => ({ ...model, providerName: names.get(model.providerID) ?? model.providerID }))
  }

  // The model a session or channel runs with: its own, else the OpenCode default.
  // (V2 runs the session model; an agent's configured model only picks titles.)
  async function baseModel(target: InteractionTarget) {
    const client = readClient()
    if (client instanceof Error) return client
    const [now, models, fallback] = await Promise.all([
      current(target),
      enabledModels(target.directory),
      client.model
        .default({ location: { directory: target.directory } })
        .catch((e) => new OpenCodeError({ operation: 'model.default', cause: e })),
    ])
    if (now instanceof Error) return now
    if (models instanceof Error) return models
    if (fallback instanceof Error) return fallback
    const model = now.model ?? (fallback.data ? { providerID: fallback.data.providerID, id: fallback.data.id } : null)
    const info = model ? models.find((candidate) => candidate.providerID === model.providerID && candidate.id === model.id) : null
    if (!model || !info) return new ConfigError({ reason: 'No model configured. Use /model to set one first.' })
    return { model, info }
  }

  // The base model with thinking level `variant`, for `/<agent>-agent variant:`.
  async function variantModel({ target, variant }: { target: InteractionTarget; variant: string }): Promise<Error | ModelChoice> {
    const base = await baseModel(target)
    if (base instanceof Error) return base
    const { info } = base
    if (!info.variants.some((candidate) => candidate.id === variant)) {
      const known = info.variants.map((candidate) => `\`${candidate.id}\``).join(', ') || 'none'
      return new ConfigError({ reason: `\`${info.providerID}/${info.id}\` has no thinking level \`${variant}\`. Available: ${known}` })
    }
    return { providerID: info.providerID, id: info.id, variant }
  }

  // --- /agent and /<agent>-agent

  async function setAgent({ target, agent }: { target: InteractionTarget; agent: string }): Promise<Error | string> {
    const before = await current(target)
    if (before instanceof Error) return before
    const result = target.sessionId
      ? await actions.switchAgent({ sessionId: target.sessionId, agent })
      : await actions.setChannelAgent({ channelId: target.channelId, agent })
    if (result instanceof Error) return result
    const previous = before.agent && before.agent !== agent ? ` (was **${before.agent}**)` : ''
    const verb = before.agent === agent ? 'Using' : 'Switched to'
    if (before.scope === 'session') {
      return `${verb} **${agent}** agent for this session${previous}\nThe agent changes from the next step.`
    }
    return `${verb} **${agent}** agent for this channel${previous}\nAll new sessions will use this agent.`
  }

  async function agentMenu(interaction: ChatInputCommandInteraction) {
    const target = await resolveTarget(interaction.channelId)
    if (target instanceof Error) return replyError(interaction, target)
    await interaction.deferReply()
    const [agents, now] = await Promise.all([primaryAgents(target.directory), current(target)])
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

  // --- /model and /model-variant

  async function renderStep({
    interaction,
    hash,
    wizard,
    step,
    page = 0,
  }: {
    interaction: ChatInputCommandInteraction | MessageComponentInteraction
    hash: string
    wizard: Wizard
    step: Step
    page?: number
  }) {
    const models = await enabledModels(wizard.target.directory)
    if (models instanceof Error) return replyError(interaction, models)
    const customId = `${MODEL_PREFIX}${hash}:${step}`
    const header = '**Set Model Preference**'
    const selected = wizard.providerID && wizard.modelID ? `${wizard.providerID}/${wizard.modelID}` : ''
    const reply = async (content: string, options: readonly Option[], placeholder: string) => {
      await interaction.editReply({ content, components: [selectRow({ customId, placeholder, options: paginate(options, page) })] })
    }
    if (step === 'provider') {
      const providers = [...new Map(models.map((model) => [model.providerID, model.providerName]))].sort((a, b) =>
        a[1].localeCompare(b[1]),
      )
      if (providers.length === 0) {
        return replyError(interaction, new ConfigError({ reason: 'No providers with credentials found. Connect one with `opencode auth login`.' }))
      }
      const now = await current(wizard.target)
      if (now instanceof Error) return replyError(interaction, now)
      const currentText = now.model ? `**Current (${now.scope}):** \`${modelLabel(now.model)}\`` : '**Current:** OpenCode default'
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
      ],
      'Apply to...',
    )
  }

  async function modelMenu(interaction: ChatInputCommandInteraction) {
    const target = await resolveTarget(interaction.channelId)
    if (target instanceof Error) return replyError(interaction, target)
    await interaction.deferReply()
    const wizard: Wizard = { target, providerID: null, providerName: null, modelID: null, variant: null }
    if (interaction.commandName === 'model') return renderStep({ interaction, hash: remember(wizard), wizard, step: 'provider' })
    // /model-variant: the variants of the model in use now.
    const base = await baseModel(target)
    if (base instanceof Error) return replyError(interaction, base)
    const { model, info } = base
    if (info.variants.length === 0) {
      await interaction.editReply({ content: `**Current model:** \`${modelLabel(model)}\`\nThis model has no thinking level variants.` })
      return
    }
    const picked = { ...wizard, providerID: info.providerID, providerName: info.providerName, modelID: info.id }
    return renderStep({ interaction, hash: remember(picked), wizard: picked, step: 'variant' })
  }

  async function applyModel(interaction: StringSelectMenuInteraction, wizard: Wizard, scope: string) {
    if (!wizard.providerID || !wizard.modelID || !wizard.providerName) return
    const model: ModelChoice = { providerID: wizard.providerID, id: wizard.modelID, variant: wizard.variant }
    const sessionId = wizard.target.sessionId
    const result =
      scope === 'session' && sessionId
        ? await actions.switchModel({ sessionId, model })
        : await actions.setChannelModel({ channelId: wizard.target.channelId, model })
    if (result instanceof Error) return replyError(interaction, result)
    const label = `**${wizard.providerName}** / **${wizard.modelID}**${model.variant ? ` (${model.variant})` : ''}\n\`${modelLabel(model)}\``
    const content =
      scope === 'session'
        ? `Model set for this session:\n${label}\nApplies from the next step.`
        : `Model preference set for this channel:\n${label}\nAll new sessions in this channel will use this model.`
    await interaction.editReply({ content, components: [] })
  }

  async function handleModelSelect(interaction: StringSelectMenuInteraction) {
    const [hash, step] = interaction.customId.slice(MODEL_PREFIX.length).split(':')
    const wizard = hash ? wizards.get(hash) : undefined
    const value = interaction.values[0]
    if (!hash || !wizard || !value) {
      await interaction.update({ content: 'Selection expired. Please run /model again.', components: [] })
      return
    }
    await interaction.deferUpdate()
    if (value.startsWith(PAGE_PREFIX) && (step === 'provider' || step === 'model' || step === 'variant')) {
      return renderStep({ interaction, hash, wizard, step, page: Number(value.slice(PAGE_PREFIX.length)) || 0 })
    }
    if (step === 'provider') {
      const models = await enabledModels(wizard.target.directory)
      if (models instanceof Error) return replyError(interaction, models)
      const providerName = models.find((model) => model.providerID === value)?.providerName ?? value
      const next = { ...wizard, providerID: value, providerName }
      wizards.set(hash, next)
      return renderStep({ interaction, hash, wizard: next, step: 'model' })
    }
    if (step === 'model') {
      const models = await enabledModels(wizard.target.directory)
      if (models instanceof Error) return replyError(interaction, models)
      const info = models.find((model) => model.providerID === wizard.providerID && model.id === value)
      const next = { ...wizard, modelID: value, variant: null }
      wizards.set(hash, next)
      return renderStep({ interaction, hash, wizard: next, step: info && info.variants.length > 0 ? 'variant' : 'scope' })
    }
    if (step === 'variant') {
      const next = { ...wizard, variant: value === NONE_VARIANT ? null : value }
      wizards.set(hash, next)
      return renderStep({ interaction, hash, wizard: next, step: 'scope' })
    }
    wizards.delete(hash)
    return applyModel(interaction, wizard, value)
  }

  // --- /verbosity

  async function verbosityMenu(interaction: ChatInputCommandInteraction) {
    const target = await resolveTarget(interaction.channelId)
    if (target instanceof Error) return replyError(interaction, target)
    const now = await readChannelVerbosity({ db, channelId: target.channelId })
    if (now instanceof Error) return replyError(interaction, now)
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

  async function handleVerbositySelect(interaction: StringSelectMenuInteraction) {
    const channelId = interaction.customId.slice(VERBOSITY_PREFIX.length)
    const option = VERBOSITY_OPTIONS.find((candidate) => candidate.value === interaction.values[0])
    if (!option) return
    await interaction.deferUpdate()
    const now = await readChannelVerbosity({ db, channelId })
    if (now instanceof Error) return replyError(interaction, now)
    if (now === option.value) {
      await interaction.editReply({ content: `Verbosity is already \`${now}\` for this channel.`, components: [] })
      return
    }
    const result = await actions.setVerbosity({ channelId, verbosity: option.value })
    if (result instanceof Error) return replyError(interaction, result)
    await interaction.editReply({
      content: `Verbosity set to \`${option.value}\` for this channel.\n${option.description}\nApplies immediately, including active sessions.`,
      components: [],
    })
  }

  async function handleAgentSelect(interaction: StringSelectMenuInteraction) {
    const agent = interaction.values[0]
    const target = await resolveTarget(interaction.channelId)
    if (target instanceof Error) return replyError(interaction, target)
    if (!agent) return
    await interaction.deferUpdate()
    const content = await setAgent({ target, agent })
    if (content instanceof Error) return replyError(interaction, content)
    await interaction.editReply({ content, components: [] })
  }

  const handlers: Record<string, (interaction: ChatInputCommandInteraction) => Promise<void>> = {
    agent: agentMenu,
    model: modelMenu,
    'model-variant': modelMenu,
    verbosity: verbosityMenu,
  }

  return {
    commands: new Set(Object.keys(handlers)),
    async handle(interaction: ChatInputCommandInteraction): Promise<void> {
      await handlers[interaction.commandName]?.(interaction)
    },
    variantModel,
    // /<agent>-agent without a prompt: agent and thinking level for the session or channel.
    async applyAgent({
      interaction,
      target,
      agent,
      model,
    }: {
      interaction: ChatInputCommandInteraction
      target: InteractionTarget
      agent: string
      model: ModelChoice | null
    }): Promise<void> {
      await interaction.deferReply()
      if (model) {
        const switched = target.sessionId
          ? await actions.switchModel({ sessionId: target.sessionId, model })
          : await actions.setChannelModel({ channelId: target.channelId, model })
        if (switched instanceof Error) return replyError(interaction, switched)
      }
      const content = await setAgent({ target, agent })
      if (content instanceof Error) return replyError(interaction, content)
      const thinking = model ? `\nThinking level: **${model.variant}** (\`${modelLabel(model)}\`)` : ''
      await interaction.editReply({ content: `${content}${thinking}` })
    },
    // Autocomplete of `variant`: the thinking levels of the model in use.
    async variantChoices(target: InteractionTarget, query: string): Promise<Error | Array<{ name: string; value: string }>> {
      const base = await baseModel(target)
      if (base instanceof Error) return base
      return base.info.variants
        .filter((variant) => variant.id.includes(query.toLowerCase()))
        .map((variant) => ({ name: `${variant.id} (${base.info.providerID}/${base.info.id})`, value: variant.id }))
    },
    ownsSelect(customId: string): boolean {
      return [AGENT_PREFIX, MODEL_PREFIX, VERBOSITY_PREFIX].some((prefix) => customId.startsWith(prefix))
    },
    async handleSelect(interaction: StringSelectMenuInteraction): Promise<void> {
      if (interaction.customId.startsWith(AGENT_PREFIX)) return handleAgentSelect(interaction)
      if (interaction.customId.startsWith(MODEL_PREFIX)) return handleModelSelect(interaction)
      return handleVerbositySelect(interaction)
    },
  }
}
