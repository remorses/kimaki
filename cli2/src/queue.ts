// Queue feature (spec 9.2, 27.6): the native OpenCode inbox shown in Discord.
// Kimaki keeps no queue of its own; this slice only mirrors inbox events of
// the root session to render them:
//
//   inbox.enqueued (queue, while busy) ─▶ "Queued at position N" + Remove
//   inbox.delivered                    ─▶ "» user: text" echo, ack loses its button
//   inbox.cancelled                    ─▶ ack says "Removed from queue"
//
// A queued prompt's inbox ID is msg_discord_<messageId> (actions.ts), so a
// Remove click, a message delete or an edit maps to the item by ID alone.

import {
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type Message,
  type PartialMessage,
} from 'discord.js'
import type { JsonValue, SessionInboxInfo, V2Event } from '@opencode/client'

import type { Actions } from './actions.ts'
import { asSubtext } from './format-parts.ts'
import { createLogger } from './logger.ts'
import type { BotStore } from './store.ts'
import { stripTurnContext } from './system-prompt.ts'
import type { Effect, ThreadView } from './thread-reducer.ts'
import { button, buttonRow, textOnly, type UiMessage } from './effects.ts'

const logger = createLogger('QUEUE')

export const QUEUE_REMOVE_PREFIX = 'queue_remove:'

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

function ackMessage({ inboxID, position }: { inboxID: string; position: number }): UiMessage {
  return {
    content: asSubtext(`Queued at position ${position}. Edit or delete your message to update the queue`),
    components: [
      buttonRow([button({ customId: `${QUEUE_REMOVE_PREFIX}${inboxID}`, label: 'Remove from queue', style: ButtonStyle.Secondary })]),
    ],
  }
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

function settleAck({ view, item, content }: { view: ThreadView; item: QueuedItem; content: string }): Result {
  if (!item.acked) return { view, effects: [] }
  return { view, effects: [{ type: 'settle', key: ackKey(item.inboxID), final: [textOnly(asSubtext(content))] }] }
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
      const ack = ackMessage({ inboxID, position: next.queue.length })
      return { view: next, effects: [{ type: 'show', key: ackKey(inboxID), messages: [ack], replyTo: meta.messageId }] }
    }
    case 'session.inbox.delivered': {
      const item = view.queue.find((candidate) => candidate.inboxID === event.data.inboxID)
      const next = removeItem(view, event.data.inboxID)
      if (!item?.acked) return { view: next, effects: [] }
      const settled = settleAck({ view: next, item, content: 'Queued message sent' })
      return {
        view: { ...settled.view, lastKind: null },
        effects: [...settled.effects, { type: 'send', text: formatEcho(item) }],
      }
    }
    case 'session.inbox.cancelled': {
      const item = view.queue.find((candidate) => candidate.inboxID === event.data.inboxID)
      const next = removeItem(view, event.data.inboxID)
      if (!item) return { view: next, effects: [] }
      return settleAck({ view: next, item, content: 'Removed from queue' })
    }
    case 'session.inbox.delivery.changed': {
      // Promoted to steer: it leaves the queue and runs at the next step.
      const item = view.queue.find((candidate) => candidate.inboxID === event.data.inboxID)
      if (!item || event.data.delivery !== 'steer') return { view, effects: [] }
      return settleAck({ view: { ...view, queue: view.queue.filter((q) => q !== item) }, item, content: 'Queued message sent' })
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
      const settled = settleAck({ view: acc.view, item, content: 'No longer queued' })
      return { view: settled.view, effects: [...acc.effects, ...settled.effects] }
    },
    { view: { ...view, queue, inputs: users.map((item) => item.id) }, effects: [] },
  )
}

// --- Discord handlers (writers side): they call actions, never render session output.

export async function handleQueueRemove({
  interaction,
  actions,
}: {
  interaction: ButtonInteraction
  actions: Actions
}): Promise<void> {
  const inboxID = interaction.customId.slice(QUEUE_REMOVE_PREFIX.length)
  await interaction.deferUpdate()
  const result = await actions.cancelQueued({ threadId: interaction.channelId, inboxID })
  if (!(result instanceof Error)) return
  logger.warn(`remove ${inboxID} failed: ${result.message}`)
  await interaction
    .followUp({ content: 'This message is no longer in the queue', flags: MessageFlags.Ephemeral })
    .catch(() => undefined)
}

function queuedItemFor({ store, threadId, messageId }: { store: BotStore; threadId: string; messageId: string }) {
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
  store,
  actions,
}: {
  message: Message
  store: BotStore
  actions: Actions
}): Promise<void> {
  const item = queuedItemFor({ store, threadId: message.channelId, messageId: message.id })
  if (!item) return
  const result = await actions.requeueEdited({ message, inboxID: item.inboxID })
  if (result instanceof Error) logger.warn(`edit of queued ${message.id} failed: ${result.message}`)
}
