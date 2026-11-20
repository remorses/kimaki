// Provider login: /login (Discord wizard) and `kimaki login` (lock server).
// Credentials are stored by OpenCode, never by Kimaki.
//
//   /login ─▶ provider select ─▶ method select ─▶ API key modal | OAuth link + code/check buttons
//                                              └▶ activate a saved credential
//
// Wizard state lives in the createLoginRoutes closure under a short hash (custom IDs max 100 chars).
// /transcription-key lives here too: provider logins and audio keys are
// secrets of the whole bot, so only the server owner or an administrator may use them.

import crypto from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
  type ModalSubmitInteraction,
  type ButtonInteraction,
} from 'discord.js'
import type { IntegrationInfo } from '@opencode/client'

import { oc, type Bot } from '../bot.ts'
import { ConfigError, DbError } from '../errors.ts'
import { button, buttonRow, paginate, SELECT_PAGE_SIZE, selectedPage, selectRow } from '../format-parts.ts'
import { replyError, resolveTarget, type InteractionRoutes } from '../interaction-context.ts'
import { handleTranscriptionKeyModal, TRANSCRIPTION_KEY_MODAL, transcriptionKeyModal } from '../voice.ts'

type LoginWizard = { userId: string; directory: string; provider: IntegrationInfo | null; expires: number; attempt?: string }

const TTL = 10 * 60_000
// Fills the whole first page of the provider select (SELECT_PAGE_SIZE), most popular first.
const POPULAR = [
  'anthropic',
  'openai',
  'google',
  'xai',
  'github-copilot',
  'openrouter',
  'opencode',
  'opencode-go',
  'deepseek',
  'mistral',
  'groq',
  'moonshotai',
  'kimi-code-plan-global',
  'zai',
  'zai-coding-plan',
  'minimax',
  'alibaba',
  'vercel',
  'amazon-bedrock',
  'google-vertex',
  'azure',
  'cerebras',
  'ollama-cloud',
]

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

const COMPLETE_POLL_MS = 500
const COMPLETE_POLLS = 40

// Completes an attempt and waits for its result: a pasted redirect settles in the background.
async function finishOAuth(bot: Bot, { request, code }: { request: { integrationID: string; attemptID: string; location: { directory: string } }; code: string }) {
  const done = await oc(bot, 'integration.oauth.complete', (client) => client.integration.oauth.complete({ ...request, code }))
  if (done instanceof Error) return done
  for (let poll = 0; poll < COMPLETE_POLLS; poll++) {
    const result = await oc(bot, 'integration.oauth.status', (client) => client.integration.oauth.status(request))
    if (result instanceof Error) return result
    if (result.data.status !== 'pending') return result.data
    await sleep(COMPLETE_POLL_MS)
  }
  return new ConfigError({ reason: 'Login still pending. Check it again in a moment.' })
}

function statusText({ provider, status }: { provider: string; status: { status: string; message?: string } }) {
  if (status.status === 'complete') return `${provider} OAuth connected. Use /model to select a model.`
  if (status.status === 'failed') return status.message ?? 'Login failed'
  return 'Login expired. Run /login again.'
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
      const result = await finishOAuth(bot, { request: { integrationID, attemptID, location }, code })
      if (result instanceof Error) return result
      return result.status === 'complete' ? { connected: true } : result
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
    instructions: 'Use --key, or --method <oauth method ID>. Complete with --attempt <id> --code <code>; when the attempt has paste: true, --code also takes the redirect URL the browser ended on. Check or cancel with --attempt <id> [--cancel].',
  }
}

// --- /login

// The login wizard: provider select ─▶ method select ─▶ key modal or OAuth buttons. One per bot.
export function createLoginRoutes(): InteractionRoutes {
  const wizards = new Map<string, LoginWizard>()

  function remember(wizard: LoginWizard) {
    for (const [id, existing] of wizards) if (existing.expires < Date.now()) wizards.delete(id)
    const id = crypto.randomBytes(8).toString('hex')
    wizards.set(id, wizard)
    return id
  }

  function lookup({ id, userId }: { id: string; userId: string }) {
    const wizard = wizards.get(id)
    if (!wizard || wizard.expires < Date.now() || wizard.userId !== userId) {
      return new ConfigError({ reason: 'Login menu expired or belongs to another user. Run /login again.' })
    }
    return wizard
  }

  // The wizard of a select, or null after an error reply. A previous/next entry shows that page.
  async function selected({ interaction, options }: { interaction: StringSelectMenuInteraction; options: (wizard: LoginWizard) => Promise<Error | Array<{ label: string; value: string }>> }) {
    const id = interaction.customId.split(':')[1] ?? ''
    const wizard = lookup({ id, userId: interaction.user.id })
    if (wizard instanceof Error) {
      await replyError(interaction, wizard)
      return null
    }
    const value = interaction.values[0] ?? ''
    const page = selectedPage(value)
    if (page === null) return { id, wizard, value }
    await interaction.deferUpdate()
    const all = await options(wizard)
    if (all instanceof Error) {
      await replyError(interaction, all)
      return null
    }
    if (page < 0 || page * SELECT_PAGE_SIZE >= all.length) {
      await replyError(interaction, new ConfigError({ reason: 'Login page no longer exists. Run /login again.' }))
      return null
    }
    await interaction.editReply({ components: [selectRow({ customId: interaction.customId, placeholder: `Page ${page + 1}`, options: paginate(all, page) })] })
    return null
  }

  async function loginCommand(bot: Bot, interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    const target = await resolveTarget(bot, interaction.channelId)
    if (target instanceof Error) return replyError(interaction, target)
    const options = await providers(bot, target.directory)
    if (options instanceof Error) return replyError(interaction, options)
    const id = remember({ userId: interaction.user.id, directory: target.directory, provider: null, expires: Date.now() + TTL })
    await interaction.editReply({
      content: 'Connect a provider. Credentials are stored by OpenCode, not Kimaki.',
      components: [selectRow({ customId: `login_provider:${id}`, placeholder: 'Provider', options: paginate(options, 0) })],
    })
  }

  async function providerSelect(bot: Bot, interaction: StringSelectMenuInteraction) {
    const picked = await selected({ interaction, options: (wizard) => providers(bot, wizard.directory) })
    if (!picked) return
    const { id, wizard, value } = picked
    await interaction.deferUpdate()
    const provider = await oc(bot, 'integration.get', (client) =>
      client.integration.get({ integrationID: value, location: { directory: wizard.directory } }),
    )
    if (provider instanceof Error) return replyError(interaction, provider)
    wizards.set(id, { ...wizard, provider: provider.data })
    const options = methods(provider.data)
    if (!options.length) return replyError(interaction, new ConfigError({ reason: 'No interactive login method. This integration uses environment credentials.' }))
    await interaction.editReply({
      content: `Connect ${provider.data.name}`,
      components: [selectRow({ customId: `login_method:${id}`, placeholder: 'Login method', options: paginate(options, 0) })],
    })
  }

  async function methodSelect(bot: Bot, interaction: StringSelectMenuInteraction) {
    const picked = await selected({ interaction, options: async (wizard) => (wizard.provider ? methods(wizard.provider) : []) })
    if (!picked) return
    const { id, wizard, value } = picked
    const provider = wizard.provider
    if (!provider) return
    if (value.startsWith('credential:')) {
      await interaction.deferUpdate()
      const credentialId = value.slice('credential:'.length)
      if (!provider.connections.some((connection) => connection.type === 'credential' && connection.id === credentialId)) {
        return replyError(interaction, new ConfigError({ reason: 'Unknown credential' }))
      }
      const result = await credential(bot, { id: credentialId, operation: 'activate' })
      if (result instanceof Error) return replyError(interaction, result)
      wizards.delete(id)
      return interaction.editReply({ content: `Activated ${provider.name} credential`, components: [] })
    }
    if (value.startsWith('oauth:')) {
      await interaction.deferUpdate()
      const method = provider.methods.find((candidate) => candidate.type === 'oauth' && candidate.id === value.slice(6))
      if (!method || method.type !== 'oauth') return replyError(interaction, new ConfigError({ reason: 'Unknown login method' }))
      const result = await oc(bot, 'integration.oauth.connect', (client) =>
        client.integration.oauth.connect({ integrationID: provider.id, methodID: method.id, location: { directory: wizard.directory } }),
      )
      if (result instanceof Error) return replyError(interaction, result)
      wizards.set(id, { ...wizard, attempt: result.data.attemptID })
      const code = result.data.mode === 'code'
      // Browser-callback methods (Sign in with ChatGPT) also take the redirect URL as code, for a
      // browser on another device (OpenCode 2.3+).
      // TODO: read `result.data.paste` directly once @opencode/client is past 2.0.29, whose types lack it.
      const paste = !code && 'paste' in result.data && result.data.paste === true
      const pasteHint = '-# If the browser is on another device, its last page fails to load. Copy that page URL and press Paste redirect URL.'
      return interaction.editReply({
        content: [result.data.url, result.data.instructions, ...(paste ? [pasteHint] : [])].join('\n'),
        components: [
          buttonRow([
            button({ customId: `login_${code ? 'code' : 'check'}:${id}`, label: code ? 'Enter code' : 'Check login' }),
            ...(paste ? [button({ customId: `login_paste:${id}`, label: 'Paste redirect URL' })] : []),
            button({ customId: `login_cancel:${id}`, label: 'Cancel' }),
          ]),
        ],
      })
    }
    if (value === 'key') {
      await interaction.showModal(textModal({ customId: `login_key:${id}`, title: `Connect ${provider.name}`.slice(0, 45), inputId: 'key', label: 'API key' }))
    }
  }

  // The wizard of a modal, or null after an error reply.
  async function modalWizard(interaction: ModalSubmitInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    const id = interaction.customId.split(':')[1] ?? ''
    const wizard = lookup({ id, userId: interaction.user.id })
    if (wizard instanceof Error) {
      await replyError(interaction, wizard)
      return null
    }
    const provider = wizard.provider
    if (!provider) {
      await replyError(interaction, new ConfigError({ reason: 'Choose a provider with /login first' }))
      return null
    }
    return { id, wizard, provider }
  }

  async function keyModal(bot: Bot, interaction: ModalSubmitInteraction) {
    const found = await modalWizard(interaction)
    if (!found) return
    const { id, wizard, provider } = found
    const result = await connectKey(bot, { provider: provider.id, key: interaction.fields.getTextInputValue('key'), directory: wizard.directory })
    if (result instanceof Error) return replyError(interaction, result)
    wizards.delete(id)
    await interaction.editReply({ content: `Connected ${provider.name}. Use /model to select a model.` })
  }

  async function codeModal(bot: Bot, interaction: ModalSubmitInteraction) {
    const found = await modalWizard(interaction)
    if (!found) return
    const { id, wizard, provider } = found
    const attemptID = wizard.attempt
    if (!attemptID) return replyError(interaction, new ConfigError({ reason: 'No pending login attempt' }))
    const code = interaction.fields.getTextInputValue('code')
    const request = { integrationID: provider.id, attemptID, location: { directory: wizard.directory } }
    const result = await finishOAuth(bot, { request, code })
    if (result instanceof Error) return replyError(interaction, result)
    wizards.delete(id)
    return interaction.editReply({ content: statusText({ provider: provider.name, status: result }) })
  }

  // The OAuth attempt of a button, or null after an error reply.
  async function attemptOf(interaction: ButtonInteraction) {
    const id = interaction.customId.split(':')[1] ?? ''
    const wizard = lookup({ id, userId: interaction.user.id })
    if (wizard instanceof Error) {
      await replyError(interaction, wizard)
      return null
    }
    const { provider, attempt: attemptID } = wizard
    if (!provider || !attemptID) {
      await replyError(interaction, new ConfigError({ reason: 'No pending login attempt' }))
      return null
    }
    return { id, provider, request: { integrationID: provider.id, attemptID, location: { directory: wizard.directory } } }
  }

  async function codeClick(_bot: Bot, interaction: ButtonInteraction) {
    const found = await attemptOf(interaction)
    if (!found) return
    return interaction.showModal(textModal({ customId: `login_code:${found.id}`, title: 'Authorization code', inputId: 'code', label: 'Code' }))
  }

  // The pasted redirect URL goes through the same modal: OpenCode completes it like a code.
  async function pasteClick(_bot: Bot, interaction: ButtonInteraction) {
    const found = await attemptOf(interaction)
    if (!found) return
    return interaction.showModal(textModal({ customId: `login_code:${found.id}`, title: 'Redirect URL', inputId: 'code', label: 'URL of the page that failed to load' }))
  }

  async function cancelClick(bot: Bot, interaction: ButtonInteraction) {
    const found = await attemptOf(interaction)
    if (!found) return
    await interaction.deferUpdate()
    const result = await oc(bot, 'integration.oauth.cancel', (client) => client.integration.oauth.cancel(found.request))
    if (result instanceof Error) return replyError(interaction, result)
    wizards.delete(found.id)
    return interaction.editReply({ content: 'Login cancelled', components: [] })
  }

  async function checkClick(bot: Bot, interaction: ButtonInteraction) {
    const found = await attemptOf(interaction)
    if (!found) return
    await interaction.deferUpdate()
    const result = await oc(bot, 'integration.oauth.status', (client) => client.integration.oauth.status(found.request))
    if (result instanceof Error) return replyError(interaction, result)
    const status = result.data
    if (status.status === 'pending') {
      return interaction.followUp({ content: 'Login still pending. Finish authorization, then check again.', flags: MessageFlags.Ephemeral })
    }
    wizards.delete(found.id)
    return interaction.editReply({ content: statusText({ provider: found.provider.name, status }), components: [] })
  }

  return {
    admin: true,
    commands: {
      login: { definition: new SlashCommandBuilder().setName('login').setDescription('Connect an OpenCode provider'), run: loginCommand },
      'transcription-key': {
        definition: new SlashCommandBuilder().setName('transcription-key').setDescription('Set the OpenAI or Gemini API key for voice transcription and speech'),
        run: (_bot, interaction) => interaction.showModal(transcriptionKeyModal()),
      },
    },
    selects: { 'login_provider:': providerSelect, 'login_method:': methodSelect },
    buttons: { 'login_code:': codeClick, 'login_paste:': pasteClick, 'login_check:': checkClick, 'login_cancel:': cancelClick },
    modals: {
      'login_key:': keyModal,
      'login_code:': codeModal,
      [TRANSCRIPTION_KEY_MODAL]: (bot, interaction) => handleTranscriptionKeyModal({ interaction, db: bot.db }),
    },
  }
}
