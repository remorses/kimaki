// Discord ingress (spec 4): gates every messageCreate, parses it into a Route
// and calls actions. Gates, in order: bots (including ourselves), channel
// ownership (only channels mapped in this machine's SQLite), permission.
// Messages of one channel are handled in arrival order, after OpenCode is ready.
//
// Messages sent while the bot was offline are not fetched here: gateway-proxy
// buffers MESSAGE_* and THREAD_* events for a disconnected client (200 max)
// and replays them after the next READY, and discord.js RESUME replays short
// drops. Both arrive as normal messageCreate events. The listener is
// registered before login so the replayed events are not missed.
//
// Attachments become prompt files; voice messages are transcribed into the
// same Route as text. Edits and deletes of queued messages update the queue.

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  Events,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  type Attachment,
  type Guild,
  type Message,
} from 'discord.js'
import * as errore from 'errore'

import { projectOf, sessionDirectory, type Bot, type PromptFile } from './bot.ts'
import { formatError, NOTIFY_MESSAGE_FLAGS, SILENT_MESSAGE_FLAGS } from './format-parts.ts'
import { createLogger } from './logger.ts'
import { parseInput, sendInput } from './lock-routes.ts'
import { cancelQueuedPrompt, dispatch, requeueEdited, send } from './prompt.ts'
import { REMOTE_PROMPT_FILE, REMOTE_RESULT_PREFIX, REMOTE_SEND_PREFIX } from './remote-send.ts'
import { formatEcho, queuedItemFor } from './queue.ts'
import { parseTextMessage, type Route } from './routes.ts'
import { primaryAgents, startSession } from './sessions.ts'
import { isVoiceAttachment, parseVoiceMessage, transcribe, type AttachmentLike } from './voice.ts'

const logger = createLogger('INGRESS')

// Owner, Administrator, Manage Server, or a role named "Kimaki". A role named
// "no-kimaki" always denies. Missing member data fails closed.
export async function canUseKimaki({ guild, userId }: { guild: Guild; userId: string }): Promise<boolean> {
  const member = await guild.members.fetch({ user: userId, force: true }).catch(() => null)
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

async function remotePromptText(url: string) {
  const response = await fetch(url).catch((cause) => new AttachmentError({ file: REMOTE_PROMPT_FILE, cause }))
  if (response instanceof Error) return response
  if (!response.ok) return new AttachmentError({ file: REMOTE_PROMPT_FILE, cause: new Error(`HTTP ${response.status}`) })
  return response.text().catch((cause) => new AttachmentError({ file: REMOTE_PROMPT_FILE, cause }))
}

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

// Voice: transcribe first. The transcription picks the route (spec 9.4).
async function voiceRoute(
  bot: Bot,
  { message, attachment, directory, inSession }: { message: Message; attachment: Attachment; directory: string; inSession: boolean },
): Promise<Error | Route> {
  const audio = await download(attachment.url)
  if (audio instanceof Error) return audio
  const agents = await primaryAgents(bot, directory)
  if (agents instanceof Error) return agents
  const result = await transcribe({
    db: bot.db,
    token: bot.token,
    baseUrls: bot.transcriptionBaseUrls,
    audio,
    mediaType: attachment.contentType ?? 'audio/ogg',
    directory,
    // The ID is what switchAgent and session.create take.
    agents: agents.map((agent) => ({ name: agent.id, description: agent.description ?? '' })),
    inSession,
  })
  if (result instanceof Error) return result
  logger.log(`voice message ${message.id} -> ${result.route}${result.agent ? ` (${result.agent})` : ''}`)
  return parseVoiceMessage(result)
}

// A remote send envelope another machine's `kimaki send` posted in a channel this bot owns.
async function handleRemoteEnvelope(bot: Bot, { message, channelId, threadId }: { message: Message; channelId: string; threadId: string | null }) {
  const footer = message.embeds[0]?.footer?.text
  if (!footer?.startsWith(REMOTE_SEND_PREFIX)) return
  const decoded = errore.try(
    () => ({ value: JSON.parse(footer.slice(REMOTE_SEND_PREFIX.length)) as unknown }),
    (cause) => new AttachmentError({ file: 'remote envelope', cause }),
  )
  if (decoded instanceof Error) return
  const value = decoded.value
  if (!value || typeof value !== 'object') return
  if (!('requestId' in value) || typeof value.requestId !== 'string' || !/^[0-9a-f]{16}$/.test(value.requestId)) return
  if (!('options' in value) || !value.options || typeof value.options !== 'object' || Array.isArray(value.options)) return
  const promptInFile = 'promptFile' in value && value.promptFile === REMOTE_PROMPT_FILE
  const first = message.attachments.first()
  const promptAttachment = promptInFile && first?.name === REMOTE_PROMPT_FILE ? first : undefined
  // Never fall back to the truncated preview in the message content.
  const prompt = !promptInFile
    ? message.content
    : promptAttachment
      ? await remotePromptText(promptAttachment.url)
      : new AttachmentError({ file: REMOTE_PROMPT_FILE, cause: new Error('missing from the remote envelope') })
  const target = threadId ? { threadId } : { channelId }
  const input = prompt instanceof Error ? prompt : parseInput(sendInput, { ...value.options, ...target, prompt })
  const attachments = [...message.attachments.values()].filter((attachment) => attachment !== promptAttachment)
  const files = await saveAttachments({ dataDir: bot.dataDir, messageId: message.id, attachments })
  const result = input instanceof Error ? input : files instanceof Error ? files : await send(bot, { ...input, files }, { localOnly: true })
  const answer = JSON.stringify(result instanceof Error ? { error: result.message } : result)
  await message
    .reply({
      content: result instanceof Error ? result.message : `Delivered to <#${result.threadId}>`,
      embeds: [{ footer: { text: `${REMOTE_RESULT_PREFIX}${value.requestId}:${answer}` } }],
      allowedMentions: { parse: [] },
      // The data is in the embed: SuppressEmbeds would hide it.
      flags: MessageFlags.SuppressNotifications,
    })
    .catch((error: Error) => logger.warn(`remote acknowledgment: ${error.message}`))
}

async function handleMessage(bot: Bot, message: Message) {
  const channel = message.channel
  const thread = channel.isThread() ? channel : null
  const channelId = thread ? thread.parentId : channel.id
  if (!channelId || !message.guild) return

  const project = await projectOf(bot, channelId)
  if (project instanceof Error) return logger.warn(project.message)
  if (!project || project.channel_type !== 'text') return
  if (message.author.bot) {
    if (message.author.id !== bot.discord.user?.id) return
    return handleRemoteEnvelope(bot, { message, channelId, threadId: thread?.id ?? null })
  }
  if (!(await canUseKimaki({ guild: message.guild, userId: message.author.id }))) {
    logger.log(`ignoring ${message.author.username}: no Kimaki permission`)
    return
  }
  const sessionId = thread ? bot.store.getState().roots[thread.id] : undefined
  if (thread && !sessionId) return
  const author = { id: message.author.id, username: message.author.username }
  const reportError = async (error: Error) => {
    logger.error(`message ${message.id} failed: ${error.message}`)
    await message.reply({ content: formatError(error.message), flags: NOTIFY_MESSAGE_FLAGS }).catch(() => undefined)
  }

  const attachments = [...message.attachments.values()]
  const voice = attachments.find((attachment) => isVoiceAttachment(attachmentLike(attachment)))
  const files = await saveAttachments({
    dataDir: bot.dataDir,
    messageId: message.id,
    attachments: attachments.filter((attachment) => attachment !== voice),
  })
  if (files instanceof Error) return reportError(files)
  const directory = sessionId && voice ? await sessionDirectory(bot, sessionId) : project.directory
  if (directory instanceof Error) return reportError(directory)
  const route = voice
    ? await voiceRoute(bot, { message, attachment: voice, directory, inSession: Boolean(sessionId) })
    : (parseTextMessage({ content: message.content }) ?? (files.length > 0 ? { kind: 'steer' as const, text: '' } : null))
  if (route instanceof Error) return reportError(route)
  if (!route) return
  // The transcription is not visible anywhere else.
  if (voice && thread && route.kind !== 'shell' && route.kind !== 'command' && route.kind !== 'skill') {
    await message.reply({ content: formatEcho({ username: author.username, text: route.text }), allowedMentions: { parse: [] }, flags: SILENT_MESSAGE_FLAGS })
  }

  if (!thread) {
    // A channel message starts a session. Queue and btw need one to wait
    // for or fork from: here they are plain prompts.
    const first = route.kind === 'shell' || route.kind === 'command' || route.kind === 'skill' ? route : { ...route, kind: 'steer' as const }
    const started = await startSession(bot, {
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

  const result = await dispatch(bot, { thread, route, author, messageId: message.id, files })
  if (result instanceof Error) return reportError(result)
  if (!result) return
  const note =
    route.kind === 'btw' ? `Session forked! Continue in <#${result.threadId}>` : `Started a new session in <#${result.threadId}>`
  await message.reply({ content: note, allowedMentions: { repliedUser: false }, flags: SILENT_MESSAGE_FLAGS }).catch(() => undefined)
}

// Registers the message listeners. Messages of one channel are handled in arrival order.
export function registerIngress(bot: Bot) {
  const chains = new Map<string, Promise<void>>()

  function serialize(channelId: string, task: () => Promise<void>) {
    const previous = chains.get(channelId) ?? Promise.resolve()
    const next = previous.then(async () => {
      // gateway-proxy replays messages missed while offline right after READY,
      // often before the OpenCode connection and hydration are done.
      const ready = await bot.opencode.ready
      if (ready instanceof Error) return logger.warn(`ingress skipped, OpenCode not ready: ${ready.message}`)
      await task().catch((error: Error) => logger.error(`ingress failed: ${error.message}`))
    })
    chains.set(channelId, next)
  }

  bot.discord.on(Events.MessageCreate, (message) => {
    if (message.author.bot && !message.embeds[0]?.footer?.text.startsWith(REMOTE_SEND_PREFIX)) return
    serialize(message.channelId, () => handleMessage(bot, message))
  })
  // Deleting a queued Discord message removes it from the queue.
  bot.discord.on(Events.MessageDelete, (message) => {
    serialize(message.channelId, async () => {
      const item = queuedItemFor(bot, { threadId: message.channelId, messageId: message.id })
      if (!item) return
      const result = await cancelQueuedPrompt(bot, { threadId: message.channelId, inboxID: item.inboxID })
      if (result instanceof Error) logger.warn(`delete of queued ${message.id} failed: ${result.message}`)
    })
  })
  // Editing a queued message re-queues the new text at the end (spec 9.2.2
  // option A: the inbox has no API to change an item's text).
  bot.discord.on(Events.MessageUpdate, (_old, message) => {
    if (message.author?.bot) return
    serialize(message.channelId, async () => {
      const full = message.partial ? await message.fetch().catch(() => null) : message
      if (!full?.guild || !queuedItemFor(bot, { threadId: full.channelId, messageId: full.id })) return
      if (!(await canUseKimaki({ guild: full.guild, userId: full.author.id }))) return
      // The re-queued prompt must carry the message's attachments again.
      const files = await saveAttachments({ dataDir: bot.dataDir, messageId: full.id, attachments: [...full.attachments.values()] })
      if (files instanceof Error) {
        logger.error(`edit of ${full.id}: ${files.message}`)
        return
      }
      // Read again: the item may have started while the files were saved.
      const item = queuedItemFor(bot, { threadId: full.channelId, messageId: full.id })
      if (!item) return
      const result = await requeueEdited(bot, { message: full, inboxID: item.inboxID, files })
      if (result instanceof Error) logger.warn(`edit of queued ${full.id} failed: ${result.message}`)
    })
  })
}
