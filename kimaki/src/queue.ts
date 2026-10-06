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
// The Discord handlers live in ingress.ts: this file must not import writers.

import type { JsonValue, SessionInboxInfo, V2Event } from '@opencode/client'
import type { Draft } from 'immer'

import type { Bot } from './bot.ts'
import { asSubtext, textOnly } from './format-parts.ts'
import { stripTurnContext } from './system-prompt.ts'
import type { Emit, ThreadView } from './thread-reducer.ts'

const ECHO_LIMIT = 1_900

// A root inbox user item not delivered yet, in inbox order.
export type PendingInput = {
  inboxID: string
  // 'queue' items wait for the end of the run and have a position.
  delivery: 'steer' | 'queue'
  text: string
  username: string | null
  // Discord message the prompt came from (the ack replies to it).
  messageId: string | null
  // An ack was posted; only acked items get an echo when they start.
  acked: boolean
  // Line from the prompt metadata (scheduled runs); shown on delivery even without an ack.
  echo: string | null
}

export function queuedItems(view: Pick<ThreadView, 'inbox'>): readonly PendingInput[] {
  return view.inbox.filter((item) => item.delivery === 'queue')
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

function closeAck({ emit }: Slice, item: PendingInput, content: string) {
  if (item.acked) emit({ type: 'edit', key: ackKey(item.inboxID), messages: [textOnly(asSubtext(content))] })
}

// Removes the item from the inbox; returns it when it was still queued.
function takeQueued({ draft }: Slice, inboxID: string): PendingInput | null {
  const item = draft.inbox.find((candidate) => candidate.inboxID === inboxID)
  draft.inbox = draft.inbox.filter((candidate) => candidate.inboxID !== inboxID)
  return item?.delivery === 'queue' ? { ...item } : null
}

// Root inbox.enqueued. `busy` is the thread busy state before this event.
export function enqueueInput(
  slice: Slice & { data: Extract<V2Event, { type: 'session.inbox.enqueued' }>['data']; busy: boolean },
) {
  const { draft, emit, data, busy } = slice
  const { item, inboxID } = data
  if (item.type !== 'user' || draft.inbox.some((candidate) => candidate.inboxID === inboxID)) return
  const meta = discordMetadata(item.payload.metadata)
  // Idle with nothing pending: OpenCode runs it at once, like a normal message.
  const acked = item.delivery === 'queue' && (busy || draft.inbox.length > 0)
  draft.inbox.push({ inboxID, delivery: item.delivery, text: stripTurnContext(item.payload.text), ...meta, acked })
  if (item.delivery !== 'queue') {
    if (!meta.echo) return
    emit({ type: 'send', text: meta.echo })
    draft.lastKind = null
    return
  }
  if (!acked) return
  const position = queuedItems(draft).length
  const ack = textOnly(asSubtext(`Queued at position ${position}. Delete the original message to remove it, or use /clear-queue position:${position}`))
  emit({ type: 'show', key: ackKey(inboxID), messages: [ack], replyTo: meta.messageId })
}

export function deliverQueued(slice: Slice & { inboxID: string }) {
  const item = takeQueued(slice, slice.inboxID)
  if (!item || (!item.acked && !item.echo)) return
  closeAck(slice, item, 'Queued message sent')
  slice.emit({ type: 'send', text: item.echo ?? formatEcho(item) })
  slice.draft.lastKind = null
}

export function cancelQueued(slice: Slice & { inboxID: string }) {
  const item = takeQueued(slice, slice.inboxID)
  if (item) closeAck(slice, item, 'Removed from queue')
}

// Promoted to steer: it leaves the queue and runs at the next step, without an echo.
export function promoteQueued(slice: Slice & { inboxID: string }) {
  const item = slice.draft.inbox.find((candidate) => candidate.inboxID === slice.inboxID)
  if (item?.delivery !== 'queue') return
  closeAck(slice, { ...item }, 'Queued message sent')
  item.delivery = 'steer'
}

// After a (re)connect: the inbox as OpenCode has it now. Items this view does
// not know were queued while the bot was away; their acks, if any, are from
// an older process, so they count as acked for the echo.
export function hydrateQueue(slice: Slice & { inbox: readonly SessionInboxInfo[] }) {
  const { draft, inbox } = slice
  const users = inbox.filter((item) => item.type === 'user')
  const pending = new Set(users.map((item) => item.id))
  for (const item of queuedItems(draft)) {
    if (!pending.has(item.inboxID)) closeAck(slice, { ...item }, 'No longer queued')
  }
  const known = new Map(draft.inbox.map((item) => [item.inboxID, { ...item }]))
  draft.inbox = users.map((item): PendingInput => {
    const existing = known.get(item.id)
    if (existing?.delivery === item.delivery) return existing
    if (existing?.delivery === 'queue' && item.delivery === 'steer') closeAck(slice, existing, 'Queued message sent')
    const meta = discordMetadata(item.payload.metadata)
    return { inboxID: item.id, delivery: item.delivery, text: stripTurnContext(item.payload.text), ...meta, acked: item.delivery === 'queue' }
  })
}

export function queuedItemFor(bot: Bot, { threadId, messageId }: { threadId: string; messageId: string }) {
  const view = bot.store.getState().threads[threadId]
  return (view && queuedItems(view).find((item) => item.messageId === messageId)) ?? null
}
