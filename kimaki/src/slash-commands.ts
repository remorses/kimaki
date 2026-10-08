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
// Dynamic commands come from the global OpenCode catalog: one location (the
// Kimaki data dir) that has no project config, so every guild gets the same
// list. Project-only entries stay reachable through /agent, /command, /skill.
//
//   agent.list    primary agents  ─▶ /<agent>-agent prompt?
//   command.list  commands        ─▶ /<cmd>-cmd arguments?
//   skill.list    skills          ─▶ /<skill>-skill arguments?
//
// Like the OpenCode TUI (client/src/solid/data.ts), the catalog is re-read
// when agent/command/skill.updated arrive, and after every reconnect (events
// sent while disconnected are lost):
//
//   agent|command|skill.updated ─▶ read catalog ─▶ buildCommands ─▶ PUT guild commands (if changed)
//   server.connected            ─┘
//
// Commands with a colon get no slash command. OpenCode names MCP prompts
// "server:prompt" and command.list has no source field, so the colon is the
// only way to leave them out. They still run as `/server:prompt args`
// messages and from /queue-command.
//
// Discord allows 100 commands per guild; skills are cut first.

import path from 'node:path'
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
import { ConfigError, DiscordError } from './errors.ts'
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
import { catalogReady, startSession } from './sessions.ts'

const logger = createLogger('COMMANDS')

const MAX_COMMANDS = 100
const NAME_LIMIT = 32
const CATALOG_EVENTS: ReadonlySet<string> = new Set(['server.connected', 'agent.updated', 'command.updated', 'skill.updated'])

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
    catalogRoutes(),
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

async function readCatalog(bot: Pick<Bot, 'opencode'>, directory: string): Promise<Error | Catalog> {
  // Waits for plugin activation, so a cold location returns its full catalog.
  const ready = await catalogReady(bot, directory)
  if (ready instanceof Error) return ready
  const location = { directory }
  const [agents, commands, skills] = await Promise.all([
    oc(bot, 'agent.list', (client) => client.agent.list({ location })),
    oc(bot, 'command.list', (client) => client.command.list({ location })),
    oc(bot, 'skill.list', (client) => client.skill.list({ location })),
  ])
  if (agents instanceof Error) return agents
  if (commands instanceof Error) return commands
  if (skills instanceof Error) return skills
  return { agents: agents.data, commands: commands.data, skills: skills.data }
}

// Autocomplete keeps the whole project catalog reachable beyond Discord's shortcut limit.
function catalogRoutes(): InteractionRoutes {
  const commands: Record<string, SlashCommand> = {}
  for (const kind of ['command', 'skill'] as const) {
    const entries = async (bot: Bot, directory: string) => {
      const location = { directory }
      if (kind === 'skill') {
        const skills = await oc(bot, 'skill.list', (client) => client.skill.list({ location }))
        if (skills instanceof Error) return skills
        return skills.data.map((skill) => ({ name: skill.id, description: skill.description }))
      }
      const list = await oc(bot, 'command.list', (client) => client.command.list({ location }))
      if (list instanceof Error) return list
      return list.data.filter((command) => !SKIPPED_COMMANDS.has(command.name))
    }
    commands[kind] = {
      definition: new SlashCommandBuilder()
        .setName(kind)
        .setDescription(`Run any OpenCode ${kind} in this project`)
        .addStringOption((option) => option.setName('name').setDescription(`${kind} name`).setRequired(true).setAutocomplete(true))
        .addStringOption((option) => option.setName('arguments').setDescription(`Arguments to pass to the ${kind}`)),
      async autocomplete(bot, interaction) {
        const where = await resolveTarget(bot, interaction.channelId)
        if (where instanceof Error) return respondChoices(interaction, where)
        const list = await entries(bot, where.directory)
        if (list instanceof Error) return respondChoices(interaction, list)
        const query = interaction.options.getFocused().toLowerCase()
        return respondChoices(interaction, list.filter((entry) => entry.name.toLowerCase().includes(query)).map((entry) => ({
          name: `/${entry.name}${entry.description ? ` - ${entry.description}` : ''}`,
          value: entry.name,
        })))
      },
      async run(bot, interaction) {
        const where = await resolveTarget(bot, interaction.channelId)
        if (where instanceof Error) return replyError(interaction, where)
        const list = await entries(bot, where.directory)
        if (list instanceof Error) return replyError(interaction, list)
        const name = interaction.options.getString('name', true).trim().replace(/^\//, '')
        if (!list.some((entry) => entry.name === name)) return replyError(interaction, new ConfigError({ reason: `Unknown ${kind} \`${name}\`. Use /${kind} autocomplete to select one.` }))
        const args = (interaction.options.getString('arguments') ?? '').trim()
        return sendInput(bot, {
          interaction,
          route: kind === 'skill' ? { kind, id: name, arguments: args } : { kind, name, arguments: args, queue: false },
          echo: `/${name} ${args}`.trim(),
        })
      },
    }
  }
  return { commands }
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

  // Sorted: the same catalog always keeps the same commands under the limit,
  // whatever order OpenCode lists them in.
  const sorted = <T>(items: readonly T[], key: (item: T) => string) =>
    items.toSorted((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
  for (const agent of sorted(catalog.agents, (agent) => agent.id)) {
    if (agent.mode === 'subagent' || agent.hidden) continue
    add({
      name: discordCommandName(agent.id, '-agent'),
      target: { kind: 'agent', name: agent.id },
      text: agent.description || `Switch to the ${agent.name} agent`,
    })
  }
  for (const command of sorted(catalog.commands, (command) => command.name)) {
    if (SKIPPED_COMMANDS.has(command.name) || command.name.includes(':')) continue
    add({
      name: discordCommandName(command.name, '-cmd'),
      target: { kind: 'command', name: command.name },
      text: command.description || `Run /${command.name}`,
    })
  }
  for (const skill of sorted(catalog.skills, (skill) => skill.id)) {
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
    if (model && !(route.kind === 'steer' && route.agent)) {
      const switched = await switchModel(bot, { sessionId: target.sessionId, model })
      if (switched instanceof Error) return replyError(interaction, switched)
    }
    const result = await dispatch(bot, { thread: target.thread, route, author, messageId: reply.id, model })
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
    const model = variant ? await variantModel(bot, { target: where, variant, agent: target.name }) : null
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
  const { discord } = bot
  // Guild -> Discord name -> OpenCode agent, command or skill, from the last registration.
  const dynamic = new Map<string, ReadonlyMap<string, DynamicCommand>>()
  // A location with no project config: its catalog is the global one.
  const globalDirectory = path.resolve(bot.dataDir)

  // Last commands set per guild: an unchanged list is not sent again (Discord
  // limits command creates to 200 per day per guild).
  const registered = new Map<string, string>()

  async function registerGuild(guild: Guild, built: ReturnType<typeof buildCommands>): Promise<void> {
    const signature = JSON.stringify(built.commands)
    if (registered.get(guild.id) === signature) {
      dynamic.set(guild.id, built.dynamic)
      return
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
    const target = dynamicCommand(interaction)
    if (target?.kind !== 'agent') return respondChoices(interaction, [])
    const where = await resolveTarget(bot, interaction.channelId)
    if (where instanceof Error) return respondChoices(interaction, where)
    return respondChoices(interaction, await variantChoices(bot, { target: where, query: interaction.options.getFocused(), agent: target.name }))
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
          const read = await readCatalog(bot, globalDirectory)
          if (passes.closed) return
          if (read instanceof Error) {
            // The next catalog event or reconnect retries.
            logger.warn(`global catalog: ${read.message}${read.cause instanceof Error ? `: ${read.cause.message}` : ''}`)
            return
          }
          const built = buildCommands({ fixed: registry.definitions, catalog: read })
          if (built.dropped > 0) {
            logger.log(`${built.dropped} catalog shortcuts do not fit in Discord's 100 commands; all entries remain available through /agent, /command and /skill`)
          }
          await Promise.all([...discord.guilds.cache.values()].map((guild) => registerGuild(guild, built)))
        }
      } finally {
        passes.active = null
      }
    })()
    passes.active = pass
    return pass
  }

  discord.on(Events.GuildCreate, () => void registerAll())
  // agent/command/skill.updated are ephemeral hints (no payload) sent on every
  // catalog change of one location: plugin activation after a cold boot, edited
  // skill or agent files. Events of any location count: OpenCode unloads idle
  // locations, so a global change may only show up in a project location.
  // server.connected follows each reconnect: hints sent while disconnected are lost.
  const unsubscribe = bot.opencode.subscribe((event) => {
    if (CATALOG_EVENTS.has(event.type)) void registerAll()
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
