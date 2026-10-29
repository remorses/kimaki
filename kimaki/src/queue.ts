// Queue feature (spec 9.2, 27.6): the native OpenCode inbox shown in Discord.
// Kimaki keeps no queue of its own; this slice only mirrors inbox events of
// the root session to render them:
//
//   inbox.enqueued (queue, while busy) ─▶ "Queued at position N" ack
//   inbox.enqueued (steer, echo)       ─▶ the echo line (wakes, scheduled runs, TUI prompts)
//   inbox.delivered (or promoted)      ─▶ "Queued message sent" reply to the user message, ack says "Queued"
//   inbox.cancelled                    ─▶ ack says "Removed from queue"
//
// Every acked item gets that reply when it starts, in threads and coordinator
// channels alike. The prompt text is never posted again. Prompts without a Discord
// message (CLI, routines, TUI) have nothing for the ack to reply to: the ack
// shows the full prompt, and the "Queued message sent" reply goes to the ack.
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
import { markdownPayloads, type DiscordPayload } from './markdown/components.ts'
import { DISCORD_TEXT_LIMIT } from './markdown/render-markdown.ts'
import type { Emit, ThreadView } from './thread-reducer.ts'

// A root inbox user item not delivered yet, in inbox order.
export type PendingInput = {
  inboxID: string
  // 'queue' items wait for the end of the run and have a position.
  delivery: 'steer' | 'queue'
  text: string
  username: string | null
  // Discord message the prompt came from (the ack replies to it).
  messageId: string | null
  // The first answer text replies to this message. Only in a coordinator channel:
  // a thread holds one conversation, so turns need no extra delimiter there.
  // Not for acked items: their "Queued message sent" reply marks the start.
  replyTo: string | null
  // An ack was posted; only acked items get an echo when they start.
  acked: boolean
  // Line from the prompt metadata (scheduled runs) or for prompts sent outside Discord; shown on delivery even without an ack.
  echo: string | null
}

export function queuedItems(view: Pick<ThreadView, 'inbox'>): readonly PendingInput[] {
  return view.inbox.filter((item) => item.delivery === 'queue')
}

function ackKey(inboxID: string): string {
  return `queue:${inboxID}`
}

// CLI and scheduled prompts carry a UUID, not a Discord message to reply to.
export function discordMessageId(messageId: string): string | null {
  return /^\d+$/.test(messageId) ? messageId : null
}

function inputFields({ payload, channelId }: { payload: { text: string; metadata?: { readonly [key: string]: JsonValue } }; channelId: string }) {
  const text = stripTurnContext(payload.text)
  const discord = payload.metadata?.['discord']
  // Sent outside Discord (TUI, other clients): echo it like V1 external sync did.
  if (!discord || typeof discord !== 'object' || Array.isArray(discord)) {
    return { external: true, text, username: null, messageId: null, replyTo: null, echo: text.trim() ? formatEcho({ username: 'user', text }) : null }
  }
  const username = discord['username']
  const raw = discord['messageId']
  const echo = discord['echo']
  const messageId = typeof raw === 'string' ? discordMessageId(raw) : null
  return {
    external: false,
    text,
    username: typeof username === 'string' ? username : null,
    messageId,
    // A coordinator prompt's conversation is the project channel itself.
    replyTo: discord['threadId'] === channelId ? messageId : null,
    // Shown when a prompt without a Discord message is taken (wake, scheduled run).
    echo: typeof echo === 'string' ? echo : null,
  }
}

function echoLine({ username, text }: { username: string | null; text: string }): string {
  // Block markdown only renders at the start of a line, so it goes below the prefix.
  const separator = BLOCK_MARKDOWN_START.test(text) ? '\n' : ' '
  return `» **${username ?? 'queued'}:**${separator}${text}`
}

// Headings, quotes, lists, code fences, rules, tables and subtext.
const BLOCK_MARKDOWN_START = /^ {0,3}(#{1,6}(\s|$)|-#\s|>|[-*+]\s|\d{1,9}[.)]\s|```|~~~|-{3,}\s*$|\|)/
const CODE_FENCE = /^ {0,3}(```|~~~)/

// Every prompt the bot posts (CLI, routines, TUI, voice, slash commands) is
// subtext, so it reads apart from model output. A long one becomes several messages (effects.ts).
export function formatEcho(input: { username: string | null; text: string }): string {
  return subtext(echoLine(input))
}

// A long echo (formatEcho) as several messages, split like model markdown.
// Each piece gets its `-# ` again: a line cut at a word break would lose it.
export function echoPayloads(echo: string): DiscordPayload[] {
  return markdownPayloads(echo).map((payload) => ('content' in payload ? { content: subtext(payload.content.trim()) } : payload))
}

// A slash command reply stands in for the user message: one Discord message, long text is cut.
export function formatEchoReply(input: { username: string | null; text: string }): string {
  return cut(formatEcho(input), DISCORD_TEXT_LIMIT)
}

// Every non-empty line gets `-# `. Subtext only renders inline markdown: code
// blocks stay as they are, headings become bold, other block markers show as text.
function subtext(text: string): string {
  let fenced = false
  return text
    .split('\n')
    .flatMap((line) => {
      if (CODE_FENCE.test(line)) fenced = !fenced
      else if (!fenced && line.trim() === '') return []
      else if (!fenced && !line.startsWith('-# ')) return [asSubtext(line.replace(HEADING, '**$1**'))]
      return [line]
    })
    .join('\n')
}

const HEADING = /^ {0,3}#{1,6}\s+(.+?)\s*$/

function cut(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

// The ack of a prompt with a Discord message replies to it. Without one (CLI,
// routines, TUI) the ack itself shows the prompt, and its status line below.
function ackContent(item: PendingInput, status: string | null): string {
  if (item.messageId) return asSubtext(status ?? '')
  const line = status ? `\n${asSubtext(status)}` : ''
  return `${cut(subtext(item.echo ?? echoLine(item)), DISCORD_TEXT_LIMIT - line.length)}${line}`
}

type Slice = { draft: Draft<ThreadView>; emit: Emit }

function closeAck({ emit }: Slice, item: PendingInput, status: string) {
  if (item.acked) emit({ type: 'edit', key: ackKey(item.inboxID), messages: [textOnly(ackContent(item, status))] })
}

// An acked item starts running. The user message (or the ack without one)
// already shows the prompt: a reply to it marks where it runs, instead of a
// second copy. Also in a coordinator, where the answer may post no text (IDLE).
function markStarted({ emit }: Slice, item: PendingInput) {
  const ack = textOnly(ackContent(item, item.messageId ? 'Queued' : null))
  emit({ type: 'edit', key: ackKey(item.inboxID), messages: [ack], reply: asSubtext('Queued message sent'), replyTo: item.messageId })
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
  const { external, ...fields } = inputFields({ payload: item.payload, channelId: draft.channelId })
  // The expanded prompt of a command Kimaki ran: the queue echo shows the typed command, never the template.
  const command = external ? draft.commandPending : null
  if (external) draft.commandPending = null
  const meta = command ? { ...fields, ...command } : fields
  // Idle with nothing pending: OpenCode runs it at once, like a normal message.
  const acked = item.delivery === 'queue' && (busy || draft.inbox.length > 0)
  const pending: PendingInput = { inboxID, delivery: item.delivery, ...meta, acked }
  draft.inbox.push(pending)
  if (item.delivery !== 'queue') {
    if (!meta.echo) return
    emit({ type: 'send', text: meta.echo, echo: true })
    draft.lastKind = null
    return
  }
  if (!acked) return
  const position = queuedItems(draft).length
  const remove = meta.messageId ? 'Delete the original message to remove it, or use' : 'Remove it with'
  const ack = textOnly(ackContent(pending, `Queued at position ${position}. ${remove} /clear-queue position:${position}`))
  emit({ type: 'show', key: ackKey(inboxID), messages: [ack], replyTo: meta.messageId, notify: false, echo: true })
}

export function deliverQueued(slice: Slice & { inboxID: string }) {
  const item = takeQueued(slice, slice.inboxID)
  if (!item || (!item.acked && !item.echo)) return
  slice.draft.lastKind = null
  if (item.acked) return markStarted(slice, item)
  slice.emit({ type: 'send', text: item.echo ?? formatEcho(item), echo: true })
}

export function cancelQueued(slice: Slice & { inboxID: string }) {
  const item = takeQueued(slice, slice.inboxID)
  if (item) closeAck(slice, item, 'Removed from queue')
}

// Promoted to steer: it leaves the queue and runs at the next step, without an echo.
export function promoteQueued(slice: Slice & { inboxID: string }) {
  const item = slice.draft.inbox.find((candidate) => candidate.inboxID === slice.inboxID)
  if (item?.delivery !== 'queue') return
  if (item.acked) markStarted(slice, { ...item })
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
    if (existing?.delivery === 'queue' && item.delivery === 'steer') {
      if (existing.acked) markStarted(slice, existing)
      return { ...existing, delivery: 'steer' }
    }
    const { external: _external, ...fields } = inputFields({ payload: item.payload, channelId: draft.channelId })
    return { inboxID: item.id, delivery: item.delivery, ...fields, acked: item.delivery === 'queue' }
  })
}

export function queuedItemFor(bot: Bot, { threadId, messageId }: { threadId: string; messageId: string }) {
  const view = bot.store.getState().threads[threadId]
  return (view && queuedItems(view).find((item) => item.messageId === messageId)) ?? null
}
