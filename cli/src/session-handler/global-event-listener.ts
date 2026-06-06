// Global SSE event listener.
// One persistent connection to /global/event that broadcasts events to all
// registered thread runtimes. Each runtime's handleEvent() filters by
// sessionId internally. Replaces per-thread SSE listeners that each opened
// their own connection, causing reconnect churn with many idle threads.
//
// Architecture mirrors the opencode TUI (packages/app/src/context/global-sdk.tsx)
// which uses a single global.event() SSE stream for all directories.

import type { Event as OpenCodeEvent, GlobalEvent } from '@opencode-ai/sdk/v2'
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2'

import { createLogger, LogPrefix } from '../logger.js'

const logger = createLogger(LogPrefix.SESSION)

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true
  if (err instanceof Error && err.name === 'AbortError') return true
  return false
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Types ──────────────────────────────────────────────────────

type EventCallback = (event: OpenCodeEvent) => void

// ── State ──────────────────────────────────────────────────────

const callbacks = new Map<string, EventCallback>()
let loopRunning = false
let disposed = false
let controller: AbortController | null = null

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
  controller?.abort()
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

/** Resolve getOpencodeServerBaseUrl lazily to break circular dep. */
let _getBaseUrl: (() => string | null) | null = null

async function resolveBaseUrlGetter(): Promise<() => string | null> {
  if (_getBaseUrl) return _getBaseUrl
  const mod = await import('../opencode.js')
  _getBaseUrl = mod.getOpencodeServerBaseUrl
  return _getBaseUrl
}

function createGlobalClient(baseUrl: string): OpencodeClient {
  return createOpencodeClient({ baseUrl })
}

function dispatchEvent(globalEvent: GlobalEvent): void {
  const payload = globalEvent.payload as OpenCodeEvent
  for (const callback of callbacks.values()) {
    callback(payload)
  }
}

async function runEventLoop(): Promise<void> {
  const getBaseUrl = await resolveBaseUrlGetter()

  let backoffMs = 500
  const maxBackoffMs = 30_000

  while (!disposed) {
    controller = new AbortController()
    const signal = controller.signal

    const baseUrl = getBaseUrl()
    if (!baseUrl) {
      if (callbacks.size === 0) {
        logger.log('[GLOBAL LISTENER] No registrations, pausing')
        loopRunning = false
        return
      }
      logger.warn(
        `[GLOBAL LISTENER] No OpenCode server available, retrying in ${backoffMs}ms`,
      )
      await delay(backoffMs)
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
      continue
    }

    const client = createGlobalClient(baseUrl)

    const subscribeResult = await client.global.event({ signal })
      .catch((e: Error) => e)

    if (subscribeResult instanceof Error) {
      if (isAbortError(subscribeResult)) {
        if (disposed) return
        backoffMs = 500
        continue
      }
      logger.warn(
        `[GLOBAL LISTENER] Subscribe failed, retrying in ${backoffMs}ms:`,
        subscribeResult.message,
      )
      await delay(backoffMs)
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
      continue
    }

    const events = subscribeResult.stream

    logger.log('[GLOBAL LISTENER] Connected to global event stream')

    let receivedAnyEvent = false
    const iterResult = await (async () => {
      for await (const event of events) {
        receivedAnyEvent = true
        dispatchEvent(event)
      }
    })()
      .catch((e: Error) => e)

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
      await delay(backoffMs)
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
    } else {
      logger.log(
        `[GLOBAL LISTENER] Stream ended normally, reconnecting in ${backoffMs}ms`,
      )
      await delay(backoffMs)
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
    }
  }
}
