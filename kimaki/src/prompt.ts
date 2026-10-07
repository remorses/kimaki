// Input into existing sessions (spec 27.2): prompts, steering, commands,
// shells, queue edits, /abort, /undo and /redo, and `kimaki send`. Callers
// (ingress, slash commands, buttons, CLI, scheduler) get an ack back. Session
// output is never rendered here: it arrives through the event stream.
//
// A new plain message interrupts the run (spec 9.1, corrected in section 20):
//
//   cancel pending questions ─▶ reject pending permissions ─▶ interrupt(resume: false)
//     ─▶ prompt(steer)
//
// Interrupt first, then prompt: the new prompt's wake starts the next
// execution with "input" scope, which runs queued items after it. The other
// order (prompt, then interrupt with resume) parks queued items for good.

import path from 'node:path'
import crypto from 'node:crypto'
import { Events, type Message, type ThreadChannel } from 'discord.js'
import * as errore from 'errore'

import {
  fetchThread,
  oc,
  parseModel,
  projectOf,
  rootSession,
  routeText,
  textChannel,
  threadOfSession,
  type Author,
  type Bot,
  type PromptFile,
} from './bot.ts'
import { switchModel } from './commands/preference-commands.ts'
import { ConfigError, DbError, DiscordError, OpenCodeError, OpenCodeUnavailableError } from './errors.ts'
import { formatError, NOTIFY_MESSAGE_FLAGS } from './format-parts.ts'
import { createLogger } from './logger.ts'
import type { SendInput } from './lock-routes.ts'
import { formatEcho } from './queue.ts'
import { noAnswerError, parseRemoteResult, remoteEnvelope, promptFilePath, REMOTE_TIMEOUT_MS, type RemoteResult } from './remote-send.ts'
import { parseTextMessage, type Route } from './routes.ts'
import { allMessages } from './session-events.ts'
import { ensureSessionMarker, forkBtw, startSession, threadProject } from './sessions.ts'
import { cancelSleep } from './sleeps.ts'
import type { ScheduledRun } from './system-prompt.ts'
import { turnContext, withTurnContext } from './system-prompt.ts'
import { isBusy } from './thread-reducer.ts'
import { resolveWorkingDirectory } from './worktrees.ts'

const logger = createLogger('PROMPT')


// Prompt IDs map a Discord message to its inbox item without stored state (spec 9.2.2).
export function promptIdForMessage(messageId: string): string {
  return `msg_discord_${messageId}`
}

export async function prompt(
  bot: Bot,
  {
    sessionId,
    threadId,
    threadName,
    text,
    author,
    messageId,
    delivery,
    files = [],
    skills = [],
    id = promptIdForMessage(messageId),
    echo,
  }: {
    sessionId: string
    threadId: string
    threadName: string
    text: string
    author: Author
    // The Discord message (or interaction) this prompt came from.
    messageId: string
    delivery: 'steer' | 'queue'
    files?: readonly PromptFile[]
    // Skill IDs attached to the prompt (`/<skill>-skill`).
    skills?: readonly string[]
    id?: string
    // Line the thread shows when OpenCode takes the prompt (queue.ts), for
    // inputs that have no Discord message: wakes, scheduled runs.
    echo?: string
  },
): Promise<OpenCodeUnavailableError | OpenCodeError | void> {
  const context = turnContext({ username: author.username, userId: author.id, messageId, threadId, threadName })
  const result = await oc(bot, 'session.prompt', (client) =>
    client.session.prompt({
      sessionID: sessionId,
      id,
      text: withTurnContext({ text, context }),
      files: files.map((file) => ({ uri: file.uri, name: file.name })),
      ...(skills.length > 0 && { skills: skills.map((skill) => ({ id: skill })) }),
      delivery,
      metadata: { discord: { userId: author.id, username: author.username, messageId, threadId, ...(echo && { echo }) } },
    }),
  )
  if (result instanceof Error) return result
}

// Questions and permissions of the thread (root and children) that wait for the user.
export async function cancelPendingUi(bot: Bot, threadId: string): Promise<OpenCodeUnavailableError | OpenCodeError | void> {
  if (!bot.opencode.endpoint) return new OpenCodeUnavailableError({ reason: 'not connected' })
  const view = bot.store.getState().threads[threadId]
  if (!view) return
  const forms = Object.entries(view.forms).map(([formID, form]) =>
    oc(bot, 'session.form.cancel', (client) => client.session.form.cancel({ sessionID: form.sessionId, formID })),
  )
  const permissions = Object.entries(view.permissions).map(([requestID, request]) =>
    oc(bot, 'permission.reply', (client) => client.permission.reply({ sessionID: request.sessionId, requestID, decision: 'reject' })),
  )
  // Settled meanwhile by someone else is fine: log and go on.
  for (const result of await Promise.all([...forms, ...permissions])) {
    if (result instanceof Error) logger.warn(`cancel pending UI in ${threadId}: ${result.message}`)
  }
}

export async function interrupt(bot: Bot, sessionId: string): Promise<OpenCodeUnavailableError | OpenCodeError | void> {
  const result = await oc(bot, 'session.interrupt', (client) => client.session.interrupt({ sessionID: sessionId, resume: false }))
  if (result instanceof Error) return result
}

// A plain message: it replaces whatever the session is doing.
export async function steer(
  bot: Bot,
  input: {
    sessionId: string
    threadId: string
    threadName: string
    text: string
    author: Author
    messageId: string
    files?: readonly PromptFile[]
    skills?: readonly string[]
    echo?: string
  },
): Promise<OpenCodeUnavailableError | OpenCodeError | void> {
  const cancelled = await cancelPendingUi(bot, input.threadId)
  if (cancelled instanceof Error) return cancelled
  const interrupted = await interrupt(bot, input.sessionId)
  if (interrupted instanceof Error) return interrupted
  return prompt(bot, { ...input, delivery: 'steer' })
}

export async function cancelQueuedPrompt(bot: Bot, { threadId, inboxID }: { threadId: string; inboxID: string }) {
  const sessionId = rootSession(bot, threadId)
  if (sessionId instanceof Error) return sessionId
  const result = await oc(bot, 'session.inbox.cancel', (client) => client.session.inbox.cancel({ sessionID: sessionId, inboxID }))
  if (result instanceof Error) return result
}

// Cancels queued items: one by 1-based position, or all of them.
export async function clearQueue(
  bot: Bot,
  { threadId, position }: { threadId: string; position?: number | null },
): Promise<OpenCodeUnavailableError | OpenCodeError | { cleared: number }> {
  const sessionId = rootSession(bot, threadId)
  if (sessionId instanceof Error) return sessionId
  const inbox = await oc(bot, 'session.inbox.list', (client) => client.session.inbox.list({ sessionID: sessionId }))
  if (inbox instanceof Error) return inbox
  const queued = inbox.filter((item) => item.type === 'user' && item.delivery === 'queue')
  const targets = position ? queued.slice(position - 1, position) : queued
  for (const item of targets) {
    const result = await cancelQueuedPrompt(bot, { threadId, inboxID: item.id })
    if (result instanceof Error) return result
  }
  return { cleared: targets.length }
}

// /abort: stop the run, drop the queue, cancel pending questions and permissions.
export async function abort(bot: Bot, { threadId }: { threadId: string }) {
  const sessionId = rootSession(bot, threadId)
  if (sessionId instanceof Error) return sessionId
  await cancelSleep(bot, sessionId)
  const cleared = await clearQueue(bot, { threadId })
  if (cleared instanceof Error) return cleared
  const cancelled = await cancelPendingUi(bot, threadId)
  if (cancelled instanceof Error) return cancelled
  const interrupted = await interrupt(bot, sessionId)
  if (interrupted instanceof Error) return interrupted
  // interrupt does not stop user shells (`!cmd`): they run in the background.
  const killed = await killShells(bot, { sessionId })
  if (killed instanceof Error) return killed
  return cleared
}

// An edited queued message: cancel the old item, queue the new text at the end.
export async function requeueEdited(
  bot: Bot,
  { message, inboxID, files }: { message: Message; inboxID: string; files: readonly PromptFile[] },
) {
  const route = parseTextMessage({ content: message.content })
  const sessionId = rootSession(bot, message.channelId)
  if (sessionId instanceof Error) return sessionId
  const cancelled = await cancelQueuedPrompt(bot, { threadId: message.channelId, inboxID })
  if (cancelled instanceof Error) return cancelled
  const text = route?.kind === 'queue' || route?.kind === 'steer' ? route.text : files.length > 0 ? '' : null
  if (text === null) return
  const thread = message.channel.isThread() ? message.channel : null
  return prompt(bot, {
    sessionId,
    threadId: message.channelId,
    threadName: thread?.name ?? '',
    text,
    author: { id: message.author.id, username: message.author.username },
    messageId: message.id,
    delivery: 'queue',
    files,
    // IDs are unique per item: every edit gets its own.
    id: `${promptIdForMessage(message.id)}_e${message.editedTimestamp ?? Date.now()}`,
  })
}

// `!cmd` (spec 9.2.1): native session.shell, not interrupting and not
// queued. The request returns only when the command ends, so it is never
// awaited; output arrives as session.shell.* events.
export function shell(bot: Bot, { threadId, sessionId, command }: { threadId: string; sessionId: string; command: string }) {
  const client = bot.opencode.endpoint?.client
  if (!client) return new OpenCodeUnavailableError({ reason: 'not connected' })
  void client.session
    .shell({ sessionID: sessionId, command })
    .catch((cause) => new OpenCodeError({ operation: 'session.shell', cause }))
    .then((result) => {
      if (!(result instanceof Error)) return
      logger.error(`shell in ${threadId} failed: ${result.message}`)
      bot.effects.run(threadId, [{ type: 'send', text: formatError(result.message), notify: true }])
    })
}

// User shells of a session that still run (for /abort).
async function killShells(bot: Bot, { sessionId }: { sessionId: string }): Promise<OpenCodeUnavailableError | OpenCodeError | void> {
  const info = await oc(bot, 'session.get', (client) => client.session.get({ sessionID: sessionId }))
  if (info instanceof Error) return info
  const location = { directory: info.location.directory }
  const shells = await oc(bot, 'shell.list', (client) => client.shell.list({ location }))
  if (shells instanceof Error) return shells
  const running = shells.data.filter((item) => item.status === 'running' && item.metadata['sessionID'] === sessionId)
  for (const item of running) {
    const removed = await oc(bot, 'shell.remove', (client) => client.shell.remove({ id: item.id, location }))
    if (removed instanceof Error) return removed
  }
}

// `/name args`: an OpenCode command when the project has it, else plain text.
async function command(
  bot: Bot,
  input: {
    sessionId: string
    threadId: string
    threadName: string
    directory: string
    route: Extract<Route, { kind: 'command' }>
    author: Author
    messageId: string
    files: readonly PromptFile[]
  },
): Promise<OpenCodeUnavailableError | OpenCodeError | void> {
  const { route } = input
  const commands = await oc(bot, 'command.list', (client) => client.command.list({ location: { directory: input.directory } }))
  if (commands instanceof Error) return commands
  if (!commands.data.some((candidate) => candidate.name === route.name)) {
    const text = `/${route.name}${route.arguments ? ` ${route.arguments}` : ''}`
    if (route.queue) return prompt(bot, { ...input, text, delivery: 'queue' })
    return steer(bot, { ...input, text })
  }
  if (!route.queue) {
    const cancelled = await cancelPendingUi(bot, input.threadId)
    if (cancelled instanceof Error) return cancelled
    const interrupted = await interrupt(bot, input.sessionId)
    if (interrupted instanceof Error) return interrupted
  }
  const result = await oc(bot, 'session.command', (client) =>
    client.session.command({
      sessionID: input.sessionId,
      name: route.name,
      text: route.arguments,
      files: input.files.map((file) => ({ uri: file.uri, name: file.name })),
      delivery: route.queue ? 'queue' : 'steer',
    }),
  )
  if (result instanceof Error) return result
}

// A route for an existing session (every kind that stays in its thread).
export async function runInSession(
  bot: Bot,
  {
    sessionId,
    threadId,
    threadName,
    directory,
    route,
    author,
    messageId,
    files,
    echo,
  }: {
    sessionId: string
    threadId: string
    threadName: string
    directory: string
    route: Exclude<Route, { kind: 'btw' | 'new-session' }>
    author: Author
    messageId: string
    files: readonly PromptFile[]
    echo?: string
  },
) {
  const base = { sessionId, threadId, threadName, author, messageId, files, echo }
  switch (route.kind) {
    case 'shell':
      return shell(bot, { threadId, sessionId, command: route.command })
    case 'command':
      return command(bot, { ...base, directory, route })
    case 'skill':
      return steer(bot, { ...base, text: route.arguments, skills: [route.id] })
    case 'queue':
      // A queued voice message does not switch the agent: that would change the running turn.
      if (route.agent) logger.log(`ignoring agent ${route.agent} of a queued message`)
      return prompt(bot, { ...base, text: route.text, delivery: 'queue' })
    case 'steer': {
      const agent = route.agent
      if (agent) {
        const switched = await oc(bot, 'session.switchAgent', (client) => client.session.switchAgent({ sessionID: sessionId, agent }))
        if (switched instanceof Error) return switched
      }
      return steer(bot, { ...base, text: route.text })
    }
  }
}

// One entry point for thread input of every source (spec 9.4).
export async function dispatch(
  bot: Bot,
  {
    thread,
    route,
    author,
    messageId,
    files = [],
    echo,
  }: {
    thread: ThreadChannel
    route: Route
    author: Author
    messageId: string
    files?: readonly PromptFile[]
    echo?: string
  },
) {
  const sessionId = rootSession(bot, thread.id)
  if (sessionId instanceof Error) return sessionId
  // New input supersedes a pending `kimaki sleep` of this session.
  await cancelSleep(bot, sessionId)
  const project = await threadProject(bot, thread)
  if (project instanceof Error) return project
  const marked = await ensureSessionMarker(bot, {
    sessionId,
    thread,
    channelId: project.channelId,
    directory: project.directory,
    userId: author.id,
  })
  if (marked instanceof Error) return marked
  switch (route.kind) {
    case 'btw':
      return forkBtw(bot, { sourceThread: thread, text: route.text, author, messageId, files, agent: route.agent })
    case 'new-session':
      // A fresh thread in the same channel, with no history.
      return startSession(bot, {
        channelId: project.channelId,
        directory: project.directory,
        route: { kind: 'steer', text: route.text, ...(route.agent && { agent: route.agent }) },
        author,
        messageId,
        startMessageId: null,
        files,
      })
    default:
      return runInSession(bot, {
        sessionId,
        threadId: thread.id,
        threadName: thread.name,
        directory: project.directory,
        route,
        author,
        messageId,
        files,
        echo,
      })
  }
}

// --- Session history: /undo, /redo.

// Revert needs an idle session: stop the run first, like the OpenCode TUI.
async function idleSession(bot: Bot, threadId: string) {
  const sessionId = rootSession(bot, threadId)
  if (sessionId instanceof Error) return sessionId
  const view = bot.store.getState().threads[threadId]
  if (view && isBusy(view)) {
    const interrupted = await interrupt(bot, sessionId)
    if (interrupted instanceof Error) return interrupted
    const waited = await oc(bot, 'session.wait', (client) => client.session.wait({ sessionID: sessionId }))
    if (waited instanceof Error) return waited
  }
  const info = await oc(bot, 'session.get', (client) => client.session.get({ sessionID: sessionId }))
  if (info instanceof Error) return info
  // All user messages, oldest first: revert boundaries are user messages.
  const messages = await oc(bot, 'message.list', (client) => allMessages({ client, sessionId, type: 'user' }))
  if (messages instanceof Error) return messages
  return { sessionId, revert: info.revert?.messageID ?? null, messages }
}

// Undo only rewinds the conversation: `files: false` makes OpenCode skip snapshot.restore,
// so the project files stay as they are.
// TODO: let users opt in to reverting files too (setting or /undo option) if they ask for it.
const revertFiles = false

// Hides the last turn. Repeating goes one turn further back.
export async function undo(bot: Bot, { threadId }: { threadId: string }) {
  const session = await idleSession(bot, threadId)
  if (session instanceof Error) return session
  const { messages } = session
  const boundary = session.revert ? messages.findIndex((message) => message.id === session.revert) : messages.length
  const target = messages[boundary - 1]
  if (!target) return { reverted: false }
  const staged = await oc(bot, 'session.revert.stage', (client) =>
    client.session.revert.stage({ sessionID: session.sessionId, messageID: target.id, files: revertFiles }),
  )
  if (staged instanceof Error) return staged
  return { reverted: true }
}

// One turn forward again; past the last turn the revert is cleared.
export async function redo(bot: Bot, { threadId }: { threadId: string }) {
  const session = await idleSession(bot, threadId)
  if (session instanceof Error) return session
  if (!session.revert) return { restored: 'nothing' as const }
  const index = session.messages.findIndex((message) => message.id === session.revert)
  const next = index >= 0 ? session.messages[index + 1] : undefined
  if (!next) {
    const cleared = await oc(bot, 'session.revert.clear', (client) => client.session.revert.clear({ sessionID: session.sessionId }))
    if (cleared instanceof Error) return cleared
    return { restored: 'all' as const }
  }
  const staged = await oc(bot, 'session.revert.stage', (client) =>
    client.session.revert.stage({ sessionID: session.sessionId, messageID: next.id, files: revertFiles }),
  )
  if (staged instanceof Error) return staged
  return { restored: 'step' as const }
}

// --- `kimaki send` and remote sends.

// The target channel belongs to another machine: post an envelope there and
// wait for that machine's bot to answer with the result (remote-send.ts).
async function remoteSend(bot: Bot, input: SendInput) {
  const targetId = input.threadId ?? input.channelId
  if (!targetId) return new ConfigError({ reason: 'Remote sends require --channel or --thread' })
  const target = await bot.discord.channels
    .fetch(targetId)
    .catch((cause) => new DiscordError({ operation: 'fetch remote target', cause }))
  if (target instanceof Error) return target
  if (!target?.isSendable()) return new ConfigError({ reason: 'Remote target is not sendable' })
  const envelope = remoteEnvelope(input)
  if (envelope instanceof Error) return envelope
  type Result = Error | RemoteResult
  return new Promise<Result>((resolve) => {
    const finish = (result: Result) => {
      clearTimeout(timer)
      bot.discord.off(Events.MessageCreate, receive)
      resolve(result)
    }
    const receive = (message: Message) => {
      if (message.author.id !== bot.discord.user?.id || message.channelId !== targetId) return
      const result = parseRemoteResult({ footer: message.embeds[0]?.footer?.text, requestId: envelope.requestId })
      if (result) finish(result)
    }
    const timer = setTimeout(() => finish(noAnswerError()), REMOTE_TIMEOUT_MS)
    bot.discord.on(Events.MessageCreate, receive)
    void target
      .send({ content: envelope.content, embeds: [{ footer: { text: envelope.footer } }], files: envelope.attachments, allowedMentions: { parse: [] } })
      .catch((cause) => finish(new DiscordError({ operation: 'send remote envelope', cause })))
  })
}

// `localOnly`: never forward to another machine (remote envelopes, scheduled runs).
// `task`: a scheduled run; its input shows as "» task #N: prompt".
export async function send(bot: Bot, input: SendInput, { localOnly = false, task }: { localOnly?: boolean; task?: ScheduledRun } = {}) {
  if (input.worktree !== undefined && (input.cwd || input.threadId || input.sessionId || input.notifyOnly)) {
    return new ConfigError({ reason: '--worktree requires a new session without --cwd or --notify-only.' })
  }
  if (input.baseBranch && input.worktree === undefined) return new ConfigError({ reason: '--base-branch requires --worktree.' })
  if (input.permissions?.length && (input.threadId || input.sessionId || input.notifyOnly)) {
    return new ConfigError({ reason: '--permission applies only to new sessions. Start a new session without --thread, --session, or --notify-only' })
  }
  const author = { id: input.user?.replace(/[<@!>]/g, '') ?? bot.discord.user!.id, username: task ? `task #${task.id}` : 'CLI' }
  const messageId = crypto.randomUUID()
  const route = parseTextMessage({ content: input.prompt })
  if (!route) return new ConfigError({ reason: 'Prompt is empty' })
  if (input.agent && (route.kind === 'steer' || route.kind === 'btw')) route.agent = input.agent

  if (input.sessionId || input.threadId) {
    const threadId = input.threadId ?? threadOfSession(bot, input.sessionId!)
    if (!threadId) return new ConfigError({ reason: 'No local thread for this session. Use --thread on its owning machine.' })
    const thread = await fetchThread(bot, threadId)
    if (thread instanceof Error) return thread
    const sessionId = bot.store.getState().roots[thread.id]
    if (!sessionId) {
      const project = thread.parentId ? await projectOf(bot, thread.parentId) : null
      if (project instanceof Error) return project
      return !project && !localOnly ? remoteSend(bot, input) : new ConfigError({ reason: 'No local session for this thread' })
    }
    if (input.user) await thread.members.add(author.id).catch((error: Error) => logger.warn(`add thread member: ${error.message}`))
    if (input.model) {
      const model = parseModel(input.model, null)
      if (!model) return new ConfigError({ reason: 'Use --model provider/model' })
      const switched = await switchModel(bot, { sessionId, model: { ...model, variant: null } })
      if (switched instanceof Error) return switched
    }
    const echo = task ? formatEcho({ username: author.username, text: routeText(route) }) : undefined
    const result = await dispatch(bot, { thread, route, author, messageId, files: input.files, echo })
    if (result instanceof Error) return result
    return result ?? { threadId, sessionId: bot.store.getState().roots[threadId]! }
  }

  const project = await bot.db.query.channel_directories
    .findFirst({ where: input.channelId ? { channel_id: input.channelId } : { directory: path.resolve(input.project!) } })
    .catch((cause) => new DbError({ operation: 'resolve send project', cause }))
  if (project instanceof Error) return project
  if (!project) return input.channelId && !localOnly ? remoteSend(bot, input) : new ConfigError({ reason: 'No local project channel for this target' })

  if (input.notifyOnly) {
    const channel = await textChannel(bot, project.channel_id)
    if (channel instanceof Error) return channel
    const thread = await channel.threads
      .create({ name: (input.name ?? input.prompt).replace(/\s+/g, ' ').slice(0, 100), autoArchiveDuration: 1440 })
      .catch((cause) => new DiscordError({ operation: 'create notification thread', cause }))
    if (thread instanceof Error) return thread
    const shown = await thread
      .send({
        content: input.prompt,
        files: input.files?.map((file) => ({ attachment: promptFilePath(file), name: file.name })),
        allowedMentions: { parse: [] },
        flags: NOTIFY_MESSAGE_FLAGS,
      })
      .catch((cause) => new DiscordError({ operation: 'post notification', cause }))
    if (shown instanceof Error) return shown
    if (input.user) await thread.members.add(author.id).catch((error: Error) => logger.warn(`add notification member: ${error.message}`))
    return { threadId: thread.id, sessionId: null }
  }

  const directory = await resolveWorkingDirectory({ projectDirectory: project.directory, candidate: input.cwd ?? project.directory })
  if (directory instanceof Error) return directory
  const permissions: Array<{ action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }> = []
  for (const rule of input.permissions ?? []) {
    const parts = rule.split(':')
    const action = parts.shift()
    const effect = parts.pop()
    if (!action || (effect !== 'allow' && effect !== 'deny' && effect !== 'ask')) return new ConfigError({ reason: 'Use --permission tool[:pattern]:allow|deny|ask' })
    permissions.push({ action, resource: parts.join(':') || '*', effect })
  }
  const model = input.model ? parseModel(input.model, null) : null
  if (input.model && !model) return new ConfigError({ reason: 'Use --model provider/model' })
  const first = route.kind === 'shell' || route.kind === 'command' || route.kind === 'skill'
    ? route
    : { kind: 'steer' as const, text: route.text, agent: input.agent }
  // --cwd reuses that checkout; a scheduled run gets a fresh worktree name per run.
  const worktree = input.cwd
    ? false
    : task && input.worktree
      ? `${input.worktree.slice(0, 40)}-${crypto.randomBytes(4).toString('hex')}`
      : input.worktree
  const started = await startSession(bot, {
    channelId: project.channel_id,
    directory,
    route: first,
    author,
    messageId,
    startMessageId: null,
    threadName: input.name,
    files: input.files,
    permissions,
    parentSessionId: input.parentSessionId,
    task,
    worktree,
    baseBranch: input.baseBranch,
    ...(model && { model: { ...model, variant: null } }),
  })
  if (started instanceof Error) return started
  if (input.user) {
    const thread = await bot.discord.channels
      .fetch(started.threadId)
      .catch((cause) => new DiscordError({ operation: 'fetch send thread', cause }))
    if (thread instanceof Error) return thread
    if (thread?.isThread()) {
      const added = await thread.members.add(author.id).catch((cause) => new DiscordError({ operation: 'add thread member', cause }))
      if (added instanceof Error) return added
    }
  }
  return started
}

// `kimaki upload`: posts local files into the session's thread.
export function upload(bot: Bot, { id, files }: { id: string; files: Array<{ path: string; name: string }> }) {
  const { sessionThreads, roots } = bot.store.getState()
  const threadId = sessionThreads[id] ?? (roots[id] ? id : undefined)
  if (!threadId) return new ConfigError({ reason: 'No local session thread for this upload' })
  bot.effects.run(threadId, [{ type: 'attachments', files }])
  return { uploaded: files.map((file) => file.name) }
}
