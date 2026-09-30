// Project channels: one Discord text channel per directory, inside the
// "Kimaki <bot>" category, mapped in channel_directories. Uses only the
// Discord REST API (guild-scoped routes), so the same code runs in the bot
// (onboarding) and in `kimaki project add` while the bot keeps running: the
// bot reads channel_directories on every message and the Guilds intent
// delivers CHANNEL_CREATE, so a new channel works without a restart.

import path from 'node:path'
import { API } from '@discordjs/core/http-only'
import { ChannelType, REST, type RESTPostAPIGuildChannelJSONBody } from 'discord.js'

import type { KimakiDb } from './db.ts'
import { ConfigError, DbError, DiscordError } from './errors.ts'
import * as schema from './schema.ts'

// Typed Discord REST calls (the discord.js REST client returns unknown).
export function createApi({ token, restUrl }: { token: string; restUrl?: string | null }): API {
  return new API(new REST({ version: '10', ...(restUrl && { api: restUrl }) }).setToken(token))
}

// Discord channel names: lowercase, [a-z0-9-], max 100 chars.
export function channelNameFor(name: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100)
  return sanitized || 'project'
}

// V1 names: "Kimaki" category and "kimaki" channel, with the bot name for
// self-hosted bots not called "kimaki". The shared gateway bot is always "kimaki".
export function defaultNames({ botName, gateway }: { botName: string; gateway: boolean }) {
  const plain = gateway || botName.toLowerCase() === 'kimaki'
  return {
    category: plain ? 'Kimaki' : `Kimaki ${botName}`,
    channel: plain ? 'kimaki' : channelNameFor(`kimaki-${botName}`),
  }
}

export function defaultProjectDirectory({ dataDir }: { dataDir: string }): string {
  return path.join(dataDir, 'projects', 'kimaki')
}

// The guild of this machine's channels. `project add` needs one: the flag, or
// the only guild that already has mapped channels.
export async function resolveGuildId({
  db,
  guildId,
}: {
  db: KimakiDb
  guildId?: string
}): Promise<DbError | ConfigError | string> {
  if (guildId) return guildId
  const rows = await db.query.channel_directories
    .findMany()
    .catch((e) => new DbError({ operation: 'read channel_directories', cause: e }))
  if (rows instanceof Error) return rows
  const guilds = [...new Set(rows.flatMap((row) => (row.guild_id ? [row.guild_id] : [])))]
  if (guilds.length === 1) return guilds[0]!
  if (guilds.length === 0) return new ConfigError({ reason: 'No Kimaki channels yet. Start the bot once to onboard.' })
  return new ConfigError({ reason: `Channels exist in several servers (${guilds.join(', ')}). Pass --guild <id>.` })
}

async function ensureCategory({
  api,
  db,
  guildId,
  name,
}: {
  api: API
  db: KimakiDb
  guildId: string
  name: string
}): Promise<DbError | DiscordError | string> {
  const stored = await db.query.guild_categories
    .findFirst({ where: { guild_id: guildId } })
    .catch((e) => new DbError({ operation: 'read guild_categories', cause: e }))
  if (stored instanceof Error) return stored
  const channels = await api.guilds
    .getChannels(guildId)
    .catch((e) => new DiscordError({ operation: 'list guild channels', cause: e }))
  if (channels instanceof Error) return channels
  const categories = channels.filter((channel) => channel.type === ChannelType.GuildCategory)
  const existing =
    categories.find((channel) => channel.id === stored?.category_id) ??
    categories.find((channel) => channel.name === name)
  const categoryId = await (async () => {
    if (existing) return existing.id
    const body: RESTPostAPIGuildChannelJSONBody = { name, type: ChannelType.GuildCategory }
    const created = await api.guilds
      .createChannel(guildId, body)
      .catch((e) => new DiscordError({ operation: 'create category', cause: e }))
    if (created instanceof Error) return created
    return created.id
  })()
  if (categoryId instanceof Error) return categoryId
  if (stored?.category_id === categoryId) return categoryId
  const saved = await db
    .insert(schema.guild_categories)
    .values({ guild_id: guildId, category_id: categoryId })
    .onConflictDoUpdate({ target: schema.guild_categories.guild_id, set: { category_id: categoryId } })
    .catch((e) => new DbError({ operation: 'save guild_categories', cause: e }))
  if (saved instanceof Error) return saved
  return categoryId
}

export type ProjectChannel = { channelId: string; name: string; directory: string; created: boolean }

// Self-hosted bots name their category after the bot. Read through a
// guild-scoped route: gateway-proxy only forwards those, and @discordjs/core
// encodes "@me" as "%40me", which proxies may not match.
export async function categoryNameFor({
  api,
  guildId,
  botId,
  gateway,
}: {
  api: API
  guildId: string
  botId: string
  gateway: boolean
}): Promise<DiscordError | string> {
  if (gateway) return defaultNames({ botName: 'kimaki', gateway }).category
  const member = await api.guilds
    .getMember(guildId, botId)
    .catch((e) => new DiscordError({ operation: 'read bot member', cause: e }))
  if (member instanceof Error) return member
  return defaultNames({ botName: member.user.username, gateway }).category
}

// Idempotent: a directory already mapped in this guild returns its channel.
export async function addProjectChannel({
  api,
  db,
  guildId,
  directory,
  name,
  topic,
  categoryName,
}: {
  api: API
  db: KimakiDb
  guildId: string
  directory: string
  name?: string
  topic?: string
  // Used only when the stored category is gone: defaultNames().category.
  categoryName: string
}): Promise<DbError | DiscordError | ProjectChannel> {
  const existing = await db.query.channel_directories
    .findFirst({ where: { directory, guild_id: guildId, channel_type: 'text' } })
    .catch((e) => new DbError({ operation: 'read channel_directories', cause: e }))
  if (existing instanceof Error) return existing
  if (existing) return { channelId: existing.channel_id, name: '', directory, created: false }

  const categoryId = await ensureCategory({ api, db, guildId, name: categoryName })
  if (categoryId instanceof Error) return categoryId

  const body: RESTPostAPIGuildChannelJSONBody = {
    name: name ?? channelNameFor(path.basename(directory)),
    type: ChannelType.GuildText,
    parent_id: categoryId,
    ...(topic && { topic }),
  }
  const channel = await api.guilds
    .createChannel(guildId, body)
    .catch((e) => new DiscordError({ operation: 'create channel', cause: e }))
  if (channel instanceof Error) return channel
  const saved = await db
    .insert(schema.channel_directories)
    .values({ channel_id: channel.id, directory, channel_type: 'text', guild_id: guildId })
    .catch((e) => new DbError({ operation: 'insert channel_directories', cause: e }))
  if (saved instanceof Error) return saved
  return { channelId: channel.id, name: channel.name ?? body.name, directory, created: true }
}

export async function listProjects({ db }: { db: KimakiDb }) {
  return db.query.channel_directories
    .findMany({ where: { channel_type: 'text' }, orderBy: { created_at: 'asc' } })
    .catch((e) => new DbError({ operation: 'read channel_directories', cause: e }))
}
