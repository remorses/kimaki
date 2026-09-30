// Actions (spec 27.2): the only module that writes to OpenCode and creates
// session threads. Callers (ingress, slash commands, buttons; CLI and
// scheduler later) get an ack back. Session output is never rendered here:
// it arrives through the event stream.
//
// A new plain message interrupts the run (spec 9.1, corrected in section 20):
//
//   interrupt(resume: false) ─▶ prompt(steer)
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
  }: {
    sourceThread: ThreadChannel
    text: string
    author: Author
    messageId: string
    files?: readonly PromptFile[]
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

  // /abort: stop the run and drop the queue.
  async function abort({ threadId }: { threadId: string }) {
    const sessionId = rootSession(threadId)
    if (sessionId instanceof Error) return sessionId
    const cleared = await clearQueue({ threadId })
    if (cleared instanceof Error) return cleared
    const interrupted = await interrupt(sessionId)
    if (interrupted instanceof Error) return interrupted
    return cleared
  }

  // An edited queued message: cancel the old item, queue the new text at the end.
  async function requeueEdited({ message, inboxID }: { message: Message; inboxID: string }) {
    const route = parseTextMessage({ content: message.content })
    const sessionId = rootSession(message.channelId)
    if (sessionId instanceof Error) return sessionId
    const cancelled = await cancelQueued({ threadId: message.channelId, inboxID })
    if (cancelled instanceof Error) return cancelled
    if (!route || (route.kind !== 'queue' && route.kind !== 'steer')) return
    const thread = message.channel.isThread() ? message.channel : null
    return prompt({
      sessionId,
      threadId: message.channelId,
      threadName: thread?.name ?? '',
      text: route.text,
      author: { id: message.author.id, username: message.author.username },
      messageId: message.id,
      delivery: 'queue',
      // IDs are unique per item: every edit gets its own.
      id: `${promptIdForMessage(message.id)}_e${message.editedTimestamp ?? Date.now()}`,
    })
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
    const base = { sessionId, threadId: thread.id, threadName: thread.name, author, messageId, files }
    switch (route.kind) {
      case 'steer':
        return steer({ ...base, text: route.text })
      case 'queue':
        return prompt({ ...base, text: route.text, delivery: 'queue' })
      case 'btw':
        return forkBtw({ sourceThread: thread, text: route.text, author, messageId, files })
      case 'command':
      case 'shell':
      case 'new-session':
        return new OpenCodeError({ operation: `route ${route.kind} (not implemented yet)` })
    }
  }

  async function startSession({
    channelId,
    directory,
    text,
    author,
    messageId,
    threadName: explicitName,
    files = [],
  }: {
    channelId: string
    directory: string
    text: string
    author: Author
    // The thread starts from this message; it also keys the prompt id.
    messageId: string
    // Default: the prompt text, flattened and cut to 80 chars.
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
    const threadName = explicitName ?? (text.replace(/\s+/g, ' ').slice(0, 80) || 'Kimaki session')
    const thread = await channel.threads
      .create({ name: threadName, startMessage: messageId, autoArchiveDuration: 1440 })
      .catch((e) => new DiscordError({ operation: 'create thread', cause: e }))
    if (thread instanceof Error) return thread

    const defaults = await db.query.channel_directories
      .findFirst({ where: { channel_id: channelId }, with: { channel_model: true, channel_agent: true } })
      .catch((e) => new DbError({ operation: 'read channel defaults', cause: e }))
    if (defaults instanceof Error) return defaults
    const model = parseModel(defaults?.channel_model?.model_id, defaults?.channel_model?.variant)
    const channelAgent = defaults?.channel_agent

    const session = await opencodeClient.session
      .create({
        title: threadName,
        location: { directory },
        ...(model && { model }),
        ...(channelAgent && { agent: channelAgent.agent_name }),
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

    const sent = await prompt({
      sessionId: session.id,
      threadId: thread.id,
      threadName,
      text,
      author,
      messageId,
      delivery: 'steer',
      files,
    })
    if (sent instanceof Error) return sent
    return { threadId: thread.id, sessionId: session.id }
  }

  return { startSession, dispatch, prompt, forkBtw, cancelQueued, clearQueue, abort, requeueEdited }
}

export type Actions = ReturnType<typeof createActions>
