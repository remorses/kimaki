// The event loop (spec 6.3, 27.2): routes every OpenCode event of the single
// /api/event stream to its Discord thread, folds it with reduce(), stores the
// new view and hands the effects to the executor.
//
//   onEvent (never awaits) ──▶ per-thread FIFO ──▶ drain (awaits only local
//   context loads: SQLite, git branch, model limits) ──▶ reduce ──▶ store ──▶ effects
//
// The SSE reader must never block: the server drops subscribers whose
// 4096-event buffer overflows.

import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Client } from 'discord.js'
import * as errore from 'errore'

import { readChannelVerbosity, type KimakiDb, type Verbosity } from './db.ts'
import type { EffectsRunner } from './effects.ts'
import { DbError, DiscordError, OpenCodeError } from './errors.ts'
import { createLogger } from './logger.ts'
import type { ConnectContext, OpenCodeClient, V2Event } from './opencode-server.ts'
import type { BotStore } from './store.ts'
import { emptyView, eventSessionId, reduce, type Prefs, type ThreadEvent } from './thread-reducer.ts'

const logger = createLogger('EVENTS')
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
  const queues = new Map<string, { events: ThreadEvent[]; running: boolean }>()
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
      const thread = await discord.channels
        .fetch(threadId)
        .catch((e) => new DiscordError({ operation: `fetch thread ${threadId}`, cause: e }))
      if (thread instanceof Error) return thread
      const channelId = thread && 'parentId' in thread ? thread.parentId : null
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

  function apply(threadId: string, context: ThreadContext, event: ThreadEvent) {
    const state = store.getState()
    const view =
      state.threads[threadId] ??
      emptyView({
        threadId,
        sessionId: context.sessionId,
        folder: path.basename(context.directory),
        isNew: false,
      })
    const result = reduce(view, event, prefsFor(context))
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
      if (context instanceof Error) {
        logger.warn(`dropping ${queue.events.length} events: ${context.message}`)
        queue.events.length = 0
        break
      }
      const event = queue.events.shift()
      if (!event) break
      if (event.type === 'session.execution.started' && eventSessionId(event) === context.sessionId) {
        apply(threadId, context, { type: 'kimaki.branch', branch: await gitBranch(context.directory) })
      }
      apply(threadId, context, event)
    }
    queue.running = false
  }

  function enqueue(threadId: string, event: ThreadEvent) {
    const queue = queues.get(threadId) ?? { events: [], running: false }
    queues.set(threadId, queue)
    queue.events.push(event)
    void drain(threadId)
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
      store.setState((current) => ({
        sessionThreads: { ...current.sessionThreads, [sessionId]: threadId },
        threads: {
          ...current.threads,
          [threadId]: emptyView({ threadId, sessionId, folder: path.basename(directory), isNew: true }),
        },
      }))
    },

    // Held live events wait while this runs (connect protocol, spec 6.8).
    async onConnect({ client }: ConnectContext): Promise<OpenCodeError | void> {
      connection.client = client
      const active = await client.session
        .active()
        .catch((e) => new OpenCodeError({ operation: 'session.active', cause: e }))
      if (active instanceof Error) return active
      const now = Date.now()
      const { threads, sessionThreads } = store.getState()
      const threadIds = new Set([
        ...Object.keys(threads),
        ...Object.keys(active).flatMap((sessionId) => sessionThreads[sessionId] ?? []),
      ])
      for (const threadId of threadIds) {
        const sessionId = threadRootSession(threadId)
        if (!sessionId) continue
        enqueue(threadId, { type: 'kimaki.synced', active: sessionId in active, at: now })
      }
    },

    onEvent(event: V2Event): void {
      const sessionId = eventSessionId(event)
      if (!sessionId) return
      const threadId = store.getState().sessionThreads[sessionId]
      if (!threadId) return
      enqueue(threadId, event)
    },

    onDisconnect(): void {
      connection.client = null
    },
  }
}

export type EventLoop = ReturnType<typeof createEventLoop>
