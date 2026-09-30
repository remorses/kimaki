// The event loop (spec 6.3, 27.2): routes every OpenCode event of the single
// /api/event stream to its Discord thread, folds it with reduce(), stores the
// new view and hands the effects to the executor.
//
//   onEvent (never awaits) ──▶ per-thread FIFO ──▶ drain (awaits only local
//   context loads: SQLite, git branch, model limits) ──▶ reduce ──▶ store ──▶ effects
//
// The SSE reader must never block: the server drops subscribers whose
// 4096-event buffer overflows.
//
// Subagent sessions join their parent's thread (spec 6.8): session.created
// with a known parentID maps the child at once; any other unknown session is
// resolved by walking parentID with session.get while its events are held
// (covers children that started before a bot restart). Sessions that lead to
// no bound thread (TUI sessions) are remembered and dropped.

import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { DiscordAPIError, RESTJSONErrorCodes, type Client } from 'discord.js'
import * as errore from 'errore'

import { readChannelVerbosity, type KimakiDb, type Verbosity } from './db.ts'
import type { EffectsRunner } from './effects.ts'
import { DbError, DiscordError, OpenCodeError } from './errors.ts'
import { createLogger } from './logger.ts'
import type { ConnectContext, OpenCodeClient, V2Event } from './opencode-server.ts'
import type { BotStore } from './store.ts'
import { emptyView, eventSessionId, reduce, type Prefs, type ThreadEvent } from './thread-reducer.ts'

const logger = createLogger('EVENTS')

const CONTEXT_RETRIES = 5
const CONTEXT_RETRY_MS = 2_000
const MAX_HELD_EVENTS = 1_000
const execFileAsync = promisify(execFile)

type ThreadContext = {
  sessionId: string
  channelId: string
  directory: string
  verbosity: Verbosity
}

class ThreadGoneError extends errore.createTaggedError({
  name: 'ThreadGoneError',
  message: 'Thread $threadId has no project channel',
}) {}

async function gitBranch(directory: string): Promise<string | null> {
  const result = await execFileAsync('git', ['branch', '--show-current'], { cwd: directory, timeout: 5_000 }).catch(
    () => null,
  )
  const branch = result?.stdout.trim()
  return branch || null
}

export function createEventLoop({
  store,
  db,
  discord,
  effects,
}: {
  store: BotStore
  db: KimakiDb
  discord: Client
  effects: EffectsRunner
}) {
  const queues = new Map<string, { events: ThreadEvent[]; running: boolean; failures: number }>()
  const contexts = new Map<string, ThreadContext>()
  const known = new Map<string, Omit<ThreadContext, 'verbosity'>>()
  const contextLimits: Record<string, number> = {}
  const connection: { client: OpenCodeClient | null } = { client: null }

  function threadRootSession(threadId: string): string | null {
    const view = store.getState().threads[threadId]
    if (view) return view.sessionId
    const entry = Object.entries(store.getState().sessionThreads).find(([, thread]) => thread === threadId)
    return entry?.[0] ?? null
  }

  async function loadModelLimits(directory: string) {
    const client = connection.client
    if (!client) return
    const models = await client.model
      .list({ location: { directory } })
      .catch((e) => new OpenCodeError({ operation: 'model.list', cause: e }))
    if (models instanceof Error) {
      logger.warn(models.message)
      return
    }
    for (const model of models.data) {
      contextLimits[`${model.providerID}/${model.id}`] = model.limit.context
    }
  }

  async function loadContext(threadId: string): Promise<ThreadContext | ThreadGoneError | DbError | DiscordError> {
    const sessionId = threadRootSession(threadId)
    if (!sessionId) return new ThreadGoneError({ threadId })
    const base = await (async () => {
      const preset = known.get(threadId)
      if (preset) return preset
      const thread = await discord.channels.fetch(threadId).catch((e) => {
        if (e instanceof DiscordAPIError && e.code === RESTJSONErrorCodes.UnknownChannel) {
          return new ThreadGoneError({ threadId })
        }
        return new DiscordError({ operation: `fetch thread ${threadId}`, cause: e })
      })
      if (thread instanceof Error) return thread
      const channelId = thread?.isThread() ? thread.parentId : null
      if (!channelId) return new ThreadGoneError({ threadId })
      const row = await db.query.channel_directories
        .findFirst({ where: { channel_id: channelId } })
        .catch((e) => new DbError({ operation: 'read channel_directories', cause: e }))
      if (row instanceof Error) return row
      if (!row) return new ThreadGoneError({ threadId })
      return { sessionId, channelId, directory: row.directory }
    })()
    if (base instanceof Error) return base
    const verbosity = await readChannelVerbosity({ db, channelId: base.channelId })
    if (verbosity instanceof Error) return verbosity
    await loadModelLimits(base.directory)
    const context = { ...base, verbosity }
    contexts.set(threadId, context)
    return context
  }

  function prefsFor(context: ThreadContext): Prefs {
    return { verbosity: context.verbosity, contextLimits }
  }

  function apply({ threadId, context, event }: { threadId: string; context: ThreadContext; event: ThreadEvent }) {
    const state = store.getState()
    const view =
      state.threads[threadId] ??
      emptyView({
        threadId,
        sessionId: context.sessionId,
        folder: path.basename(context.directory),
        isNew: false,
      })
    const result = reduce({ view, event, prefs: prefsFor(context) })
    if (result.view !== state.threads[threadId]) {
      store.setState((current) => ({ threads: { ...current.threads, [threadId]: result.view } }))
    }
    effects.run(threadId, result.effects)
  }

  async function drain(threadId: string) {
    const queue = queues.get(threadId)
    if (!queue || queue.running) return
    queue.running = true
    while (queue.events.length > 0) {
      const context = contexts.get(threadId) ?? (await loadContext(threadId))
      if (context instanceof ThreadGoneError || (context instanceof Error && queue.failures >= CONTEXT_RETRIES)) {
        logger.warn(`dropping ${queue.events.length} events of thread ${threadId}: ${context.message}`)
        queue.events.length = 0
        break
      }
      if (context instanceof Error) {
        // Transient Discord or SQLite failure: keep the events and retry.
        queue.failures++
        logger.warn(`thread ${threadId} context failed (${queue.failures}/${CONTEXT_RETRIES}): ${context.message}`)
        setTimeout(() => void drain(threadId), CONTEXT_RETRY_MS * queue.failures)
        break
      }
      queue.failures = 0
      const event = queue.events.shift()
      if (!event) break
      if (event.type === 'session.execution.started' && eventSessionId(event) === context.sessionId) {
        apply({ threadId, context, event: { type: 'kimaki.branch', branch: await gitBranch(context.directory) } })
      }
      apply({ threadId, context, event })
    }
    queue.running = false
  }

  function enqueue(threadId: string, event: ThreadEvent) {
    const queue = queues.get(threadId) ?? { events: [], running: false, failures: 0 }
    queues.set(threadId, queue)
    queue.events.push(event)
    void drain(threadId)
  }

  const ignoredSessions = new Set<string>()
  // Events of sessions whose thread is being looked up, in arrival order.
  const resolving = new Map<string, { events: V2Event[]; inFlight: boolean }>()

  function mapSession(sessionId: string, threadId: string) {
    store.setState((current) => ({ sessionThreads: { ...current.sessionThreads, [sessionId]: threadId } }))
  }

  // Walks parentID up to a bound session. null = confirmed unrelated (no parent
  // leads to a thread); an Error = lookup failed, try again later.
  async function findAncestorThread({
    client,
    sessionId,
    signal,
  }: {
    client: OpenCodeClient
    sessionId: string
    signal?: AbortSignal
  }): Promise<OpenCodeError | null | { threadId: string; chain: Array<{ sessionId: string; agent: string }> }> {
    const chain: Array<{ sessionId: string; agent: string }> = []
    let current = sessionId
    for (let depth = 0; depth < 8; depth++) {
      const info = await client.session
        .get({ sessionID: current }, { signal })
        .catch((e) => new OpenCodeError({ operation: 'session.get', cause: e }))
      if (info instanceof Error) return info
      if (!info.parentID) return null
      chain.unshift({ sessionId: current, agent: info.agent ?? 'subagent' })
      const threadId = store.getState().sessionThreads[info.parentID]
      if (threadId) return { threadId, chain }
      current = info.parentID
    }
    return null
  }

  function adoptChain({ threadId, chain }: { threadId: string; chain: Array<{ sessionId: string; agent: string }> }) {
    for (const link of chain) {
      mapSession(link.sessionId, threadId)
      enqueue(threadId, { type: 'kimaki.child', sessionId: link.sessionId, agent: link.agent })
    }
  }

  async function resolveUnknownSession(sessionId: string) {
    const entry = resolving.get(sessionId)
    const client = connection.client
    if (!entry || entry.inFlight || !client) return
    entry.inFlight = true
    const found = await findAncestorThread({ client, sessionId })
    entry.inFlight = false
    if (found instanceof Error) {
      // Keep the held events; the next event of this session retries.
      logger.warn(`cannot resolve session ${sessionId}: ${found.message}`)
      return
    }
    resolving.delete(sessionId)
    if (!found) {
      ignoredSessions.add(sessionId)
      return
    }
    adoptChain(found)
    for (const event of entry.events) enqueue(found.threadId, event)
  }

  return {
    // Bindings from SQLite. Several rows can share a session after V1 /resume;
    // the most recently updated one wins.
    async load(): Promise<DbError | void> {
      const rows = await db.query.thread_sessions
        .findMany({ orderBy: { updated_at: 'asc' } })
        .catch((e) => new DbError({ operation: 'read thread_sessions', cause: e }))
      if (rows instanceof Error) return rows
      const sessionThreads = Object.fromEntries(rows.map((row) => [row.session_id, row.thread_id]))
      store.setState({ sessionThreads })
    },

    // A session this bot just created for a thread.
    bind({
      threadId,
      sessionId,
      channelId,
      directory,
    }: {
      threadId: string
      sessionId: string
      channelId: string
      directory: string
    }): void {
      known.set(threadId, { sessionId, channelId, directory })
      ignoredSessions.delete(sessionId)
      store.setState((current) => ({
        sessionThreads: { ...current.sessionThreads, [sessionId]: threadId },
        threads: {
          ...current.threads,
          [threadId]: emptyView({ threadId, sessionId, folder: path.basename(directory), isNew: true }),
        },
      }))
    },

    // Held live events wait while this runs (connect protocol, spec 6.8).
    // Reconciles busy state; children that started while the bot was away are
    // adopted through their parentID chain first.
    async onConnect({ client, signal }: ConnectContext): Promise<OpenCodeError | void> {
      connection.client = client
      const active = await client.session
        .active({ signal })
        .catch((e) => new OpenCodeError({ operation: 'session.active', cause: e }))
      if (active instanceof Error) return active
      const unknown = Object.keys(active).filter(
        (sessionId) => !store.getState().sessionThreads[sessionId] && !ignoredSessions.has(sessionId),
      )
      const found = await Promise.all(unknown.map((sessionId) => findAncestorThread({ client, sessionId, signal })))
      if (signal.aborted) return new OpenCodeError({ operation: 'hydrate (superseded)' })
      for (const result of found) {
        if (result && !(result instanceof Error)) adoptChain(result)
      }
      const now = Date.now()
      const { threads, sessionThreads } = store.getState()
      const byThread = new Map<string, string[]>(Object.keys(threads).map((threadId) => [threadId, []]))
      for (const sessionId of Object.keys(active)) {
        const threadId = sessionThreads[sessionId]
        if (!threadId) continue
        byThread.set(threadId, [...(byThread.get(threadId) ?? []), sessionId])
      }
      for (const [threadId, activeSessionIds] of byThread) {
        enqueue(threadId, { type: 'kimaki.synced', activeSessionIds, at: now })
      }
    },

    onEvent(event: V2Event): void {
      const sessionId = eventSessionId(event)
      if (!sessionId) return
      const { sessionThreads } = store.getState()
      const threadId = sessionThreads[sessionId]
      if (threadId) {
        enqueue(threadId, event)
        return
      }
      if (ignoredSessions.has(sessionId)) return
      const parentThread = event.type === 'session.created' && event.data.parentID ? sessionThreads[event.data.parentID] : null
      if (parentThread) {
        mapSession(sessionId, parentThread)
        enqueue(parentThread, event)
        return
      }
      const entry = resolving.get(sessionId) ?? { events: [], inFlight: false }
      resolving.set(sessionId, entry)
      entry.events.push(event)
      // Bounded: a session whose lookup keeps failing must not grow forever.
      if (entry.events.length > MAX_HELD_EVENTS) entry.events.shift()
      void resolveUnknownSession(sessionId)
    },

    onDisconnect(): void {
      connection.client = null
    },
  }
}

export type EventLoop = ReturnType<typeof createEventLoop>
