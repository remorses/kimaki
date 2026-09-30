// Slash commands. Registered per guild (guild-scoped route: gateway-proxy
// rejects global application command routes). Phase 6 adds the rest; for now
// only /session-id, which gives the IDs and commands needed to debug a thread.

import {
  Events,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
} from 'discord.js'
import dedent from 'string-dedent'

import type { KimakiDb } from './db.ts'
import { DiscordError } from './errors.ts'
import { createLogger } from './logger.ts'
import { resolveSession } from './session-events.ts'

const logger = createLogger('COMMANDS')

const COMMANDS = [
  new SlashCommandBuilder()
    .setName('session-id')
    .setDescription('Show the OpenCode session ID of this thread and how to debug it'),
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

export function registerSlashCommands({ discord, db, kimaki }: { discord: Client; db: KimakiDb; kimaki: string }) {
  discord.on(Events.GuildCreate, (guild) => void registerGuild({ discord, guild }))
  for (const guild of discord.guilds.cache.values()) void registerGuild({ discord, guild })

  discord.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) return
    if (interaction.commandName !== 'session-id') return
    void handleSessionId({ interaction, db, kimaki }).catch((error: Error) =>
      logger.error(`/session-id failed: ${error.message}`),
    )
  })
}
