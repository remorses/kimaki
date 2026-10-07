// Sessions and their threads: the only module that creates session threads
// and binds sessions to them (spec 27.2). New sessions, /resume, /fork,
// /fork-subagent, btw forks, the session marker and the instructions entry.

import path from 'node:path'
import crypto from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import type { SessionMetadata } from '@opencode/client'
import type { TextChannel, ThreadChannel } from 'discord.js'
import * as orm from 'drizzle-orm'

import {
  cliContext,
  oc,
  parseModel,
  projectOf,
  readMarker,
  rootSession,
  routeText,
  sessionDirectory,
  textChannel,
  type Author,
  type Bot,
  type ModelChoice,
  type PromptFile,
} from './bot.ts'
import { ConfigError, DbError, DiscordError, OpenCodeError, OpenCodeUnavailableError } from './errors.ts'
import { SILENT_MESSAGE_FLAGS } from './format-parts.ts'
import { createLogger } from './logger.ts'
import type { OpenCodeClient, OpencodeEndpoint } from './opencode-server.ts'
import { prompt, runInSession } from './prompt.ts'
import { formatEcho } from './queue.ts'
import type { Route } from './routes.ts'
import * as schema from './schema.ts'
import { baseInstructions, INSTRUCTION_KEY, type ScheduledRun } from './system-prompt.ts'
import { createWorktree, resolveWorkingDirectory } from './worktrees.ts'

const logger = createLogger('SESSIONS')

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

// Project channel, project directory and current cwd of a session thread.
export async function threadProject(bot: Bot, thread: ThreadChannel) {
  const channelId = thread.parentId
  if (!channelId) return new DiscordError({ operation: `find the channel of thread ${thread.id}` })
  const row = await projectOf(bot, channelId)
  if (row instanceof Error) return row
  if (!row) return new DiscordError({ operation: `find the project of channel ${channelId}` })
  const sessionId = rootSession(bot, thread.id)
  if (sessionId instanceof Error) return sessionId
  const directory = await sessionDirectory(bot, sessionId)
  if (directory instanceof Error) return directory
  return { channelId, projectDirectory: row.directory, directory }
}

// /cwd and `kimaki session cwd`: show the cwd, or move the session to a
// project subfolder or linked worktree.
export async function sessionCwd(bot: Bot, { thread, directory }: { thread: ThreadChannel; directory?: string }) {
  const project = await threadProject(bot, thread)
  if (project instanceof Error) return project
  if (!directory) return { directory: project.directory }
  const destination = await resolveWorkingDirectory({
    projectDirectory: project.projectDirectory,
    candidate: path.resolve(project.directory, directory),
  })
  if (destination instanceof Error) return destination
  const plugin = await bot.features.waitForPlugin(destination)
  if (plugin instanceof Error) return plugin
  const sessionId = rootSession(bot, thread.id)
  if (sessionId instanceof Error) return sessionId
  const moved = await oc(bot, 'session.move', (client) => client.session.move({ sessionID: sessionId, directory: destination, delivery: 'steer' }))
  if (moved instanceof Error) return moved
  return { requestedDirectory: destination }
}

async function bindThread(
  bot: Bot,
  { threadId, sessionId, channelId, directory, isNew }: { threadId: string; sessionId: string; channelId: string; directory: string; isNew: boolean },
): Promise<DbError | void> {
  const inserted = await bot.db
    .insert(schema.thread_sessions)
    .values({ thread_id: threadId, session_id: sessionId, source: 'kimaki' })
    .catch((cause) => new DbError({ operation: 'insert thread_sessions', cause }))
  if (inserted instanceof Error) return inserted
  await bot.eventLoop.bind({ threadId, sessionId, channelId, directory, isNew })
  logger.log(`session ${sessionId} bound to thread ${threadId}`)
}

// Agents a session may switch to (not subagents, not hidden ones).
export async function primaryAgents(bot: Bot, directory: string) {
  const agents = await oc(bot, 'agent.list', (client) => client.agent.list({ location: { directory } }))
  if (agents instanceof Error) return agents
  return agents.data.filter((agent) => agent.mode !== 'subagent' && !agent.hidden)
}

// The one durable system instruction of a session (spec 5.4).
async function putInstructions(
  bot: Bot,
  {
    sessionId,
    thread,
    channel,
    directory,
    userId,
    parentSessionId = null,
    scheduledTask = null,
  }: {
    sessionId: string
    thread: ThreadChannel
    channel: TextChannel
    directory: string
    userId: string
    parentSessionId?: string | null
    scheduledTask?: ScheduledRun | null
  },
): Promise<OpenCodeUnavailableError | OpenCodeError | void> {
  // The agent list is optional prompt context: a failure must not strand the thread.
  const found = await primaryAgents(bot, directory)
  if (found instanceof Error) logger.warn(`agent list for instructions failed: ${found.message}`)
  // The ID is what switchAgent and session.create take.
  const agents = found instanceof Error ? [] : found.map((agent) => ({ name: agent.id, description: agent.description ?? '' }))
  const value = baseInstructions({
    sessionId,
    threadId: thread.id,
    channelId: channel.id,
    guildId: channel.guildId,
    userId,
    dataDir: bot.dataDir,
    channelTopic: channel.topic,
    agents,
    parentSessionId,
    scheduledTask,
  })
  const put = await oc(bot, 'instructions.entry.put', (client) =>
    client.session.instructions.entry.put({ sessionID: sessionId, key: INSTRUCTION_KEY, value }),
  )
  if (put instanceof Error) return put
}

export type PluginWait = (directory: string) => Promise<ConfigError | OpenCodeUnavailableError | OpenCodeError | void>

// The bot writes plugins/kimaki/ on start (opencode-server.ts), but
// OpenCode's watcher picks it up a moment later: wait for it, bounded.
// One per bot (bot.features.waitForPlugin).
export function createPluginWait(bot: Pick<Bot, 'opencode'>): PluginWait {
  // Directories where the plugin was seen active, per connection: a reconnect
  // may reach a new OpenCode process, so its endpoint starts with no entries.
  const active = new WeakMap<OpencodeEndpoint, Set<string>>()
  return async (directory) => {
    const endpoint = bot.opencode.endpoint
    if (endpoint && active.get(endpoint)?.has(directory)) return
    const location = { directory }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const endpoint = bot.opencode.endpoint
      if (!endpoint) return new OpenCodeUnavailableError({ reason: 'not connected' })
      // The integration catalog waits for activations OpenCode already started; plugin.list does not.
      const activated = await endpoint.client.integration.list({ location })
        .catch((cause) => new OpenCodeError({ operation: 'integration.list', cause }))
      if (activated instanceof Error) return activated
      const plugins = await endpoint.client.plugin.list({ location })
        .catch((cause) => new OpenCodeError({ operation: 'plugin.list', cause }))
      if (plugins instanceof Error) return plugins
      if (bot.opencode.endpoint !== endpoint) continue
      if (plugins.data.some((plugin) => plugin.id === 'kimaki' && plugin.state.status === 'active')) {
        active.set(endpoint, (active.get(endpoint) ?? new Set()).add(directory))
        return
      }
      await sleep(200)
    }
    return new ConfigError({
      reason: `Kimaki plugin is not active in OpenCode for ${directory}. Kimaki writes it to <OpenCode config dir>/plugins/kimaki/ on start; check \`opencode plugin list\` and the OpenCode logs`,
    })
  }
}

// The plugin and the agent's `kimaki` calls read metadata.kimaki. Sessions
// from V1 (imported thread_sessions) have no marker and no instructions
// entry; sessions of an older bot run point at its old lock port. Checked
// on each input instead of for every binding at startup (a V1 install has
// thousands of bindings).
export async function ensureSessionMarker(
  bot: Bot,
  {
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
  },
): Promise<ConfigError | OpenCodeUnavailableError | OpenCodeError | DiscordError | void> {
  const plugin = await bot.features.waitForPlugin(directory)
  if (plugin instanceof Error) return plugin
  const info = await oc(bot, `get session ${sessionId}`, (client) => client.session.get({ sessionID: sessionId }))
  if (info instanceof Error) return info
  const marker = readMarker(info.metadata)
  if (marker && marker.dataDir === bot.dataDir && marker.lockPort === bot.lockPort) return
  // Instructions first: the marker means "set up", so a failure here is retried on the next input.
  if (!marker) {
    logger.log(`adopting legacy session ${sessionId} of thread ${thread.id}`)
    const channel = await textChannel(bot, channelId)
    if (channel instanceof Error) return channel
    const instructions = await putInstructions(bot, { sessionId, thread, channel, directory, userId })
    if (instructions instanceof Error) return instructions
  }
  const kimaki = { ...marker?.fields, source: 'discord', ...cliContext(bot), threadId: thread.id, channelId }
  const updated = await oc(bot, 'session.update', (client) =>
    client.session.update({ sessionID: sessionId, metadata: { ...info.metadata, kimaki } }),
  )
  if (updated instanceof Error) return updated
}

// Running sessions of an older bot run point at its lock port; their agent
// can call `kimaki` before the next user input (ensureSessionMarker).
export async function refreshCliContext(bot: Bot) {
  const active = await oc(bot, 'session.active', (client) => client.session.active())
  if (active instanceof Error) return active
  const { sessionThreads } = bot.store.getState()
  for (const sessionId of Object.keys(active).filter((id) => sessionThreads[id])) {
    const info = await oc(bot, 'get bound session', (client) => client.session.get({ sessionID: sessionId }))
    if (info instanceof Error) {
      logger.warn(info.message)
      continue
    }
    const marker = readMarker(info.metadata)
    if (!marker) continue
    if (marker.dataDir === bot.dataDir && marker.lockPort === bot.lockPort) continue
    const metadata = { ...info.metadata, kimaki: { ...marker.fields, ...cliContext(bot) } }
    const result = await oc(bot, 'refresh Kimaki CLI context', (client) => client.session.update({ sessionID: sessionId, metadata }))
    if (result instanceof Error) return result
  }
}

export async function startSession(
  bot: Bot,
  {
    channelId,
    directory: requestedDirectory,
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
    task,
    worktree,
    baseBranch,
    run = true,
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
    // A scheduled run (scheduler.ts): marks the session as started by this task.
    task?: ScheduledRun
    // undefined uses the channel default; false explicitly reuses an existing cwd.
    worktree?: string | false
    baseBranch?: string
    // false: only set up the thread (/new-worktree), no first input.
    run?: boolean
  },
): Promise<Error | { threadId: string; sessionId: string }> {
  const defaults = await bot.db.query.channel_directories
    .findFirst({ where: { channel_id: channelId }, with: { channel_model: true, channel_agent: true, channel_worktree: true } })
    .catch((cause) => new DbError({ operation: 'read channel defaults', cause }))
  if (defaults instanceof Error) return defaults
  const text = routeText(route)
  const channelWorktrees = defaults?.channel_worktree ? defaults.channel_worktree.enabled === 1 : bot.autoWorktrees
  const useWorktree = typeof worktree === 'string' || (worktree !== false && channelWorktrees)
  const textSlug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-|-$/g, '') || 'session'
  const slug = typeof worktree === 'string' && worktree ? worktree : `${textSlug}-${crypto.randomBytes(4).toString('hex')}`
  const checkout = useWorktree
    ? await createWorktree({ projectDirectory: defaults?.directory ?? requestedDirectory, dataDir: bot.dataDir, name: slug, baseBranch })
    : null
  if (checkout instanceof Error) return checkout
  const directory = checkout?.directory ?? requestedDirectory
  const plugin = await bot.features.waitForPlugin(directory)
  if (plugin instanceof Error) return plugin

  const channel = await textChannel(bot, channelId)
  if (channel instanceof Error) return channel
  const threadName = explicitName ?? (checkout ? `⬦ ${slug}` : text.replace(/\s+/g, ' ').slice(0, 80) || 'Kimaki session')
  const thread = await channel.threads
    .create({ name: threadName, autoArchiveDuration: 1440, ...(startMessageId && { startMessage: startMessageId }) })
    .catch((cause) => new DiscordError({ operation: 'create thread', cause }))
  if (thread instanceof Error) return thread

  const model = explicitModel
    ? { providerID: explicitModel.providerID, id: explicitModel.id, ...(explicitModel.variant && { variant: explicitModel.variant }) }
    : parseModel(defaults?.channel_model?.model_id, defaults?.channel_model?.variant)
  const agent = (route.kind === 'steer' && route.agent) || defaults?.channel_agent?.agent_name
  const kimaki = {
    threadId: thread.id,
    channelId,
    source: task ? 'task' : 'discord',
    ...(task && { taskId: task.id, task }),
    ...cliContext(bot),
    ...(parentSessionId && { parentSessionId }),
  }
  const session = await oc(bot, 'session.create', (client) =>
    client.session.create({
      title: threadName,
      location: { directory },
      ...(model && { model }),
      ...(agent && { agent }),
      ...(permissions && { permissions }),
      metadata: { kimaki },
    }),
  )
  if (session instanceof Error) return session
  bot.analytics.track('session_created', { has_worktree: Boolean(checkout), source: 'discord' })

  const instructions = await putInstructions(bot, {
    sessionId: session.id,
    thread,
    channel,
    directory,
    userId: author.id,
    parentSessionId,
    scheduledTask: task ?? null,
  })
  if (instructions instanceof Error) return instructions

  const bound = await bindThread(bot, { threadId: thread.id, sessionId: session.id, channelId, directory, isNew: true })
  if (bound instanceof Error) return bound
  if (!run) {
    const posted = await thread
      .send({
        content: `Worktree ready: \`${directory}\`\nBranch: \`${checkout?.branch ?? 'detached'}\`\nSend a message to start working.`,
        allowedMentions: { parse: [] },
        flags: SILENT_MESSAGE_FLAGS,
      })
      .catch((cause) => new DiscordError({ operation: 'post worktree ready', cause }))
    if (posted instanceof Error) return posted
    return { threadId: thread.id, sessionId: session.id }
  }
  if (showInput) {
    const names = files.map((file) => file.name).join(', ')
    const shown = names ? `${text}\nFiles: ${names}` : text
    const echo = await thread
      .send({ content: formatEcho({ username: author.username, text: shown }), allowedMentions: { parse: [] }, flags: SILENT_MESSAGE_FLAGS })
      .catch((cause) => new DiscordError({ operation: 'send first input', cause }))
    if (echo instanceof Error) return echo
  }

  const first = route.kind === 'steer' ? { kind: 'steer' as const, text: route.text } : route
  const sent = await runInSession(bot, {
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

// --- Sessions that get a new thread: /resume, /fork, /fork-subagent, btw.

// Binds an existing session to a new thread. Order matters:
//
//   thread + intro ─▶ metadata + instructions (new IDs) ─▶ history
//     ─▶ one DB batch: old bindings out, new one in ─▶ routing + replay (same tick)
//     ─▶ hydrate what it runs and waits on now
//
// Nothing routes to the thread before the replay, so live output follows
// it. A failure before the binding deletes the new thread (and calls
// `discard`), leaving any old binding untouched.
async function adoptSession(
  bot: Bot,
  {
    channel,
    session,
    threadName,
    intro,
    note,
    author,
    parentSessionId = null,
    scheduledTask = null,
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
    // A resumed task session keeps its task; a fork is a new user session.
    scheduledTask?: ScheduledRun | null
    // Cleanup of a session created only for this thread (a fork).
    discard?: () => Promise<void>
  },
): Promise<OpenCodeUnavailableError | OpenCodeError | DiscordError | DbError | { threadId: string; sessionId: string }> {
  const sessionId = session.id
  const thread = await channel.threads
    .create({ name: threadName.replace(/\s+/g, ' ').slice(0, 100), autoArchiveDuration: 1440 })
    .catch((cause) => new DiscordError({ operation: 'create thread', cause }))
  if (thread instanceof Error) return thread

  const prepared = await (async () => {
    const posted = await thread
      .send({ content: intro.slice(0, 2_000), allowedMentions: { parse: [] }, flags: SILENT_MESSAGE_FLAGS })
      .catch((cause) => new DiscordError({ operation: 'send intro', cause }))
    if (posted instanceof Error) return posted
    // Merge: other metadata stays. Task fields stay only for a resumed task session.
    const { task: _task, taskId: _taskId, ...rest } = readMarker(session.metadata)?.fields ?? {}
    const marker = scheduledTask ? { ...rest, taskId: scheduledTask.id, task: scheduledTask } : rest
    const kimaki = { ...marker, source: scheduledTask ? 'task' : 'discord', ...cliContext(bot), threadId: thread.id, channelId: channel.id }
    const marked = await oc(bot, 'session.update', (client) =>
      client.session.update({ sessionID: sessionId, metadata: { ...session.metadata, kimaki } }),
    )
    if (marked instanceof Error) return marked
    const instructions = await putInstructions(bot, {
      sessionId,
      thread,
      channel,
      directory: session.location.directory,
      userId: author.id,
      parentSessionId,
      scheduledTask,
    })
    if (instructions instanceof Error) return instructions
    const messages = await oc(bot, 'message.list', (client) => client.message.list({ sessionID: sessionId, order: 'desc', limit: 100 }))
    if (messages instanceof Error) return messages
    // One thread per session: older threads of this session stop following it.
    const moved = await bot.db
      .batch([
        bot.db
          .delete(schema.thread_sessions)
          .where(orm.eq(schema.thread_sessions.session_id, sessionId))
          .returning({ threadId: schema.thread_sessions.thread_id }),
        bot.db.insert(schema.thread_sessions).values({ thread_id: thread.id, session_id: sessionId, source: 'kimaki' }),
      ])
      .catch((cause) => new DbError({ operation: 'move thread_sessions', cause }))
    if (moved instanceof Error) return moved
    return { history: [...messages.data].reverse(), previous: moved[0].map((row) => row.threadId) }
  })()
  if (prepared instanceof Error) {
    await thread.delete('session adoption failed').catch(() => undefined)
    await discard?.()
    return prepared
  }

  for (const previousThread of prepared.previous) bot.eventLoop.unbind(previousThread)
  await bot.eventLoop.bind({
    threadId: thread.id,
    sessionId,
    channelId: channel.id,
    directory: session.location.directory,
    isNew: false,
    first: [{ type: 'kimaki.replay', messages: prepared.history, note }],
  })
  logger.log(`session ${sessionId} bound to thread ${thread.id}`)
  await thread.members.add(author.id).catch((e: Error) => logger.warn(`add member: ${e.message}`))
  const hydrated = await bot.eventLoop.syncThread(thread.id)
  if (hydrated instanceof Error) logger.warn(`hydrate ${thread.id}: ${hydrated.message}`)
  return { threadId: thread.id, sessionId }
}

// The project channel whose directory holds this session.
export async function channelForSession(bot: Bot, sessionId: string) {
  const directory = await sessionDirectory(bot, sessionId)
  if (directory instanceof Error) return directory
  return channelForDirectory(bot, directory)
}

export async function channelForDirectory(bot: Bot, directory: string) {
  const projects = await bot.db.query.channel_directories
    .findMany()
    .catch((cause) => new DbError({ operation: 'read channel_directories', cause }))
  if (projects instanceof Error) return projects
  projects.sort((a, b) => b.directory.length - a.directory.length)
  // Stored directories may be symlink aliases of the real path.
  const matches = await Promise.all(
    projects.map(async (row) => !(await resolveWorkingDirectory({ projectDirectory: row.directory, candidate: directory }) instanceof Error)),
  )
  const project = projects.find((_, index) => matches[index])
  if (!project) return new ConfigError({ reason: `No project channel for ${directory}. Pass --channel.` })
  return project.channel_id
}

// Binds an existing session of the channel's project to a new thread.
export async function resume(bot: Bot, { channelId, sessionId, author }: { channelId: string; sessionId: string; author: Author }) {
  const [channel, project] = await Promise.all([textChannel(bot, channelId), projectOf(bot, channelId)])
  if (channel instanceof Error) return channel
  if (project instanceof Error) return project
  if (!project) return new ConfigError({ reason: 'This channel is not configured with a project directory' })
  const info = await oc(bot, 'session.get', (client) => client.session.get({ sessionID: sessionId }))
  if (info instanceof Error) return info
  if (await resolveWorkingDirectory({ projectDirectory: project.directory, candidate: info.location.directory }) instanceof Error) {
    return new ConfigError({
      reason: `This session belongs to a different project or worktree: \`${info.location.directory}\`. Run \`/resume\` in the channel for that directory.`,
    })
  }
  const title = info.title ?? 'Untitled'
  const marker = readMarker(info.metadata)
  const adopted = await adoptSession(bot, {
    channel,
    session: info,
    parentSessionId: marker?.parentSessionId ?? null,
    scheduledTask: marker?.task ?? null,
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
export async function fork(
  bot: Bot,
  {
    sourceThread,
    sessionId,
    before,
    subagent,
    name,
    author,
    worktree,
  }: {
    sourceThread: ThreadChannel
    sessionId: string
    before?: string
    // Thread name; default is OpenCode's fork title.
    name?: string
    // Set when forking a subagent session: its agent and task.
    subagent?: { agent: string; description: string }
    author: Author
    // Move the fork into a new worktree (/new-worktree in a thread).
    worktree?: { name: string; baseBranch?: string }
  },
) {
  const root = rootSession(bot, sourceThread.id)
  if (root instanceof Error) return root
  if (sessionId !== root) {
    const info = await oc(bot, 'session.get', (client) => client.session.get({ sessionID: sessionId }))
    if (info instanceof Error) return info
    if (info.parentID !== root) {
      return new ConfigError({ reason: "This session is not the thread's root or a direct subagent. Run /fork or /fork-subagent in the session's own thread." })
    }
  }
  const project = await threadProject(bot, sourceThread)
  if (project instanceof Error) return project
  const channel = await textChannel(bot, project.channelId)
  if (channel instanceof Error) return channel
  const forked = await oc(bot, 'session.fork', (client) => client.session.fork({ sessionID: sessionId, ...(before && { before }) }))
  if (forked instanceof Error) return forked
  const discard = async () => {
    const removed = await oc(bot, 'session.remove', (client) => client.session.remove({ sessionID: forked.id }))
    if (removed instanceof Error) logger.warn(`discard fork ${forked.id}: ${removed.message}`)
  }
  const relocated = await (async () => {
    if (!worktree) return forked
    const checkout = await createWorktree({
      projectDirectory: project.projectDirectory,
      dataDir: bot.dataDir,
      name: worktree.name,
      baseBranch: worktree.baseBranch,
    })
    if (checkout instanceof Error) return checkout
    const plugin = await bot.features.waitForPlugin(checkout.directory)
    if (plugin instanceof Error) return plugin
    const moved = await oc(bot, 'move worktree fork', (client) => client.session.move({ sessionID: forked.id, directory: checkout.directory }))
    if (moved instanceof Error) return moved
    const waited = await oc(bot, 'wait for worktree fork move', (client) => client.session.wait({ sessionID: forked.id }))
    if (waited instanceof Error) return waited
    const info = await oc(bot, 'confirm worktree fork directory', (client) => client.session.get({ sessionID: forked.id }))
    if (info instanceof Error) return info
    if (info.location.directory !== checkout.directory) {
      return new ConfigError({ reason: `Session did not move to ${checkout.directory}. No new thread was bound.` })
    }
    return info
  })()
  if (relocated instanceof Error) {
    await discard()
    return relocated
  }
  const intro = subagent
    ? `**Forked subagent session created!**\nAgent: \`${subagent.agent}\`\nTask: ${subagent.description || 'No description'}\nFrom: \`${sessionId}\`\nNew session: \`${forked.id}\``
    : `**Forked session created!**\nFrom: <#${sourceThread.id}> (\`${sessionId}\`)\nNew session: \`${forked.id}\``
  return adoptSession(bot, {
    channel,
    session: relocated,
    discard,
    // OpenCode titles forks "<title> (fork #1)".
    threadName: name ?? (forked.title || `Fork: ${subagent?.description || sourceThread.name}`),
    intro,
    note: 'You can now continue the conversation from this point.',
    author,
  })
}

// Fork the whole session into a new "btw:" thread that answers one side
// question (V1 /btw). The source session keeps running. The fork inherits
// messages, agent, model and instructions, so its prompt cache is warm.
export async function forkBtw(
  bot: Bot,
  {
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
  },
): Promise<OpenCodeUnavailableError | OpenCodeError | DiscordError | DbError | { threadId: string; sessionId: string }> {
  const parentSessionId = rootSession(bot, sourceThread.id)
  if (parentSessionId instanceof Error) return parentSessionId
  const project = await threadProject(bot, sourceThread)
  if (project instanceof Error) return project
  const channel = await textChannel(bot, project.channelId)
  if (channel instanceof Error) return channel

  const [forked, thread] = await Promise.all([
    oc(bot, 'session.fork', (client) => client.session.fork({ sessionID: parentSessionId })),
    channel.threads
      .create({ name: `btw: ${text.replace(/\s+/g, ' ')}`.slice(0, 100), autoArchiveDuration: 1440 })
      .catch((cause) => new DiscordError({ operation: 'create btw thread', cause })),
  ])
  // Either side failed: remove the other so nothing is left half set up.
  if (forked instanceof Error) {
    if (!(thread instanceof Error)) await thread.delete('btw fork failed').catch(() => undefined)
    return forked
  }
  if (thread instanceof Error) {
    const removed = await oc(bot, 'session.remove', (client) => client.session.remove({ sessionID: forked.id }))
    if (removed instanceof Error) logger.warn(`discard btw fork ${forked.id}: ${removed.message}`)
    return thread
  }

  const kimaki = { threadId: thread.id, channelId: project.channelId, source: 'discord' }
  const marked = await oc(bot, 'session.update', (client) => client.session.update({ sessionID: forked.id, metadata: { kimaki } }))
  if (marked instanceof Error) return marked
  const bound = await bindThread(bot, {
    threadId: thread.id,
    sessionId: forked.id,
    channelId: project.channelId,
    directory: project.directory,
    isNew: false,
  })
  if (bound instanceof Error) return bound
  await thread.members.add(author.id).catch((e: Error) => logger.warn(`add btw member: ${e.message}`))
  const intro = await thread
    .send({ content: `Reusing context from <#${sourceThread.id}> to answer prompt...\n${text}`.slice(0, 2_000), flags: SILENT_MESSAGE_FLAGS })
    .catch((cause) => new DiscordError({ operation: 'send btw intro', cause }))
  if (intro instanceof Error) return intro
  if (agent) {
    const switched = await oc(bot, 'session.switchAgent', (client) => client.session.switchAgent({ sessionID: forked.id, agent }))
    if (switched instanceof Error) return switched
  }

  const sent = await prompt(bot, {
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
