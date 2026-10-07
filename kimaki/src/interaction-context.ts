// What every interaction handler shares: the route table types each feature
// exports, where an interaction happens (project channel, session thread),
// who sent it, and the error and autocomplete replies. Feature files import
// this module, never slash-commands.ts, which only combines their tables.
//
//   feature file ─▶ InteractionRoutes { commands, buttons, selects, modals }
//   slash-commands.ts ─▶ one name lookup per command, one prefix lookup per component kind

import {
  ChannelType,
  MessageFlags,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
  type StringSelectMenuInteraction,
  type ThreadChannel,
} from 'discord.js'

import { projectOf, sessionDirectory, type Author, type Bot } from './bot.ts'
import { ConfigError, DiscordError } from './errors.ts'
import { formatError, SILENT_MESSAGE_FLAGS } from './format-parts.ts'
import { createLogger } from './logger.ts'
import { formatEcho } from './queue.ts'

const logger = createLogger('COMMANDS')

// --- Route tables

export type InteractionHandler<I> = (bot: Bot, interaction: I) => Promise<unknown>

export type SlashCommand = {
  // A SlashCommandBuilder (or its JSON) whose name is the table key.
  definition: { toJSON(): RESTPostAPIChatInputApplicationCommandsJSONBody }
  run: InteractionHandler<ChatInputCommandInteraction>
  autocomplete?: InteractionHandler<AutocompleteInteraction>
}

// One feature's interactions. Component tables are keyed by custom ID prefix.
export type InteractionRoutes = {
  // Only the server owner or an administrator may use any of these (bot-wide secrets).
  admin?: boolean
  commands?: Readonly<Record<string, SlashCommand>>
  buttons?: Readonly<Record<string, InteractionHandler<ButtonInteraction>>>
  selects?: Readonly<Record<string, InteractionHandler<StringSelectMenuInteraction>>>
  modals?: Readonly<Record<string, InteractionHandler<ModalSubmitInteraction>>>
}

// --- Context

// Where an interaction happens: the project channel and, in a session
// thread, the thread and its root session.
export type InteractionTarget = {
  channelId: string
  directory: string
  thread: ThreadChannel | null
  sessionId: string | null
  projectDirectory: string
}

export function authorOf(interaction: { user: { id: string; username: string } }): Author {
  return { id: interaction.user.id, username: interaction.user.username }
}

export async function resolveTarget(bot: Bot, channelId: string | null): Promise<Error | InteractionTarget> {
  if (!channelId) return new ConfigError({ reason: 'This command can only be used in a channel' })
  const channel = await bot.discord.channels
    .fetch(channelId)
    .catch((cause) => new DiscordError({ operation: `fetch channel ${channelId}`, cause }))
  if (channel instanceof Error) return channel
  const thread = channel?.isThread() && channel.type !== ChannelType.AnnouncementThread ? channel : null
  const projectChannelId = thread ? thread.parentId : channel?.type === ChannelType.GuildText ? channel.id : null
  if (!projectChannelId) return new ConfigError({ reason: 'This command can only be used in text channels or threads' })
  const row = await projectOf(bot, projectChannelId)
  if (row instanceof Error) return row
  if (!row) return new ConfigError({ reason: 'This channel is not configured with a project directory' })
  const sessionId = thread ? (bot.store.getState().roots[thread.id] ?? null) : null
  const directory = sessionId ? await sessionDirectory(bot, sessionId) : row.directory
  if (directory instanceof Error) return directory
  return { channelId: projectChannelId, directory, projectDirectory: row.directory, thread, sessionId }
}

export type SessionTarget = InteractionTarget & { thread: ThreadChannel; sessionId: string }

// The session thread of a command, or null after a reply saying where it works.
export async function sessionTarget(bot: Bot, interaction: ChatInputCommandInteraction): Promise<SessionTarget | null> {
  const target = await resolveTarget(bot, interaction.channelId)
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

// --- Replies

export async function replyError(
  interaction: ChatInputCommandInteraction | MessageComponentInteraction | ModalSubmitInteraction,
  error: Error,
) {
  logger.error(`interaction ${interaction.id} failed: ${error.message}`)
  // Config errors are messages for the user, the rest are failures.
  const content = error instanceof ConfigError ? error.message : formatError(error.message)
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content, components: [] }).catch(() => undefined)
    return
  }
  await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => undefined)
}

// The visible reply stands in for the user message: acks and prompts point at its ID.
export async function replyWithEcho(interaction: ChatInputCommandInteraction, { author, text }: { author: Author; text: string }) {
  await interaction.reply({ content: formatEcho({ username: author.username, text }), allowedMentions: { parse: [] }, flags: SILENT_MESSAGE_FLAGS })
  return interaction.fetchReply().catch((e: Error) => e)
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
