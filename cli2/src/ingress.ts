// Discord ingress (spec 4): gates every messageCreate, parses it into a Route
// and calls actions. Gates, in order: bots (including ourselves), channel
// ownership (only channels mapped in this machine's SQLite), permission.
// Messages of one channel are handled in arrival order.
//
// Attachments become prompt files; voice messages are transcribed into the
// same Route as text. Edits and deletes of queued messages update the queue.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  Events,
  GuildMember,
  PermissionFlagsBits,
  type Attachment,
  type Client,
  type Guild,
  type Message,
} from 'discord.js'
import * as errore from 'errore'

import { parseSendInput, REMOTE_SEND_PREFIX, REMOTE_RESULT_PREFIX, type Actions, type PromptFile } from './actions.ts'
import type { KimakiDb } from './db.ts'
import { formatError } from './format-parts.ts'
import { createLogger } from './logger.ts'
import { formatEcho, handleQueuedMessageDelete, handleQueuedMessageEdit, queuedItemFor } from './queue.ts'
import { parseTextMessage, type Route } from './routes.ts'
import type { BotStore } from './store.ts'
import { isVoiceAttachment, parseVoiceMessage, type AttachmentLike, type Transcriber } from './voice.ts'

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

// Attachments are saved under <dataDir>/attachments/<messageId>/ and sent as
// file:// URIs; OpenCode reads them into the prompt (images are resized there).
async function saveAttachments({
  dataDir,
  messageId,
  attachments,
}: {
  dataDir: string
  messageId: string
  attachments: readonly Attachment[]
}): Promise<AttachmentError | PromptFile[]> {
  if (attachments.length === 0) return []
  const directory = path.join(dataDir, 'attachments', messageId)
  const created = await fs.promises
    .mkdir(directory, { recursive: true })
    .catch((e) => new AttachmentError({ file: directory, cause: e }))
  if (created instanceof Error) return created
  const saved: PromptFile[] = []
  for (const [index, attachment] of attachments.entries()) {
    const bytes = await download(attachment.url)
    if (bytes instanceof Error) return bytes
    // Index prefix: two attachments may share a name.
    const file = path.join(directory, `${index}-${path.basename(attachment.name) || 'attachment'}`)
    const written = await fs.promises
      .writeFile(file, bytes)
      .catch((e) => new AttachmentError({ file: attachment.name, cause: e }))
    if (written instanceof Error) return written
    saved.push({ uri: pathToFileURL(file).href, name: attachment.name })
  }
  return saved
}

class AttachmentError extends errore.createTaggedError({
  name: 'AttachmentError',
  message: 'Could not download attachment $file',
}) {}

async function download(url: string): Promise<AttachmentError | Buffer> {
  const response = await fetch(url).catch((e) => new AttachmentError({ file: url, cause: e }))
  if (response instanceof Error) return response
  if (!response.ok) return new AttachmentError({ file: `${url} (HTTP ${response.status})` })
  const body = await response.arrayBuffer().catch((e) => new AttachmentError({ file: url, cause: e }))
  if (body instanceof Error) return body
  return Buffer.from(body)
}

function attachmentLike(attachment: Attachment): AttachmentLike {
  return {
    contentType: attachment.contentType,
    name: attachment.name,
    duration: attachment.duration,
    waveform: attachment.waveform,
    width: attachment.width,
    height: attachment.height,
  }
}

export function registerIngress({
  discord,
  db,
  store,
  actions,
  transcriber,
  dataDir,
}: {
  discord: Client
  db: KimakiDb
  store: BotStore
  actions: Actions
  transcriber: Transcriber
  dataDir: string
}) {
  const chains = new Map<string, Promise<void>>()

  // Voice: transcribe first. The transcription picks the route (spec 9.4).
  async function voiceRoute({
    message,
    attachment,
    directory,
    inSession,
  }: {
    message: Message
    attachment: Attachment
    directory: string
    inSession: boolean
  }): Promise<Error | Route> {
    const audio = await download(attachment.url)
    if (audio instanceof Error) return audio
    const agents = await actions.primaryAgents({ directory })
    if (agents instanceof Error) return agents
    const result = await transcriber.transcribe({
      audio,
      mediaType: attachment.contentType ?? 'audio/ogg',
      directory,
      agents,
      inSession,
    })
    if (result instanceof Error) return result
    logger.log(`voice message ${message.id} -> ${result.route}${result.agent ? ` (${result.agent})` : ''}`)
    return parseVoiceMessage(result)
  }

  async function handle(message: Message) {
    const channel = message.channel
    const thread = channel.isThread() ? channel : null
    const channelId = thread ? thread.parentId : channel.id
    if (!channelId || !message.guild) return

    const project = await db.query.channel_directories.findFirst({ where: { channel_id: channelId } })
    if (!project || project.channel_type !== 'text') return
    if (message.author.bot) {
      if (message.author.id !== discord.user?.id) return
      const footer = message.embeds[0]?.footer?.text
      if (!footer?.startsWith(REMOTE_SEND_PREFIX)) return
      const decoded = errore.try(() => ({ value: JSON.parse(footer.slice(REMOTE_SEND_PREFIX.length)) as unknown }), (cause) => new AttachmentError({ file: 'remote envelope', cause }))
      if (decoded instanceof Error) return
      const value = decoded.value
      if (!value || typeof value !== 'object' || !('requestId' in value) || typeof value.requestId !== 'string' || !/^[0-9a-f]{16}$/.test(value.requestId) || !('options' in value) || !value.options || typeof value.options !== 'object' || Array.isArray(value.options)) return
      const input = parseSendInput({ ...value.options, ...(thread ? { threadId: thread.id } : { channelId }), prompt: message.content })
      const files = await saveAttachments({ dataDir, messageId: message.id, attachments: [...message.attachments.values()] })
      const result = input instanceof Error ? input : files instanceof Error ? files : await actions.send({ ...input, files }, true)
      await message.reply({ content: result instanceof Error ? result.message : `Delivered to <#${result.threadId}>`, embeds: [{ footer: { text: `${REMOTE_RESULT_PREFIX}${value.requestId}:${JSON.stringify(result instanceof Error ? { error: result.message } : result)}` } }], allowedMentions: { parse: [] } }).catch((error: Error) => logger.warn(`remote acknowledgment: ${error.message}`))
      return
    }
    if (!(await canUseKimaki({ guild: message.guild, userId: message.author.id }))) {
      logger.log(`ignoring ${message.author.username}: no Kimaki permission`)
      return
    }
    const inSession = thread ? Boolean(store.getState().roots[thread.id]) : false
    if (thread && !inSession) return
    const author = { id: message.author.id, username: message.author.username }
    const reportError = async (error: Error) => {
      logger.error(`message ${message.id} failed: ${error.message}`)
      await message.reply(formatError(error.message)).catch(() => undefined)
    }

    const attachments = [...message.attachments.values()]
    const voice = attachments.find((attachment) => isVoiceAttachment(attachmentLike(attachment)))
    const files = await saveAttachments({
      dataDir,
      messageId: message.id,
      attachments: attachments.filter((attachment) => attachment !== voice),
    })
    if (files instanceof Error) return reportError(files)
    const route = voice
      ? await voiceRoute({ message, attachment: voice, directory: project.directory, inSession })
      : (parseTextMessage({ content: message.content }) ?? (files.length > 0 ? { kind: 'steer' as const, text: '' } : null))
    if (route instanceof Error) return reportError(route)
    if (!route) return
    // The transcription is not visible anywhere else.
    if (voice && thread && route.kind !== 'shell' && route.kind !== 'command' && route.kind !== 'skill') {
      await message.reply({ content: formatEcho({ username: author.username, text: route.text }), allowedMentions: { parse: [] } })
    }

    if (!thread) {
      // A channel message starts a session. Queue and btw need one to wait
      // for or fork from: here they are plain prompts.
      const first = route.kind === 'shell' || route.kind === 'command' || route.kind === 'skill' ? route : { ...route, kind: 'steer' as const }
      const started = await actions.startSession({
        channelId,
        directory: project.directory,
        route: first,
        author,
        messageId: message.id,
        showInput: Boolean(voice),
        files,
      })
      if (started instanceof Error) return reportError(started)
      return
    }

    const result = await actions.dispatch({ thread, route, author, messageId: message.id, files })
    if (result instanceof Error) return reportError(result)
    if (!result) return
    const note =
      route.kind === 'btw' ? `Session forked! Continue in <#${result.threadId}>` : `Started a new session in <#${result.threadId}>`
    await message.reply(note).catch(() => undefined)
  }

  function serialize(channelId: string, task: () => Promise<void>) {
    const previous = chains.get(channelId) ?? Promise.resolve()
    const next = previous.then(() => task().catch((error: Error) => logger.error(`ingress failed: ${error.message}`)))
    chains.set(channelId, next)
  }

  discord.on(Events.MessageCreate, (message) => {
    if (message.author.bot && !message.embeds[0]?.footer?.text.startsWith(REMOTE_SEND_PREFIX)) return
    serialize(message.channelId, () => handle(message))
  })
  discord.on(Events.MessageDelete, (message) => {
    serialize(message.channelId, () => handleQueuedMessageDelete({ message, store, actions }))
  })
  discord.on(Events.MessageUpdate, (_old, message) => {
    if (message.author?.bot) return
    serialize(message.channelId, async () => {
      const full = message.partial ? await message.fetch().catch(() => null) : message
      if (!full || !queuedItemFor({ store, threadId: full.channelId, messageId: full.id })) return
      // The re-queued prompt must carry the message's attachments again.
      const files = await saveAttachments({ dataDir, messageId: full.id, attachments: [...full.attachments.values()] })
      if (files instanceof Error) {
        logger.error(`edit of ${full.id}: ${files.message}`)
        return
      }
      await handleQueuedMessageEdit({ message: full, files, store, actions })
    })
  })
}
