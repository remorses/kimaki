// Slash commands and component interactions (spec 14). Registered per guild
// with one bulk overwrite (guild-scoped route: gateway-proxy rejects global
// application command routes). Every interaction passes the same permission
// gate as messages, then goes to its handler: thread commands here, session
// and preference commands in commands/, buttons and selects of session output
// in their feature files. Handlers only collect input and call actions;
// session output comes from events.
//
// Dynamic commands come from the OpenCode catalog of the guild's projects:
//
//   agent.list    primary agents  ─▶ /<agent>-agent prompt?
//   command.list  commands        ─▶ /<cmd>-cmd arguments?
//   skill.list    skills          ─▶ /<skill>-skill arguments?
//
// Commands with a colon get no slash command. OpenCode names MCP prompts
// "server:prompt" and command.list has no source field, so the colon is the
// only way to leave them out. They still run as `/server:prompt args`
// messages and from /queue-command.
//
// Discord allows 100 commands per guild; skills are cut first.

import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  ChannelType,
  EmbedBuilder,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
  type Interaction,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  type ThreadChannel,
} from 'discord.js'
import * as errore from 'errore'
import dedent from 'string-dedent'

import type { Actions, Author, ModelChoice } from './actions.ts'
import type { AgentUi } from './agent-ui.ts'
import { createPreferenceCommands } from './commands/preference-commands.ts'
import { shellQuote } from './onboarding.ts'
import { createSessionCommands } from './commands/session-commands.ts'
import { createLoginCommands } from './commands/login-commands.ts'
import type { KimakiDb } from './db.ts'
import { ConfigError, DbError, DiscordError, OpenCodeError, OpenCodeUnavailableError } from './errors.ts'
import { formatError } from './format-parts.ts'
import { canUseKimaki } from './ingress.ts'
import { createLogger } from './logger.ts'
import type { OpenCodeClient, OpencodeConnection, V2Event } from './opencode-server.ts'
import { handlePermissionButton, PERMISSION_PREFIX } from './permissions.ts'
import { createQuestionHandlers, FORM_OTHER_PREFIX, FORM_SELECT_PREFIX } from './questions.ts'
import { formatEcho } from './queue.ts'
import type { Route } from './routes.ts'
import { resolveSession } from './session-events.ts'
import type { BotStore } from './store.ts'

const logger = createLogger('COMMANDS')
const execFileAsync = promisify(execFile)

const MAX_COMMANDS = 100
const NAME_LIMIT = 32
const CATALOG_REFRESH_MS = 1_000

// Global OpenCode events after which agent.list or command.list may differ.
// Not skill.updated: every skill.list call makes OpenCode emit it for all
// locations, so reacting to it would refresh in a loop. skill.list waits for
// the skill scan, so the read in a pass is already complete.
export function isCatalogEvent(event: V2Event): boolean {
  return event.type === 'agent.updated' || event.type === 'command.updated'
}
// Built-in OpenCode command that only makes sense in the TUI (V1 skipped it too).
const SKIPPED_COMMANDS = new Set(['init'])

const STATIC_COMMANDS = [
  new SlashCommandBuilder().setName('login').setDescription('Connect an OpenCode provider'),
  new SlashCommandBuilder()
    .setName('new-session')
    .setDescription('Start a new OpenCode session')
    .addStringOption((option) => option.setName('prompt').setDescription('Prompt content for the session').setRequired(true))
    .addStringOption((option) =>
      option.setName('files').setDescription('Files to attach (comma separated; autocomplete)').setAutocomplete(true).setMaxLength(6000),
    )
    .addStringOption((option) => option.setName('agent').setDescription('Agent to use for this session').setAutocomplete(true)),
  new SlashCommandBuilder()
    .setName('resume')
    .setDescription('Resume an existing OpenCode session in a new thread')
    .addStringOption((option) =>
      option.setName('session').setDescription('The session to resume').setRequired(true).setAutocomplete(true),
    ),
  new SlashCommandBuilder().setName('fork').setDescription('Fork the session from a past user message'),
  new SlashCommandBuilder().setName('fork-subagent').setDescription('Fork a subagent task session into a new thread'),
  new SlashCommandBuilder()
    .setName('btw')
    .setDescription('Ask something without polluting or blocking the current session')
    .addStringOption((option) =>
      option.setName('prompt').setDescription('The message to send in the forked session').setRequired(true),
    ),
  new SlashCommandBuilder().setName('abort').setDescription('Stop the current run and clear the queue'),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Send a message after the current run finishes')
    .addStringOption((option) => option.setName('message').setDescription('The message to queue').setRequired(true)),
  new SlashCommandBuilder()
    .setName('clear-queue')
    .setDescription('Remove queued messages')
    .addIntegerOption((option) => option.setName('position').setDescription('Only this position (1 = next)').setMinValue(1)),
  new SlashCommandBuilder()
    .setName('queue-command')
    .setDescription('Queue an OpenCode command to run after the current run finishes')
    .addStringOption((option) =>
      option.setName('command').setDescription('The command to run').setRequired(true).setAutocomplete(true),
    )
    .addStringOption((option) => option.setName('arguments').setDescription('Arguments to pass to the command')),
  new SlashCommandBuilder().setName('agent').setDescription('Set the agent for this session or channel'),
  new SlashCommandBuilder().setName('model').setDescription('Set the model for this session or channel'),
  new SlashCommandBuilder().setName('model-variant').setDescription('Change the thinking level of the current model'),
  new SlashCommandBuilder().setName('verbosity').setDescription('Set what the bot shows in this channel'),
  new SlashCommandBuilder().setName('compact').setDescription('Compact the session context by summarizing the history'),
  new SlashCommandBuilder().setName('undo').setDescription('Undo the last turn and revert its file changes'),
  new SlashCommandBuilder().setName('redo').setDescription('Redo previously undone changes'),
  new SlashCommandBuilder().setName('diff').setDescription('Show the git diff as a shareable URL'),
  new SlashCommandBuilder().setName('context-usage').setDescription('Show token usage and context window percentage'),
  new SlashCommandBuilder()
    .setName('session-id')
    .setDescription('Show the OpenCode session ID of this thread and how to open it in OpenCode'),
].map((command) => command.setDMPermission(false).toJSON())

export type DynamicCommand =
  | { kind: 'agent'; name: string }
  | { kind: 'command'; name: string }
  | { kind: 'skill'; id: string }

export type Catalog = {
  agents: ReadonlyArray<{ id: string; name: string; description?: string; mode: string; hidden: boolean }>
  commands: ReadonlyArray<{ name: string; description?: string }>
  skills: ReadonlyArray<{ id: string; description?: string }>
}

// Lowercase letters, digits and hyphens; the suffix always survives the 32-char limit.
export function discordCommandName(name: string, suffix: string): string | null {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  if (!base) return null
  return `${base.slice(0, NAME_LIMIT - suffix.length).replace(/-$/, '')}${suffix}`
}

// Pure: the full command list for a guild plus the owner of each dynamic name.
export function buildCommands(catalog: Catalog): {
  commands: RESTPostAPIChatInputApplicationCommandsJSONBody[]
  dynamic: Map<string, DynamicCommand>
  // Commands past the Discord limit that were left out.
  dropped: number
} {
  const taken = new Set(STATIC_COMMANDS.map((command) => command.name))
  const dynamic = new Map<string, DynamicCommand>()
  const commands = [...STATIC_COMMANDS]
  // Every dynamic command has one optional text option.
  const add = ({ name, target, text }: { name: string | null; target: DynamicCommand; text: string }) => {
    if (!name || taken.has(name)) return
    taken.add(name)
    dynamic.set(name, target)
    const builder = new SlashCommandBuilder()
      .setName(name)
      .setDescription(text.replace(/\s+/g, ' ').trim().slice(0, 100) || '-')
      .setDMPermission(false)
    if (target.kind === 'agent') {
      builder
        .addStringOption((option) => option.setName('prompt').setDescription('Send a prompt with this agent'))
        .addStringOption((option) =>
          option.setName('variant').setDescription('Thinking level of the current model').setAutocomplete(true),
        )
    } else {
      builder.addStringOption((option) => option.setName('arguments').setDescription('Arguments to pass to the command'))
    }
    commands.push(builder.toJSON())
  }

  for (const agent of catalog.agents) {
    if (agent.mode === 'subagent' || agent.hidden) continue
    add({
      name: discordCommandName(agent.id, '-agent'),
      target: { kind: 'agent', name: agent.id },
      text: agent.description || `Switch to the ${agent.name} agent`,
    })
  }
  for (const command of catalog.commands) {
    if (SKIPPED_COMMANDS.has(command.name) || command.name.includes(':')) continue
    add({
      name: discordCommandName(command.name, '-cmd'),
      target: { kind: 'command', name: command.name },
      text: command.description || `Run /${command.name}`,
    })
  }
  for (const skill of catalog.skills) {
    add({
      name: discordCommandName(skill.id, '-skill'),
      target: { kind: 'skill', id: skill.id },
      text: skill.description || `Use the ${skill.id} skill`,
    })
  }
  for (const dropped of commands.slice(MAX_COMMANDS)) dynamic.delete(dropped.name)
  return { commands: commands.slice(0, MAX_COMMANDS), dynamic, dropped: Math.max(0, commands.length - MAX_COMMANDS) }
}

export function sessionIdReply({
  sessionId,
  threadId,
  directory,
}: {
  sessionId: string
  threadId: string
  directory: string | null
}): string {
  const attach = directory ? `opencode2 ${shellQuote(directory)} --session ${sessionId}` : `opencode2 --session ${sessionId}`
  return dedent`
    **Session ID:** \`${sessionId}\`
    **Thread ID:** \`${threadId}\`
    **Attach command:**
    \`\`\`bash
    ${attach}
    \`\`\`
  `
}

// Where an interaction happens: the project channel and, in a session
// thread, the thread and its root session.
export type InteractionTarget = {
  channelId: string
  directory: string
  thread: ThreadChannel | null
  sessionId: string | null
}

export type CommandContext = {
  discord: Client
  db: KimakiDb
  store: BotStore
  actions: Actions
  // Reads only (catalogs, history); writes go through actions.
  readClient: () => OpenCodeUnavailableError | OpenCodeClient
  resolveTarget: (channelId: string | null) => Promise<ConfigError | DbError | DiscordError | InteractionTarget>
  replyError: (interaction: RepliableInteraction, error: Error) => Promise<void>
}

type RepliableInteraction = ChatInputCommandInteraction | MessageComponentInteraction | ModalSubmitInteraction

export function authorOf(interaction: { user: { id: string; username: string } }): Author {
  return { id: interaction.user.id, username: interaction.user.username }
}

// Autocomplete choices must never throw; a failed lookup answers with nothing.
export async function respondChoices(
  interaction: AutocompleteInteraction,
  choices: Error | ReadonlyArray<{ name: string; value: string }>,
): Promise<void> {
  if (choices instanceof Error) logger.warn(`autocomplete /${interaction.commandName}: ${choices.message}`)
  const list = choices instanceof Error ? [] : choices.slice(0, 25)
  await interaction.respond(list.map((choice) => ({ name: choice.name.slice(0, 100), value: choice.value.slice(0, 100) }))).catch(() => undefined)
}

export function registerSlashCommands({
  discord,
  db,
  store,
  actions,
  opencode,
  agentUi,
}: {
  discord: Client
  db: KimakiDb
  store: BotStore
  actions: Actions
  opencode: OpencodeConnection
  agentUi: AgentUi
}) {
  // Guild -> Discord name -> OpenCode agent, command or skill, from the last registration.
  const dynamic = new Map<string, ReadonlyMap<string, DynamicCommand>>()

  function readClient() {
    return opencode.endpoint?.client ?? new OpenCodeUnavailableError({ reason: 'not connected' })
  }

  async function catalogFor(directories: readonly string[]): Promise<Catalog> {
    const client = readClient()
    const catalog: { agents: Catalog['agents'][number][]; commands: Catalog['commands'][number][]; skills: Catalog['skills'][number][] } = {
      agents: [],
      commands: [],
      skills: [],
    }
    if (client instanceof Error) return catalog
    for (const directory of directories) {
      const location = { directory }
      const [agents, commands, skills] = await Promise.all([
        client.agent.list({ location }).catch((e) => new OpenCodeError({ operation: 'agent.list', cause: e })),
        client.command.list({ location }).catch((e) => new OpenCodeError({ operation: 'command.list', cause: e })),
        client.skill.list({ location }).catch((e) => new OpenCodeError({ operation: 'skill.list', cause: e })),
      ])
      // Union by name: the first project that has a name wins.
      if (agents instanceof Error) logger.warn(agents.message)
      else catalog.agents.push(...agents.data.filter((agent) => catalog.agents.every((known) => known.id !== agent.id)))
      if (commands instanceof Error) logger.warn(commands.message)
      else catalog.commands.push(...commands.data.filter((command) => catalog.commands.every((known) => known.name !== command.name)))
      if (skills instanceof Error) logger.warn(skills.message)
      else catalog.skills.push(...skills.data.filter((skill) => catalog.skills.every((known) => known.id !== skill.id)))
    }
    return catalog
  }

  // Last commands set per guild: an unchanged list is not sent again (Discord
  // limits command creates to 200 per day per guild).
  const registered = new Map<string, string>()

  async function registerGuild(guild: Guild): Promise<void> {
    const rows = await db.query.channel_directories
      .findMany({ where: { channel_type: 'text' } })
      .catch((e) => new DbError({ operation: 'read channel_directories', cause: e }))
    if (rows instanceof Error) {
      logger.warn(rows.message)
      return
    }
    // Rows from before guild_id was stored belong to any guild.
    const directories = [...new Set(rows.filter((row) => !row.guild_id || row.guild_id === guild.id).map((row) => row.directory))]
    const built = buildCommands(await catalogFor(directories))
    if (refresh.closed) return
    const signature = JSON.stringify(built.commands)
    if (registered.get(guild.id) === signature) {
      dynamic.set(guild.id, built.dynamic)
      return
    }
    if (built.dropped > 0) {
      logger.warn(`${built.commands.length + built.dropped} commands exceed the Discord limit of ${MAX_COMMANDS}; ${built.dropped} dropped`)
    }
    const result = await discord.application?.commands
      .set(built.commands, guild.id)
      .catch((e) => new DiscordError({ operation: `register commands in ${guild.id}`, cause: e }))
    if (result instanceof Error) {
      logger.warn(result.message)
      return
    }
    registered.set(guild.id, signature)
    dynamic.set(guild.id, built.dynamic)
    logger.log(`registered ${built.commands.length} commands in guild ${guild.id}`)
  }

  async function resolveTarget(channelId: string | null): Promise<ConfigError | DbError | DiscordError | InteractionTarget> {
    if (!channelId) return new ConfigError({ reason: 'This command can only be used in a channel' })
    const channel = await discord.channels
      .fetch(channelId)
      .catch((e) => new DiscordError({ operation: `fetch channel ${channelId}`, cause: e }))
    if (channel instanceof Error) return channel
    const thread = channel?.isThread() && channel.type !== ChannelType.AnnouncementThread ? channel : null
    const projectChannelId = thread ? thread.parentId : channel?.type === ChannelType.GuildText ? channel.id : null
    if (!projectChannelId) return new ConfigError({ reason: 'This command can only be used in text channels or threads' })
    const row = await db.query.channel_directories
      .findFirst({ where: { channel_id: projectChannelId } })
      .catch((e) => new DbError({ operation: 'read channel_directories', cause: e }))
    if (row instanceof Error) return row
    if (!row) return new ConfigError({ reason: 'This channel is not configured with a project directory' })
    const sessionId = thread ? (store.getState().roots[thread.id] ?? null) : null
    return { channelId: projectChannelId, directory: row.directory, thread, sessionId }
  }

  async function replyError(interaction: RepliableInteraction, error: Error) {
    logger.error(`interaction ${interaction.id} failed: ${error.message}`)
    // Config errors are messages for the user, the rest are failures.
    const content = error instanceof ConfigError ? error.message : formatError(error.message)
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content, components: [] }).catch(() => undefined)
      return
    }
    await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined)
  }

  const context: CommandContext = { discord, db, store, actions, readClient, resolveTarget, replyError }
  const sessions = createSessionCommands(context)
  const preferences = createPreferenceCommands(context)
  const questions = createQuestionHandlers({ store, actions })
  const login = createLoginCommands(context)

  // The session thread of a command, or a reply saying where it works.
  async function sessionTarget(interaction: ChatInputCommandInteraction) {
    const target = await resolveTarget(interaction.channelId)
    if (target instanceof Error) {
      await replyError(interaction, target)
      return null
    }
    if (!target.thread || !target.sessionId) {
      await interaction.reply({ content: 'Use this command in a thread with a Kimaki session', flags: MessageFlags.Ephemeral })
      return null
    }
    return { ...target, thread: target.thread, sessionId: target.sessionId }
  }

  // An input from a command: a prompt in the thread, or a new session in a channel.
  async function sendInput({
    interaction,
    route,
    echo,
    model = null,
  }: {
    interaction: ChatInputCommandInteraction
    route: Exclude<Route, { kind: 'btw' | 'new-session' | 'queue' }>
    echo: string
    // A model for this session only (`/<agent>-agent variant:`).
    model?: ModelChoice | null
  }) {
    const target = await resolveTarget(interaction.channelId)
    if (target instanceof Error) return replyError(interaction, target)
    const author = authorOf(interaction)
    if (target.thread && target.sessionId) {
      // The visible reply stands in for the user message.
      await interaction.reply({ content: formatEcho({ username: author.username, text: echo }), allowedMentions: { parse: [] } })
      const reply = await interaction.fetchReply().catch((e: Error) => e)
      if (reply instanceof Error) return replyError(interaction, reply)
      if (model) {
        const switched = await actions.switchModel({ sessionId: target.sessionId, model })
        if (switched instanceof Error) return replyError(interaction, switched)
      }
      const result = await actions.dispatch({ thread: target.thread, route, author, messageId: reply.id })
      if (result instanceof Error) return replyError(interaction, result)
      return
    }
    if (target.thread) {
      await interaction.reply({ content: 'Use this command in a thread with a Kimaki session', flags: MessageFlags.Ephemeral })
      return
    }
    await interaction.deferReply()
    const started = await actions.startSession({
      channelId: target.channelId,
      directory: target.directory,
      route,
      author,
      messageId: interaction.id,
      startMessageId: null,
      ...(model && { model }),
    })
    if (started instanceof Error) return replyError(interaction, started)
    await interaction.editReply({ content: `Started a new session in <#${started.threadId}>` })
  }

  async function handleDynamic(interaction: ChatInputCommandInteraction, target: DynamicCommand) {
    const text = (interaction.options.getString(target.kind === 'agent' ? 'prompt' : 'arguments') ?? '').trim()
    if (target.kind === 'agent') {
      const variant = interaction.options.getString('variant')?.trim()
      const where = await resolveTarget(interaction.channelId)
      if (where instanceof Error) return replyError(interaction, where)
      const model = variant ? await preferences.variantModel({ target: where, variant }) : null
      if (model instanceof Error) return replyError(interaction, model)
      if (!text) return preferences.applyAgent({ interaction, target: where, agent: target.name, model })
      const label = model ? `${target.name}, ${model.variant}` : target.name
      return sendInput({ interaction, route: { kind: 'steer', text, agent: target.name }, echo: `(${label}) ${text}`, model })
    }
    if (target.kind === 'skill') {
      return sendInput({ interaction, route: { kind: 'skill', id: target.id, arguments: text }, echo: `/${target.id} ${text}`.trim() })
    }
    return sendInput({
      interaction,
      route: { kind: 'command', name: target.name, arguments: text, queue: false },
      echo: `/${target.name} ${text}`.trim(),
    })
  }

  async function handleSessionId(interaction: ChatInputCommandInteraction) {
    const channel = interaction.channel
    const resolved = channel?.isThread() ? await resolveSession({ db, id: channel.id }) : null
    if (!resolved || resolved instanceof Error) {
      await interaction.reply({ content: 'Run /session-id inside a Kimaki session thread.', flags: MessageFlags.Ephemeral })
      return
    }
    const parent = channel?.isThread() ? channel.parentId : null
    const project = parent ? await db.query.channel_directories.findFirst({ where: { channel_id: parent } }) : null
    await interaction.reply({
      content: sessionIdReply({ ...resolved, directory: project?.directory ?? null }),
      flags: MessageFlags.Ephemeral,
    })
  }

  async function handleDiff(interaction: ChatInputCommandInteraction) {
    const target = await resolveTarget(interaction.channelId)
    if (target instanceof Error) return replyError(interaction, target)
    await interaction.deferReply()
    const status = await execFileAsync('git', ['status', '--porcelain'], { cwd: target.directory, timeout: 10_000 }).catch(
      (e) => new DiscordError({ operation: 'git status', cause: e }),
    )
    if (status instanceof Error) return replyError(interaction, new ConfigError({ reason: 'This project is not a git repository' }))
    if (!status.stdout.trim()) {
      await interaction.editReply({ content: 'No changes to show' })
      return
    }
    const title = `${path.basename(target.directory)}: Discord /diff`
    const upload = await execFileAsync('critique', ['--web', title, '--json'], { cwd: target.directory, timeout: 30_000 }).catch(
      (e: NodeJS.ErrnoException & { stdout?: string }) => e,
    )
    if (upload instanceof Error && upload.code === 'ENOENT') {
      return replyError(interaction, new ConfigError({ reason: 'critique is not installed. Install it with: npm i -g critique' }))
    }
    const output = upload instanceof Error ? (upload.stdout ?? '') : upload.stdout
    const result = parseCritiqueOutput(output)
    if (!result) return replyError(interaction, new ConfigError({ reason: `critique failed: ${output.slice(0, 200) || 'no output'}` }))
    if (!result.ok) return replyError(interaction, new ConfigError({ reason: result.error }))
    const embed = new EmbedBuilder().setTitle(title).setURL(result.url).setImage(`https://critique.work/og/${result.id}.png`)
    await interaction.editReply({ embeds: [embed] })
  }

  async function handleContextUsage(interaction: ChatInputCommandInteraction) {
    const target = await sessionTarget(interaction)
    if (!target) return
    const client = readClient()
    if (client instanceof Error) return replyError(interaction, client)
    await interaction.deferReply()
    const [info, messages, models] = await Promise.all([
      client.session.get({ sessionID: target.sessionId }).catch((e) => new OpenCodeError({ operation: 'session.get', cause: e })),
      client.message
        .list({ sessionID: target.sessionId, type: 'assistant', order: 'desc', limit: 20 })
        .catch((e) => new OpenCodeError({ operation: 'message.list', cause: e })),
      client.model.list({ location: { directory: target.directory } }).catch((e) => new OpenCodeError({ operation: 'model.list', cause: e })),
    ])
    if (info instanceof Error) return replyError(interaction, info)
    if (messages instanceof Error) return replyError(interaction, messages)
    const last = messages.data.find((message) => message.type === 'assistant' && message.tokens)
    if (!last || last.type !== 'assistant' || !last.tokens) {
      await interaction.editReply({ content: 'Token usage not available for this session yet' })
      return
    }
    const { tokens, model } = last
    const total = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
    const limit = models instanceof Error ? null : models.data.find((candidate) => candidate.providerID === model.providerID && candidate.id === model.id)?.limit.context
    const formatted = total.toLocaleString('en-US')
    const lines = [
      limit
        ? `**Context usage:** ${Math.round((total / limit) * 100)}%, ${formatted} / ${limit.toLocaleString('en-US')} tokens`
        : `**Context usage:** ${formatted} tokens (context limit unavailable)`,
      `**Model:** ${model.providerID}/${model.id}`,
      ...(info.cost > 0 ? [`**Session cost:** $${info.cost.toFixed(4)}`] : []),
    ]
    await interaction.editReply({ content: lines.join('\n') })
  }

  async function handleThreadCommand(interaction: ChatInputCommandInteraction) {
    const target = await sessionTarget(interaction)
    if (!target) return
    const { thread } = target
    const author = authorOf(interaction)
    switch (interaction.commandName) {
      case 'abort': {
        await interaction.deferReply()
        const result = await actions.abort({ threadId: thread.id })
        if (result instanceof Error) return replyError(interaction, result)
        const note = result.cleared > 0 ? `, cleared ${result.cleared} queued message${result.cleared > 1 ? 's' : ''}` : ''
        await interaction.editReply({ content: `Request **aborted**${note}` })
        return
      }
      case 'queue':
      case 'queue-command': {
        const name = interaction.options.getString('command')?.trim().replace(/^\//, '') ?? ''
        const args = (interaction.options.getString('arguments') ?? '').trim()
        const echo = name ? `/${name} ${args}`.trim() : interaction.options.getString('message', true).trim()
        const route: Route = name ? { kind: 'command', name, arguments: args, queue: true } : { kind: 'queue', text: echo }
        // The visible reply stands in for the user message: the ack replies to it.
        await interaction.reply({ content: formatEcho({ username: author.username, text: echo }), allowedMentions: { parse: [] } })
        const reply = await interaction.fetchReply().catch((e: Error) => e)
        if (reply instanceof Error) return replyError(interaction, reply)
        const result = await actions.dispatch({ thread, route, author, messageId: reply.id })
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
      case 'compact': {
        await interaction.deferReply()
        const result = await actions.compact({ threadId: thread.id })
        if (result instanceof Error) return replyError(interaction, result)
        await interaction.editReply({ content: 'Compacting the session context' })
        return
      }
      case 'undo': {
        await interaction.deferReply()
        const result = await actions.undo({ threadId: thread.id })
        if (result instanceof Error) return replyError(interaction, result)
        if (!result.reverted) {
          await interaction.editReply({ content: 'No messages to undo' })
          return
        }
        const files = result.reverted.files > 0 ? `\nReverted ${result.reverted.files} file(s)` : ''
        await interaction.editReply({ content: `Undone - reverted the last turn${files}` })
        return
      }
      case 'redo': {
        await interaction.deferReply()
        const result = await actions.redo({ threadId: thread.id })
        if (result instanceof Error) return replyError(interaction, result)
        const content = {
          nothing: 'Nothing to redo - no previous undo found',
          all: 'Restored - session fully back to its previous state',
          step: 'Restored one step forward',
        }[result.restored]
        await interaction.editReply({ content })
        return
      }
      case 'context-usage':
        return handleContextUsage(interaction)
    }
  }

  async function handleCommand(interaction: ChatInputCommandInteraction) {
    const name = interaction.commandName
    if (name === 'login') return login.handle(interaction)
    if (name === 'session-id') return handleSessionId(interaction)
    if (name === 'diff') return handleDiff(interaction)
    if (sessions.commands.has(name)) return sessions.handle(interaction)
    if (preferences.commands.has(name)) return preferences.handle(interaction)
    const target = interaction.guildId ? dynamic.get(interaction.guildId)?.get(name) : undefined
    if (target) return handleDynamic(interaction, target)
    return handleThreadCommand(interaction)
  }

  async function handleAutocomplete(interaction: AutocompleteInteraction) {
    if (sessions.commands.has(interaction.commandName)) return sessions.autocomplete(interaction)
    const agentCommand = interaction.guildId ? dynamic.get(interaction.guildId)?.get(interaction.commandName) : undefined
    if (agentCommand?.kind === 'agent') {
      const where = await resolveTarget(interaction.channelId)
      if (where instanceof Error) return respondChoices(interaction, where)
      return respondChoices(interaction, await preferences.variantChoices(where, interaction.options.getFocused()))
    }
    if (interaction.commandName !== 'queue-command') return respondChoices(interaction, [])
    const target = await resolveTarget(interaction.channelId)
    if (target instanceof Error) return respondChoices(interaction, target)
    const client = readClient()
    if (client instanceof Error) return respondChoices(interaction, client)
    const commands = await client.command
      .list({ location: { directory: target.directory } })
      .catch((e) => new OpenCodeError({ operation: 'command.list', cause: e }))
    if (commands instanceof Error) return respondChoices(interaction, commands)
    const query = interaction.options.getFocused().toLowerCase()
    return respondChoices(
      interaction,
      commands.data
        .filter((command) => !SKIPPED_COMMANDS.has(command.name) && command.name.toLowerCase().includes(query))
        .map((command) => ({ name: `/${command.name}${command.description ? ` - ${command.description}` : ''}`, value: command.name })),
    )
  }

  async function handle(interaction: Interaction) {
    if (!interaction.guildId) return
    const channel = interaction.channel ?? (interaction.channelId ? await discord.channels.fetch(interaction.channelId).catch(() => null) : null)
    const projectId = channel?.isThread() ? channel.parentId : channel?.id
    if (!projectId || !(await db.query.channel_directories.findFirst({ where: { channel_id: projectId } }))) return
    const guild = interaction.guild ?? (await discord.guilds.fetch(interaction.guildId).catch(() => null))
    if (!guild || !(await canUseKimaki({ guild, userId: interaction.user.id }))) {
      if (interaction.isAutocomplete()) return respondChoices(interaction, [])
      if (interaction.isRepliable()) {
        await interaction.reply({ content: 'You do not have permission to use Kimaki', flags: MessageFlags.Ephemeral })
      }
      return
    }
    const credentialCommand = (interaction.isChatInputCommand() && interaction.commandName === 'login') || ('customId' in interaction && interaction.customId.startsWith('login_'))
    if (credentialCommand && guild.ownerId !== interaction.user.id) {
      const member = await guild.members.fetch(interaction.user.id).catch(() => null)
      if (!member?.permissions.has(PermissionFlagsBits.Administrator)) {
        if (interaction.isRepliable()) await interaction.reply({ content: 'Provider login requires the server owner or an administrator', flags: MessageFlags.Ephemeral })
        return
      }
    }
    if (interaction.isChatInputCommand()) return handleCommand(interaction)
    if (interaction.isAutocomplete()) return handleAutocomplete(interaction)
    if (interaction.isButton() && interaction.customId.startsWith('login_')) return login.click(interaction)
    if (interaction.isButton() && /^(action_button|file_upload_btn):/.test(interaction.customId)) return agentUi.click(interaction)
    if (interaction.isModalSubmit() && interaction.customId.startsWith('file_upload_modal:')) return agentUi.modal(interaction)
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('login_')) return login.select(interaction)
    if (interaction.isModalSubmit() && interaction.customId.startsWith('login_')) return login.modal(interaction)
    if (interaction.isButton() && interaction.customId.startsWith(PERMISSION_PREFIX)) {
      return handlePermissionButton({ interaction, store, actions })
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith(FORM_SELECT_PREFIX)) {
      return questions.handleSelect(interaction)
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith(FORM_OTHER_PREFIX)) {
      return questions.handleOther(interaction)
    }
    if (interaction.isStringSelectMenu() && sessions.ownsSelect(interaction.customId)) return sessions.handleSelect(interaction)
    if (interaction.isStringSelectMenu() && preferences.ownsSelect(interaction.customId)) return preferences.handleSelect(interaction)
  }

  discord.on(Events.InteractionCreate, (interaction) => {
    handle(interaction).catch((error: Error) => logger.error(`interaction failed: ${error.message}`))
  })
  // OpenCode loads agents, commands and skills lazily (config, plugins, files),
  // so the catalog read at startup can be incomplete. Every registration goes
  // through register(): one pass at a time, and a request made during a pass
  // runs one more pass, so an older catalog read never overwrites a newer one.
  const refresh: { timer: ReturnType<typeof setTimeout> | null; active: Promise<void> | null; dirty: boolean; closed: boolean } = {
    timer: null,
    active: null,
    dirty: false,
    closed: false,
  }

  // Bulk overwrite of every guild's commands from the current OpenCode catalog.
  function register(): Promise<void> {
    refresh.dirty = true
    if (refresh.active) return refresh.active
    const pass = (async () => {
      try {
        while (refresh.dirty && !refresh.closed) {
          refresh.dirty = false
          await Promise.all([...discord.guilds.cache.values()].map((guild) => registerGuild(guild)))
        }
      } finally {
        refresh.active = null
      }
    })()
    refresh.active = pass
    return pass
  }

  discord.on(Events.GuildCreate, () => void register())

  return {
    registerAll: register,
    // The catalog may have changed: register again soon (one trailing pass per window).
    // `force` also resends lists that look unchanged, to repair commands removed in Discord.
    scheduleRefresh({ force }: { force: boolean }): void {
      if (force) registered.clear()
      if (refresh.closed || refresh.timer) return
      refresh.timer = setTimeout(() => {
        refresh.timer = null
        register().catch((e: Error) => logger.warn(`command refresh failed: ${e.message}`))
      }, CATALOG_REFRESH_MS)
    },
    // Waits for a running pass so nothing writes after Discord is destroyed.
    async stop(): Promise<void> {
      refresh.closed = true
      if (refresh.timer) clearTimeout(refresh.timer)
      refresh.timer = null
      await refresh.active?.catch(() => undefined)
    },
  }
}

// critique --json prints { url, id } or { error } on one stdout line.
export function parseCritiqueOutput(output: string): { ok: true; url: string; id: string } | { ok: false; error: string } | null {
  for (const line of output.trim().split('\n')) {
    if (!line.startsWith('{')) continue
    const parsed = errore.try(
      () => {
        const value: unknown = JSON.parse(line)
        return { value }
      },
      (cause) => new ConfigError({ reason: 'invalid critique output', cause }),
    )
    if (parsed instanceof Error || typeof parsed.value !== 'object' || parsed.value === null) continue
    const fields = new Map<string, unknown>(Object.entries(parsed.value))
    const error = fields.get('error')
    const url = fields.get('url')
    const id = fields.get('id')
    if (typeof error === 'string') return { ok: false, error }
    if (typeof url === 'string' && typeof id === 'string') return { ok: true, url, id }
  }
  return null
}
