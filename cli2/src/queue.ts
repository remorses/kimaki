// Queue feature (spec 9.2, 27.6): the native OpenCode inbox shown in Discord.
// Kimaki keeps no queue of its own; this slice only mirrors inbox events of
// the root session to render them:
//
//   inbox.enqueued (queue, while busy) ─▶ "Queued at position N" ack
//   inbox.delivered                    ─▶ "» user: text" echo, ack says "Queued message sent"
//   inbox.cancelled                    ─▶ ack says "Removed from queue"
//
// A queued prompt's inbox ID is msg_discord_<messageId> (actions.ts), so a
// message delete or an edit maps to the item by ID alone. Items without a
// Discord source message (/queue, CLI, commands) are removed with /clear-queue.

import type { Message, PartialMessage } from 'discord.js'
import type { JsonValue, SessionInboxInfo, V2Event } from '@opencode/client'

import type { Actions, PromptFile } from './actions.ts'
import { asSubtext } from './format-parts.ts'
import { createLogger } from './logger.ts'
import type { BotStore } from './store.ts'
import { stripTurnContext } from './system-prompt.ts'
import type { Effect, ThreadView } from './thread-reducer.ts'
import { textOnly } from './effects.ts'

const logger = createLogger('QUEUE')

const ECHO_LIMIT = 1_900

export type QueuedItem = {
  inboxID: string
  text: string
  username: string | null
  // Discord message the prompt came from (the ack replies to it).
  messageId: string | null
  // An ack was posted; only acked items get an echo when they start.
  acked: boolean
}

type Result = { view: ThreadView; effects: Effect[] }

function ackKey(inboxID: string): string {
  return `queue:${inboxID}`
}

function discordMetadata(metadata: { readonly [key: string]: JsonValue } | undefined) {
  const discord = metadata?.['discord']
  if (!discord || typeof discord !== 'object' || Array.isArray(discord)) return { username: null, messageId: null }
  const username = discord['username']
  const messageId = discord['messageId']
  return {
    username: typeof username === 'string' ? username : null,
    messageId: typeof messageId === 'string' ? messageId : null,
  }
}

export function formatEcho({ username, text }: { username: string | null; text: string }): string {
  const body = text.length > ECHO_LIMIT ? `${text.slice(0, ECHO_LIMIT - 1)}…` : text
  return `» **${username ?? 'queued'}:** ${body}`
}

function closeAck({ view, item, content }: { view: ThreadView; item: QueuedItem; content: string }): Result {
  if (!item.acked) return { view, effects: [] }
  return { view, effects: [{ type: 'edit', key: ackKey(item.inboxID), messages: [textOnly(asSubtext(content))] }] }
}

function removeItem(view: ThreadView, inboxID: string): ThreadView {
  return {
    ...view,
    queue: view.queue.filter((item) => item.inboxID !== inboxID),
    inputs: view.inputs.filter((id) => id !== inboxID),
  }
}

// Root inbox events. `busy` is the thread busy state before this event.
export function reduceQueue({ view, event, busy }: { view: ThreadView; event: V2Event; busy: boolean }): Result | null {
  switch (event.type) {
    case 'session.inbox.enqueued': {
      const { item, inboxID } = event.data
      if (item.type !== 'user' || view.inputs.includes(inboxID)) return { view, effects: [] }
      const inputs = [...view.inputs, inboxID]
      if (item.delivery !== 'queue') return { view: { ...view, inputs }, effects: [] }
      // Idle with nothing pending: OpenCode runs it at once, like a normal message.
      const acked = busy || view.inputs.length > 0
      const meta = discordMetadata(item.payload.metadata)
      const queued: QueuedItem = { inboxID, text: stripTurnContext(item.payload.text), ...meta, acked }
      const next = { ...view, inputs, queue: [...view.queue, queued] }
      if (!acked) return { view: next, effects: [] }
      const ack = textOnly(asSubtext(`Queued at position ${next.queue.length}. Delete the original message to remove it, or use /clear-queue position:${next.queue.length}`))
      return { view: next, effects: [{ type: 'show', key: ackKey(inboxID), messages: [ack], replyTo: meta.messageId }] }
    }
    case 'session.inbox.delivered': {
      const item = view.queue.find((candidate) => candidate.inboxID === event.data.inboxID)
      const next = removeItem(view, event.data.inboxID)
      if (!item?.acked) return { view: next, effects: [] }
      const settled = closeAck({ view: next, item, content: 'Queued message sent' })
      return {
        view: { ...settled.view, lastKind: null },
        effects: [...settled.effects, { type: 'send', text: formatEcho(item) }],
      }
    }
    case 'session.inbox.cancelled': {
      const item = view.queue.find((candidate) => candidate.inboxID === event.data.inboxID)
      const next = removeItem(view, event.data.inboxID)
      if (!item) return { view: next, effects: [] }
      return closeAck({ view: next, item, content: 'Removed from queue' })
    }
    case 'session.inbox.delivery.changed': {
      // Promoted to steer: it leaves the queue and runs at the next step.
      const item = view.queue.find((candidate) => candidate.inboxID === event.data.inboxID)
      if (!item || event.data.delivery !== 'steer') return { view, effects: [] }
      return closeAck({ view: { ...view, queue: view.queue.filter((q) => q !== item) }, item, content: 'Queued message sent' })
    }
    default:
      return null
  }
}

// After a (re)connect: the inbox as OpenCode has it now. Items this view does
// not know were queued while the bot was away; their acks, if any, are from
// an older process, so they count as acked for the echo.
export function hydrateQueue({ view, inbox }: { view: ThreadView; inbox: readonly SessionInboxInfo[] }): Result {
  const users = inbox.filter((item) => item.type === 'user')
  const pending = new Set(users.map((item) => item.id))
  const queue = users
    .filter((item) => item.delivery === 'queue')
    .map((item): QueuedItem => {
      const known = view.queue.find((candidate) => candidate.inboxID === item.id)
      if (known) return known
      return { inboxID: item.id, text: stripTurnContext(item.payload.text), ...discordMetadata(item.payload.metadata), acked: true }
    })
  const gone = view.queue.filter((item) => !pending.has(item.inboxID))
  return gone.reduce<Result>(
    (acc, item) => {
      const settled = closeAck({ view: acc.view, item, content: 'No longer queued' })
      return { view: settled.view, effects: [...acc.effects, ...settled.effects] }
    },
    { view: { ...view, queue, inputs: users.map((item) => item.id) }, effects: [] },
  )
}

// --- Discord handlers (writers side): they call actions, never render session output.

export function queuedItemFor({ store, threadId, messageId }: { store: BotStore; threadId: string; messageId: string }) {
  return store.getState().threads[threadId]?.queue.find((item) => item.messageId === messageId) ?? null
}

// Deleting a queued Discord message removes it from the queue.
export async function handleQueuedMessageDelete({
  message,
  store,
  actions,
}: {
  message: Message | PartialMessage
  store: BotStore
  actions: Actions
}): Promise<void> {
  const item = queuedItemFor({ store, threadId: message.channelId, messageId: message.id })
  if (!item) return
  const result = await actions.cancelQueued({ threadId: message.channelId, inboxID: item.inboxID })
  if (result instanceof Error) logger.warn(`delete of queued ${message.id} failed: ${result.message}`)
}

// Editing a queued message re-queues the new text at the end (spec 9.2.2
// option A: the inbox has no API to change an item's text).
export async function handleQueuedMessageEdit({
  message,
  files,
  store,
  actions,
}: {
  message: Message
  files: readonly PromptFile[]
  store: BotStore
  actions: Actions
}): Promise<void> {
  const item = queuedItemFor({ store, threadId: message.channelId, messageId: message.id })
  if (!item) return
  const result = await actions.requeueEdited({ message, inboxID: item.inboxID, files })
  if (result instanceof Error) logger.warn(`edit of queued ${message.id} failed: ${result.message}`)
}
