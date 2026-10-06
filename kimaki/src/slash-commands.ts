// Slash commands and component interactions (spec 14). Registered per guild
// with one bulk overwrite (guild-scoped route: gateway-proxy rejects global
// application command routes). Every interaction passes the same permission
// gate as messages, then goes to its handler with one lookup:
//
//   feature files ─▶ InteractionRoutes ─▶ createInteractionRegistry (this file)
//   chat command  ─▶ commands[name]  (else a dynamic command below)
//   button        ─▶ buttons[prefix]   select ─▶ selects[prefix]   modal ─▶ modals[prefix]
//
// Handlers only collect input and call the writers (prompt.ts, sessions.ts,
// ...); session output comes from events.
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

import {
  Events,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type Interaction,
  type ModalSubmitInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  type StringSelectMenuInteraction,
} from 'discord.js'

import { agentUiRoutes } from './agent-ui.ts'
import { oc, projectOf, type Bot, type ModelChoice } from './bot.ts'
import { createLoginRoutes } from './commands/login-commands.ts'
import { applyAgent, createPreferenceRoutes, switchModel, variantChoices, variantModel } from './commands/preference-commands.ts'
import { sessionRoutes } from './commands/session-commands.ts'
import { SKIPPED_COMMANDS, threadRoutes } from './commands/thread-commands.ts'
import { worktreeRoutes } from './commands/worktree-commands.ts'
import { DbError, DiscordError } from './errors.ts'
import { canUseKimaki } from './ingress.ts'
import {
  authorOf,
  replyError,
  replyWithEcho,
  resolveTarget,
  respondChoices,
  sessionTarget,
  type InteractionHandler,
  type InteractionRoutes,
  type SlashCommand,
} from './interaction-context.ts'
import { createLogger } from './logger.ts'
import { permissionRoutes } from './permissions.ts'
import { dispatch } from './prompt.ts'
import { createQuestionHandlers } from './questions.ts'
import type { Route } from './routes.ts'
import { taskRoutes } from './scheduler.ts'
import { startSession } from './sessions.ts'

const logger = createLogger('COMMANDS')

const MAX_COMMANDS = 100
const NAME_LIMIT = 32

// --- The registry: every feature's tables, combined once per bot.

type PrefixRoute<I> = { prefix: string; run: InteractionHandler<I>; admin: boolean }

export type InteractionRegistry = {
  commands: ReadonlyMap<string, SlashCommand & { admin: boolean }>
  // Static command JSON in table order; registered before the dynamic ones.
  definitions: readonly RESTPostAPIChatInputApplicationCommandsJSONBody[]
  buttons: ReadonlyArray<PrefixRoute<ButtonInteraction>>
  selects: ReadonlyArray<PrefixRoute<StringSelectMenuInteraction>>
  modals: ReadonlyArray<PrefixRoute<ModalSubmitInteraction>>
}

function prefixRoutes<I>(
  features: readonly InteractionRoutes[],
  table: (feature: InteractionRoutes) => Readonly<Record<string, InteractionHandler<I>>> | undefined,
): Array<PrefixRoute<I>> {
  const routes = features.flatMap((feature) =>
    Object.entries(table(feature) ?? {}).map(([prefix, run]) => ({ prefix, run, admin: feature.admin === true })),
  )
  const prefixes = routes.map((route) => route.prefix)
  const duplicate = prefixes.find((prefix, index) => prefixes.indexOf(prefix) !== index)
  if (duplicate !== undefined) throw new Error(`Two interaction routes use the custom ID prefix ${duplicate}`)
  // Longest first: a prefix that starts another prefix never hides it.
  return routes.sort((a, b) => b.prefix.length - a.prefix.length)
}

function byPrefix<I>(routes: ReadonlyArray<PrefixRoute<I>>, customId: string): PrefixRoute<I> | null {
  return routes.find((route) => customId.startsWith(route.prefix)) ?? null
}

export function combineRoutes(features: readonly InteractionRoutes[]): InteractionRegistry {
  const commands = new Map<string, SlashCommand & { admin: boolean }>()
  const definitions: RESTPostAPIChatInputApplicationCommandsJSONBody[] = []
  for (const feature of features) {
    for (const [name, command] of Object.entries(feature.commands ?? {})) {
      const json = command.definition.toJSON()
      if (json.name !== name) throw new Error(`Slash command ${json.name} is registered under ${name}`)
      if (commands.has(name)) throw new Error(`Two features define /${name}`)
      commands.set(name, { ...command, admin: feature.admin === true })
      definitions.push({ ...json, dm_permission: false })
    }
  }
  return {
    commands,
    definitions,
    buttons: prefixRoutes(features, (feature) => feature.buttons),
    selects: prefixRoutes(features, (feature) => feature.selects),
    modals: prefixRoutes(features, (feature) => feature.modals),
  }
}

// One per bot: the wizard and form features keep per-bot state in their closures.
export function createInteractionRegistry(): InteractionRegistry {
  return combineRoutes([
    worktreeRoutes,
    createLoginRoutes(),
    sessionRoutes,
    threadRoutes,
    createPreferenceRoutes(),
    taskRoutes,
    agentUiRoutes,
    permissionRoutes,
    createQuestionHandlers(),
  ])
}

// --- Dynamic commands

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

// Pure: the full command list for a guild (the fixed commands first) plus the owner of each dynamic name.
export function buildCommands({ fixed, catalog }: { fixed: readonly RESTPostAPIChatInputApplicationCommandsJSONBody[]; catalog: Catalog }): {
  commands: RESTPostAPIChatInputApplicationCommandsJSONBody[]
  dynamic: Map<string, DynamicCommand>
  // Commands past the Discord limit that were left out.
  dropped: number
} {
  const taken = new Set(fixed.map((command) => command.name))
  const dynamic = new Map<string, DynamicCommand>()
  const commands = [...fixed]
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

// An input from a command: a prompt in the thread, or a new session in a channel.
async function sendInput(
  bot: Bot,
  {
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
  },
) {
  const target = await resolveTarget(bot, interaction.channelId)
  if (target instanceof Error) return replyError(interaction, target)
  const author = authorOf(interaction)
  if (target.thread && target.sessionId) {
    const reply = await replyWithEcho(interaction, { author, text: echo })
    if (reply instanceof Error) return replyError(interaction, reply)
    if (model) {
      const switched = await switchModel(bot, { sessionId: target.sessionId, model })
      if (switched instanceof Error) return replyError(interaction, switched)
    }
    const result = await dispatch(bot, { thread: target.thread, route, author, messageId: reply.id })
    if (result instanceof Error) return replyError(interaction, result)
    return
  }
  if (target.thread) {
    await interaction.reply({ content: 'Use this command in a thread with a Kimaki session', flags: MessageFlags.Ephemeral })
    return
  }
  await interaction.deferReply()
  const started = await startSession(bot, {
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

async function handleDynamic(bot: Bot, { interaction, target }: { interaction: ChatInputCommandInteraction; target: DynamicCommand }) {
  const text = (interaction.options.getString(target.kind === 'agent' ? 'prompt' : 'arguments') ?? '').trim()
  if (target.kind === 'agent') {
    const variant = interaction.options.getString('variant')?.trim()
    const where = await resolveTarget(bot, interaction.channelId)
    if (where instanceof Error) return replyError(interaction, where)
    const model = variant ? await variantModel(bot, { target: where, variant }) : null
    if (model instanceof Error) return replyError(interaction, model)
    if (!text) return applyAgent(bot, { interaction, target: where, agent: target.name, model })
    const label = model ? `${target.name}, ${model.variant}` : target.name
    return sendInput(bot, { interaction, route: { kind: 'steer', text, agent: target.name }, echo: `(${label}) ${text}`, model })
  }
  if (target.kind === 'skill') {
    return sendInput(bot, { interaction, route: { kind: 'skill', id: target.id, arguments: text }, echo: `/${target.id} ${text}`.trim() })
  }
  return sendInput(bot, {
    interaction,
    route: { kind: 'command', name: target.name, arguments: text, queue: false },
    echo: `/${target.name} ${text}`.trim(),
  })
}

// --- Listener and registration

// Registers the interaction listener and keeps every guild's commands in line
// with the OpenCode catalog. Returns registerAll and stop.
export function registerSlashCommands(bot: Bot, registry: InteractionRegistry) {
  const { discord, db } = bot
  // Guild -> Discord name -> OpenCode agent, command or skill, from the last registration.
  const dynamic = new Map<string, ReadonlyMap<string, DynamicCommand>>()

  async function catalogFor(directories: readonly string[]): Promise<Catalog> {
    const catalog: { agents: Catalog['agents'][number][]; commands: Catalog['commands'][number][]; skills: Catalog['skills'][number][] } = {
      agents: [],
      commands: [],
      skills: [],
    }
    for (const directory of directories) {
      const location = { directory }
      const [agents, commands, skills] = await Promise.all([
        oc(bot, 'agent.list', (client) => client.agent.list({ location })),
        oc(bot, 'command.list', (client) => client.command.list({ location })),
        oc(bot, 'skill.list', (client) => client.skill.list({ location })),
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
    const built = buildCommands({ fixed: registry.definitions, catalog: await catalogFor(directories) })
    if (passes.closed) return
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

  function dynamicCommand(interaction: { guildId: string | null; commandName: string }) {
    return interaction.guildId ? dynamic.get(interaction.guildId)?.get(interaction.commandName) : undefined
  }

  async function runCommand(interaction: ChatInputCommandInteraction) {
    const command = registry.commands.get(interaction.commandName)
    if (command) return command.run(bot, interaction)
    const target = dynamicCommand(interaction)
    if (target) return handleDynamic(bot, { interaction, target })
    // A catalog command removed since the last registration: only told where commands work.
    await sessionTarget(bot, interaction)
  }

  async function autocomplete(interaction: AutocompleteInteraction) {
    const command = registry.commands.get(interaction.commandName)
    if (command?.autocomplete) return command.autocomplete(bot, interaction)
    if (dynamicCommand(interaction)?.kind !== 'agent') return respondChoices(interaction, [])
    const where = await resolveTarget(bot, interaction.channelId)
    if (where instanceof Error) return respondChoices(interaction, where)
    return respondChoices(interaction, await variantChoices(bot, { target: where, query: interaction.options.getFocused() }))
  }

  // Provider logins and audio keys are secrets of the whole bot.
  function adminOnly(interaction: Interaction): boolean {
    if (interaction.isChatInputCommand() || interaction.isAutocomplete()) return registry.commands.get(interaction.commandName)?.admin === true
    if (interaction.isButton()) return byPrefix(registry.buttons, interaction.customId)?.admin === true
    if (interaction.isStringSelectMenu()) return byPrefix(registry.selects, interaction.customId)?.admin === true
    if (interaction.isModalSubmit()) return byPrefix(registry.modals, interaction.customId)?.admin === true
    return false
  }

  async function handle(interaction: Interaction) {
    if (!interaction.guildId) return
    const channel = interaction.channel ?? (interaction.channelId ? await discord.channels.fetch(interaction.channelId).catch(() => null) : null)
    const projectId = channel?.isThread() ? channel.parentId : channel?.id
    const project = projectId ? await projectOf(bot, projectId) : null
    if (project instanceof Error) return logger.warn(project.message)
    if (!project) return
    const guild = interaction.guild ?? (await discord.guilds.fetch(interaction.guildId).catch(() => null))
    if (!guild || !(await canUseKimaki({ guild, userId: interaction.user.id }))) {
      if (interaction.isAutocomplete()) return respondChoices(interaction, [])
      if (interaction.isRepliable()) {
        await interaction.reply({ content: 'You do not have permission to use Kimaki', flags: MessageFlags.Ephemeral })
      }
      return
    }
    if (adminOnly(interaction) && guild.ownerId !== interaction.user.id) {
      const member = await guild.members.fetch(interaction.user.id).catch(() => null)
      if (!member?.permissions.has(PermissionFlagsBits.Administrator)) {
        if (interaction.isRepliable()) await interaction.reply({ content: 'Provider login requires the server owner or an administrator', flags: MessageFlags.Ephemeral })
        return
      }
    }
    if (interaction.isChatInputCommand()) return runCommand(interaction)
    if (interaction.isAutocomplete()) return autocomplete(interaction)
    if (interaction.isButton()) return byPrefix(registry.buttons, interaction.customId)?.run(bot, interaction)
    if (interaction.isStringSelectMenu()) return byPrefix(registry.selects, interaction.customId)?.run(bot, interaction)
    if (interaction.isModalSubmit()) return byPrefix(registry.modals, interaction.customId)?.run(bot, interaction)
  }

  discord.on(Events.InteractionCreate, (interaction) => {
    handle(interaction).catch((error: Error) => logger.error(`interaction failed: ${error.message}`))
  })
  // One registration pass at a time; a request made during a pass runs one more
  // pass, so an older catalog read never overwrites a newer one.
  const passes: { active: Promise<void> | null; dirty: boolean; closed: boolean } = { active: null, dirty: false, closed: false }

  // Brings every guild's commands in line with the current OpenCode catalog.
  function registerAll(): Promise<void> {
    passes.dirty = true
    if (passes.active) return passes.active
    const pass = (async () => {
      try {
        while (passes.dirty && !passes.closed) {
          passes.dirty = false
          await Promise.all([...discord.guilds.cache.values()].map((guild) => registerGuild(guild)))
        }
      } finally {
        passes.active = null
      }
    })()
    passes.active = pass
    return pass
  }

  discord.on(Events.GuildCreate, () => void registerAll())
  // agent/command/skill.updated are ephemeral hints (no payload). OpenCode sends
  // them while a location loads (a cold start returns an incomplete catalog) and
  // when skill files change, so a pass re-reads the lists and Discord is only
  // written when the resulting commands differ.
  const unsubscribe = bot.opencode.subscribe((event) => {
    if (event.type === 'agent.updated' || event.type === 'command.updated' || event.type === 'skill.updated') void registerAll()
  })

  return {
    registerAll,
    // Waits for a running pass so nothing writes after Discord is destroyed.
    async stop(): Promise<void> {
      unsubscribe()
      passes.closed = true
      await passes.active
    },
  }
}
