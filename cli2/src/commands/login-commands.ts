// Provider login: /login (Discord wizard) and `kimaki login` (lock server).
// Credentials are stored by OpenCode, never by Kimaki.
//
//   /login ─▶ provider select ─▶ method select ─▶ API key modal | OAuth link + code/check buttons
//                                              └▶ activate a saved credential
//
// Wizard state lives in bot.local.loginWizards under a short hash (custom IDs max 100 chars).

import crypto from 'node:crypto'
import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
  type ModalSubmitInteraction,
  type ButtonInteraction,
} from 'discord.js'
import type { IntegrationInfo } from '@opencode/client'

import { oc, type Bot } from '../bot.ts'
import { ConfigError, DbError } from '../errors.ts'
import { button, buttonRow } from '../format-parts.ts'
import { replyError, resolveTarget } from '../slash-commands.ts'

export type LoginWizard = { userId: string; directory: string; provider: IntegrationInfo | null; expires: number; attempt?: string }

const TTL = 10 * 60_000
const POPULAR = ['openai', 'anthropic', 'google', 'opencode']

function remember(bot: Bot, wizard: LoginWizard) {
  const wizards = bot.local.loginWizards
  for (const [id, existing] of wizards) if (existing.expires < Date.now()) wizards.delete(id)
  const id = crypto.randomBytes(8).toString('hex')
  wizards.set(id, wizard)
  return id
}

function lookup(bot: Bot, { id, userId }: { id: string; userId: string }) {
  const wizard = bot.local.loginWizards.get(id)
  if (!wizard || wizard.expires < Date.now() || wizard.userId !== userId) {
    return new ConfigError({ reason: 'Login menu expired or belongs to another user. Run /login again.' })
  }
  return wizard
}

function pageOptions(options: Array<{ label: string; value: string }>, page: number) {
  return [
    ...(page > 0 ? [{ label: 'Previous page', value: `page:${page - 1}` }] : []),
    ...options.slice(page * 23, (page + 1) * 23),
    ...((page + 1) * 23 < options.length ? [{ label: 'Next page', value: `page:${page + 1}` }] : []),
  ]
}

function selectMenu({ customId, placeholder, options }: { customId: string; placeholder: string; options: Array<{ label: string; value: string }> }) {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).addOptions(options),
  )
}

function textModal({ customId, title, inputId, label }: { customId: string; title: string; inputId: string; label: string }) {
  const input = new TextInputBuilder().setCustomId(inputId).setLabel(label).setStyle(TextInputStyle.Short).setRequired(true)
  return new ModalBuilder().setCustomId(customId).setTitle(title).addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input))
}

async function providers(bot: Bot, directory: string) {
  const result = await oc(bot, 'integration.list', (client) => client.integration.list({ location: { directory } }))
  if (result instanceof Error) return result
  const rank = (key: string) => (POPULAR.includes(key) ? POPULAR.indexOf(key) : 100)
  return [...result.data]
    .sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name))
    .map((provider) => ({ label: provider.name.slice(0, 100), value: provider.id }))
}

function methods(provider: IntegrationInfo) {
  const options = provider.methods.flatMap((method) => {
    if (method.type === 'key') return [{ label: method.label ?? 'API key', value: 'key' }]
    if (method.type === 'oauth') return [{ label: method.label, value: `oauth:${method.id}` }]
    return []
  })
  const credentials = provider.connections.flatMap((connection) =>
    connection.type === 'credential' ? [{ label: `Activate ${connection.label}`.slice(0, 100), value: `credential:${connection.id}` }] : [],
  )
  return [...options, ...credentials]
}

async function connectKey(bot: Bot, { provider, key, directory }: { provider: string; key: string; directory: string }) {
  const result = await oc(bot, 'integration.connect.key', (client) =>
    client.integration.connect.key({ integrationID: provider, key, location: { directory } }),
  )
  if (result instanceof Error) return result
  return { message: `Connected ${provider}` }
}

// `kimaki login credential`: activate, remove or relabel a saved credential.
export async function credential(bot: Bot, input: { id: string; operation: 'activate' | 'remove' | 'label'; label?: string }) {
  const result = await oc(bot, `credential.${input.operation}`, (client) =>
    input.operation === 'label'
      ? client.credential.update({ credentialID: input.id, label: input.label ?? '' })
      : client.credential[input.operation]({ credentialID: input.id }),
  )
  if (result instanceof Error) return result
  return { message: `Credential ${input.operation} complete` }
}

// `kimaki login`: one step of the same flow as /login, driven by flags.
export async function loginCli(
  bot: Bot,
  input: { provider: string; method?: string; attempt?: string; code?: string; key?: string; operation?: string },
) {
  const project = await bot.db.query.channel_directories
    .findFirst()
    .catch((cause) => new DbError({ operation: 'find login directory', cause }))
  if (project instanceof Error) return project
  const directory = project?.directory
  if (!directory) return new ConfigError({ reason: 'Pass a login directory or add a project first' })
  const location = { directory }
  const { provider: integrationID, attempt } = input
  if (input.key) return connectKey(bot, { provider: integrationID, key: input.key, directory })
  if (attempt) {
    const attemptID = attempt
    if (input.operation === 'cancel') {
      const result = await oc(bot, 'integration.oauth.cancel', (client) => client.integration.oauth.cancel({ integrationID, attemptID, location }))
      if (result instanceof Error) return result
      return { cancelled: true }
    }
    const code = input.code
    if (code) {
      const result = await oc(bot, 'integration.oauth.complete', (client) =>
        client.integration.oauth.complete({ integrationID, attemptID, code, location }),
      )
      if (result instanceof Error) return result
      return { connected: true }
    }
    const result = await oc(bot, 'integration.oauth.status', (client) => client.integration.oauth.status({ integrationID, attemptID, location }))
    if (result instanceof Error) return result
    return result.data
  }
  const methodID = input.method
  if (methodID) {
    const result = await oc(bot, 'integration.oauth.connect', (client) => client.integration.oauth.connect({ integrationID, methodID, location }))
    if (result instanceof Error) return result
    return result.data
  }
  const info = await oc(bot, 'integration.get', (client) => client.integration.get({ integrationID, location }))
  if (info instanceof Error) return info
  return {
    provider: info.data.name,
    methods: info.data.methods,
    connections: info.data.connections,
    instructions: 'Use --key, or --method <oauth method ID>. Complete with --attempt <id> --code <code>; check or cancel with --attempt <id> [--cancel].',
  }
}

// --- /login

export async function handleLoginCommand(bot: Bot, interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })
  const target = await resolveTarget(bot, interaction.channelId)
  if (target instanceof Error) return replyError(interaction, target)
  const options = await providers(bot, target.directory)
  if (options instanceof Error) return replyError(interaction, options)
  const id = remember(bot, { userId: interaction.user.id, directory: target.directory, provider: null, expires: Date.now() + TTL })
  await interaction.editReply({
    content: 'Connect a provider. Credentials are stored by OpenCode, not Kimaki.',
    components: [selectMenu({ customId: `login_provider:${id}`, placeholder: 'Provider', options: pageOptions(options, 0) })],
  })
}

export async function handleLoginSelect(bot: Bot, interaction: StringSelectMenuInteraction) {
  const [kind, id = ''] = interaction.customId.split(':')
  const wizard = lookup(bot, { id, userId: interaction.user.id })
  if (wizard instanceof Error) return replyError(interaction, wizard)
  const selected = interaction.values[0] ?? ''
  if (/^page:\d+$/.test(selected)) {
    await interaction.deferUpdate()
    const page = Number(selected.slice(5))
    const options = kind === 'login_provider' ? await providers(bot, wizard.directory) : wizard.provider ? methods(wizard.provider) : []
    if (options instanceof Error) return replyError(interaction, options)
    if (page < 0 || page * 23 >= options.length) return replyError(interaction, new ConfigError({ reason: 'Login page no longer exists. Run /login again.' }))
    return interaction.editReply({
      components: [selectMenu({ customId: interaction.customId, placeholder: `Page ${page + 1}`, options: pageOptions(options, page) })],
    })
  }
  if (kind === 'login_provider') {
    await interaction.deferUpdate()
    const provider = await oc(bot, 'integration.get', (client) =>
      client.integration.get({ integrationID: selected, location: { directory: wizard.directory } }),
    )
    if (provider instanceof Error) return replyError(interaction, provider)
    bot.local.loginWizards.set(id, { ...wizard, provider: provider.data })
    const options = methods(provider.data)
    if (!options.length) return replyError(interaction, new ConfigError({ reason: 'No interactive login method. This integration uses environment credentials.' }))
    await interaction.editReply({
      content: `Connect ${provider.data.name}`,
      components: [selectMenu({ customId: `login_method:${id}`, placeholder: 'Login method', options: pageOptions(options, 0) })],
    })
    return
  }
  const provider = wizard.provider
  if (kind !== 'login_method' || !provider) return
  if (selected.startsWith('credential:')) {
    await interaction.deferUpdate()
    const credentialId = selected.slice('credential:'.length)
    if (!provider.connections.some((connection) => connection.type === 'credential' && connection.id === credentialId)) {
      return replyError(interaction, new ConfigError({ reason: 'Unknown credential' }))
    }
    const result = await credential(bot, { id: credentialId, operation: 'activate' })
    if (result instanceof Error) return replyError(interaction, result)
    bot.local.loginWizards.delete(id)
    return interaction.editReply({ content: `Activated ${provider.name} credential`, components: [] })
  }
  if (selected.startsWith('oauth:')) {
    await interaction.deferUpdate()
    const method = provider.methods.find((candidate) => candidate.type === 'oauth' && candidate.id === selected.slice(6))
    if (!method || method.type !== 'oauth') return replyError(interaction, new ConfigError({ reason: 'Unknown login method' }))
    const result = await oc(bot, 'integration.oauth.connect', (client) =>
      client.integration.oauth.connect({ integrationID: provider.id, methodID: method.id, location: { directory: wizard.directory } }),
    )
    if (result instanceof Error) return replyError(interaction, result)
    bot.local.loginWizards.set(id, { ...wizard, attempt: result.data.attemptID })
    const code = result.data.mode === 'code'
    return interaction.editReply({
      content: `${result.data.url}\n${result.data.instructions}`,
      components: [
        buttonRow([
          button({ customId: `login_${code ? 'code' : 'check'}:${id}`, label: code ? 'Enter code' : 'Check login' }),
          button({ customId: `login_cancel:${id}`, label: 'Cancel' }),
        ]),
      ],
    })
  }
  if (selected === 'key') {
    await interaction.showModal(textModal({ customId: `login_key:${id}`, title: `Connect ${provider.name}`.slice(0, 45), inputId: 'key', label: 'API key' }))
  }
}

export async function handleLoginModal(bot: Bot, interaction: ModalSubmitInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })
  const id = interaction.customId.split(':')[1] ?? ''
  const wizard = lookup(bot, { id, userId: interaction.user.id })
  if (wizard instanceof Error) return replyError(interaction, wizard)
  const provider = wizard.provider
  if (!provider) return replyError(interaction, new ConfigError({ reason: 'Choose a provider with /login first' }))
  if (interaction.customId.startsWith('login_code:')) {
    const attemptID = wizard.attempt
    if (!attemptID) return replyError(interaction, new ConfigError({ reason: 'No pending login attempt' }))
    const code = interaction.fields.getTextInputValue('code')
    const result = await oc(bot, 'integration.oauth.complete', (client) =>
      client.integration.oauth.complete({ integrationID: provider.id, attemptID, code, location: { directory: wizard.directory } }),
    )
    if (result instanceof Error) return replyError(interaction, result)
    bot.local.loginWizards.delete(id)
    return interaction.editReply({ content: `${provider.name} OAuth connected. Use /model to select a model.` })
  }
  const result = await connectKey(bot, { provider: provider.id, key: interaction.fields.getTextInputValue('key'), directory: wizard.directory })
  if (result instanceof Error) return replyError(interaction, result)
  bot.local.loginWizards.delete(id)
  await interaction.editReply({ content: `Connected ${provider.name}. Use /model to select a model.` })
}

export async function handleLoginClick(bot: Bot, interaction: ButtonInteraction) {
  const [kind, id = ''] = interaction.customId.split(':')
  const wizard = lookup(bot, { id, userId: interaction.user.id })
  if (wizard instanceof Error) return replyError(interaction, wizard)
  const { provider, attempt: attemptID } = wizard
  if (!provider || !attemptID) return replyError(interaction, new ConfigError({ reason: 'No pending login attempt' }))
  if (kind === 'login_code') {
    return interaction.showModal(textModal({ customId: `login_code:${id}`, title: 'Authorization code', inputId: 'code', label: 'Code' }))
  }
  await interaction.deferUpdate()
  const request = { integrationID: provider.id, attemptID, location: { directory: wizard.directory } }
  if (kind === 'login_cancel') {
    const result = await oc(bot, 'integration.oauth.cancel', (client) => client.integration.oauth.cancel(request))
    if (result instanceof Error) return replyError(interaction, result)
    bot.local.loginWizards.delete(id)
    return interaction.editReply({ content: 'Login cancelled', components: [] })
  }
  const result = await oc(bot, 'integration.oauth.status', (client) => client.integration.oauth.status(request))
  if (result instanceof Error) return replyError(interaction, result)
  const status = result.data
  if (status.status === 'pending') {
    return interaction.followUp({ content: 'Login still pending. Finish authorization, then check again.', flags: MessageFlags.Ephemeral })
  }
  bot.local.loginWizards.delete(id)
  const content = status.status === 'complete'
    ? `${provider.name} OAuth connected`
    : status.status === 'failed'
      ? status.message
      : 'Login expired. Run /login again.'
  return interaction.editReply({ content, components: [] })
}
