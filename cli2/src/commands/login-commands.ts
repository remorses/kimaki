import crypto from 'node:crypto'
import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, StringSelectMenuBuilder, type ChatInputCommandInteraction, type StringSelectMenuInteraction, type ModalSubmitInteraction, type ButtonInteraction } from 'discord.js'
import type { IntegrationInfo } from '@opencode/client'
import { ConfigError, OpenCodeError } from '../errors.ts'
import type { CommandContext } from '../slash-commands.ts'
import { button, buttonRow } from '../effects.ts'

type Wizard = { userId: string; directory: string; provider: IntegrationInfo | null; expires: number; attempt?: string }
const TTL = 10 * 60_000

export function createLoginCommands({ readClient, resolveTarget, actions, replyError }: CommandContext) {
  const contexts = new Map<string, Wizard>()
  function remember(context: Wizard) {
    for (const [id, wizard] of contexts) if (wizard.expires < Date.now()) contexts.delete(id)
    const id = crypto.randomBytes(8).toString('hex')
    contexts.set(id, context)
    return id
  }
  function lookup(id: string, userId: string) {
    const wizard = contexts.get(id)
    if (!wizard || wizard.expires < Date.now() || wizard.userId !== userId) return new ConfigError({ reason: 'Login menu expired or belongs to another user. Run /login again.' })
    return wizard
  }
  function pageOptions(options: Array<{ label: string; value: string }>, page: number) {
    return [
      ...(page > 0 ? [{ label: 'Previous page', value: `page:${page - 1}` }] : []),
      ...options.slice(page * 23, (page + 1) * 23),
      ...((page + 1) * 23 < options.length ? [{ label: 'Next page', value: `page:${page + 1}` }] : []),
    ]
  }
  async function providers(directory: string) {
    const client = readClient()
    if (client instanceof Error) return client
    const result = await client.integration.list({ location: { directory } }).catch((cause) => new OpenCodeError({ operation: 'integration.list', cause }))
    if (result instanceof Error) return result
    const popular = ['openai', 'anthropic', 'google', 'opencode']
    return [...result.data].sort((a, b) => {
      const rank = (key: string) => popular.includes(key) ? popular.indexOf(key) : 100
      return rank(a.id) - rank(b.id) || a.name.localeCompare(b.name)
    }).map((provider) => ({ label: provider.name.slice(0, 100), value: provider.id }))
  }
  function methods(provider: IntegrationInfo) {
    const options = provider.methods.flatMap((method) => method.type === 'key' ? [{ label: method.label ?? 'API key', value: 'key' }] : method.type === 'oauth' ? [{ label: method.label, value: `oauth:${method.id}` }] : [])
    return [...options, ...provider.connections.flatMap((connection) => connection.type === 'credential' ? [{ label: `Activate ${connection.label}`.slice(0, 100), value: `credential:${connection.id}` }] : [])]
  }
  async function handle(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    const target = await resolveTarget(interaction.channelId)
    if (target instanceof Error) return replyError(interaction, target)
    const options = await providers(target.directory)
    if (options instanceof Error) return replyError(interaction, options)
    const id = remember({ userId: interaction.user.id, directory: target.directory, provider: null, expires: Date.now() + TTL })
    await interaction.editReply({ content: 'Connect a provider. Credentials are stored by OpenCode, not Kimaki.', components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId(`login_provider:${id}`).setPlaceholder('Provider').addOptions(pageOptions(options, 0)),
    )] })
  }
  async function select(interaction: StringSelectMenuInteraction) {
    const [kind, id = ''] = interaction.customId.split(':')
    const wizard = lookup(id, interaction.user.id)
    if (wizard instanceof Error) return replyError(interaction, wizard)
    const selected = interaction.values[0] ?? ''
    if (/^page:\d+$/.test(selected)) {
      await interaction.deferUpdate()
      const page = Number(selected.slice(5))
      const options = kind === 'login_provider' ? await providers(wizard.directory) : wizard.provider ? methods(wizard.provider) : []
      if (options instanceof Error) return replyError(interaction, options)
      if (page < 0 || page * 23 >= options.length) return replyError(interaction, new ConfigError({ reason: 'Login page no longer exists. Run /login again.' }))
      return interaction.editReply({ components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(interaction.customId).setPlaceholder(`Page ${page + 1}`).addOptions(pageOptions(options, page)))] })
    }
    if (kind === 'login_provider') {
      await interaction.deferUpdate()
      const client = readClient()
      if (client instanceof Error) return replyError(interaction, client)
      const provider = await client.integration.get({ integrationID: interaction.values[0]!, location: { directory: wizard.directory } }).catch((cause) => new OpenCodeError({ operation: 'integration.get', cause }))
      if (provider instanceof Error) return replyError(interaction, provider)
      contexts.set(id, { ...wizard, provider: provider.data })
      const options = methods(provider.data)
      if (!options.length) return replyError(interaction, new ConfigError({ reason: 'No interactive login method. This integration uses environment credentials.' }))
      await interaction.editReply({ content: `Connect ${provider.data.name}`, components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(`login_method:${id}`).setPlaceholder('Login method').addOptions(pageOptions(options, 0)),
      )] })
      return
    }
    if (kind !== 'login_method' || !wizard.provider) return
    const value = interaction.values[0] ?? ''
    if (value.startsWith('credential:')) {
      await interaction.deferUpdate()
      const credentialId = value.slice('credential:'.length)
      if (!wizard.provider.connections.some((connection) => connection.type === 'credential' && connection.id === credentialId)) return replyError(interaction, new ConfigError({ reason: 'Unknown credential' }))
      const result = await actions.credential({ id: credentialId, operation: 'activate' })
      if (result instanceof Error) return replyError(interaction, result)
      contexts.delete(id)
      return interaction.editReply({ content: `Activated ${wizard.provider.name} credential`, components: [] })
    }
    if (value.startsWith('oauth:')) {
      await interaction.deferUpdate()
      const method = wizard.provider.methods.find((method) => method.type === 'oauth' && method.id === value.slice(6))
      if (!method || method.type !== 'oauth') return replyError(interaction, new ConfigError({ reason: 'Unknown login method' }))
      const result = await actions.startOAuth({ provider: wizard.provider.id, method: method.id, directory: wizard.directory })
      if (result instanceof Error) return replyError(interaction, result)
      contexts.set(id, { ...wizard, attempt: result.data.attemptID })
      return interaction.editReply({ content: `${result.data.url}\n${result.data.instructions}`, components: [buttonRow([
        button({ customId: `login_${result.data.mode === 'code' ? 'code' : 'check'}:${id}`, label: result.data.mode === 'code' ? 'Enter code' : 'Check login' }),
        button({ customId: `login_cancel:${id}`, label: 'Cancel' }),
      ])] })
    }
    if (value === 'key') {
      await interaction.showModal(new ModalBuilder().setCustomId(`login_key:${id}`).setTitle(`Connect ${wizard.provider.name}`.slice(0, 45)).addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('key').setLabel('API key').setStyle(TextInputStyle.Short).setRequired(true)),
      ))
    }
  }
  async function modal(interaction: ModalSubmitInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    const id = interaction.customId.split(':')[1] ?? ''
    const wizard = lookup(id, interaction.user.id)
    if (wizard instanceof Error) return replyError(interaction, wizard)
    if (!wizard.provider) return replyError(interaction, new ConfigError({ reason: 'Choose a provider with /login first' }))
    if (interaction.customId.startsWith('login_code:')) {
      if (!wizard.attempt) return replyError(interaction, new ConfigError({ reason: 'No pending login attempt' }))
      const result = await actions.completeOAuth({ provider: wizard.provider.id, attempt: wizard.attempt, directory: wizard.directory, code: interaction.fields.getTextInputValue('code') })
      if (result instanceof Error) return replyError(interaction, result)
      contexts.delete(id)
      return interaction.editReply({ content: `${wizard.provider.name} OAuth connected. Use /model to select a model.` })
    }
    const result = await actions.loginKey({ provider: wizard.provider.id, key: interaction.fields.getTextInputValue('key'), directory: wizard.directory })
    if (result instanceof Error) return replyError(interaction, result)
    contexts.delete(id)
    await interaction.editReply({ content: `Connected ${wizard.provider.name}. Use /model to select a model.` })
  }
  async function click(interaction: ButtonInteraction) {
    const [kind, id = ''] = interaction.customId.split(':')
    const wizard = lookup(id, interaction.user.id)
    if (wizard instanceof Error) return replyError(interaction, wizard)
    if (!wizard.provider || !wizard.attempt) return replyError(interaction, new ConfigError({ reason: 'No pending login attempt' }))
    if (kind === 'login_code') {
      return interaction.showModal(new ModalBuilder().setCustomId(`login_code:${id}`).setTitle('Authorization code').addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('code').setLabel('Code').setStyle(TextInputStyle.Short).setRequired(true)),
      ))
    }
    await interaction.deferUpdate()
    const input = { provider: wizard.provider.id, attempt: wizard.attempt, directory: wizard.directory }
    if (kind === 'login_cancel') {
      const result = await actions.cancelOAuth(input)
      if (result instanceof Error) return replyError(interaction, result)
      contexts.delete(id)
      return interaction.editReply({ content: 'Login cancelled', components: [] })
    }
    const result = await actions.oauthStatus(input)
    if (result instanceof Error) return replyError(interaction, result)
    const status = result.data
    if (status.status === 'pending') return interaction.followUp({ content: 'Login still pending. Finish authorization, then check again.', flags: MessageFlags.Ephemeral })
    contexts.delete(id)
    return interaction.editReply({ content: status.status === 'complete' ? `${wizard.provider.name} OAuth connected` : status.status === 'failed' ? status.message : 'Login expired. Run /login again.', components: [] })
  }
  return { handle, select, modal, click }
}
