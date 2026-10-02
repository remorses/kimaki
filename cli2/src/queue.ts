// Queue feature (spec 9.2, 27.6): the native OpenCode inbox shown in Discord.
// Kimaki keeps no queue of its own; this slice only mirrors inbox events of
// the root session to render them:
//
//   inbox.enqueued (queue, while busy) ─▶ "Queued at position N" ack
//   inbox.enqueued (steer, metadata echo) ─▶ the echo line (wakes, scheduled runs)
//   inbox.delivered                    ─▶ "» user: text" echo, ack says "Queued message sent"
//   inbox.cancelled                    ─▶ ack says "Removed from queue"
//
// A queued prompt's inbox ID is msg_discord_<messageId> (prompt.ts), so a
// message delete or an edit maps to the item by ID alone. Items without a
// Discord source message (/queue, CLI, commands) are removed with /clear-queue.

import type { Message, PartialMessage } from 'discord.js'
import type { JsonValue, SessionInboxInfo, V2Event } from '@opencode/client'

import type { Bot, PromptFile } from './bot.ts'
import type { Draft } from 'immer'

import { asSubtext, textOnly } from './format-parts.ts'
import { createLogger } from './logger.ts'
import { cancelQueuedPrompt, requeueEdited } from './prompt.ts'
import { stripTurnContext } from './system-prompt.ts'
import type { Emit, ThreadView } from './thread-reducer.ts'

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
  // Line from the prompt metadata (scheduled runs); shown on delivery even without an ack.
  echo: string | null
}

function ackKey(inboxID: string): string {
  return `queue:${inboxID}`
}

function discordMetadata(metadata: { readonly [key: string]: JsonValue } | undefined) {
  const discord = metadata?.['discord']
  if (!discord || typeof discord !== 'object' || Array.isArray(discord)) return { username: null, messageId: null, echo: null }
  const username = discord['username']
  const messageId = discord['messageId']
  const echo = discord['echo']
  return {
    username: typeof username === 'string' ? username : null,
    // CLI and scheduled prompts carry a UUID, not a Discord message to reply to.
    messageId: typeof messageId === 'string' && /^\d+$/.test(messageId) ? messageId : null,
    // Shown when a prompt without a Discord message is taken (wake, scheduled run).
    echo: typeof echo === 'string' ? echo : null,
  }
}

export function formatEcho({ username, text }: { username: string | null; text: string }): string {
  const body = text.length > ECHO_LIMIT ? `${text.slice(0, ECHO_LIMIT - 1)}…` : text
  return `» **${username ?? 'queued'}:** ${body}`
}

type Slice = { draft: Draft<ThreadView>; emit: Emit }

function closeAck({ emit }: Slice, item: QueuedItem, content: string) {
  if (item.acked) emit({ type: 'edit', key: ackKey(item.inboxID), messages: [textOnly(asSubtext(content))] })
}

// Removes the item from inputs and queue; returns it when it was queued.
function takeItem({ draft }: Slice, inboxID: string): QueuedItem | null {
  const item = draft.queue.find((candidate) => candidate.inboxID === inboxID)
  draft.queue = draft.queue.filter((candidate) => candidate.inboxID !== inboxID)
  draft.inputs = draft.inputs.filter((id) => id !== inboxID)
  return item ? { ...item } : null
}

// Root inbox.enqueued. `busy` is the thread busy state before this event.
export function enqueueInput(
  slice: Slice & { data: Extract<V2Event, { type: 'session.inbox.enqueued' }>['data']; busy: boolean },
) {
  const { draft, emit, data, busy } = slice
  const { item, inboxID } = data
  if (item.type !== 'user' || draft.inputs.includes(inboxID)) return
  const meta = discordMetadata(item.payload.metadata)
  // Idle with nothing pending: OpenCode runs it at once, like a normal message.
  const acked = busy || draft.inputs.length > 0
  draft.inputs.push(inboxID)
  if (item.delivery !== 'queue') {
    if (!meta.echo) return
    emit({ type: 'send', text: meta.echo })
    draft.lastKind = null
    return
  }
  draft.queue.push({ inboxID, text: stripTurnContext(item.payload.text), ...meta, acked })
  if (!acked) return
  const position = draft.queue.length
  const ack = textOnly(asSubtext(`Queued at position ${position}. Delete the original message to remove it, or use /clear-queue position:${position}`))
  emit({ type: 'show', key: ackKey(inboxID), messages: [ack], replyTo: meta.messageId })
}

export function deliverQueued(slice: Slice & { inboxID: string }) {
  const item = takeItem(slice, slice.inboxID)
  if (!item || (!item.acked && !item.echo)) return
  closeAck(slice, item, 'Queued message sent')
  slice.emit({ type: 'send', text: item.echo ?? formatEcho(item) })
  slice.draft.lastKind = null
}

export function cancelQueued(slice: Slice & { inboxID: string }) {
  const item = takeItem(slice, slice.inboxID)
  if (item) closeAck(slice, item, 'Removed from queue')
}

// Promoted to steer: it leaves the queue and runs at the next step.
export function promoteQueued(slice: Slice & { inboxID: string }) {
  const item = slice.draft.queue.find((candidate) => candidate.inboxID === slice.inboxID)
  if (!item) return
  closeAck(slice, { ...item }, 'Queued message sent')
  slice.draft.queue = slice.draft.queue.filter((candidate) => candidate.inboxID !== slice.inboxID)
}

// After a (re)connect: the inbox as OpenCode has it now. Items this view does
// not know were queued while the bot was away; their acks, if any, are from
// an older process, so they count as acked for the echo.
export function hydrateQueue(slice: Slice & { inbox: readonly SessionInboxInfo[] }) {
  const { draft, inbox } = slice
  const users = inbox.filter((item) => item.type === 'user')
  const pending = new Set(users.map((item) => item.id))
  for (const item of draft.queue) {
    if (!pending.has(item.inboxID)) closeAck(slice, { ...item }, 'No longer queued')
  }
  const known = new Map(draft.queue.map((item) => [item.inboxID, { ...item }]))
  draft.queue = users
    .filter((item) => item.delivery === 'queue')
    .map((item) => known.get(item.id) ?? { inboxID: item.id, text: stripTurnContext(item.payload.text), ...discordMetadata(item.payload.metadata), acked: true })
  draft.inputs = users.map((item) => item.id)
}

// --- Discord handlers (writers side): they call prompt.ts, never render session output.

export function queuedItemFor(bot: Bot, { threadId, messageId }: { threadId: string; messageId: string }) {
  return bot.store.getState().threads[threadId]?.queue.find((item) => item.messageId === messageId) ?? null
}

// Deleting a queued Discord message removes it from the queue.
export async function handleQueuedMessageDelete(bot: Bot, message: Message | PartialMessage): Promise<void> {
  const item = queuedItemFor(bot, { threadId: message.channelId, messageId: message.id })
  if (!item) return
  const result = await cancelQueuedPrompt(bot, { threadId: message.channelId, inboxID: item.inboxID })
  if (result instanceof Error) logger.warn(`delete of queued ${message.id} failed: ${result.message}`)
}

// Editing a queued message re-queues the new text at the end (spec 9.2.2
// option A: the inbox has no API to change an item's text).
export async function handleQueuedMessageEdit(bot: Bot, { message, files }: { message: Message; files: readonly PromptFile[] }): Promise<void> {
  const item = queuedItemFor(bot, { threadId: message.channelId, messageId: message.id })
  if (!item) return
  const result = await requeueEdited(bot, { message, inboxID: item.inboxID, files })
  if (result instanceof Error) logger.warn(`edit of queued ${message.id} failed: ${result.message}`)
}
