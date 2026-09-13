// Global SSE event listener.
// One persistent connection to /global/event that broadcasts events to all
// registered thread runtimes. Each runtime's handleEvent() filters by
// sessionId internally. Replaces per-thread SSE listeners that each opened
// their own connection, causing reconnect churn with many idle threads.
//
// Architecture mirrors the opencode TUI (packages/app/src/context/global-sdk.tsx)
// which uses a single global.event() SSE stream for all directories.

import { OpenCode, type OpenCodeClient, type V2Event } from '@opencode/client'

import { OpenCodeSdkError } from '../errors.js'
import { createLogger, LogPrefix } from '../logger.js'
import { getOpencodeServerAuthHeaders } from '../opencode.js'

const logger = createLogger(LogPrefix.SESSION)

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true
  if (err instanceof Error && err.name === 'AbortError') return true
  return false
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timeout = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timeout)
      resolve()
    }, { once: true })
  })
}

// ── Types ──────────────────────────────────────────────────────

export type GlobalEventContext = { reconnected: boolean }
type EventCallback = (event: V2Event, context: GlobalEventContext) => void

// ── State ──────────────────────────────────────────────────────

const callbacks = new Map<string, EventCallback>()
let loopRunning = false
let disposed = false
let controller: AbortController | null = null
let connected = false
let connectedBefore = false
const connectionWaiters = new Set<() => void>()

// ── Public API ─────────────────────────────────────────────────

/**
 * Register a thread runtime to receive global events. Every event from the
 * global SSE stream is broadcast to every callback; the runtime's own
 * handleEvent() filters by sessionId.
 */
export function registerEventListener(
  threadId: string,
  callback: EventCallback,
): void {
  // Allow restart after dispose (e.g. server restart in tests).
  if (disposed) {
    disposed = false
  }
  callbacks.set(threadId, callback)
  ensureListenerRunning()
}

/**
 * Unregister a thread runtime.
 */
export function unregisterEventListener(threadId: string): void {
  callbacks.delete(threadId)
}

/**
 * Stop the global listener entirely. Called during server shutdown.
 * The listener can be restarted by a subsequent registerEventListener() call.
 */
export function disposeGlobalEventListener(): void {
  disposed = true
  loopRunning = false
  connected = false
  connectedBefore = false
  controller?.abort()
  controller = null
  callbacks.clear()
}

/**
 * Restart the global listener (e.g. after the opencode server restarts).
 * Aborts the current SSE connection so it reconnects immediately.
 */
export function restartGlobalEventListener(): void {
  if (disposed) return
  connected = false
  controller?.abort()
}

/** Wait until the SSE stream has yielded its first event (server.connected). */
export function waitForGlobalEventListener(): Promise<void> {
  if (callbacks.size === 0 || connected) return Promise.resolve()
  ensureListenerRunning()
  return new Promise((resolve) => {
    connectionWaiters.add(resolve)
  })
}

// ── Internals ──────────────────────────────────────────────────

// Lazy subscription to opencode server lifecycle. Deferred to avoid
// circular import: global-event-listener imports opencode.ts which
// imports global-event-listener at module scope.
let lifecycleSubscribed = false

function ensureLifecycleSubscription(): void {
  if (lifecycleSubscribed) return
  lifecycleSubscribed = true
  void import('../opencode.js')
    .then(({ subscribeOpencodeServerLifecycle }) => {
      subscribeOpencodeServerLifecycle((event) => {
        if (event.type === 'started') {
          logger.log(
            `[GLOBAL LISTENER] OpenCode server started on port ${event.port}, reconnecting`,
          )
          restartGlobalEventListener()
        }
      })
    })
    .catch((error) => {
      logger.warn(
        '[GLOBAL LISTENER] Failed to subscribe to OpenCode lifecycle:',
        error,
      )
    })
}

function ensureListenerRunning(): void {
  if (loopRunning || disposed) return
  ensureLifecycleSubscription()
  loopRunning = true
  void runEventLoop()
}

type ServerConnection = { baseUrl: string; password: string }

/** Resolve the active server connection lazily to break the circular import. */
let _getServerConnection: (() => ServerConnection | null) | null = null

async function resolveServerConnectionGetter(): Promise<() => ServerConnection | null> {
  if (_getServerConnection) return _getServerConnection
  const mod = await import('../opencode.js')
  _getServerConnection = () => mod.getOpencodeServerConnection()
  return _getServerConnection
}

export function createGlobalEventClient({
  baseUrl,
  password,
}: ServerConnection): OpenCodeClient {
  return OpenCode.make({
    baseUrl,
    headers: getOpencodeServerAuthHeaders({ password }),
  })
}

function dispatchEvent(event: V2Event, context: GlobalEventContext): void {
  for (const callback of callbacks.values()) {
    callback(event, context)
  }
}

async function runEventLoop(): Promise<void> {
  const getServerConnection = await resolveServerConnectionGetter()

  let backoffMs = 500
  const maxBackoffMs = 30_000

  while (!disposed) {
    controller = new AbortController()
    const signal = controller.signal

    const serverConnection = getServerConnection()
    if (!serverConnection) {
      if (callbacks.size === 0) {
        logger.log('[GLOBAL LISTENER] No registrations, pausing')
        loopRunning = false
        return
      }
      logger.warn(
        `[GLOBAL LISTENER] No OpenCode server available, retrying in ${backoffMs}ms`,
      )
      await delay(backoffMs, signal)
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
      continue
    }

    const client = createGlobalEventClient(serverConnection)

    const events = client.event.subscribe({ signal })

    logger.log('[GLOBAL LISTENER] Subscribing to global event stream')

    let receivedAnyEvent = false
    const iterResult = await (async () => {
      for await (const event of events) {
        if (!receivedAnyEvent) {
          receivedAnyEvent = true
          const reconnected = connectedBefore
          connectedBefore = true
          connected = true
          for (const resolve of connectionWaiters) resolve()
          connectionWaiters.clear()
          logger.log('[GLOBAL LISTENER] Connected to global event stream')
          dispatchEvent(event, { reconnected })
          continue
        }
        dispatchEvent(event, { reconnected: false })
      }
    })()
      .catch((e) => new OpenCodeSdkError({ operation: 'event.iterate', cause: e }))

    connected = false

    if (receivedAnyEvent) {
      backoffMs = 500
    }

    if (iterResult instanceof Error) {
      if (isAbortError(iterResult)) {
        if (disposed) return
        backoffMs = 500
        continue
      }
      logger.warn(
        `[GLOBAL LISTENER] Stream broke, reconnecting in ${backoffMs}ms:`,
        iterResult.message,
      )
      await delay(backoffMs, signal)
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
    } else {
      if (signal.aborted) {
        backoffMs = 500
        continue
      }
      logger.log(
        `[GLOBAL LISTENER] Stream ended normally, reconnecting in ${backoffMs}ms`,
      )
      await delay(backoffMs, signal)
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
    }
  }
}
