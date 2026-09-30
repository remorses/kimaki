// Discord ingress (spec 4): gates every messageCreate, parses it into a Route
// and calls actions. Gates, in order: bots (including ourselves), channel
// ownership (only channels mapped in this machine's SQLite), permission.
// Messages of one channel are handled in arrival order.

import {
  ChannelType,
  Events,
  GuildMember,
  PermissionFlagsBits,
  type Client,
  type Message,
} from 'discord.js'

import type { Actions } from './actions.ts'
import type { KimakiDb } from './db.ts'
import { formatError } from './format-parts.ts'
import { createLogger } from './logger.ts'
import { parseTextMessage } from './routes.ts'

const logger = createLogger('INGRESS')

function isThreadType(type: ChannelType): boolean {
  return type === ChannelType.PublicThread || type === ChannelType.PrivateThread
}

// Owner, Administrator, Manage Server, or a role named "Kimaki". A role named
// "no-kimaki" always denies. Missing member data fails closed.
async function hasKimakiPermission(message: Message): Promise<boolean> {
  const guild = message.guild
  if (!guild) return false
  const member = message.member ?? (await guild.members.fetch(message.author.id).catch(() => null))
  if (!(member instanceof GuildMember)) return false
  const roleNames = member.roles.cache.map((role) => role.name.toLowerCase())
  if (roleNames.includes('no-kimaki')) return false
  if (guild.ownerId === message.author.id) return true
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true
  return roleNames.includes('kimaki')
}

export function registerIngress({ discord, db, actions }: { discord: Client; db: KimakiDb; actions: Actions }) {
  const chains = new Map<string, Promise<void>>()

  async function handle(message: Message) {
    const channel = message.channel
    const inThread = isThreadType(channel.type)
    const channelId = inThread && 'parentId' in channel ? channel.parentId : channel.id
    if (!channelId) return

    const project = await db.query.channel_directories.findFirst({ where: { channel_id: channelId } })
    if (!project || project.channel_type !== 'text') return
    if (!(await hasKimakiPermission(message))) {
      logger.log(`ignoring ${message.author.username}: no Kimaki permission`)
      return
    }
    const route = parseTextMessage({ content: message.content })
    if (!route) return
    const author = { id: message.author.id, username: message.author.username }

    if (!inThread) {
      const started = await actions.startSession({
        channelId,
        directory: project.directory,
        text: route.text,
        author,
        messageId: message.id,
      })
      if (started instanceof Error) {
        logger.error(`start session failed: ${started.message}`)
        await message.reply(formatError(started.message)).catch(() => undefined)
      }
      return
    }

    const binding = await db.query.thread_sessions.findFirst({ where: { thread_id: channel.id } })
    if (!binding) return
    const sent = await actions.send({
      threadId: channel.id,
      threadName: 'name' in channel ? (channel.name ?? '') : '',
      sessionId: binding.session_id,
      text: route.text,
      author,
      messageId: message.id,
    })
    if (sent instanceof Error) {
      logger.error(`send failed: ${sent.message}`)
      await message.reply(formatError(sent.message)).catch(() => undefined)
    }
  }

  discord.on(Events.MessageCreate, (message) => {
    if (message.author.bot) return
    const key = message.channelId
    const previous = chains.get(key) ?? Promise.resolve()
    const next = previous.then(() =>
      handle(message).catch((error: Error) => logger.error(`ingress failed: ${error.message}`)),
    )
    chains.set(key, next)
  })
}
