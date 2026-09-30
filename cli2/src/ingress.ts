// Discord ingress (spec 4): gates every messageCreate, parses it into a Route
// and calls actions. Gates, in order: bots (including ourselves), channel
// ownership (only channels mapped in this machine's SQLite), permission.
// Messages of one channel are handled in arrival order.
//
// Edits and deletes of messages that sit in the queue update the queue.

import { Events, GuildMember, PermissionFlagsBits, type Client, type Guild, type Message } from 'discord.js'

import type { Actions } from './actions.ts'
import type { KimakiDb } from './db.ts'
import { formatError } from './format-parts.ts'
import { createLogger } from './logger.ts'
import { handleQueuedMessageDelete, handleQueuedMessageEdit } from './queue.ts'
import { parseTextMessage } from './routes.ts'
import type { BotStore } from './store.ts'

const logger = createLogger('INGRESS')

// Owner, Administrator, Manage Server, or a role named "Kimaki". A role named
// "no-kimaki" always denies. Missing member data fails closed.
export async function canUseKimaki({ guild, userId }: { guild: Guild; userId: string }): Promise<boolean> {
  const member = await guild.members.fetch(userId).catch(() => null)
  if (!(member instanceof GuildMember)) return false
  const roleNames = member.roles.cache.map((role) => role.name.toLowerCase())
  if (roleNames.includes('no-kimaki')) return false
  if (guild.ownerId === userId) return true
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true
  return roleNames.includes('kimaki')
}

export function registerIngress({
  discord,
  db,
  store,
  actions,
}: {
  discord: Client
  db: KimakiDb
  store: BotStore
  actions: Actions
}) {
  const chains = new Map<string, Promise<void>>()

  async function handle(message: Message) {
    const channel = message.channel
    const thread = channel.isThread() ? channel : null
    const channelId = thread ? thread.parentId : channel.id
    if (!channelId || !message.guild) return

    const project = await db.query.channel_directories.findFirst({ where: { channel_id: channelId } })
    if (!project || project.channel_type !== 'text') return
    if (!(await canUseKimaki({ guild: message.guild, userId: message.author.id }))) {
      logger.log(`ignoring ${message.author.username}: no Kimaki permission`)
      return
    }
    const route = parseTextMessage({ content: message.content })
    if (!route) return
    const author = { id: message.author.id, username: message.author.username }

    if (!thread) {
      // A channel message starts a session; its text is the first prompt as is.
      const started = await actions.startSession({
        channelId,
        directory: project.directory,
        text: message.content.trim(),
        author,
        messageId: message.id,
      })
      if (started instanceof Error) {
        logger.error(`start session failed: ${started.message}`)
        await message.reply(formatError(started.message)).catch(() => undefined)
      }
      return
    }

    if (!store.getState().roots[thread.id]) return
    const result = await actions.dispatch({ thread, route, author, messageId: message.id })
    if (result instanceof Error) {
      logger.error(`${route.kind} failed: ${result.message}`)
      await message.reply(formatError(result.message)).catch(() => undefined)
      return
    }
    if (route.kind === 'btw' && result) {
      await message.reply(`Session forked! Continue in <#${result.threadId}>`).catch(() => undefined)
    }
  }

  function serialize(channelId: string, task: () => Promise<void>) {
    const previous = chains.get(channelId) ?? Promise.resolve()
    const next = previous.then(() => task().catch((error: Error) => logger.error(`ingress failed: ${error.message}`)))
    chains.set(channelId, next)
  }

  discord.on(Events.MessageCreate, (message) => {
    if (message.author.bot) return
    serialize(message.channelId, () => handle(message))
  })
  discord.on(Events.MessageDelete, (message) => {
    serialize(message.channelId, () => handleQueuedMessageDelete({ message, store, actions }))
  })
  discord.on(Events.MessageUpdate, (_old, message) => {
    if (message.author?.bot) return
    serialize(message.channelId, async () => {
      const full = message.partial ? await message.fetch().catch(() => null) : message
      if (full) await handleQueuedMessageEdit({ message: full, store, actions })
    })
  })
}
