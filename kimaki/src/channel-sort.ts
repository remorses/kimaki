// `kimaki --sort-channels`: the channels of this machine's "Kimaki <machine>"
// category are sorted by the last user interaction, latest first. A user
// message or interaction (slash command, button, select, modal) in a channel
// or one of its threads moves that channel to the top. Discord stores the
// positions, so the order needs no SQLite state and survives restarts.
//
// Touches collect for delayMs, then one PATCH /guilds/{id}/channels sends the
// new order (skipped when it did not change). Discord does not publish the
// rate limit of that route and sends a CHANNEL_UPDATE per moved channel.

import { ChannelType, discordSort, Events, MessageType, type Channel, type Guild, type Interaction, type Message, type NonThreadGuildBasedChannel } from 'discord.js'

import type { Bot } from './bot.ts'
import { DbError, DiscordError } from './errors.ts'
import { createLogger } from './logger.ts'

const logger = createLogger('SORT')
export const SORT_CHANNELS_DELAY_MS = 10_000

// Discord lists these together in a category; voice and stage channels sort below them.
const SORTED_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia])

// The recently touched channels first (latest first), then the rest in their current order.
function sortedChannelIds({ current, recent }: { current: readonly string[]; recent: readonly string[] }): string[] {
  const top = recent.filter((id) => current.includes(id))
  return [...top, ...current.filter((id) => !top.includes(id))]
}

async function sortGuild(bot: Bot, { guild, recent }: { guild: Guild; recent: readonly string[] }) {
  const row = await bot.db.query.guild_categories
    .findFirst({ where: { guild_id: guild.id } })
    .catch((cause) => new DbError({ operation: 'read guild_categories', cause }))
  if (row instanceof Error) return row
  const categoryId = row?.category_id
  if (!categoryId) return
  const siblings = discordSort(
    guild.channels.cache.filter((channel): channel is NonThreadGuildBasedChannel => channel.parentId === categoryId && SORTED_TYPES.has(channel.type)),
  )
  const current = [...siblings.keys()]
  const next = sortedChannelIds({ current, recent })
  if (next.every((id, index) => id === current[index])) return
  // Positions only order siblings: keep this category's channels near their old numbers.
  const base = Math.min(...siblings.map((channel) => channel.rawPosition))
  const updated = await guild.channels
    .setPositions(next.map((id, index) => ({ channel: id, position: base + index })))
    .catch((cause) => new DiscordError({ operation: `sort channels of category ${categoryId}`, cause }))
  if (updated instanceof Error) return updated
  logger.log(`moved ${next[0]} to the top of category ${categoryId}`)
}

// Registers the listeners. Returns the cleanup for main.ts.
export function registerChannelSort(bot: Bot, { delayMs }: { delayMs: number }) {
  // Per guild, the touched channel IDs, latest first.
  const pending = new Map<string, string[]>()
  const timer: { current: NodeJS.Timeout | null } = { current: null }
  const running = { current: Promise.resolve() }

  async function flush() {
    timer.current = null
    const batch = [...pending.entries()]
    pending.clear()
    for (const [guildId, recent] of batch) {
      const guild = bot.discord.guilds.cache.get(guildId)
      if (!guild) continue
      const result = await sortGuild(bot, { guild, recent })
      if (result instanceof Error) logger.warn(`cannot sort channels`, result)
    }
  }

  function touch(channel: Channel | null) {
    if (!channel || channel.isDMBased()) return
    const channelId = channel.isThread() ? channel.parentId : channel.id
    if (!channelId) return
    const recent = (pending.get(channel.guildId) ?? []).filter((id) => id !== channelId)
    pending.set(channel.guildId, [channelId, ...recent])
    if (timer.current) return
    // Flushes run one at a time, in touch order.
    timer.current = setTimeout(() => {
      running.current = running.current.then(flush)
    }, delayMs)
  }

  const onMessage = (message: Message) => {
    if (message.author.bot || message.webhookId) return
    if (message.type !== MessageType.Default && message.type !== MessageType.Reply) return
    touch(message.channel)
  }
  const onInteraction = (interaction: Interaction) => {
    if (interaction.isAutocomplete() || interaction.user.bot) return
    touch(interaction.channel)
  }
  bot.discord.on(Events.MessageCreate, onMessage)
  bot.discord.on(Events.InteractionCreate, onInteraction)
  return () => {
    bot.discord.off(Events.MessageCreate, onMessage)
    bot.discord.off(Events.InteractionCreate, onInteraction)
    if (timer.current) clearTimeout(timer.current)
    return running.current
  }
}
