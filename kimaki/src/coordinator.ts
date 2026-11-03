// Coordinator notes: when a thread session finishes a run, its coordinator learns
// about it, so the coordinator always knows what happened in its project.
//
//   thread run ends ─▶ `kimaki send --wait` prompt, wait not over, target busy? ─▶ no note: the wait prints the answer
//                  ├─▶ run prompt sent by a coordinator (`sender`)?      ─▶ note + wake that coordinator
//                  └─▶ else (user steered, routine), channel coordinator? ─▶ silent note (read at next prompt)
//
// Who sent the prompt is in its metadata (`sender`, prompt.ts), read from the
// run's messages: no state of its own. The note is a synthetic inbox item, like
// OpenCode's own subagent completion (core/src/session/subagent-completion.ts):
// `resume` decides if it wakes the session.

import { isCoordinatorChannel, oc, projectOf, readMarker, type Bot } from './bot.ts'
import type { RunEnded } from './event-loop.ts'
import { createLogger } from './logger.ts'
import { IDLE_REPLY } from './plugin/coordinator.ts'
import type { Sender } from './prompt.ts'
import { finalAnswer, formatDuration, formatTokens, sessionUsage, type Message } from './session-events.ts'
import { escapeAttribute } from './system-prompt.ts'

const logger = createLogger('COORDINATOR')

// A woken coordinator reads the whole answer; a silent note only says what happened.
const WAKE_ANSWER_CHARS = 2_000
const NOTE_ANSWER_CHARS = 400
const USER_PROMPT_CHARS = 1_000
const RUN_PAGE_MESSAGES = 30
// A run longer than this only loses uploads from its first steps.
const MAX_RUN_PAGES = 10

// The messages of the last run, oldest first: pages back until its user prompt.
async function lastRunMessages(bot: Bot, sessionId: string) {
  const messages: Message[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_RUN_PAGES; page++) {
    const result = await oc(bot, 'message.list', (client) =>
      client.message.list({ sessionID: sessionId, limit: RUN_PAGE_MESSAGES, ...(cursor ? { cursor } : { order: 'desc' as const }) }),
    )
    if (result instanceof Error) return result
    messages.push(...result.data)
    cursor = result.cursor.next ?? undefined
    if (!cursor || result.data.some((message) => message.type === 'user')) break
  }
  return messages.reverse()
}

// Who wrote the run's prompt, from its metadata (prompt.ts): a sender
// (`kimaki send`, routine, sleep wake) or a person in Discord.
function runPrompt(messages: readonly Message[]): { sender: Sender | null; user: { username: string; text: string } | null } {
  const prompt = messages.findLast((message) => message.type === 'user')
  if (prompt?.type !== 'user') return { sender: null, user: null }
  const sender: unknown = prompt.metadata?.['sender']
  if (sender && typeof sender === 'object') {
    const sessionId: unknown = Reflect.get(sender, 'sessionId')
    const waitUntil: unknown = Reflect.get(sender, 'waitUntil')
    return { sender: { ...(typeof sessionId === 'string' && { sessionId }), ...(typeof waitUntil === 'number' && { waitUntil }) }, user: null }
  }
  const discord: unknown = prompt.metadata?.['discord']
  const username: unknown = discord && typeof discord === 'object' ? Reflect.get(discord, 'username') : null
  return { sender: null, user: typeof username === 'string' ? { username, text: prompt.text } : null }
}

// The coordinator a session belongs to: the root of its conversation when that is
// a coordinator channel. The sender may be a subagent of that coordinator.
async function coordinatorOf(bot: Bot, sessionId: string): Promise<string | null> {
  const { sessionThreads, roots } = bot.store.getState()
  const conversation = sessionThreads[sessionId]
  if (!conversation || !(await holdsCoordinator(bot, conversation))) return null
  return roots[conversation] ?? null
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

// A conversation that is a project channel in coordinator mode holds a coordinator.
async function holdsCoordinator(bot: Bot, conversationId: string): Promise<boolean> {
  if (!isCoordinatorChannel(bot, conversationId)) return false
  const project = await projectOf(bot, conversationId)
  return !(project instanceof Error) && project !== null
}

// The project channel of a session thread, from its view or from Discord.
async function channelOfThread(bot: Bot, threadId: string): Promise<string | null> {
  const view = bot.store.getState().threads[threadId]
  if (view) return view.channelId
  const channel = await bot.discord.channels.fetch(threadId).catch(() => null)
  return channel?.isThread() ? channel.parentId : null
}

// The run's prompt came from `kimaki send --wait`, the run ended before the wait
// ran out and the target still runs: it is waiting in that shell call, which
// prints the answer. A target that is idle lost its wait (shell timeout,
// interrupt), so it gets the note.
async function isWaiting(bot: Bot, target: string): Promise<boolean> {
  const active = await oc(bot, 'session.active', (client) => client.session.active())
  // On a failed check the note goes out: a duplicate is better than a lost result.
  if (active instanceof Error) {
    logger.warn(`wait check of ${target}`, active)
    return false
  }
  return target in active
}

async function noteRunEnded(bot: Bot, run: RunEnded): Promise<void> {
  const channelId = await channelOfThread(bot, run.threadId)
  // The coordinator's own runs, and threads outside any project channel.
  if (!channelId || channelId === run.threadId) return
  const [info, messages] = await Promise.all([
    oc(bot, 'session.get', (client) => client.session.get({ sessionID: run.sessionId })),
    lastRunMessages(bot, run.sessionId),
  ])
  if (info instanceof Error) return logger.warn(`note of ${run.sessionId}`, info)
  if (messages instanceof Error) return logger.warn(`answer of ${run.sessionId}`, messages)
  const marker = readMarker(info.metadata)
  const { sender, user } = runPrompt(messages)
  // TODO: also note sessions on other machines (remote `kimaki send`, OpenCode workspaces).
  // Their bot cannot reach this OpenCode server: relay the note through a Discord envelope
  // in the coordinator channel, like remote-send.ts does for prompts.
  // Only a run a coordinator prompted wakes it. The user steering the thread, routines and
  // other senders leave a silent note in the channel's coordinator.
  const sentBy = sender?.sessionId ? await coordinatorOf(bot, sender.sessionId) : null
  const wake = sentBy !== null
  const target = sentBy ?? (isCoordinatorChannel(bot, channelId) ? bot.store.getState().roots[channelId] : undefined)
  if (!target || target === run.sessionId) return
  if (sender?.waitUntil !== undefined && Date.now() < sender.waitUntil && (await isWaiting(bot, target))) return
  const answer = run.error ?? finalAnswer(messages) ?? 'Finished without a text answer.'
  const state = run.error ? 'error' : 'completed'
  const title = info.title || 'Untitled'
  const routine = marker?.task ? ` routine="#${marker.task.id}"` : ''
  // Context size and run length, so the coordinator knows when a follow-up would rewrite a big cache.
  const usage = sessionUsage(messages)
  const stats = usage ? ` context="${formatTokens(usage.contextTokens)} tokens"${usage.runMs === null ? '' : ` duration="${formatDuration(usage.runMs)}"`}` : ''
  const text = [
    `<session-finished sessionID="${run.sessionId}" threadID="${run.threadId}" state="${state}" title="${escapeAttribute(title)}"${routine}${stats} wake="${wake}">`,
    // The user steered this thread directly: the coordinator must know what they asked.
    ...(user ? [`<user-prompt username="${escapeAttribute(user.username)}">\n${cut(user.text, USER_PROMPT_CHARS)}\n</user-prompt>`] : []),
    cut(answer, wake ? WAKE_ANSWER_CHARS : NOTE_ANSWER_CHARS),
    `More: kimaki session read ${run.sessionId}`,
    ...(wake ? [`The user sees nothing else about this. When it is work they asked for, a failure or a decision they must make, tell them the outcome in a few plain sentences, with the thread link <#${run.threadId}> once. Otherwise reply exactly ${IDLE_REPLY}.`] : []),
    '</session-finished>',
  ].join('\n')
  const sent = await oc(bot, 'session.synthetic', (client) =>
    client.session.synthetic({
      sessionID: target,
      text,
      description: `${title} finished`,
      metadata: { source: 'kimaki-session', sessionID: run.sessionId, threadID: run.threadId, title, state, wake },
      resume: wake,
    }),
  )
  if (sent instanceof Error) return logger.warn(`note of ${run.sessionId} to ${target}`, sent)
  logger.log(`${wake ? 'woke' : 'noted'} coordinator ${target}: ${run.sessionId} ${state}`)
}

export function createCoordinatorNotes() {
  const registered: { bot: Bot | null } = { bot: null }
  return {
    register(bot: Bot) {
      registered.bot = bot
    },
    runEnded(run: RunEnded) {
      const bot = registered.bot
      // No channel in coordinator mode: no note to send, so no OpenCode reads.
      if (bot && (bot.coordinatorDefault || Object.values(bot.store.getState().coordinator).includes(true))) void noteRunEnded(bot, run)
    },
  }
}
