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

import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import type { SessionMetadata } from '@opencode/client'
import type { Analytics } from './analytics.ts'
import { ChannelType, Events, type Client, type Message, type TextChannel, type ThreadChannel } from 'discord.js'
import * as errore from 'errore'
import * as orm from 'drizzle-orm'

import { verbosityToV1, type KimakiDb, type Verbosity } from './db.ts'
import { ConfigError, DbError, DiscordError, OpenCodeError, OpenCodeUnavailableError } from './errors.ts'
import type { EventLoop } from './event-loop.ts'
import { createLogger } from './logger.ts'
import type { OpenCodeClient, OpencodeConnection } from './opencode-server.ts'
import type { PermissionDecision } from './permissions.ts'
import type { FormAnswer } from './questions.ts'
import { canonicalPath } from './project.ts'
import { formatEcho } from './queue.ts'
import { parseTextMessage, type Route } from './routes.ts'
import * as schema from './schema.ts'
import type { BotStore } from './store.ts'
import { baseInstructions, INSTRUCTION_KEY, turnContext, withTurnContext } from './system-prompt.ts'
import { isBusy } from './thread-reducer.ts'

const logger = createLogger('ACTIONS')

export type Author = { id: string; username: string }

export type PromptFile = { uri: string; name: string }

export type ModelChoice = { providerID: string; id: string; variant: string | null }

export type SendInput = {
  channelId?: string
  threadId?: string
  sessionId?: string
  project?: string
  prompt: string
  name?: string
  agent?: string
  model?: string
  user?: string
  files?: PromptFile[]
  cwd?: string
  parentSessionId?: string
  permissions?: string[]
  notifyOnly?: boolean
}

export const REMOTE_SEND_PREFIX = 'kimaki-send-v2:'
export const REMOTE_RESULT_PREFIX = 'kimaki-result-v2:'

export function parseSendInput(value: unknown): ConfigError | SendInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new ConfigError({ reason: 'Expected a send object' })
  const fields = new Map(Object.entries(value))
  for (const key of ['channelId', 'threadId', 'sessionId', 'project', 'name', 'agent', 'model', 'user', 'cwd', 'parentSessionId']) {
    const field = fields.get(key)
    if (field !== undefined && (typeof field !== 'string' || !field.trim())) return new ConfigError({ reason: `${key} must be a non-empty string` })
  }
  if (fields.has('notifyOnly') && typeof fields.get('notifyOnly') !== 'boolean') return new ConfigError({ reason: 'notifyOnly must be boolean' })
  const permissions = fields.get('permissions')
  if (permissions !== undefined && (!Array.isArray(permissions) || permissions.some((permission) => typeof permission !== 'string'))) return new ConfigError({ reason: 'Permission rules must be strings' })
  const prompt = fields.get('prompt')
  if (typeof prompt !== 'string' || !prompt.trim()) return new ConfigError({ reason: 'prompt must be a non-empty string' })
  if (['channelId', 'threadId', 'sessionId', 'project'].filter((key) => fields.has(key)).length !== 1) {
    return new ConfigError({ reason: 'Use exactly one of --channel, --thread, --session, --project' })
  }
  const files = fields.get('files')
  if (files !== undefined && (!Array.isArray(files) || files.some((file) => !file || typeof file !== 'object' || typeof file.uri !== 'string' || typeof file.name !== 'string'))) {
    return new ConfigError({ reason: 'files must contain uri and name strings' })
  }
  // The wire shape is checked before relational queries.
  return value as SendInput
}

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
  if (route.kind === 'skill') return `/${route.id}${route.arguments ? ` ${route.arguments}` : ''}`
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
  analytics,
  cliContext,
}: {
  discord: Client
  db: KimakiDb
  opencode: OpencodeConnection
  eventLoop: EventLoop
  store: BotStore
  analytics: Analytics
  cliContext: { dataDir: string; lockPort: number }
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
    skills = [],
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
    // Skill IDs attached to the prompt (`/<skill>-skill`).
    skills?: readonly string[]
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
        ...(skills.length > 0 && { skills: skills.map((skill) => ({ id: skill })) }),
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
    skills?: readonly string[]
  }): Promise<OpenCodeUnavailableError | OpenCodeError | void> {
    const cancelled = await cancelPendingUi(input.threadId)
    if (cancelled instanceof Error) return cancelled
    const interrupted = await interrupt(input.sessionId)
    if (interrupted instanceof Error) return interrupted
    return prompt({ ...input, delivery: 'steer' })
  }

  async function textChannel(channelId: string): Promise<DiscordError | TextChannel> {
    const channel = await discord.channels
      .fetch(channelId)
      .catch((e) => new DiscordError({ operation: `fetch channel ${channelId}`, cause: e }))
    if (channel instanceof Error) return channel
    if (channel?.type !== ChannelType.GuildText) return new DiscordError({ operation: `use non-text channel ${channelId}` })
    return channel
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
    const channel = await textChannel(project.channelId)
    if (channel instanceof Error) return channel

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
      // The ID is what switchAgent and session.create take; the name is for display.
      .map((agent) => ({ name: agent.id, description: agent.description ?? '' }))
  }

  function storedParentSessionId(metadata: SessionMetadata | undefined): string | null {
    const marker = metadata?.['kimaki']
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null
    const parent = marker['parentSessionId']
    return typeof parent === 'string' ? parent : null
  }

  // The one durable system instruction of a session (spec 5.4).
  async function putInstructions({
    sessionId,
    thread,
    channel,
    directory,
    userId,
    parentSessionId = null,
  }: {
    sessionId: string
    thread: ThreadChannel
    channel: TextChannel
    directory: string
    userId: string
    parentSessionId?: string | null
  }): Promise<OpenCodeUnavailableError | OpenCodeError | void> {
    const opencodeClient = client()
    if (opencodeClient instanceof Error) return opencodeClient
    // The agent list is optional prompt context: a failure must not strand the thread.
    const found = await primaryAgents({ directory })
    if (found instanceof Error) logger.warn(`agent list for instructions failed: ${found.message}`)
    const agents = found instanceof Error ? [] : found
    const put = await opencodeClient.session.instructions.entry
      .put({
        sessionID: sessionId,
        key: INSTRUCTION_KEY,
        value: baseInstructions({
          sessionId,
          threadId: thread.id,
          channelId: channel.id,
          guildId: channel.guildId,
          userId,
          dataDir: cliContext.dataDir,
          channelTopic: channel.topic,
          agents,
          parentSessionId,
        }),
      })
      .catch((e) => new OpenCodeError({ operation: 'instructions.entry.put', cause: e }))
    if (put instanceof Error) return put
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
      case 'skill':
        return steer({ ...base, text: route.arguments, skills: [route.id] })
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

  // Directories where the Kimaki plugin was seen active (it stays loaded).
  const pluginActive = new Set<string>()

  // The bot writes plugins/kimaki/ on start (opencode-server.ts), but
  // OpenCode's watcher picks it up a moment later: wait for it, bounded.
  async function waitForPlugin(directory: string): Promise<ConfigError | OpenCodeUnavailableError | OpenCodeError | void> {
    if (pluginActive.has(directory)) return
    const opencodeClient = client()
    if (opencodeClient instanceof Error) return opencodeClient
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      // The integration catalog waits for activations OpenCode already started; plugin.list does not.
      const activated = await opencodeClient.integration.list({ location: { directory } }).catch((cause) => new OpenCodeError({ operation: 'integration.list', cause }))
      if (activated instanceof Error) return activated
      const plugins = await opencodeClient.plugin.list({ location: { directory } }).catch((cause) => new OpenCodeError({ operation: 'plugin.list', cause }))
      if (plugins instanceof Error) return plugins
      if (plugins.data.some((plugin) => plugin.id === 'kimaki' && plugin.state.status === 'active')) {
        pluginActive.add(directory)
        return
      }
      await sleep(200)
    }
    return new ConfigError({ reason: `Kimaki plugin is not active in OpenCode for ${directory}. Kimaki writes it to <OpenCode config dir>/plugins/kimaki/ on start; check \`opencode plugin list\` and the OpenCode logs` })
  }

  // The plugin and the agent's `kimaki` calls read metadata.kimaki. Sessions
  // from V1 (imported thread_sessions) have no marker and no instructions
  // entry; sessions of an older bot run point at its old lock port. Checked
  // on each input instead of for every binding at startup (a V1 install has
  // thousands of bindings).
  async function ensureSessionMarker({
    sessionId,
    thread,
    channelId,
    directory,
    userId,
  }: {
    sessionId: string
    thread: ThreadChannel
    channelId: string
    directory: string
    userId: string
  }): Promise<ConfigError | OpenCodeUnavailableError | OpenCodeError | DiscordError | void> {
    const opencodeClient = client()
    if (opencodeClient instanceof Error) return opencodeClient
    const plugin = await waitForPlugin(directory)
    if (plugin instanceof Error) return plugin
    const info = await opencodeClient.session
      .get({ sessionID: sessionId })
      .catch((e) => new OpenCodeError({ operation: `get session ${sessionId}`, cause: e }))
    if (info instanceof Error) return info
    const previous = info.metadata?.['kimaki']
    const marker = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : null
    if (marker && marker['dataDir'] === cliContext.dataDir && marker['lockPort'] === cliContext.lockPort) return
    // Instructions first: the marker means "set up", so a failure here is retried on the next input.
    if (!marker) {
      logger.log(`adopting legacy session ${sessionId} of thread ${thread.id}`)
      const channel = await textChannel(channelId)
      if (channel instanceof Error) return channel
      const instructions = await putInstructions({ sessionId, thread, channel, directory, userId })
      if (instructions instanceof Error) return instructions
    }
    const updated = await opencodeClient.session
      .update({
        sessionID: sessionId,
        metadata: { ...info.metadata, kimaki: { ...marker, source: 'discord', ...cliContext, threadId: thread.id, channelId } },
      })
      .catch((e) => new OpenCodeError({ operation: 'session.update', cause: e }))
    if (updated instanceof Error) return updated
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
    const marked = await ensureSessionMarker({ sessionId, thread, channelId: project.channelId, directory: project.directory, userId: author.id })
    if (marked instanceof Error) return marked
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
    model: explicitModel,
    permissions,
    parentSessionId,
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
    // Overrides the channel model for this session.
    model?: ModelChoice
    permissions?: NonNullable<Parameters<OpenCodeClient['session']['create']>[0]>['permissions']
    parentSessionId?: string
  }): Promise<
    ConfigError | OpenCodeUnavailableError | OpenCodeError | DiscordError | DbError | { threadId: string; sessionId: string }
  > {
    const opencodeClient = client()
    if (opencodeClient instanceof Error) return opencodeClient

    const plugin = await waitForPlugin(directory)
    if (plugin instanceof Error) return plugin

    const channel = await textChannel(channelId)
    if (channel instanceof Error) return channel
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
    const model = explicitModel
      ? { providerID: explicitModel.providerID, id: explicitModel.id, ...(explicitModel.variant && { variant: explicitModel.variant }) }
      : parseModel(defaults?.channel_model?.model_id, defaults?.channel_model?.variant)
    const agent = (route.kind === 'steer' && route.agent) || defaults?.channel_agent?.agent_name

    const session = await opencodeClient.session
      .create({
        title: threadName,
        location: { directory },
        ...(model && { model }),
        ...(agent && { agent }),
        ...(permissions && { permissions }),
        metadata: { kimaki: { threadId: thread.id, channelId, source: 'discord', ...cliContext, ...(parentSessionId && { parentSessionId }) } },
      })
      .catch((e) => new OpenCodeError({ operation: 'session.create', cause: e }))
    if (session instanceof Error) return session
    analytics.track('session_created', { has_worktree: false, source: 'discord' })

    const instructions = await putInstructions({ sessionId: session.id, thread, channel, directory, userId: author.id, parentSessionId })
    if (instructions instanceof Error) return instructions

    const bound = await bindThread({ threadId: thread.id, sessionId: session.id, channelId, directory, isNew: true })
    if (bound instanceof Error) return bound
    if (showInput) {
      const names = files.map((file) => file.name).join(', ')
      const shown = names ? `${text}\nFiles: ${names}` : text
      const echo = await thread
        .send({ content: formatEcho({ username: author.username, text: shown }), allowedMentions: { parse: [] } })
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

  // --- Sessions that get a new thread: /resume, /fork, /fork-subagent.

  // Binds an existing session to a new thread. Order matters:
  //
  //   thread + intro ─▶ metadata + instructions (new IDs) ─▶ history
  //     ─▶ one DB batch: old bindings out, new one in ─▶ routing + replay (same tick)
  //     ─▶ hydrate what it runs and waits on now
  //
  // Nothing routes to the thread before the replay, so live output follows
  // it. A failure before the binding deletes the new thread (and calls
  // `discard`), leaving any old binding untouched.
  async function adoptSession({
    channel,
    session,
    threadName,
    intro,
    note,
    author,
    parentSessionId = null,
    discard,
  }: {
    channel: TextChannel
    session: { id: string; metadata?: SessionMetadata; location: { directory: string } }
    threadName: string
    intro: string
    note: string
    author: Author
    // Explicit `kimaki send --parent-session` of a resumed session; never a fork's OpenCode parent.
    parentSessionId?: string | null
    // Cleanup of a session created only for this thread (a fork).
    discard?: () => Promise<void>
  }): Promise<OpenCodeUnavailableError | OpenCodeError | DiscordError | DbError | { threadId: string; sessionId: string }> {
    const opencodeClient = client()
    if (opencodeClient instanceof Error) return opencodeClient
    const sessionId = session.id
    const thread = await channel.threads
      .create({ name: threadName.replace(/\s+/g, ' ').slice(0, 100), autoArchiveDuration: 1440 })
      .catch((e) => new DiscordError({ operation: 'create thread', cause: e }))
    if (thread instanceof Error) return thread

    const prepared = await (async () => {
      const posted = await thread
        .send({ content: intro.slice(0, 2_000), allowedMentions: { parse: [] } })
        .catch((e) => new DiscordError({ operation: 'send intro', cause: e }))
      if (posted instanceof Error) return posted
      // Merge: other metadata (and task fields of the marker) stay.
      const previous = session.metadata?.['kimaki']
      const marker = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}
      const marked = await opencodeClient.session
        .update({
          sessionID: sessionId,
          metadata: {
            ...session.metadata,
            kimaki: { ...marker, source: 'discord', ...cliContext, threadId: thread.id, channelId: channel.id },
          },
        })
        .catch((e) => new OpenCodeError({ operation: 'session.update', cause: e }))
      if (marked instanceof Error) return marked
      const instructions = await putInstructions({ sessionId, thread, channel, directory: session.location.directory, userId: author.id, parentSessionId })
      if (instructions instanceof Error) return instructions
      const messages = await opencodeClient.message
        .list({ sessionID: sessionId, order: 'desc', limit: 100 })
        .catch((e) => new OpenCodeError({ operation: 'message.list', cause: e }))
      if (messages instanceof Error) return messages
      // One thread per session: older threads of this session stop following it.
      const moved = await db
        .batch([
          db
            .delete(schema.thread_sessions)
            .where(orm.eq(schema.thread_sessions.session_id, sessionId))
            .returning({ threadId: schema.thread_sessions.thread_id }),
          db.insert(schema.thread_sessions).values({ thread_id: thread.id, session_id: sessionId, source: 'kimaki' }),
        ])
        .catch((e) => new DbError({ operation: 'move thread_sessions', cause: e }))
      if (moved instanceof Error) return moved
      return { history: [...messages.data].reverse(), previous: moved[0].map((row) => row.threadId) }
    })()
    if (prepared instanceof Error) {
      await thread.delete('session adoption failed').catch(() => undefined)
      await discard?.()
      return prepared
    }

    for (const previousThread of prepared.previous) eventLoop.unbind(previousThread)
    const bound = await eventLoop.bind({
      threadId: thread.id,
      sessionId,
      channelId: channel.id,
      directory: session.location.directory,
      isNew: false,
      first: [{ type: 'kimaki.replay', messages: prepared.history, note }],
    })
    if (bound instanceof Error) return bound
    logger.log(`session ${sessionId} bound to thread ${thread.id}`)
    await thread.members.add(author.id).catch((e: Error) => logger.warn(`add member: ${e.message}`))
    const hydrated = await eventLoop.hydrateThread(thread.id)
    if (hydrated instanceof Error) logger.warn(`hydrate ${thread.id}: ${hydrated.message}`)
    return { threadId: thread.id, sessionId }
  }

  // The project channel whose directory holds this session.
  async function channelForSession(sessionId: string) {
    const opencodeClient = client()
    if (opencodeClient instanceof Error) return opencodeClient
    const info = await opencodeClient.session
      .get({ sessionID: sessionId })
      .catch((e) => new OpenCodeError({ operation: 'session.get', cause: e }))
    if (info instanceof Error) return info
    const directory = await canonicalPath(info.location.directory)
    const projects = await db.query.channel_directories
      .findMany()
      .catch((e) => new DbError({ operation: 'read channel_directories', cause: e }))
    if (projects instanceof Error) return projects
    // Stored directories may be symlink aliases of the real path.
    const matches = await Promise.all(projects.map(async (row) => (await canonicalPath(row.directory)) === directory))
    const project = projects.find((_, index) => matches[index])
    if (!project) return new ConfigError({ reason: `No project channel for ${info.location.directory}. Pass --channel.` })
    return project.channel_id
  }

  // Binds an existing session of the channel's project to a new thread.
  async function resume({ channelId, sessionId, author }: { channelId: string; sessionId: string; author: Author }) {
    const opencodeClient = client()
    if (opencodeClient instanceof Error) return opencodeClient
    const [channel, project] = await Promise.all([
      textChannel(channelId),
      db.query.channel_directories
        .findFirst({ where: { channel_id: channelId } })
        .catch((e) => new DbError({ operation: 'read channel_directories', cause: e })),
    ])
    if (channel instanceof Error) return channel
    if (project instanceof Error) return project
    if (!project) return new ConfigError({ reason: 'This channel is not configured with a project directory' })
    const info = await opencodeClient.session
      .get({ sessionID: sessionId })
      .catch((e) => new OpenCodeError({ operation: 'session.get', cause: e }))
    if (info instanceof Error) return info
    if ((await canonicalPath(info.location.directory)) !== (await canonicalPath(project.directory))) {
      return new ConfigError({
        reason: `This session belongs to a different project or worktree: \`${info.location.directory}\`. Run \`/resume\` in the channel for that directory.`,
      })
    }
    const title = info.title ?? 'Untitled'
    const adopted = await adoptSession({
      channel,
      session: info,
      parentSessionId: storedParentSessionId(info.metadata),
      threadName: `Resume: ${title}`,
      intro: `**Resumed session:** ${title}\n**Created:** <t:${Math.floor(info.time.created / 1_000)}:f>`,
      note: '**Session resumed!** You can now continue the conversation by sending messages in this thread.',
      author,
    })
    if (adopted instanceof Error) return adopted
    return { ...adopted, title }
  }

  // Forks the thread's session (or one of its subagent sessions) into a new
  // thread. `before`: a user message ID; the fork ends right before it.
  async function fork({
    sourceThread,
    sessionId,
    before,
    subagent,
    name,
    author,
  }: {
    sourceThread: ThreadChannel
    sessionId: string
    before?: string
    // Thread name; default is OpenCode's fork title.
    name?: string
    // Set when forking a subagent session: its agent and task.
    subagent?: { agent: string; description: string }
    author: Author
  }) {
    const opencodeClient = client()
    if (opencodeClient instanceof Error) return opencodeClient
    const project = await threadProject(sourceThread)
    if (project instanceof Error) return project
    const channel = await textChannel(project.channelId)
    if (channel instanceof Error) return channel
    const forked = await opencodeClient.session
      .fork({ sessionID: sessionId, ...(before && { before }) })
      .catch((e) => new OpenCodeError({ operation: 'session.fork', cause: e }))
    if (forked instanceof Error) return forked
    const intro = subagent
      ? `**Forked subagent session created!**\nAgent: \`${subagent.agent}\`\nTask: ${subagent.description || 'No description'}\nFrom: \`${sessionId}\`\nNew session: \`${forked.id}\``
      : `**Forked session created!**\nFrom: <#${sourceThread.id}> (\`${sessionId}\`)\nNew session: \`${forked.id}\``
    return adoptSession({
      channel,
      session: forked,
      discard: async () => {
        await opencodeClient.session.remove({ sessionID: forked.id }).catch(() => undefined)
      },
      // OpenCode titles forks "<title> (fork #1)".
      threadName: name ?? (forked.title || `Fork: ${subagent?.description || sourceThread.name}`),
      intro,
      note: 'You can now continue the conversation from this point.',
      author,
    })
  }

  // --- Agent, model and channel preferences.

  async function switchModel({ sessionId, model }: { sessionId: string; model: ModelChoice }) {
    const opencodeClient = client()
    if (opencodeClient instanceof Error) return opencodeClient
    const result = await opencodeClient.session
      .switchModel({
        sessionID: sessionId,
        model: { providerID: model.providerID, id: model.id, ...(model.variant && { variant: model.variant }) },
      })
      .catch((e) => new OpenCodeError({ operation: 'session.switchModel', cause: e }))
    if (result instanceof Error) return result
  }

  async function setChannelModel({ channelId, model }: { channelId: string; model: ModelChoice }): Promise<DbError | void> {
    const values = { model_id: `${model.providerID}/${model.id}`, variant: model.variant ?? null }
    const result = await db
      .insert(schema.channel_models)
      .values({ channel_id: channelId, ...values })
      .onConflictDoUpdate({ target: schema.channel_models.channel_id, set: values })
      .catch((e) => new DbError({ operation: 'write channel_models', cause: e }))
    if (result instanceof Error) return result
  }

  async function setChannelAgent({ channelId, agent }: { channelId: string; agent: string }): Promise<DbError | void> {
    const result = await db
      .insert(schema.channel_agents)
      .values({ channel_id: channelId, agent_name: agent })
      .onConflictDoUpdate({ target: schema.channel_agents.channel_id, set: { agent_name: agent } })
      .catch((e) => new DbError({ operation: 'write channel_agents', cause: e }))
    if (result instanceof Error) return result
  }

  // Applies to running sessions of the channel too, from their next event.
  async function setVerbosity({ channelId, verbosity }: { channelId: string; verbosity: Verbosity }): Promise<DbError | void> {
    const value = verbosityToV1(verbosity)
    const result = await db
      .insert(schema.channel_verbosity)
      .values({ channel_id: channelId, verbosity: value })
      .onConflictDoUpdate({ target: schema.channel_verbosity.channel_id, set: { verbosity: value } })
      .catch((e) => new DbError({ operation: 'write channel_verbosity', cause: e }))
    if (result instanceof Error) return result
    eventLoop.forgetChannel(channelId)
  }

  // --- Session history: /compact, /undo, /redo.

  async function compact({ threadId }: { threadId: string }) {
    const opencodeClient = client()
    if (opencodeClient instanceof Error) return opencodeClient
    const sessionId = rootSession(threadId)
    if (sessionId instanceof Error) return sessionId
    const result = await opencodeClient.session
      .compact({ sessionID: sessionId })
      .catch((e) => new OpenCodeError({ operation: 'session.compact', cause: e }))
    if (result instanceof Error) return result
  }

  // All user messages, oldest first: revert boundaries are user messages.
  async function userMessages(sessionId: string): Promise<OpenCodeUnavailableError | OpenCodeError | Array<{ id: string }>> {
    const opencodeClient = client()
    if (opencodeClient instanceof Error) return opencodeClient
    const collected: Array<{ id: string }> = []
    let cursor: string | undefined
    for (let page = 0; page < 100; page++) {
      const result = await opencodeClient.message
        // A cursor must not be combined with `order`.
        .list({ sessionID: sessionId, type: 'user', limit: 200, ...(cursor ? { cursor } : { order: 'asc' as const }) })
        .catch((e) => new OpenCodeError({ operation: 'message.list', cause: e }))
      if (result instanceof Error) return result
      collected.push(...result.data.map((message) => ({ id: message.id })))
      cursor = result.cursor.next ?? undefined
      if (!cursor) break
    }
    return collected
  }

  // Revert needs an idle session: stop the run first, like the OpenCode TUI.
  async function idleSession(threadId: string) {
    const opencodeClient = client()
    if (opencodeClient instanceof Error) return opencodeClient
    const sessionId = rootSession(threadId)
    if (sessionId instanceof Error) return sessionId
    const view = store.getState().threads[threadId]
    if (view && isBusy(view)) {
      const interrupted = await interrupt(sessionId)
      if (interrupted instanceof Error) return interrupted
      const waited = await opencodeClient.session
        .wait({ sessionID: sessionId })
        .catch((e) => new OpenCodeError({ operation: 'session.wait', cause: e }))
      if (waited instanceof Error) return waited
    }
    const info = await opencodeClient.session
      .get({ sessionID: sessionId })
      .catch((e) => new OpenCodeError({ operation: 'session.get', cause: e }))
    if (info instanceof Error) return info
    return { client: opencodeClient, sessionId, revert: info.revert?.messageID ?? null }
  }

  // Hides the last turn and reverts its file changes. Repeating goes one turn further back.
  async function undo({ threadId }: { threadId: string }) {
    const session = await idleSession(threadId)
    if (session instanceof Error) return session
    const messages = await userMessages(session.sessionId)
    if (messages instanceof Error) return messages
    const boundary = session.revert ? messages.findIndex((message) => message.id === session.revert) : messages.length
    const target = messages[boundary - 1]
    if (!target) return { reverted: null }
    const staged = await session.client.session.revert
      .stage({ sessionID: session.sessionId, messageID: target.id })
      .catch((e) => new OpenCodeError({ operation: 'session.revert.stage', cause: e }))
    if (staged instanceof Error) return staged
    return { reverted: { files: staged.files?.length ?? 0 } }
  }

  // One turn forward again; past the last turn the revert is cleared.
  async function redo({ threadId }: { threadId: string }) {
    const session = await idleSession(threadId)
    if (session instanceof Error) return session
    if (!session.revert) return { restored: 'nothing' as const }
    const messages = await userMessages(session.sessionId)
    if (messages instanceof Error) return messages
    const index = messages.findIndex((message) => message.id === session.revert)
    const next = index >= 0 ? messages[index + 1] : undefined
    if (!next) {
      const cleared = await session.client.session.revert
        .clear({ sessionID: session.sessionId })
        .catch((e) => new OpenCodeError({ operation: 'session.revert.clear', cause: e }))
      if (cleared instanceof Error) return cleared
      return { restored: 'all' as const }
    }
    const staged = await session.client.session.revert
      .stage({ sessionID: session.sessionId, messageID: next.id })
      .catch((e) => new OpenCodeError({ operation: 'session.revert.stage', cause: e }))
    if (staged instanceof Error) return staged
    return { restored: 'step' as const }
  }

  async function remoteSend(input: SendInput) {
    const targetId = input.threadId ?? input.channelId
    if (!targetId) return new ConfigError({ reason: 'Remote sends require --channel or --thread' })
    const target = await discord.channels.fetch(targetId).catch((cause) => new DiscordError({ operation: 'fetch remote target', cause }))
    if (target instanceof Error) return target
    if (!target?.isSendable()) return new ConfigError({ reason: 'Remote target is not sendable' })
    const requestId = crypto.randomBytes(8).toString('hex')
    const { files, prompt, ...options } = input
    const footer = `${REMOTE_SEND_PREFIX}${JSON.stringify({ requestId, options })}`
    if (footer.length > 2048 || prompt.length > 2000) return new ConfigError({ reason: 'Remote prompt or options exceed Discord message limits. Send shorter input.' })
    return new Promise<Error | { threadId: string; sessionId: string | null }>((resolve) => {
      const finish = (result: Error | { threadId: string; sessionId: string | null }) => { clearTimeout(timer); discord.off(Events.MessageCreate, receive); resolve(result) }
      const receive = (message: Message) => {
        if (message.author.id !== discord.user?.id || message.channelId !== targetId) return
        const footer = message.embeds[0]?.footer?.text
        const prefix = `${REMOTE_RESULT_PREFIX}${requestId}:`
        if (!footer?.startsWith(prefix)) return
        const parsed = errore.try(() => ({ value: JSON.parse(footer.slice(prefix.length)) as unknown }), (cause) => new ConfigError({ reason: 'Invalid remote response', cause }))
        if (parsed instanceof Error) return finish(parsed)
        const result = parsed.value
        if (result && typeof result === 'object' && 'threadId' in result && typeof result.threadId === 'string' && 'sessionId' in result && (typeof result.sessionId === 'string' || result.sessionId === null)) return finish({ threadId: result.threadId, sessionId: result.sessionId })
        finish(new ConfigError({ reason: result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : 'Remote send failed' }))
      }
      const timer = setTimeout(() => finish(new ConfigError({ reason: 'No owning Kimaki bot answered this remote send. Start Kimaki on that machine.' })), 20_000)
      discord.on(Events.MessageCreate, receive)
      void target.send({ content: prompt, embeds: [{ footer: { text: footer } }], files: files?.map((file) => ({ name: file.name, attachment: file.uri.startsWith('file:') ? fileURLToPath(file.uri) : file.uri })), allowedMentions: { parse: [] } })
        .catch((cause) => finish(new DiscordError({ operation: 'send remote envelope', cause })))
    })
  }

  async function send(input: SendInput, localOnly = false) {
    const author = { id: input.user?.replace(/[<@!>]/g, '') ?? discord.user!.id, username: 'CLI' }
    const messageId = crypto.randomUUID()
    const route = parseTextMessage({ content: input.prompt })
    if (!route) return new ConfigError({ reason: 'Prompt is empty' })
    if (input.agent && (route.kind === 'steer' || route.kind === 'btw')) route.agent = input.agent
    if (input.sessionId || input.threadId) {
      const threadId = input.threadId ?? Object.entries(store.getState().roots).find(([, id]) => id === input.sessionId)?.[0]
      if (!threadId) return new ConfigError({ reason: 'No local thread for this session. Use --thread on its owning machine.' })
      const thread = await discord.channels.fetch(threadId).catch((cause) => new DiscordError({ operation: 'fetch send thread', cause }))
      if (thread instanceof Error) return thread
      if (!thread?.isThread()) return new ConfigError({ reason: 'Target is not a thread' })
      if (!store.getState().roots[thread.id]) {
        const project = thread.parentId ? await db.query.channel_directories.findFirst({ where: { channel_id: thread.parentId } }) : null
        return !project && !localOnly ? remoteSend(input) : new ConfigError({ reason: 'No local session for this thread' })
      }
      const result = await dispatch({ thread, route, author, messageId, files: input.files })
      if (result instanceof Error) return result
      return result ?? { threadId, sessionId: store.getState().roots[threadId]! }
    }
    const project = await db.query.channel_directories.findFirst({ where: input.channelId ? { channel_id: input.channelId } : { directory: path.resolve(input.project!) } })
      .catch((cause) => new DbError({ operation: 'resolve send project', cause }))
    if (project instanceof Error) return project
    if (!project) return input.channelId && !localOnly ? remoteSend(input) : new ConfigError({ reason: 'No local project channel for this target' })
    if (input.notifyOnly) {
      const channel = await textChannel(project.channel_id)
      if (channel instanceof Error) return channel
      const thread = await channel.threads.create({ name: (input.name ?? input.prompt).replace(/\s+/g, ' ').slice(0, 100), autoArchiveDuration: 1440 }).catch((cause) => new DiscordError({ operation: 'create notification thread', cause }))
      if (thread instanceof Error) return thread
      const shown = await thread.send({ content: input.prompt, files: input.files?.map((file) => ({ attachment: file.uri.startsWith('file:') ? fileURLToPath(file.uri) : file.uri, name: file.name })), allowedMentions: { parse: [] } }).catch((cause) => new DiscordError({ operation: 'post notification', cause }))
      if (shown instanceof Error) return shown
      if (input.user) await thread.members.add(author.id).catch((error: Error) => logger.warn(`add notification member: ${error.message}`))
      return { threadId: thread.id, sessionId: null }
    }
    const directory = await fs.promises.realpath(input.cwd ?? project.directory).catch((cause) => new ConfigError({ reason: 'Send directory does not exist', cause }))
    if (directory instanceof Error) return directory
    const base = await fs.promises.realpath(project.directory).catch((cause) => new ConfigError({ reason: 'Project directory does not exist', cause }))
    if (base instanceof Error) return base
    if (directory !== base && !directory.startsWith(`${base}${path.sep}`)) return new ConfigError({ reason: '--cwd must be inside the project; worktrees arrive in P10' })
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
    const first = route.kind === 'shell' || route.kind === 'command' || route.kind === 'skill' ? route : { kind: 'steer' as const, text: route.text, agent: input.agent }
    const started = await startSession({ channelId: project.channel_id, directory, route: first, author, messageId, startMessageId: null,
      threadName: input.name, files: input.files, permissions, parentSessionId: input.parentSessionId, ...(model && { model: { ...model, variant: null } }) })
    if (started instanceof Error) return started
    if (input.user) {
      const thread = await discord.channels.fetch(started.threadId).catch((cause) => new DiscordError({ operation: 'fetch send thread', cause }))
      if (thread instanceof Error) return thread
      if (thread?.isThread()) {
        const added = await thread.members.add(author.id).catch((cause) => new DiscordError({ operation: 'add thread member', cause }))
        if (added instanceof Error) return added
      }
    }
    return started
  }

  async function loginKey(input: { provider: string; key: string; directory?: string; label?: string }) {
    const api = client()
    if (api instanceof Error) return api
    const project = input.directory ? null : await db.query.channel_directories.findFirst().catch((cause) => new DbError({ operation: 'find login directory', cause }))
    if (project instanceof Error) return project
    const directory = input.directory ?? project?.directory
    const result = await api.integration.connect.key({ integrationID: input.provider, key: input.key, label: input.label,
      ...(directory && { location: { directory } }) })
      .catch((cause) => new OpenCodeError({ operation: 'integration.connect.key', cause }))
    if (result instanceof Error) return result
    return { message: `Connected ${input.provider}` }
  }

  async function credential(input: { id: string; operation: 'activate' | 'remove' | 'label'; label?: string }) {
    const api = client()
    if (api instanceof Error) return api
    const result = await (input.operation === 'label'
      ? api.credential.update({ credentialID: input.id, label: input.label ?? '' })
      : api.credential[input.operation]({ credentialID: input.id }))
      .catch((cause) => new OpenCodeError({ operation: `credential.${input.operation}`, cause }))
    if (result instanceof Error) return result
    return { message: `Credential ${input.operation} complete` }
  }

  async function startOAuth(input: { provider: string; method: string; directory: string }) {
    const api = client()
    if (api instanceof Error) return api
    return api.integration.oauth.connect({ integrationID: input.provider, methodID: input.method, location: { directory: input.directory } })
      .catch((cause) => new OpenCodeError({ operation: 'integration.oauth.connect', cause }))
  }
  async function completeOAuth(input: { provider: string; attempt: string; directory: string; code?: string }) {
    const api = client()
    if (api instanceof Error) return api
    return api.integration.oauth.complete({ integrationID: input.provider, attemptID: input.attempt, code: input.code, location: { directory: input.directory } })
      .catch((cause) => new OpenCodeError({ operation: 'integration.oauth.complete', cause }))
  }
  async function oauthStatus(input: { provider: string; attempt: string; directory: string }) {
    const api = client()
    if (api instanceof Error) return api
    return api.integration.oauth.status({ integrationID: input.provider, attemptID: input.attempt, location: { directory: input.directory } })
      .catch((cause) => new OpenCodeError({ operation: 'integration.oauth.status', cause }))
  }
  async function cancelOAuth(input: { provider: string; attempt: string; directory: string }) {
    const api = client()
    if (api instanceof Error) return api
    return api.integration.oauth.cancel({ integrationID: input.provider, attemptID: input.attempt, location: { directory: input.directory } })
      .catch((cause) => new OpenCodeError({ operation: 'integration.oauth.cancel', cause }))
  }

  async function loginCli(input: { provider: string; method?: string; attempt?: string; code?: string; key?: string; operation?: string; directory?: string }): Promise<Error | { data: unknown }> {
    const api = client()
    if (api instanceof Error) return api
    const project = await db.query.channel_directories.findFirst().catch((cause) => new DbError({ operation: 'find login directory', cause }))
    if (project instanceof Error) return project
    const directory = input.directory ?? project?.directory
    if (!directory) return new ConfigError({ reason: 'Pass a login directory or add a project first' })
    if (input.key) {
      const result = await loginKey({ provider: input.provider, key: input.key, directory })
      return result instanceof Error ? result : { data: result }
    }
    const base = { provider: input.provider, directory }
    if (input.attempt) {
      const args = { ...base, attempt: input.attempt }
      if (input.operation === 'cancel') {
        const result = await cancelOAuth(args)
        return result instanceof Error ? result : { data: { cancelled: true } }
      }
      if (input.code) {
        const result = await completeOAuth({ ...args, code: input.code })
        return result instanceof Error ? result : { data: { connected: true } }
      }
      const result = await oauthStatus(args)
      return result instanceof Error ? result : { data: result.data }
    }
    if (input.method) {
      const result = await startOAuth({ ...base, method: input.method })
      return result instanceof Error ? result : { data: result.data }
    }
    const info = await api.integration.get({ integrationID: input.provider, location: { directory } }).catch((cause) => new OpenCodeError({ operation: 'integration.get', cause }))
    return info instanceof Error ? info : { data: { provider: info.data.name, methods: info.data.methods, connections: info.data.connections, instructions: 'Use --key, or --method <oauth method ID>. Complete with --attempt <id> --code <code>; check or cancel with --attempt <id> [--cancel].' } }
  }

  async function runCli(name: string, input: unknown): Promise<Error | { data: unknown }> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return new ConfigError({ reason: 'Expected action arguments' })
    const fields = new Map(Object.entries(input))
    for (const key of ['sessionId', 'threadId', 'channelId', 'directory', 'text', 'agent', 'model', 'variant', 'before', 'inboxId', 'name']) {
      const value = fields.get(key)
      if (value !== undefined && (typeof value !== 'string' || !value.trim())) return new ConfigError({ reason: `${key} must be a non-empty string` })
    }
    const args = input as { sessionId?: string; threadId?: string; channelId?: string; directory?: string; text?: string; agent?: string; model?: string; variant?: string; before?: string; inboxId?: string; name?: string }
    if (name.startsWith('channel.')) {
      const project = await db.query.channel_directories.findFirst({ where: args.channelId ? { channel_id: args.channelId } : { directory: path.resolve(args.directory ?? process.cwd()) } }).catch((cause) => new DbError({ operation: 'find channel', cause }))
      if (project instanceof Error) return project
      if (!project) return new ConfigError({ reason: 'No local project channel. Pass --channel.' })
      const channelId = project.channel_id
      if (fields.get('clear') === true && (name === 'channel.agent' || name === 'channel.model')) {
        const result = name === 'channel.agent'
          ? await db.delete(schema.channel_agents).where(orm.eq(schema.channel_agents.channel_id, channelId)).catch((cause) => new DbError({ operation: 'clear agent', cause }))
          : await db.delete(schema.channel_models).where(orm.eq(schema.channel_models.channel_id, channelId)).catch((cause) => new DbError({ operation: 'clear model', cause }))
        return result instanceof Error ? result : { data: { cleared: true } }
      }
      if (name === 'channel.agent' && args.agent) {
        const result = await setChannelAgent({ channelId, agent: args.agent })
        return result instanceof Error ? result : { data: { agent: args.agent } }
      }
      if (name === 'channel.model' && args.model) {
        const model = parseModel(args.model, args.variant)
        if (!model) return new ConfigError({ reason: 'Use provider/model' })
        const result = await setChannelModel({ channelId, model: { ...model, variant: args.variant ?? null } })
        return result instanceof Error ? result : { data: { model } }
      }
      if (name === 'channel.verbosity' && (args.text === 'text' || args.text === 'tools')) {
        const result = await setVerbosity({ channelId, verbosity: args.text })
        return result instanceof Error ? result : { data: { verbosity: args.text } }
      }
      return new ConfigError({ reason: 'Invalid channel action or value' })
    }
    if (name === 'session.resume' && args.sessionId) {
      const channelId = args.channelId ?? await channelForSession(args.sessionId)
      if (channelId instanceof Error) return channelId
      const result = await resume({ channelId, sessionId: args.sessionId, author: { id: discord.user!.id, username: 'CLI' } })
      return result instanceof Error ? result : { data: result }
    }
    const threadId = args.threadId ?? (args.sessionId ? store.getState().sessionThreads[args.sessionId] : undefined)
    if (!threadId || !store.getState().roots[threadId]) return new ConfigError({ reason: 'No local session. Use --session or --thread.' })
    const sessionId = store.getState().roots[threadId]!
    const api = client()
    if (api instanceof Error) return api
    if (name === 'session.title' && args.text) {
      const renamed = await api.session.update({ sessionID: sessionId, title: args.text }).catch((cause) => new OpenCodeError({ operation: 'session.update', cause }))
      if (renamed instanceof Error) return renamed
      const thread = await discord.channels.fetch(threadId).catch((cause) => new DiscordError({ operation: 'fetch title thread', cause }))
      if (thread instanceof Error) return thread
      if (!thread?.isThread()) return new ConfigError({ reason: 'Target is not a thread' })
      const updated = await thread.setName(args.text.slice(0, 100)).catch((cause) => new DiscordError({ operation: 'rename thread', cause }))
      return updated instanceof Error ? updated : { data: { title: args.text } }
    }
    if (name === 'session.archive') {
      const thread = await discord.channels.fetch(threadId).catch((cause) => new DiscordError({ operation: 'fetch archive thread', cause }))
      if (thread instanceof Error) return thread
      if (!thread?.isThread()) return new ConfigError({ reason: 'Target is not a thread' })
      const archived = await thread.setArchived(true).catch((cause) => new DiscordError({ operation: 'archive thread', cause }))
      return archived instanceof Error ? archived : { data: { archived: true } }
    }
    if (name === 'queue.list') {
      const result = await api.session.inbox.list({ sessionID: sessionId }).catch((cause) => new OpenCodeError({ operation: 'session.inbox.list', cause }))
      return result instanceof Error ? result : { data: result.filter((item) => item.delivery === 'queue') }
    }
    if (name === 'queue.remove' && args.inboxId) {
      const result = await cancelQueued({ threadId, inboxID: args.inboxId })
      return result instanceof Error ? result : { data: { removed: true } }
    }
    if (name === 'queue.clear' || name === 'session.abort') {
      const result = await (name === 'queue.clear' ? clearQueue({ threadId }) : abort({ threadId }))
      return result instanceof Error ? result : { data: result }
    }
    if (name === 'session.fork') {
      const thread = await discord.channels.fetch(threadId).catch((cause) => new DiscordError({ operation: 'fetch fork thread', cause }))
      if (thread instanceof Error) return thread
      if (!thread?.isThread()) return new ConfigError({ reason: 'Target is not a thread' })
      const result = await fork({ sourceThread: thread, sessionId: args.sessionId ?? sessionId, before: args.before, name: args.name, author: { id: discord.user!.id, username: 'CLI' } })
      return result instanceof Error ? result : { data: result }
    }
    if (name === 'session.command' && args.text) {
      const queued = fields.get('queue') === true ? '. queue' : ''
      const result = await send({ threadId, prompt: `/${args.text}${queued ? ` ${queued}` : ''}` })
      return result instanceof Error ? result : { data: result }
    }
    if (name === 'session.shell' && args.text) {
      const result = shell({ threadId, sessionId, command: args.text })
      return result instanceof Error ? result : { data: { started: true } }
    }
    if (name === 'session.btw' && args.text) {
      const result = await send({ threadId, prompt: `${args.text}. btw` })
      return result instanceof Error ? result : { data: result }
    }
    if (name === 'queue.add' && args.text) {
      const result = await send({ threadId, prompt: `${args.text}. queue` })
      return result instanceof Error ? result : { data: result }
    }
    return new ConfigError({ reason: `Unknown or incomplete action: ${name}` })
  }

  async function upload({ id, files }: { id: string; files: Array<{ path: string; name: string }> }) {
    const threadId = store.getState().sessionThreads[id] ?? (store.getState().roots[id] ? id : undefined)
    if (!threadId) return new ConfigError({ reason: 'No local session thread for this upload' })
    eventLoop.dispatch(threadId, { type: 'kimaki.upload', files })
    return { uploaded: files.map((file) => file.name) }
  }

  // Running sessions of an older bot run point at its lock port; their agent
  // can call `kimaki` before the next user input (ensureSessionMarker).
  async function refreshCliContext() {
    const api = client()
    if (api instanceof Error) return api
    const active = await api.session.active().catch((cause) => new OpenCodeError({ operation: 'session.active', cause }))
    if (active instanceof Error) return active
    const { sessionThreads } = store.getState()
    for (const sessionId of Object.keys(active).filter((id) => sessionThreads[id])) {
      const info = await api.session.get({ sessionID: sessionId }).catch((cause) => new OpenCodeError({ operation: 'get bound session', cause }))
      if (info instanceof Error) { logger.warn(info.message); continue }
      const marker = info.metadata?.['kimaki']
      if (!marker || typeof marker !== 'object' || Array.isArray(marker)) continue
      if (marker['dataDir'] === cliContext.dataDir && marker['lockPort'] === cliContext.lockPort) continue
      const result = await api.session.update({ sessionID: sessionId, metadata: { ...info.metadata, kimaki: { ...marker, ...cliContext } } })
        .catch((cause) => new OpenCodeError({ operation: 'refresh Kimaki CLI context', cause }))
      if (result instanceof Error) return result
    }
  }

  return {
    send,
    loginKey,
    credential,
    startOAuth,
    completeOAuth,
    oauthStatus,
    cancelOAuth,
    loginCli,
    runCli,
    upload,
    refreshCliContext,
    resume,
    fork,
    switchAgent,
    switchModel,
    setChannelModel,
    setChannelAgent,
    setVerbosity,
    compact,
    undo,
    redo,
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
