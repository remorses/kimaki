// The event loop (spec 6.3, 27.2): routes every OpenCode event of the single
// /api/event stream to its Discord thread, folds it with reduce(), stores the
// new view and hands the effects to the executor. Folding is synchronous:
//
//   onEvent ─▶ sessionThreads ─▶ threadId ─▶ reduce ─▶ store ─▶ effects.run (never awaited)
//
// The SSE reader must never block: the server drops subscribers whose
// 4096-event buffer overflows. Two cases wait for a lookup, and hold their
// events in arrival order meanwhile:
//
//   unknown session  walk parentID with session.get until a bound session
//                    (subagents that started before a bot restart). Sessions
//                    that lead to no thread (TUI sessions) are dropped.
//   cold thread      a bound thread without a view yet (bound in an earlier
//                    bot run): read its project channel and directory once.

import { DiscordAPIError, RESTJSONErrorCodes, type Client } from 'discord.js'

import type { Analytics } from './analytics.ts'
import { verbosityFromV1, type KimakiDb } from './db.ts'
import type { EffectsRunner } from './effects.ts'
import { DbError, DiscordError, OpenCodeError } from './errors.ts'
import { createLogger } from './logger.ts'
import type { ConnectContext, OpenCodeClient, V2Event } from './opencode-server.ts'
import type { EventRecorder } from './session-events.ts'
import type { BotStore } from './store.ts'
import {
  emptyView,
  eventSessionId,
  isKimakiEvent,
  reduce,
  type KimakiEvent,
  type SessionSnapshot,
  type ThreadEvent,
} from './thread-reducer.ts'

const logger = createLogger('EVENTS')

const LOAD_RETRIES = 5
const LOAD_RETRY_MS = 2_000
const MAX_HELD_EVENTS = 1_000

type Held = { events: ThreadEvent[]; loading: boolean; failures: number }

type ThreadSnapshot = { threadId: string; event: Extract<KimakiEvent, { type: 'kimaki.snapshot' }> }

function hold(map: Map<string, Held>, key: string, event: ThreadEvent): Held {
  const entry = map.get(key) ?? { events: [], loading: false, failures: 0 }
  map.set(key, entry)
  entry.events.push(event)
  // Bounded: a lookup that keeps failing must not grow forever.
  if (entry.events.length > MAX_HELD_EVENTS) entry.events.shift()
  return entry
}

export function createEventLoop({
  store,
  db,
  discord,
  effects,
  recorder,
  analytics,
}: {
  store: BotStore
  db: KimakiDb
  discord: Client
  effects: EffectsRunner
  recorder: EventRecorder
  analytics: Analytics
}) {
  // The client of the current connection, set before hydration starts.
  const connection: { client: OpenCodeClient | null } = { client: null }
  // Context window sizes ("providerID/modelID" -> tokens), read once per
  // directory per connection: project config can add providers.
  const limits: { byModel: Readonly<Record<string, number>>; loads: Map<string, Promise<void>> } = { byModel: {}, loads: new Map() }
  const coldThreads = new Map<string, Held>()
  const unknownSessions = new Map<string, Held>()
  const ignoredSessions = new Set<string>()

  // Resolves when the limits of `directory` are known (or failed to load).
  function loadModelLimits(directory: string): Promise<void> {
    const client = connection.client
    if (!client) return Promise.resolve()
    const existing = limits.loads.get(directory)
    if (existing) return existing
    const load = (async () => {
      const models = await client.model.list({ location: { directory } }).catch((e) => new OpenCodeError({ operation: 'model.list', cause: e }))
      if (models instanceof Error) {
        limits.loads.delete(directory)
        logger.warn(models.message)
        return
      }
      limits.byModel = { ...limits.byModel, ...Object.fromEntries(models.data.map((model) => [`${model.providerID}/${model.id}`, model.limit.context])) }
    })()
    limits.loads.set(directory, load)
    return load
  }

  // Folds one event into a loaded view.
  function fold(threadId: string, event: ThreadEvent) {
    const state = store.getState()
    const view = state.threads[threadId]
    if (!view) return
    const verbosity = state.verbosity[view.channelId] ?? verbosityFromV1(null)
    const result = reduce({ view, event, prefs: { verbosity, contextLimits: limits.byModel } })
    if (result.view !== view) store.setState((current) => ({ threads: { ...current.threads, [threadId]: result.view } }))
    effects.run(threadId, result.effects)
    if (event.type === 'session.moved' && event.data.sessionID === view.sessionId) void loadModelLimits(event.data.location.directory)
  }

  // Every event of a thread enters here exactly once.
  function deliver(threadId: string, event: ThreadEvent) {
    recorder.record(threadId, event)
    if (!isKimakiEvent(event)) analytics.observe(event, store.getState().roots[threadId] === eventSessionId(event))
    if (store.getState().threads[threadId] && !coldThreads.has(threadId)) return fold(threadId, event)
    hold(coldThreads, threadId, event)
    void loadView(threadId)
  }

  // A thread bound in an earlier run: its channel (for verbosity) and the
  // session's directory, then the held events in order.
  async function loadView(threadId: string): Promise<void> {
    const entry = coldThreads.get(threadId)
    if (!entry || entry.loading) return
    entry.loading = true
    const sessionId = store.getState().roots[threadId]
    const loaded = await (async () => {
      if (!sessionId) return null
      const thread = await discord.channels.fetch(threadId).catch((e) => e instanceof DiscordAPIError && e.code === RESTJSONErrorCodes.UnknownChannel ? null : new DiscordError({ operation: `fetch thread ${threadId}`, cause: e }))
      if (thread instanceof Error) return thread
      const channelId = thread?.isThread() ? thread.parentId : null
      if (!channelId) return null
      const project = await db.query.channel_directories.findFirst({ where: { channel_id: channelId } }).catch((e) => new DbError({ operation: 'read channel_directories', cause: e }))
      if (project instanceof Error) return project
      if (!project) return null
      const client = connection.client
      if (!client) return new OpenCodeError({ operation: 'load session directory while disconnected' })
      const info = await client.session.get({ sessionID: sessionId }).catch((cause) => new OpenCodeError({ operation: 'read session directory', cause }))
      if (info instanceof Error) return info
      await loadModelLimits(info.location.directory)
      return { channelId, directory: info.location.directory }
    })()
    entry.loading = false
    if (loaded instanceof Error && entry.failures < LOAD_RETRIES) {
      // Transient Discord, SQLite or OpenCode failure: keep the events and retry.
      entry.failures++
      logger.warn(`thread ${threadId} load failed (${entry.failures}/${LOAD_RETRIES}): ${loaded.message}`)
      setTimeout(() => void loadView(threadId), LOAD_RETRY_MS * entry.failures)
      return
    }
    coldThreads.delete(threadId)
    // Unbound, rebound or gone meanwhile: the held events belong to no view.
    if (!sessionId || !loaded || loaded instanceof Error || store.getState().roots[threadId] !== sessionId) {
      logger.warn(`dropping ${entry.events.length} events of thread ${threadId}: ${loaded instanceof Error ? loaded.message : 'no project channel'}`)
      return
    }
    if (!store.getState().threads[threadId]) {
      const view = emptyView({ threadId, sessionId, channelId: loaded.channelId, directory: loaded.directory, isNew: false })
      store.setState((current) => ({ threads: { ...current.threads, [threadId]: view } }))
    }
    for (const event of entry.events) fold(threadId, event)
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
      const info = await client.session.get({ sessionID: current }, { signal }).catch((e) => new OpenCodeError({ operation: 'session.get', cause: e }))
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
      store.setState((current) => ({ sessionThreads: { ...current.sessionThreads, [link.sessionId]: threadId } }))
      deliver(threadId, { type: 'kimaki.child', sessionId: link.sessionId, agent: link.agent })
    }
  }

  async function resolveUnknownSession(sessionId: string) {
    const entry = unknownSessions.get(sessionId)
    const client = connection.client
    if (!entry || entry.loading || !client) return
    entry.loading = true
    const found = await findAncestorThread({ client, sessionId })
    entry.loading = false
    if (found instanceof Error) {
      // Keep the held events; the next event of this session retries.
      logger.warn(`cannot resolve session ${sessionId}: ${found.message}`)
      return
    }
    unknownSessions.delete(sessionId)
    if (!found) {
      ignoredSessions.add(sessionId)
      return
    }
    adoptChain(found)
    for (const event of entry.events) deliver(found.threadId, event)
  }

  // What OpenCode runs and waits on now, per thread: busy state, root
  // directory, queue, questions and permissions. Children that started while
  // the bot was away are adopted through their parentID chain first.
  // `threadIds`: only these threads; default every thread with a view or an
  // active session. Waiting state is read only where it can exist: active
  // sessions, and sessions whose questions, permissions or queue a view shows.
  async function snapshots({
    client,
    signal,
    threadIds,
    beforeRead,
  }: {
    client: OpenCodeClient
    signal: AbortSignal
    threadIds?: readonly string[]
    // Called after adopting children, right before the state reads start.
    beforeRead?: () => void
  }): Promise<OpenCodeError | ThreadSnapshot[]> {
    const active = await client.session.active({ signal }).catch((e) => new OpenCodeError({ operation: 'session.active', cause: e }))
    if (active instanceof Error) return active
    const unknown = Object.keys(active).filter((id) => !store.getState().sessionThreads[id] && !ignoredSessions.has(id))
    const found = await Promise.all(unknown.map((sessionId) => findAncestorThread({ client, sessionId, signal })))
    if (signal.aborted) return new OpenCodeError({ operation: 'sync (superseded)' })
    for (const result of found) {
      if (result && !(result instanceof Error)) adoptChain(result)
    }
    beforeRead?.()
    const { threads, sessionThreads, roots } = store.getState()
    const activeIds = Object.keys(active)
    const targets = threadIds ?? [...new Set([...Object.keys(threads), ...activeIds.flatMap((id) => sessionThreads[id] ?? [])])]
    const at = Date.now()
    const results = await Promise.all(
      targets.map(async (threadId): Promise<OpenCodeError | ThreadSnapshot | null> => {
        const root = roots[threadId]
        if (!root) return null
        const view = threads[threadId]
        const activeSessionIds = activeIds.filter((id) => sessionThreads[id] === threadId)
        const shown = view ? [...Object.values(view.forms), ...Object.values(view.permissions)].map((item) => item.sessionId) : []
        const queued = view && view.queue.length > 0 ? [root] : []
        const sessionIds = [...new Set([...activeSessionIds, ...shown, ...queued])]
        const [info, sessions] = await Promise.all([
          // A deleted session keeps its last known directory.
          client.session.get({ sessionID: root }, { signal }).catch(() => null),
          Promise.all(sessionIds.map((sessionId) => readSession({ client, sessionId, isRoot: sessionId === root, signal }))),
        ])
        const failed = sessions.find((session) => session instanceof Error)
        if (failed instanceof Error) return failed
        const directory = info?.location.directory ?? null
        if (directory) await loadModelLimits(directory)
        const event: ThreadSnapshot['event'] = {
          type: 'kimaki.snapshot',
          at,
          directory,
          activeSessionIds,
          sessions: sessions.filter((session): session is SessionSnapshot => !(session instanceof Error)),
        }
        return { threadId, event }
      }),
    )
    if (signal.aborted) return new OpenCodeError({ operation: 'sync (superseded)' })
    const failed = results.find((result) => result instanceof Error)
    if (failed instanceof Error) return failed
    return results.filter((result): result is ThreadSnapshot => result !== null && !(result instanceof Error))
  }

  async function readSession({ client, sessionId, isRoot, signal }: { client: OpenCodeClient; sessionId: string; isRoot: boolean; signal: AbortSignal }): Promise<OpenCodeError | SessionSnapshot> {
    const [inbox, forms, permissions] = await Promise.all([
      isRoot ? client.session.inbox.list({ sessionID: sessionId }, { signal }).catch((e) => new OpenCodeError({ operation: 'session.inbox.list', cause: e })) : null,
      client.session.form.list({ sessionID: sessionId }, { signal }).catch((e) => new OpenCodeError({ operation: 'session.form.list', cause: e })),
      client.permission.list({ sessionID: sessionId }, { signal }).catch((e) => new OpenCodeError({ operation: 'permission.list', cause: e })),
    ])
    if (inbox instanceof Error) return inbox
    if (forms instanceof Error) return forms
    if (permissions instanceof Error) return permissions
    return { sessionId, inbox, forms, permissions }
  }

  return {
    // Bindings and channel verbosity from SQLite. Several bindings can share a
    // session after V1 /resume; the most recently updated one wins.
    async load(): Promise<DbError | void> {
      const [rows, verbosity] = await Promise.all([
        db.query.thread_sessions.findMany({ orderBy: { updated_at: 'asc' } }).catch((e) => new DbError({ operation: 'read thread_sessions', cause: e })),
        db.query.channel_verbosity.findMany().catch((e) => new DbError({ operation: 'read channel_verbosity', cause: e })),
      ])
      if (rows instanceof Error) return rows
      if (verbosity instanceof Error) return verbosity
      store.setState({
        roots: Object.fromEntries(rows.map((row) => [row.thread_id, row.session_id])),
        sessionThreads: Object.fromEntries(rows.map((row) => [row.session_id, row.thread_id])),
        verbosity: Object.fromEntries(verbosity.map((row) => [row.channel_id, verbosityFromV1(row.verbosity)])),
      })
    },

    // A session this bot created, forked or resumed for a thread. Called before
    // the first prompt, so the whole first turn is routed. `first`: internal
    // events folded before any live event (history replay).
    async bind({
      threadId,
      sessionId,
      channelId,
      directory,
      isNew,
      first = [],
    }: {
      threadId: string
      sessionId: string
      channelId: string
      directory: string
      // New sessions show a banner on their first step; forks do not.
      isNew: boolean
      first?: readonly KimakiEvent[]
    }): Promise<void> {
      ignoredSessions.delete(sessionId)
      coldThreads.delete(threadId)
      store.setState((current) => ({
        roots: { ...current.roots, [threadId]: sessionId },
        sessionThreads: { ...current.sessionThreads, [sessionId]: threadId },
        threads: { ...current.threads, [threadId]: emptyView({ threadId, sessionId, channelId, directory, isNew }) },
      }))
      // Same synchronous turn as the routing change: no live event can come first.
      for (const event of first) deliver(threadId, event)
      // Before the first prompt, so its footer can show the context percent.
      await loadModelLimits(directory)
    },

    // A thread loses its session (`/resume` moved the session to a new thread).
    unbind(threadId: string): void {
      coldThreads.delete(threadId)
      effects.dispose(threadId)
      store.setState((current) => {
        const { [threadId]: _root, ...roots } = current.roots
        const { [threadId]: _view, ...threads } = current.threads
        const sessionThreads = Object.fromEntries(Object.entries(current.sessionThreads).filter(([, mapped]) => mapped !== threadId))
        return { roots, threads, sessionThreads }
      })
    },

    // An existing session was bound to this thread (`/resume`, `/fork`). Its
    // live events wait until the snapshot is folded, so a newer event (an
    // execution that ended meanwhile) is never overwritten by older state.
    async syncThread(threadId: string): Promise<OpenCodeError | void> {
      const client = connection.client
      if (!client || coldThreads.has(threadId)) return
      const entry: Held = { events: [], loading: true, failures: 0 }
      const result = await snapshots({ client, signal: AbortSignal.timeout(10_000), threadIds: [threadId], beforeRead: () => coldThreads.set(threadId, entry) })
      if (coldThreads.get(threadId) === entry) coldThreads.delete(threadId)
      if (!(result instanceof Error)) for (const snapshot of result) deliver(snapshot.threadId, snapshot.event)
      for (const event of entry.events) fold(threadId, event)
      if (result instanceof Error) return result
    },

    // Held live events wait while this runs (connect protocol, spec 6.8).
    async onConnect({ client, signal }: ConnectContext): Promise<OpenCodeError | void> {
      connection.client = client
      // A new connection may bring new providers, and old unrelated sessions are gone.
      limits.loads.clear()
      ignoredSessions.clear()
      const result = await snapshots({ client, signal })
      if (result instanceof Error) return result
      for (const snapshot of result) deliver(snapshot.threadId, snapshot.event)
    },

    // Internal events (agent UI) go through the same fold as OpenCode events.
    dispatch(threadId: string, event: KimakiEvent): void {
      deliver(threadId, event)
    },

    onEvent(event: V2Event): void {
      const sessionId = eventSessionId(event)
      if (!sessionId) return
      const { sessionThreads } = store.getState()
      const threadId = sessionThreads[sessionId]
      if (threadId) return deliver(threadId, event)
      if (ignoredSessions.has(sessionId)) return
      const parentThread = event.type === 'session.created' && event.data.parentID ? sessionThreads[event.data.parentID] : null
      if (parentThread) {
        store.setState((current) => ({ sessionThreads: { ...current.sessionThreads, [sessionId]: parentThread } }))
        return deliver(parentThread, event)
      }
      hold(unknownSessions, sessionId, event)
      void resolveUnknownSession(sessionId)
    },

    onDisconnect(): void {
      connection.client = null
    },
  }
}

export type EventLoop = ReturnType<typeof createEventLoop>
