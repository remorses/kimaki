// Actions (spec 27.2): the only module that writes to OpenCode and creates
// session threads. Callers (ingress, slash commands, buttons; CLI and
// scheduler later) get an ack back. Session output is never rendered here:
// it arrives through the event stream.
//
// A new plain message interrupts the run (spec 9.1, corrected in section 20):
//
//   cancel pending questions ─▶ reject pending permissions ─▶ interrupt(resume: false)
//     ─▶ prompt(steer)
//
// Interrupt first, then prompt: the new prompt's wake starts the next
// execution with "input" scope, which runs queued items after it. The other
// order (prompt, then interrupt with resume) parks queued items for good.

import { ChannelType, type Client, type Message, type ThreadChannel } from 'discord.js'

import type { KimakiDb } from './db.ts'
import { DbError, DiscordError, OpenCodeError, OpenCodeUnavailableError } from './errors.ts'
import type { EventLoop } from './event-loop.ts'
import { createLogger } from './logger.ts'
import type { OpencodeConnection } from './opencode-server.ts'
import type { PermissionDecision } from './permissions.ts'
import type { FormAnswer } from './questions.ts'
import { formatEcho } from './queue.ts'
import { parseTextMessage, type Route } from './routes.ts'
import * as schema from './schema.ts'
import type { BotStore } from './store.ts'
import { baseInstructions, INSTRUCTION_KEY, turnContext, withTurnContext } from './system-prompt.ts'

const logger = createLogger('ACTIONS')

export type Author = { id: string; username: string }

export type PromptFile = { uri: string; name: string }

// Prompt IDs map a Discord message to its inbox item without stored state (spec 9.2.2).
export function promptIdForMessage(messageId: string): string {
  return `msg_discord_${messageId}`
}

function parseModel(value: string | null | undefined, variant: string | null | undefined) {
  if (!value) return null
  const slash = value.indexOf('/')
  if (slash <= 0) return null
  return {
    providerID: value.slice(0, slash),
    id: value.slice(slash + 1),
    ...(variant && { variant }),
  }
}

// What a thread name and an echo show for an input.
function routeText(route: Route): string {
  if (route.kind === 'shell') return `!${route.command}`
  if (route.kind === 'command') return `/${route.name}${route.arguments ? ` ${route.arguments}` : ''}`
  return route.text
}

export function btwPrompt({
  text,
  parentSessionId,
  sourceThreadId,
  sessionId,
  threadId,
}: {
  text: string
  parentSessionId: string
  sourceThreadId: string
  sessionId: string
  threadId: string
}): string {
  return [
    'The user asked a side question while you were working on another task.',
    'This is a forked session whose ONLY goal is to answer this question.',
    'Do NOT continue, resume, or reference the previous task. Only answer the question below.',
    '',
    `Parent session: ${parentSessionId} (thread <#${sourceThreadId}>)`,
    'Do NOT send messages to the parent session unless the user explicitly asks you to.',
    // The instructions entry is copied from the parent (prompt cache); these IDs win.
    `This fork has its own IDs: OpenCode session ${sessionId}, Discord thread ${threadId}.`,
    '',
    text,
  ].join('\n')
}

export function createActions({
  discord,
  db,
  opencode,
  eventLoop,
  store,
}: {
  discord: Client
  db: KimakiDb
  opencode: OpencodeConnection
  eventLoop: EventLoop
  store: BotStore
}) {
  function client() {
    const endpoint = opencode.endpoint
    if (!endpoint) return new OpenCodeUnavailableError({ reason: 'not connected' })
    return endpoint.client
  }

  function rootSession(threadId: string): OpenCodeError | string {
    return store.getState().roots[threadId] ?? new OpenCodeError({ operation: `find the session of thread ${threadId}` })
  }

  async function prompt({
    sessionId,
    threadId,
    threadName,
    text,
    author,
    messageId,
    delivery,
    files = [],
    id = promptIdForMessage(messageId),
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
    id?: string
  }): Promise<OpenCodeUnavailableError | OpenCodeError | void> {
    const opencodeClient = client()
    if (opencodeClient instanceof Error) return opencodeClient
    const context = turnContext({ username: author.username, userId: author.id, messageId, threadId, threadName })
    const result = await opencodeClient.session
      .prompt({
        sessionID: sessionId,
        id,
        text: withTurnContext({ text, context }),
        files: files.map((file) => ({ uri: file.uri, name: file.name })),
        delivery,
        metadata: { discord: { userId: author.id, username: author.username, messageId, threadId } },
      })
      .catch((e) => new OpenCodeError({ operation: 'session.prompt', cause: e }))
    if (result instanceof Error) return result
  }

  // Questions and permissions of the thread (root and children) that wait for the user.
  async function cancelPendingUi(threadId: string): Promise<OpenCodeUnavailableError | OpenCodeError | void> {
    const view = store.getState().threads[threadId]
    const opencodeClient = client()
    if (opencodeClient instanceof Error) return opencodeClient
    if (!view) return
    const forms = Object.entries(view.forms).map(([formID, form]) =>
      opencodeClient.session.form
        .cancel({ sessionID: form.sessionId, formID })
        .catch((e) => new OpenCodeError({ operation: 'session.form.cancel', cause: e })),
    )
    const permissions = Object.entries(view.permissions).map(([requestID, request]) =>
      opencodeClient.permission
        .reply({ sessionID: request.sessionId, requestID, decision: 'reject' })
        .catch((e) => new OpenCodeError({ operation: 'permission.reply', cause: e })),
    )
    // Settled meanwhile by someone else is fine: log and go on.
    for (const result of await Promise.all([...forms, ...permissions])) {
      if (result instanceof Error) logger.warn(`cancel pending UI in ${threadId}: ${result.message}`)
    }
  }

  async function answerForm({ sessionId, formID, answer }: { sessionId: string; formID: string; answer: FormAnswer }) {
    const opencodeClient = client()
    if (opencodeClient instanceof Error) return opencodeClient
    const result = await opencodeClient.session.form
      .reply({ sessionID: sessionId, formID, answer })
      .catch((e) => new OpenCodeError({ operation: 'session.form.reply', cause: e }))
    if (result instanceof Error) return result
  }

  async function replyPermission({
    sessionId,
    requestID,
    decision,
  }: {
    sessionId: string
    requestID: string
    decision: PermissionDecision
  }) {
    const opencodeClient = client()
    if (opencodeClient instanceof Error) return opencodeClient
    const result = await opencodeClient.permission
      .reply({ sessionID: sessionId, requestID, decision })
      .catch((e) => new OpenCodeError({ operation: 'permission.reply', cause: e }))
    if (result instanceof Error) return result
  }

  async function interrupt(sessionId: string): Promise<OpenCodeUnavailableError | OpenCodeError | void> {
    const opencodeClient = client()
    if (opencodeClient instanceof Error) return opencodeClient
    const result = await opencodeClient.session
      .interrupt({ sessionID: sessionId, resume: false })
      .catch((e) => new OpenCodeError({ operation: 'session.interrupt', cause: e }))
    if (result instanceof Error) return result
  }

  // A plain message: it replaces whatever the session is doing.
  async function steer(input: {
    sessionId: string
    threadId: string
    threadName: string
    text: string
    author: Author
    messageId: string
    files?: readonly PromptFile[]
  }): Promise<OpenCodeUnavailableError | OpenCodeError | void> {
    const cancelled = await cancelPendingUi(input.threadId)
    if (cancelled instanceof Error) return cancelled
    const interrupted = await interrupt(input.sessionId)
    if (interrupted instanceof Error) return interrupted
    return prompt({ ...input, delivery: 'steer' })
  }

  async function threadProject(thread: ThreadChannel): Promise<DbError | DiscordError | { channelId: string; directory: string }> {
    const channelId = thread.parentId
    if (!channelId) return new DiscordError({ operation: `find the channel of thread ${thread.id}` })
    const row = await db.query.channel_directories
      .findFirst({ where: { channel_id: channelId } })
      .catch((e) => new DbError({ operation: 'read channel_directories', cause: e }))
    if (row instanceof Error) return row
    if (!row) return new DiscordError({ operation: `find the project of channel ${channelId}` })
    return { channelId, directory: row.directory }
  }

  async function bindThread({
    threadId,
    sessionId,
    channelId,
    directory,
    isNew,
  }: {
    threadId: string
    sessionId: string
    channelId: string
    directory: string
    isNew: boolean
  }): Promise<DbError | void> {
    const inserted = await db
      .insert(schema.thread_sessions)
      .values({ thread_id: threadId, session_id: sessionId, source: 'kimaki' })
      .catch((e) => new DbError({ operation: 'insert thread_sessions', cause: e }))
    if (inserted instanceof Error) return inserted
    const bound = await eventLoop.bind({ threadId, sessionId, channelId, directory, isNew })
    if (bound instanceof Error) return bound
    logger.log(`session ${sessionId} bound to thread ${threadId}`)
  }

  // Fork the whole session into a new "btw:" thread that answers one side
  // question (V1 /btw). The source session keeps running. The fork inherits
  // messages, agent, model and instructions, so its prompt cache is warm.
  async function forkBtw({
    sourceThread,
    text,
    author,
    messageId,
    files = [],
    agent,
  }: {
    sourceThread: ThreadChannel
    text: string
    author: Author
    messageId: string
    files?: readonly PromptFile[]
    // A voice message asked for this agent.
    agent?: string
  }): Promise<OpenCodeUnavailableError | OpenCodeError | DiscordError | DbError | { threadId: string; sessionId: string }> {
    const opencodeClient = client()
    if (opencodeClient instanceof Error) return opencodeClient
    const parentSessionId = rootSession(sourceThread.id)
    if (parentSessionId instanceof Error) return parentSessionId
    const project = await threadProject(sourceThread)
    if (project instanceof Error) return project
    const channel = await discord.channels
      .fetch(project.channelId)
      .catch((e) => new DiscordError({ operation: `fetch channel ${project.channelId}`, cause: e }))
    if (channel instanceof Error) return channel
    if (channel?.type !== ChannelType.GuildText) {
      return new DiscordError({ operation: `fork into non-text channel ${project.channelId}` })
    }

    const [forked, thread] = await Promise.all([
      opencodeClient.session
        .fork({ sessionID: parentSessionId })
        .catch((e) => new OpenCodeError({ operation: 'session.fork', cause: e })),
      channel.threads
        .create({ name: `btw: ${text.replace(/\s+/g, ' ')}`.slice(0, 100), autoArchiveDuration: 1440 })
        .catch((e) => new DiscordError({ operation: 'create btw thread', cause: e })),
    ])
    // Either side failed: remove the other so nothing is left half set up.
    if (forked instanceof Error) {
      if (!(thread instanceof Error)) await thread.delete('btw fork failed').catch(() => undefined)
      return forked
    }
    if (thread instanceof Error) {
      await opencodeClient.session.remove({ sessionID: forked.id }).catch(() => undefined)
      return thread
    }

    const marked = await opencodeClient.session
      .update({
        sessionID: forked.id,
        metadata: { kimaki: { threadId: thread.id, channelId: project.channelId, source: 'discord' } },
      })
      .catch((e) => new OpenCodeError({ operation: 'session.update', cause: e }))
    if (marked instanceof Error) return marked
    const bound = await bindThread({
      threadId: thread.id,
      sessionId: forked.id,
      channelId: project.channelId,
      directory: project.directory,
      isNew: false,
    })
    if (bound instanceof Error) return bound
    await thread.members.add(author.id).catch((e: Error) => logger.warn(`add btw member: ${e.message}`))
    const intro = await thread
      .send({ content: `Reusing context from <#${sourceThread.id}> to answer prompt...\n${text}`.slice(0, 2_000) })
      .catch((e) => new DiscordError({ operation: 'send btw intro', cause: e }))
    if (intro instanceof Error) return intro
    if (agent) {
      const switched = await switchAgent({ sessionId: forked.id, agent })
      if (switched instanceof Error) return switched
    }

    const sent = await prompt({
      sessionId: forked.id,
      threadId: thread.id,
      threadName: thread.name,
      text: btwPrompt({ text, parentSessionId, sourceThreadId: sourceThread.id, sessionId: forked.id, threadId: thread.id }),
      author,
      messageId,
      delivery: 'steer',
      files,
    })
    if (sent instanceof Error) return sent
    return { threadId: thread.id, sessionId: forked.id }
  }

  async function cancelQueued({ threadId, inboxID }: { threadId: string; inboxID: string }) {
    const opencodeClient = client()
    if (opencodeClient instanceof Error) return opencodeClient
    const sessionId = rootSession(threadId)
    if (sessionId instanceof Error) return sessionId
    const result = await opencodeClient.session.inbox
      .cancel({ sessionID: sessionId, inboxID })
      .catch((e) => new OpenCodeError({ operation: 'session.inbox.cancel', cause: e }))
    if (result instanceof Error) return result
  }

  // Cancels queued items: one by 1-based position, or all of them.
  async function clearQueue({
    threadId,
    position,
  }: {
    threadId: string
    position?: number | null
  }): Promise<OpenCodeUnavailableError | OpenCodeError | { cleared: number }> {
    const opencodeClient = client()
    if (opencodeClient instanceof Error) return opencodeClient
    const sessionId = rootSession(threadId)
    if (sessionId instanceof Error) return sessionId
    const inbox = await opencodeClient.session.inbox
      .list({ sessionID: sessionId })
      .catch((e) => new OpenCodeError({ operation: 'session.inbox.list', cause: e }))
    if (inbox instanceof Error) return inbox
    const queued = inbox.filter((item) => item.type === 'user' && item.delivery === 'queue')
    const targets = position ? queued.slice(position - 1, position) : queued
    for (const item of targets) {
      const result = await cancelQueued({ threadId, inboxID: item.id })
      if (result instanceof Error) return result
    }
    return { cleared: targets.length }
  }

  // /abort: stop the run, drop the queue, cancel pending questions and permissions.
  async function abort({ threadId }: { threadId: string }) {
    const sessionId = rootSession(threadId)
    if (sessionId instanceof Error) return sessionId
    const cleared = await clearQueue({ threadId })
    if (cleared instanceof Error) return cleared
    const cancelled = await cancelPendingUi(threadId)
    if (cancelled instanceof Error) return cancelled
    const interrupted = await interrupt(sessionId)
    if (interrupted instanceof Error) return interrupted
    // interrupt does not stop user shells (`!cmd`): they run in the background.
    const killed = await killShells({ sessionId })
    if (killed instanceof Error) return killed
    return cleared
  }

  // An edited queued message: cancel the old item, queue the new text at the end.
  async function requeueEdited({
    message,
    inboxID,
    files,
  }: {
    message: Message
    inboxID: string
    files: readonly PromptFile[]
  }) {
    const route = parseTextMessage({ content: message.content })
    const sessionId = rootSession(message.channelId)
    if (sessionId instanceof Error) return sessionId
    const cancelled = await cancelQueued({ threadId: message.channelId, inboxID })
    if (cancelled instanceof Error) return cancelled
    const text = route?.kind === 'queue' || route?.kind === 'steer' ? route.text : files.length > 0 ? '' : null
    if (text === null) return
    const thread = message.channel.isThread() ? message.channel : null
    return prompt({
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
  function shell({ threadId, sessionId, command }: { threadId: string; sessionId: string; command: string }) {
    const opencodeClient = client()
    if (opencodeClient instanceof Error) return opencodeClient
    void opencodeClient.session
      .shell({ sessionID: sessionId, command })
      .catch((e) => new OpenCodeError({ operation: 'session.shell', cause: e }))
      .then((result) => {
        if (!(result instanceof Error)) return
        logger.error(`shell in ${threadId} failed: ${result.message}`)
        eventLoop.dispatch(threadId, { type: 'kimaki.error', message: result.message })
      })
  }

  // User shells of a session that still run (for /abort).
  async function killShells({ sessionId }: { sessionId: string }): Promise<OpenCodeUnavailableError | OpenCodeError | void> {
    const opencodeClient = client()
    if (opencodeClient instanceof Error) return opencodeClient
    const info = await opencodeClient.session
      .get({ sessionID: sessionId })
      .catch((e) => new OpenCodeError({ operation: 'session.get', cause: e }))
    if (info instanceof Error) return info
    const location = { directory: info.location.directory }
    const shells = await opencodeClient.shell
      .list({ location })
      .catch((e) => new OpenCodeError({ operation: 'shell.list', cause: e }))
    if (shells instanceof Error) return shells
    const running = shells.data.filter((item) => item.status === 'running' && item.metadata['sessionID'] === sessionId)
    for (const item of running) {
      const removed = await opencodeClient.shell
        .remove({ id: item.id, location })
        .catch((e) => new OpenCodeError({ operation: 'shell.remove', cause: e }))
      if (removed instanceof Error) return removed
    }
  }

  // `/name args`: an OpenCode command when the project has it, else plain text.
  async function command(input: {
    sessionId: string
    threadId: string
    threadName: string
    directory: string
    route: Extract<Route, { kind: 'command' }>
    author: Author
    messageId: string
    files: readonly PromptFile[]
  }): Promise<OpenCodeUnavailableError | OpenCodeError | void> {
    const opencodeClient = client()
    if (opencodeClient instanceof Error) return opencodeClient
    const { route } = input
    const commands = await opencodeClient.command
      .list({ location: { directory: input.directory } })
      .catch((e) => new OpenCodeError({ operation: 'command.list', cause: e }))
    if (commands instanceof Error) return commands
    if (!commands.data.some((candidate) => candidate.name === route.name)) {
      const text = `/${route.name}${route.arguments ? ` ${route.arguments}` : ''}`
      if (route.queue) return prompt({ ...input, text, delivery: 'queue' })
      return steer({ ...input, text })
    }
    if (!route.queue) {
      const cancelled = await cancelPendingUi(input.threadId)
      if (cancelled instanceof Error) return cancelled
      const interrupted = await interrupt(input.sessionId)
      if (interrupted instanceof Error) return interrupted
    }
    const result = await opencodeClient.session
      .command({
        sessionID: input.sessionId,
        name: route.name,
        text: route.arguments,
        files: input.files.map((file) => ({ uri: file.uri, name: file.name })),
        delivery: route.queue ? 'queue' : 'steer',
      })
      .catch((e) => new OpenCodeError({ operation: 'session.command', cause: e }))
    if (result instanceof Error) return result
  }

  // Agents a voice message may pick (not subagents, not hidden ones).
  async function primaryAgents({ directory }: { directory: string }) {
    const opencodeClient = client()
    if (opencodeClient instanceof Error) return opencodeClient
    const agents = await opencodeClient.agent
      .list({ location: { directory } })
      .catch((e) => new OpenCodeError({ operation: 'agent.list', cause: e }))
    if (agents instanceof Error) return agents
    return agents.data
      .filter((agent) => agent.mode !== 'subagent' && !agent.hidden)
      .map((agent) => ({ name: agent.name, description: agent.description ?? '' }))
  }

  async function switchAgent({ sessionId, agent }: { sessionId: string; agent: string }) {
    const opencodeClient = client()
    if (opencodeClient instanceof Error) return opencodeClient
    const result = await opencodeClient.session
      .switchAgent({ sessionID: sessionId, agent })
      .catch((e) => new OpenCodeError({ operation: 'session.switchAgent', cause: e }))
    if (result instanceof Error) return result
  }

  // A route for an existing session (every kind that stays in its thread).
  async function runInSession({
    sessionId,
    threadId,
    threadName,
    directory,
    route,
    author,
    messageId,
    files,
  }: {
    sessionId: string
    threadId: string
    threadName: string
    directory: string
    route: Exclude<Route, { kind: 'btw' | 'new-session' }>
    author: Author
    messageId: string
    files: readonly PromptFile[]
  }) {
    const base = { sessionId, threadId, threadName, author, messageId, files }
    switch (route.kind) {
      case 'shell':
        return shell({ threadId, sessionId, command: route.command })
      case 'command':
        return command({ ...base, directory, route })
      case 'queue':
        // A queued voice message does not switch the agent: that would change the running turn.
        if (route.agent) logger.log(`ignoring agent ${route.agent} of a queued message`)
        return prompt({ ...base, text: route.text, delivery: 'queue' })
      case 'steer': {
        if (route.agent) {
          const switched = await switchAgent({ sessionId, agent: route.agent })
          if (switched instanceof Error) return switched
        }
        return steer({ ...base, text: route.text })
      }
    }
  }

  // One entry point for thread input of every source (spec 9.4).
  async function dispatch({
    thread,
    route,
    author,
    messageId,
    files = [],
  }: {
    thread: ThreadChannel
    route: Route
    author: Author
    messageId: string
    files?: readonly PromptFile[]
  }) {
    const sessionId = rootSession(thread.id)
    if (sessionId instanceof Error) return sessionId
    const project = await threadProject(thread)
    if (project instanceof Error) return project
    switch (route.kind) {
      case 'btw':
        return forkBtw({ sourceThread: thread, text: route.text, author, messageId, files, agent: route.agent })
      case 'new-session': {
        // A fresh thread in the same channel, with no history.
        return startSession({
          channelId: project.channelId,
          directory: project.directory,
          route: { kind: 'steer', text: route.text, ...(route.agent && { agent: route.agent }) },
          author,
          messageId,
          startMessageId: null,
          files,
        })
      }
      default:
        return runInSession({
          sessionId,
          threadId: thread.id,
          threadName: thread.name,
          directory: project.directory,
          route,
          author,
          messageId,
          files,
        })
    }
  }

  async function startSession({
    channelId,
    directory,
    route,
    author,
    messageId,
    startMessageId = messageId,
    showInput = startMessageId === null,
    threadName: explicitName,
    files = [],
  }: {
    channelId: string
    directory: string
    // The first input: a prompt, a shell command or an OpenCode command.
    route: Exclude<Route, { kind: 'btw' | 'new-session' | 'queue' }>
    author: Author
    // The Discord message this input came from; it keys the prompt id.
    messageId: string
    // The thread starts from this message; null for a thread without one.
    startMessageId?: string | null
    // Post the input as the first thread message: the start message does not
    // show it (voice message, or no start message).
    showInput?: boolean
    // Default: the input text, flattened and cut to 80 chars.
    threadName?: string
    files?: readonly PromptFile[]
  }): Promise<
    OpenCodeUnavailableError | OpenCodeError | DiscordError | DbError | { threadId: string; sessionId: string }
  > {
    const opencodeClient = client()
    if (opencodeClient instanceof Error) return opencodeClient

    const channel = await discord.channels
      .fetch(channelId)
      .catch((e) => new DiscordError({ operation: `fetch channel ${channelId}`, cause: e }))
    if (channel instanceof Error) return channel
    if (channel?.type !== ChannelType.GuildText) {
      return new DiscordError({ operation: `start thread in non-text channel ${channelId}` })
    }
    const text = routeText(route)
    const threadName = explicitName ?? (text.replace(/\s+/g, ' ').slice(0, 80) || 'Kimaki session')
    const thread = await channel.threads
      .create({ name: threadName, autoArchiveDuration: 1440, ...(startMessageId && { startMessage: startMessageId }) })
      .catch((e) => new DiscordError({ operation: 'create thread', cause: e }))
    if (thread instanceof Error) return thread

    const defaults = await db.query.channel_directories
      .findFirst({ where: { channel_id: channelId }, with: { channel_model: true, channel_agent: true } })
      .catch((e) => new DbError({ operation: 'read channel defaults', cause: e }))
    if (defaults instanceof Error) return defaults
    const model = parseModel(defaults?.channel_model?.model_id, defaults?.channel_model?.variant)
    const agent = (route.kind === 'steer' && route.agent) || defaults?.channel_agent?.agent_name

    const session = await opencodeClient.session
      .create({
        title: threadName,
        location: { directory },
        ...(model && { model }),
        ...(agent && { agent }),
        metadata: { kimaki: { threadId: thread.id, channelId, source: 'discord' } },
      })
      .catch((e) => new OpenCodeError({ operation: 'session.create', cause: e }))
    if (session instanceof Error) return session

    const instructions = await opencodeClient.session.instructions.entry
      .put({
        sessionID: session.id,
        key: INSTRUCTION_KEY,
        value: baseInstructions({ sessionId: session.id, threadId: thread.id, channelId, guildId: channel.guildId }),
      })
      .catch((e) => new OpenCodeError({ operation: 'instructions.entry.put', cause: e }))
    if (instructions instanceof Error) return instructions

    const bound = await bindThread({ threadId: thread.id, sessionId: session.id, channelId, directory, isNew: true })
    if (bound instanceof Error) return bound
    if (showInput) {
      const echo = await thread
        .send({ content: formatEcho({ username: author.username, text }), allowedMentions: { parse: [] } })
        .catch((e) => new DiscordError({ operation: 'send first input', cause: e }))
      if (echo instanceof Error) return echo
    }

    const first = route.kind === 'steer' ? { kind: 'steer' as const, text: route.text } : route
    const sent = await runInSession({
      sessionId: session.id,
      threadId: thread.id,
      threadName,
      directory,
      route: first,
      author,
      messageId,
      files,
    })
    if (sent instanceof Error) return sent
    return { threadId: thread.id, sessionId: session.id }
  }

  return {
    startSession,
    dispatch,
    shell,
    killShells,
    primaryAgents,
    prompt,
    forkBtw,
    cancelQueued,
    clearQueue,
    abort,
    requeueEdited,
    answerForm,
    replyPermission,
  }
}

export type Actions = ReturnType<typeof createActions>
