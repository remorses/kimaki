// Effects executor (spec 27.5): the only Discord writer for session output.
// One FIFO worker per thread keeps Discord order equal to event order, and
// one typing interval per thread refreshes the indicator every 7s. Never
// awaited by the event loop.
//
// Interactive prompts: `show` remembers the posted message IDs under its key,
// `edit` with the same key replaces them and forgets the key. An edit for a
// key this process never showed (posted before a restart) does nothing.
//
// When Discord is slower than the event stream, effects pile up in the
// queue; consecutive bot lines are then merged into one message (≤ 2000
// chars) so a burst of tool lines does not hit the 5 msg / 5s channel limit.

import {
  ButtonStyle,
  ComponentType,
  type APIActionRowComponent,
  type APIButtonComponentWithCustomId,
  type APIComponentInMessageActionRow,
  type Client,
  type MessageCreateOptions,
  type SendableChannels,
} from 'discord.js'

import { createLogger } from './logger.ts'
import { segmentPayloads, type DiscordPayload } from './markdown/components.ts'
import { DISCORD_TEXT_LIMIT, renderMarkdown } from './markdown/render-markdown.ts'
import type { Effect } from './thread-reducer.ts'

const logger = createLogger('EFFECTS')

const TYPING_REFRESH_MS = 7_000

// --- Interactive prompts (queue acks, question dropdowns, permission buttons).
// Reducers name each prompt with a key and never see message IDs.

export type UiMessage = {
  content: string
  components: ReadonlyArray<APIActionRowComponent<APIComponentInMessageActionRow>>
}

export type UiEffect =
  // Posts the messages in order; the first replies to `replyTo` when set.
  | { type: 'show'; key: string; messages: readonly UiMessage[]; replyTo: string | null }
  // Edits the messages `show` posted under `key` (by index; the last one covers the rest).
  | { type: 'edit'; key: string; messages: readonly UiMessage[] }

export function textOnly(content: string): UiMessage {
  return { content, components: [] }
}

export function button({
  customId,
  label,
  style = ButtonStyle.Secondary,
}: {
  customId: string
  label: string
  style?: ButtonStyle.Primary | ButtonStyle.Secondary | ButtonStyle.Success | ButtonStyle.Danger
}): APIButtonComponentWithCustomId {
  return { type: ComponentType.Button, custom_id: customId, label, style }
}

export function buttonRow(
  buttons: readonly APIButtonComponentWithCustomId[],
): APIActionRowComponent<APIComponentInMessageActionRow> {
  return { type: ComponentType.ActionRow, components: [...buttons] }
}

type ThreadWorker = {
  queue: Effect[]
  running: boolean
  typing: ReturnType<typeof setInterval> | null
  // Bumped by dispose(): effects taken before it are dropped.
  generation: number
}

// Adjacent `send` effects become one, as long as the joined text fits a message.
export function mergeSends(effects: Effect[]): Effect[] {
  return effects.reduce<Effect[]>((merged, effect) => {
    const last = merged[merged.length - 1]
    if (effect.type !== 'send' || last?.type !== 'send') return [...merged, effect]
    const text = `${last.text}\n${effect.text}`
    if (text.length > DISCORD_TEXT_LIMIT) return [...merged, effect]
    return [...merged.slice(0, -1), { type: 'send', text }]
  }, [])
}

function markdownMessages({ text, blankLineBefore }: { text: string; blankLineBefore: boolean }): DiscordPayload[] {
  const segments = renderMarkdown(text, { limit: DISCORD_TEXT_LIMIT - 1 })
  const [first, ...rest] = segments
  if (!blankLineBefore || first?.kind !== 'text') return segmentPayloads(segments)
  return segmentPayloads([{ kind: 'text', markdown: `\n${first.markdown}` }, ...rest])
}

export function createEffectsRunner({ discord }: { discord: Client }) {
  const workers = new Map<string, ThreadWorker>()
  // Prompt key -> IDs of its posted messages, until edited. The only
  // Discord facts kept in memory (spec 6.3 #4).
  const prompts = new Map<string, readonly string[]>()
  // After stop(): no more sends or typing, even from effects already queued.
  const lifecycle = { closed: false }

  function worker(threadId: string): ThreadWorker {
    const existing = workers.get(threadId)
    if (existing) return existing
    const created: ThreadWorker = { queue: [], running: false, typing: null, generation: 0 }
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

  async function runOne(threadId: string, effect: Effect) {
    const thread = worker(threadId)
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
      const ids = prompts.get(effect.key)
      prompts.delete(effect.key)
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
      prompts.set(effect.key, ids)
    }
    const payloads =
      effect.type === 'send' ? [{ content: effect.text }] : effect.type === 'markdown' ? markdownMessages(effect) : []
    for (const payload of payloads) {
      await post({ threadId, options: payload })
    }
    // A bot message ends the typing indicator in the Discord UI.
    if (thread.typing) await pulseTyping(threadId)
  }

  async function drain(threadId: string) {
    const thread = worker(threadId)
    if (thread.running) return
    thread.running = true
    while (thread.queue.length > 0) {
      const generation = thread.generation
      for (const effect of mergeSends(thread.queue.splice(0))) {
        if (thread.generation !== generation) break
        await runOne(threadId, effect)
      }
    }
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
