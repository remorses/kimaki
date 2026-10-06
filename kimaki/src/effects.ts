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
import { type Client, type MessageCreateOptions, type SendableChannels } from 'discord.js'

import { formatFooter, type UiMessage } from './format-parts.ts'
import { createLogger } from './logger.ts'
import { segmentPayloads, type DiscordPayload } from './markdown/components.ts'
import { DISCORD_TEXT_LIMIT, renderMarkdown } from './markdown/render-markdown.ts'
import type { Effect } from './thread-reducer.ts'

const logger = createLogger('EFFECTS')

const TYPING_REFRESH_MS = 7_000
const execFileAsync = promisify(execFile)

async function gitBranch(directory: string): Promise<string | null> {
  const result = await execFileAsync('git', ['branch', '--show-current'], { cwd: directory, timeout: 5_000 }).catch(() => null)
  return result?.stdout.trim() || null
}

async function footerText(effect: Extract<Effect, { type: 'footer' }>): Promise<string> {
  const { directory, durationMs, contextPercent, model, agent } = effect
  const branch = await gitBranch(directory)
  return formatFooter({ folder: path.basename(directory), branch, durationMs, contextPercent, model, agent })
}

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

export function createEffectsRunner({ discord }: { discord: Client }) {
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
      logger.warn(`thread ${threadId} is not sendable`, channel instanceof Error ? channel.message : '')
      return null
    }
    return channel
  }

  async function pulseTyping(threadId: string) {
    if (lifecycle.closed) return
    const channel = await sendableChannel(threadId)
    if (!channel || lifecycle.closed) return
    await channel.sendTyping().catch((e: Error) => logger.warn(`typing failed in ${threadId}: ${e.message}`))
  }

  function stopTyping(threadId: string) {
    const thread = workers.get(threadId)
    if (!thread?.typing) return
    clearInterval(thread.typing)
    thread.typing = null
  }

  async function post({ threadId, options }: { threadId: string; options: MessageCreateOptions }) {
    if (lifecycle.closed) return null
    const channel = await sendableChannel(threadId)
    if (!channel || lifecycle.closed) return null
    const sent = await channel.send({ ...options, allowedMentions: { parse: ['users'] } }).catch((e: Error) => e)
    if (!(sent instanceof Error)) return sent.id
    logger.error(`send failed in ${threadId}: ${sent.message}`)
    return null
  }

  async function edit({ channel, messageId, message }: { channel: SendableChannels; messageId: string; message: UiMessage }) {
    const edited = await channel.messages
      .edit(messageId, { content: message.content, components: [...message.components] })
      .catch((e: Error) => e)
    if (edited instanceof Error) logger.warn(`edit of ${messageId} failed: ${edited.message}`)
  }

  // A bot message ends the typing indicator in the Discord UI.
  async function refreshTyping(threadId: string) {
    if (worker(threadId).typing) await pulseTyping(threadId)
  }

  // Every effect but bot lines, which drain() merges and posts itself.
  async function runOne(threadId: string, effect: Exclude<Effect, { type: 'send' | 'footer' }>) {
    const thread = worker(threadId)
    if (effect.type === 'attachments') {
      for (let offset = 0; offset < effect.files.length; offset += 10) {
        await post({ threadId, options: { files: effect.files.slice(offset, offset + 10).map((file) => ({ attachment: file.path, name: file.name })) } })
      }
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
      const ids = thread.prompts.get(effect.key)
      thread.prompts.delete(effect.key)
      if (!ids || ids.length === 0) return
      const channel = await sendableChannel(threadId)
      if (!channel || lifecycle.closed) return
      for (const [index, messageId] of ids.entries()) {
        const message = effect.messages[index] ?? effect.messages[effect.messages.length - 1]
        if (message) await edit({ channel, messageId, message })
      }
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
        })
        if (id) ids.push(id)
      }
      thread.prompts.set(effect.key, ids)
      await refreshTyping(threadId)
      return
    }
    for (const payload of markdownMessages(effect)) {
      await post({ threadId, options: payload })
    }
    await refreshTyping(threadId)
  }

  // Runs the effects queued so far in order. Adjacent bot lines (sends and
  // footers) become one message while the joined text fits.
  async function runBatch(threadId: string, batch: readonly Effect[]) {
    const thread = worker(threadId)
    const generation = thread.generation
    const live = () => thread.generation === generation
    let lines: string | null = null
    const flush = async () => {
      const text = lines
      lines = null
      if (text === null || !live()) return
      await post({ threadId, options: { content: text } })
      await refreshTyping(threadId)
    }
    for (const effect of batch) {
      if (!live()) return
      if (effect.type !== 'send' && effect.type !== 'footer') {
        await flush()
        if (live()) await runOne(threadId, effect)
        continue
      }
      const text = effect.type === 'send' ? effect.text : await footerText(effect)
      const joined: string | null = lines === null ? null : `${lines}\n${text}`
      if (joined !== null && joined.length <= DISCORD_TEXT_LIMIT) {
        lines = joined
        continue
      }
      await flush()
      lines = text
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
      if (effects.length === 0 || lifecycle.closed) return
      worker(threadId).queue.push(...effects)
      void drain(threadId)
    },
    // The thread no longer shows a session: drop what is pending and stop typing.
    dispose(threadId: string): void {
      const thread = workers.get(threadId)
      if (!thread) return
      thread.queue.length = 0
      thread.generation++
      thread.prompts.clear()
      stopTyping(threadId)
    },
    stop(): void {
      lifecycle.closed = true
      for (const [threadId, thread] of workers) {
        thread.queue.length = 0
        stopTyping(threadId)
      }
    },
  }
}

export type EffectsRunner = ReturnType<typeof createEffectsRunner>
