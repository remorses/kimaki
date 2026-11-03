// Effects executor (spec 27.5): the only Discord writer for session output.
// The footer reads the git branch here, when it is posted.
// One FIFO worker per thread keeps Discord order equal to event order, and
// one typing interval per thread refreshes the indicator every 7s. Never
// awaited by the event loop.
//
// Interactive prompts: `show` remembers the posted message IDs under its key
// (per thread), `edit` with the same key replaces them and forgets the key.
// An edit for a key this process never showed (posted before a restart) does nothing.
//
// When Discord is slower than the event stream, effects pile up in the
// queue; consecutive bot lines (footers included) are then merged into one
// message (≤ 2000 chars) so a burst of tool lines does not hit the 5 msg / 5s
// channel limit.

import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  ComponentType,
  MessageFlags,
  type APIMessageTopLevelComponent,
  type Client,
  type MessageCreateOptions,
  type SendableChannels,
} from 'discord.js'

import { DISCORD_MEDIA_URL, embedFlags, formatFooter, SILENT_MESSAGE_FLAGS, type UiMessage } from './format-parts.ts'
import { createLogger } from './logger.ts'
import { echoPayloads } from './queue.ts'
import { markdownPayloads, segmentPayloads, type DiscordPayload } from './markdown/components.ts'
import { DISCORD_TEXT_LIMIT, renderMarkdown } from './markdown/render-markdown.ts'
import { DiscordError } from './errors.ts'
import type { Effect, UploadFile } from './thread-reducer.ts'

const logger = createLogger('EFFECTS')

const TYPING_REFRESH_MS = 7_000
const execFileAsync = promisify(execFile)

async function gitBranch(directory: string): Promise<string | null> {
  const result = await execFileAsync('git', ['branch', '--show-current'], { cwd: directory, timeout: 5_000 }).catch(() => null)
  return result?.stdout.trim() || null
}

async function readDefaultBranch(directory: string): Promise<string | null> {
  const git = (args: string[]) => execFileAsync('git', args, { cwd: directory, timeout: 5_000 }).then((r) => r.stdout.trim(), () => '')
  const remoteHead = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  if (remoteHead) return remoteHead.replace(/^origin\//, '')
  // No origin/HEAD (repo never cloned, or no remote): fall back to a local main or master.
  const local = await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/main', 'refs/heads/master'])
  return local.split('\n')[0] || null
}

// Directory -> default branch, read once per process: it almost never changes.
const defaultBranches = new Map<string, Promise<string | null>>()

function defaultBranch(directory: string): Promise<string | null> {
  const cached = defaultBranches.get(directory)
  if (cached) return cached
  const lookup = readDefaultBranch(directory)
  defaultBranches.set(directory, lookup)
  return lookup
}

// Project folder and default agent of a channel, read when a footer is posted. null: not a project channel.
export type FooterDefaults = (channelId: string) => Promise<Error | null | { projectDirectory: string; defaultAgent: string | null }>

async function footerText({ effect, footerDefaults }: { effect: Extract<Effect, { type: 'footer' }>; footerDefaults: FooterDefaults }): Promise<string> {
  const { channelId, directory, durationMs, contextPercent, model, agent } = effect
  const [branch, mainBranch, defaults] = await Promise.all([gitBranch(directory), defaultBranch(directory), footerDefaults(channelId)])
  if (defaults instanceof Error) logger.warn(`footer defaults of channel ${channelId} failed`, defaults)
  const known = defaults instanceof Error ? null : defaults
  return formatFooter({
    directory,
    projectDirectory: known?.projectDirectory ?? null,
    branch,
    defaultBranch: mainBranch,
    durationMs,
    contextPercent,
    model,
    agent,
    defaultAgent: known?.defaultAgent ?? null,
  })
}

// post() adds the notification flags to the payload's own flag.
type PostOptions = Omit<MessageCreateOptions, 'flags'> & { flags?: MessageFlags.IsComponentsV2 }

type ThreadWorker = {
  queue: Effect[]
  running: boolean
  typing: ReturnType<typeof setInterval> | null
  // Bumped by dispose(): effects taken before it are dropped.
  generation: number
  // Prompt key -> IDs of its posted messages, until edited. The only
  // Discord facts kept in memory (spec 6.3 #4).
  prompts: Map<string, readonly string[]>
}

function markdownMessages({ text, blankLineBefore }: { text: string; blankLineBefore: boolean }): DiscordPayload[] {
  const segments = renderMarkdown(text, { limit: DISCORD_TEXT_LIMIT - 1 })
  const [first, ...rest] = segments
  if (!blankLineBefore || first?.kind !== 'text') return segmentPayloads(segments)
  return segmentPayloads([{ kind: 'text', markdown: `\n${first.markdown}` }, ...rest])
}

// Discord takes at most 10 files and 25 MiB per message request; the margin
// leaves room for the multipart envelope. A file over the per-file limit
// (20 MiB unless boosted) is sent alone and Discord's error goes back.
// https://docs.discord.com/developers/resources/message#create-message
const MAX_FILES_PER_MESSAGE = 10
const MAX_UPLOAD_REQUEST_BYTES = 24 * 1024 * 1024

function uploadBatches(files: readonly UploadFile[]): UploadFile[][] {
  const batches: Array<{ files: UploadFile[]; bytes: number }> = []
  for (const file of files) {
    const last = batches.at(-1)
    if (last && last.files.length < MAX_FILES_PER_MESSAGE && last.bytes + file.size <= MAX_UPLOAD_REQUEST_BYTES) {
      last.files.push(file)
      last.bytes += file.size
    } else {
      batches.push({ files: [file], bytes: file.size })
    }
  }
  return batches.map((batch) => batch.files)
}

// Media Gallery takes images and videos; everything else is a File component.
const GALLERY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.webm', '.mov'])

// Plain `files` let the Discord client group images into a mosaic apart from
// other files. Components V2 place each file explicitly, so the thread shows
// them in argument order. With several files each one gets a numbered label,
// so the user and the agent can point at "file 3".
// https://docs.discord.com/developers/components/reference#media-gallery
function uploadMessage({ files, first, numbered }: { files: readonly UploadFile[]; first: number; numbered: boolean }) {
  const used = new Set<string>()
  const components: APIMessageTopLevelComponent[] = []
  const attachments = files.map((file, index) => {
    const number = first + index
    // attachment:// needs a unique name Discord keeps as is.
    const safe = file.name.replace(/[^\w.-]/g, '_') || 'file'
    const name = used.has(safe) ? `${number}-${safe}` : safe
    used.add(name)
    if (numbered) components.push({ type: ComponentType.TextDisplay, content: `-# ${number}. \`${file.name}\`` })
    const media = { url: `attachment://${name}` }
    components.push(
      GALLERY_EXTENSIONS.has(path.extname(name).toLowerCase())
        ? { type: ComponentType.MediaGallery, items: [{ media }] }
        : { type: ComponentType.File, file: media },
    )
    return { attachment: file.path, name }
  })
  return { files: attachments, components, flags: MessageFlags.IsComponentsV2 | SILENT_MESSAGE_FLAGS }
}

// Components V2 messages come back with an empty `attachments` list: Discord
// resolves each attachment:// URL inside the components instead, in upload order.
function mediaUrls(components: readonly APIMessageTopLevelComponent[]): string[] {
  return components.flatMap((component) => {
    if (component.type === ComponentType.MediaGallery) return component.items.map((item) => item.media.url)
    if (component.type === ComponentType.File) return [component.file.url]
    return []
  })
}

// Effects that will never run: an upload still waits for its answer.
function drop(effects: readonly Effect[]) {
  for (const effect of effects) {
    if (effect.type === 'attachments') effect.settle(new DiscordError({ operation: 'upload (the thread no longer shows a session)' }))
  }
}

export type MarkViewed = (input: { sessionId: string; idle: number }) => Promise<Error | void>

export function createEffectsRunner({ discord, markViewed, footerDefaults }: { discord: Client; markViewed: MarkViewed; footerDefaults: FooterDefaults }) {
  const workers = new Map<string, ThreadWorker>()
  // After stop(): no more sends or typing, even from effects already queued.
  const lifecycle = { closed: false }

  function worker(threadId: string): ThreadWorker {
    const existing = workers.get(threadId)
    if (existing) return existing
    const created: ThreadWorker = { queue: [], running: false, typing: null, generation: 0, prompts: new Map() }
    workers.set(threadId, created)
    return created
  }

  async function sendableChannel(threadId: string) {
    const channel = await discord.channels.fetch(threadId).catch((e: Error) => e)
    if (channel instanceof Error || !channel?.isSendable()) {
      logger.warn(`thread ${threadId} is not sendable`, ...(channel instanceof Error ? [channel] : []))
      return null
    }
    return channel
  }

  async function pulseTyping(threadId: string) {
    if (lifecycle.closed) return
    const channel = await sendableChannel(threadId)
    if (!channel || lifecycle.closed) return
    await channel.sendTyping().catch((e: Error) => logger.warn(`typing failed in ${threadId}`, e))
  }

  function stopTyping(threadId: string) {
    const thread = workers.get(threadId)
    if (!thread?.typing) return
    clearInterval(thread.typing)
    thread.typing = null
  }

  // `mentions: false` for user text (prompt echoes): it must never ping.
  async function post({ threadId, options, notify, mentions = true }: { threadId: string; options: PostOptions; notify: boolean; mentions?: boolean }) {
    if (lifecycle.closed) return null
    const channel = await sendableChannel(threadId)
    if (!channel || lifecycle.closed) return null
    const flags = (options.flags ?? 0) | embedFlags(options.content) | (notify ? 0 : MessageFlags.SuppressNotifications)
    // Replies never ping their author: the footer is what notifies.
    const sent = await channel.send({ ...options, flags, allowedMentions: { parse: mentions ? ['users'] : [], repliedUser: false } }).catch((e: Error) => e)
    if (!(sent instanceof Error)) return sent.id
    logger.error(`send failed in ${threadId}`, sent)
    return null
  }

  // Unlike post(), the error goes back to the agent that uploaded.
  async function postFiles(threadId: string, files: readonly UploadFile[]): Promise<Error | string[]> {
    let first = 1
    const urls: string[] = []
    for (const batch of uploadBatches(files)) {
      if (lifecycle.closed) return new DiscordError({ operation: 'upload (bot stopped)' })
      const channel = await sendableChannel(threadId)
      if (!channel) return new DiscordError({ operation: `upload to thread ${threadId}` })
      const sent = await channel
        .send({ ...uploadMessage({ files: batch, first, numbered: files.length > 1 }), allowedMentions: { parse: [] } })
        .catch((cause: Error) => new DiscordError({ operation: `upload of ${batch.map((file) => file.name).join(', ')} (${cause.message})`, cause }))
      if (sent instanceof Error) return sent
      urls.push(...mediaUrls(sent.components.map((component) => component.toJSON())))
      first += batch.length
    }
    return urls
  }

  async function edit({ channel, messageId, message }: { channel: SendableChannels; messageId: string; message: UiMessage }) {
    const edited = await channel.messages
      .edit(messageId, { content: message.content, components: [...message.components], flags: DISCORD_MEDIA_URL.test(message.content) ? [] : MessageFlags.SuppressEmbeds })
      .catch((e: Error) => e)
    if (edited instanceof Error) logger.warn(`edit of ${messageId} failed`, edited)
  }

  // A bot message ends the typing indicator in the Discord UI.
  async function refreshTyping(threadId: string) {
    if (worker(threadId).typing) await pulseTyping(threadId)
  }

  // Every effect but bot lines, which drain() merges and posts itself.
  async function runOne(threadId: string, effect: Exclude<Effect, { type: 'send' | 'footer' }>) {
    const thread = worker(threadId)
    if (effect.type === 'attachments') {
      effect.settle(await postFiles(threadId, effect.files))
      return
    }
    if (effect.type === 'viewed') {
      // Not awaited: a slow OpenCode call must not hold back Discord output.
      void markViewed(effect).then((error) => {
        if (error) logger.warn(`marking ${effect.sessionId} as viewed failed`, error)
      })
      return
    }
    if (effect.type === 'typing') {
      if (!effect.on) {
        stopTyping(threadId)
        return
      }
      if (thread.typing || lifecycle.closed) return
      thread.typing = setInterval(() => void pulseTyping(threadId), TYPING_REFRESH_MS)
      await pulseTyping(threadId)
      return
    }
    if (effect.type === 'edit') {
      const ids = thread.prompts.get(effect.key) ?? []
      thread.prompts.delete(effect.key)
      const channel = ids.length > 0 ? await sendableChannel(threadId) : null
      if (lifecycle.closed) return
      for (const [index, messageId] of ids.entries()) {
        const message = effect.messages[index] ?? effect.messages[effect.messages.length - 1]
        if (channel && message) await edit({ channel, messageId, message })
      }
      if (effect.reply === undefined) return
      // A key from before a restart: the reply still marks the moment, without a reference.
      const replyTo = effect.replyTo ?? ids[0]
      await post({ threadId, options: { content: effect.reply, ...(replyTo && { reply: { messageReference: replyTo, failIfNotExists: false } }) }, notify: false })
      await refreshTyping(threadId)
      return
    }
    if (effect.type === 'show') {
      const ids: string[] = []
      for (const [index, message] of effect.messages.entries()) {
        const replyTo = index === 0 ? effect.replyTo : null
        const id = await post({
          threadId,
          options: {
            content: message.content,
            components: [...message.components],
            ...(replyTo && { reply: { messageReference: replyTo, failIfNotExists: false } }),
          },
          notify: effect.notify,
          mentions: !effect.echo,
        })
        if (id) ids.push(id)
      }
      thread.prompts.set(effect.key, ids)
      await refreshTyping(threadId)
      return
    }
    for (const [index, payload] of markdownMessages(effect).entries()) {
      const replyTo = index === 0 ? effect.replyTo : null
      await post({ threadId, options: { ...payload, ...(replyTo && { reply: { messageReference: replyTo, failIfNotExists: false } }) }, notify: false })
    }
    await refreshTyping(threadId)
  }

  // Runs the effects queued so far in order. Adjacent bot lines (sends and
  // footers) become one message while the joined text fits.
  async function runBatch(threadId: string, batch: readonly Effect[]) {
    const thread = worker(threadId)
    const generation = thread.generation
    const live = () => thread.generation === generation
    // A merged message notifies when any of its lines does. Echoes and
    // bot lines never merge, so an echo never pings and a bot line can.
    // Lines with Discord media only merge with each other: their message
    // shows embeds, so other links merged in would unfurl too.
    let lines: { text: string; notify: boolean; mentions: boolean; media: boolean } | null = null
    const flush = async () => {
      const pending = lines
      lines = null
      if (pending === null || !live()) return
      await post({ threadId, options: { content: pending.text }, notify: pending.notify, mentions: pending.mentions })
      await refreshTyping(threadId)
    }
    for (const [index, effect] of batch.entries()) {
      if (!live()) return drop(batch.slice(index))
      if (effect.type !== 'send' && effect.type !== 'footer') {
        await flush()
        if (!live()) return drop(batch.slice(index))
        await runOne(threadId, effect)
        continue
      }
      const text = effect.type === 'send' ? effect.text : await footerText({ effect, footerDefaults })
      const notify = effect.notify === true
      const echo = effect.type === 'send' && effect.echo === true
      const mentions = !echo
      // A line over the limit (a long prompt echo) is split like model markdown.
      if (text.length > DISCORD_TEXT_LIMIT) {
        await flush()
        for (const payload of echo ? echoPayloads(text) : markdownPayloads(text)) {
          if (!live()) return drop(batch.slice(index + 1))
          await post({ threadId, options: payload, notify, mentions })
        }
        await refreshTyping(threadId)
        continue
      }
      const media = DISCORD_MEDIA_URL.test(text)
      const joined: string | null = lines === null ? null : `${lines.text}\n${text}`
      if (lines !== null && joined !== null && lines.mentions === mentions && lines.media === media && joined.length <= DISCORD_TEXT_LIMIT) {
        lines = { text: joined, notify: lines.notify || notify, mentions, media }
        continue
      }
      await flush()
      lines = { text, notify, mentions, media }
    }
    await flush()
  }

  async function drain(threadId: string) {
    const thread = worker(threadId)
    if (thread.running) return
    thread.running = true
    while (thread.queue.length > 0) await runBatch(threadId, thread.queue.splice(0))
    thread.running = false
  }

  return {
    run(threadId: string, effects: Effect[]): void {
      if (effects.length === 0) return
      if (lifecycle.closed) return drop(effects)
      worker(threadId).queue.push(...effects)
      void drain(threadId)
    },
    // The thread no longer shows a session: drop what is pending and stop typing.
    dispose(threadId: string): void {
      const thread = workers.get(threadId)
      if (!thread) return
      drop(thread.queue.splice(0))
      thread.generation++
      thread.prompts.clear()
      stopTyping(threadId)
    },
    stop(): void {
      lifecycle.closed = true
      for (const [threadId, thread] of workers) {
        drop(thread.queue.splice(0))
        stopTyping(threadId)
      }
    },
  }
}

export type EffectsRunner = ReturnType<typeof createEffectsRunner>
