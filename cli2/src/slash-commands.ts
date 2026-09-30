// Slash commands and component interactions (spec 14). Registered per guild
// (guild-scoped route: gateway-proxy rejects global application command
// routes). Every interaction passes the same permission gate as messages,
// then goes to its handler: slash commands here, buttons and selects in their
// feature files. Handlers only call actions; session output comes from events.

import {
  ChannelType,
  Events,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type Interaction,
  type ThreadChannel,
} from 'discord.js'
import dedent from 'string-dedent'

import type { Actions } from './actions.ts'
import type { KimakiDb } from './db.ts'
import { DiscordError } from './errors.ts'
import { formatError } from './format-parts.ts'
import { canUseKimaki } from './ingress.ts'
import { createLogger } from './logger.ts'
import { handlePermissionButton, PERMISSION_PREFIX } from './permissions.ts'
import { createQuestionHandlers, FORM_OTHER_PREFIX, FORM_SELECT_PREFIX } from './questions.ts'
import { formatEcho, handleQueueRemove, QUEUE_REMOVE_PREFIX } from './queue.ts'
import { resolveSession } from './session-events.ts'
import type { BotStore } from './store.ts'

const logger = createLogger('COMMANDS')

export const COMMANDS = [
  new SlashCommandBuilder()
    .setName('session-id')
    .setDescription('Show the OpenCode session ID of this thread and how to debug it'),
  new SlashCommandBuilder()
    .setName('abort')
    .setDescription('Stop the current run and clear the queue')
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Send a message after the current run finishes')
    .addStringOption((option) => option.setName('message').setDescription('The message to queue').setRequired(true))
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('clear-queue')
    .setDescription('Remove queued messages')
    .addIntegerOption((option) =>
      option.setName('position').setDescription('Only this position (1 = next)').setMinValue(1),
    )
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName('btw')
    .setDescription('Ask something without polluting or blocking the current session')
    .addStringOption((option) =>
      option.setName('prompt').setDescription('The message to send in the forked session').setRequired(true),
    )
    .setDMPermission(false),
].map((command) => command.toJSON())

async function registerGuild({ discord, guild }: { discord: Client; guild: Guild }): Promise<void> {
  const result = await discord.application?.commands
    .set(COMMANDS, guild.id)
    .catch((e) => new DiscordError({ operation: `register commands in ${guild.id}`, cause: e }))
  if (result instanceof Error) logger.warn(result.message)
}

export function sessionIdReply({
  sessionId,
  threadId,
  directory,
  kimaki,
}: {
  sessionId: string
  threadId: string
  directory: string | null
  kimaki: string
}): string {
  const attach = directory ? `opencode2 ${directory} --session ${sessionId}` : `opencode2 --session ${sessionId}`
  return dedent`
    **Session:** \`${sessionId}\`
    **Thread:** \`${threadId}\`
    Messages: \`${kimaki} session read ${sessionId}\`
    Events (retries, errors, order): \`${kimaki} session events ${sessionId}\`
    Open in the OpenCode TUI: \`${attach}\`
  `
}

async function handleSessionId({
  interaction,
  db,
  kimaki,
}: {
  interaction: ChatInputCommandInteraction
  db: KimakiDb
  kimaki: string
}) {
  const channel = interaction.channel
  const resolved = channel?.isThread() ? await resolveSession({ db, id: channel.id }) : null
  if (!resolved || resolved instanceof Error) {
    await interaction.reply({ content: 'Run /session-id inside a Kimaki session thread.', flags: MessageFlags.Ephemeral })
    return
  }
  const parent = channel?.isThread() ? channel.parentId : null
  const project = parent ? await db.query.channel_directories.findFirst({ where: { channel_id: parent } }) : null
  await interaction.reply({
    content: sessionIdReply({ ...resolved, directory: project?.directory ?? null, kimaki }),
    flags: MessageFlags.Ephemeral,
  })
}

// The thread of an interaction when it has a Kimaki session, else null.
async function sessionThread({
  discord,
  store,
  channelId,
}: {
  discord: Client
  store: BotStore
  channelId: string | null
}): Promise<ThreadChannel | null> {
  if (!channelId || !store.getState().roots[channelId]) return null
  const channel = await discord.channels.fetch(channelId).catch(() => null)
  if (!channel?.isThread() || channel.type === ChannelType.AnnouncementThread) return null
  return channel
}

async function replyError(interaction: ChatInputCommandInteraction, error: Error) {
  logger.error(`/${interaction.commandName} failed: ${error.message}`)
  const content = formatError(error.message)
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content }).catch(() => undefined)
    return
  }
  await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined)
}

// Commands that act on the session of the current thread.
async function handleThreadCommand({
  interaction,
  discord,
  store,
  actions,
}: {
  interaction: ChatInputCommandInteraction
  discord: Client
  store: BotStore
  actions: Actions
}) {
  const thread = await sessionThread({ discord, store, channelId: interaction.channelId })
  if (!thread) {
    await interaction.reply({ content: 'Use this command in a thread with a Kimaki session', flags: MessageFlags.Ephemeral })
    return
  }
  const author = { id: interaction.user.id, username: interaction.user.username }
  switch (interaction.commandName) {
    case 'abort': {
      await interaction.deferReply()
      const result = await actions.abort({ threadId: thread.id })
      if (result instanceof Error) return replyError(interaction, result)
      const note = result.cleared > 0 ? `, cleared ${result.cleared} queued message${result.cleared > 1 ? 's' : ''}` : ''
      await interaction.editReply({ content: `Request **aborted**${note}` })
      return
    }
    case 'queue': {
      const text = interaction.options.getString('message', true).trim()
      // The visible reply stands in for the user message: the ack replies to it.
      await interaction.reply({ content: formatEcho({ username: author.username, text }) })
      const reply = await interaction.fetchReply().catch((e: Error) => e)
      if (reply instanceof Error) return replyError(interaction, reply)
      const result = await actions.dispatch({ thread, route: { kind: 'queue', text }, author, messageId: reply.id })
      if (result instanceof Error) return replyError(interaction, result)
      return
    }
    case 'clear-queue': {
      await interaction.deferReply()
      const result = await actions.clearQueue({ threadId: thread.id, position: interaction.options.getInteger('position') })
      if (result instanceof Error) return replyError(interaction, result)
      const content =
        result.cleared === 0 ? 'No queued messages' : `-# Cleared ${result.cleared} queued message${result.cleared > 1 ? 's' : ''}`
      await interaction.editReply({ content })
      return
    }
    case 'btw': {
      const text = interaction.options.getString('prompt', true).trim()
      await interaction.deferReply()
      const result = await actions.forkBtw({ sourceThread: thread, text, author, messageId: interaction.id })
      if (result instanceof Error) return replyError(interaction, result)
      await interaction.editReply({ content: `Session forked! Continue in <#${result.threadId}>` })
      return
    }
  }
}

export function registerSlashCommands({
  discord,
  db,
  kimaki,
  store,
  actions,
}: {
  discord: Client
  db: KimakiDb
  kimaki: string
  store: BotStore
  actions: Actions
}) {
  discord.on(Events.GuildCreate, (guild) => void registerGuild({ discord, guild }))
  for (const guild of discord.guilds.cache.values()) void registerGuild({ discord, guild })

  const questions = createQuestionHandlers({ store, actions })

  async function handle(interaction: Interaction) {
    if (!interaction.guildId) return
    const guild = interaction.guild ?? (await discord.guilds.fetch(interaction.guildId).catch(() => null))
    if (!guild || !(await canUseKimaki({ guild, userId: interaction.user.id }))) {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: 'You do not have permission to use Kimaki', flags: MessageFlags.Ephemeral })
      }
      return
    }
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'session-id') return handleSessionId({ interaction, db, kimaki })
      return handleThreadCommand({ interaction, discord, store, actions })
    }
    if (interaction.isButton() && interaction.customId.startsWith(QUEUE_REMOVE_PREFIX)) {
      return handleQueueRemove({ interaction, actions })
    }
    if (interaction.isButton() && interaction.customId.startsWith(PERMISSION_PREFIX)) {
      return handlePermissionButton({ interaction, store, actions })
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith(FORM_SELECT_PREFIX)) {
      return questions.handleSelect(interaction)
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith(FORM_OTHER_PREFIX)) {
      return questions.handleOther(interaction)
    }
  }

  discord.on(Events.InteractionCreate, (interaction) => {
    handle(interaction).catch((error: Error) => logger.error(`interaction failed: ${error.message}`))
  })
}
