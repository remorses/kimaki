// ThreadSessionRuntime — one per active thread.
// Owns resource handles (listener controller, typing timers, part buffer).
// Delegates all state to the global store via thread-runtime-state.ts transitions.
//
// Phase 1: skeleton with empty method stubs and registry functions.
// Phase 2+ will fill in the event listener loop, dispatch, and event handlers.

import type { ThreadChannel } from 'discord.js'
import * as threadState from './thread-runtime-state.js'

// ── Registry ─────────────────────────────────────────────────────
// Runtime instances are kept in a plain Map (not Zustand — the Map
// is not reactive state, just a lookup for resource handles).

const runtimes = new Map<string, ThreadSessionRuntime>()

export function getRuntime(
  threadId: string,
): ThreadSessionRuntime | undefined {
  return runtimes.get(threadId)
}

export type RuntimeOptions = {
  threadId: string
  thread: ThreadChannel
  projectDirectory: string
  sdkDirectory: string
  channelId?: string
  appId?: string
}

export function getOrCreateRuntime(
  opts: RuntimeOptions,
): ThreadSessionRuntime {
  const existing = runtimes.get(opts.threadId)
  if (existing) {
    // Reconcile sdkDirectory: worktree threads transition from pending
    // (projectDirectory) to ready (worktree path) after runtime creation.
    if (existing.sdkDirectory !== opts.sdkDirectory) {
      existing.sdkDirectory = opts.sdkDirectory
    }
    return existing
  }
  threadState.ensureThread(opts.threadId) // add to global store
  const runtime = new ThreadSessionRuntime(opts)
  runtimes.set(opts.threadId, runtime)
  return runtime
}

export function disposeRuntime(threadId: string): void {
  const runtime = runtimes.get(threadId)
  if (!runtime) {
    return
  }
  runtime.dispose()
  runtimes.delete(threadId)
  threadState.removeThread(threadId) // remove from global store
}

export function disposeRuntimesForDirectory({
  directory,
  channelId,
}: {
  directory: string
  channelId?: string
}): void {
  for (const [threadId, runtime] of runtimes) {
    if (runtime.projectDirectory !== directory) {
      continue
    }
    if (channelId && runtime.channelId !== channelId) {
      continue
    }
    runtime.dispose()
    runtimes.delete(threadId)
    threadState.removeThread(threadId)
  }
}

/** Returns number of active runtimes (useful for diagnostics). */
export function getRuntimeCount(): number {
  return runtimes.size
}

// ── Runtime class ────────────────────────────────────────────────

export class ThreadSessionRuntime {
  readonly threadId: string
  readonly projectDirectory: string
  // Mutable: worktree threads transition from pending (projectDirectory)
  // to ready (worktree path) after creation. getOrCreateRuntime reconciles
  // this on each call so dispatch always uses the current path.
  sdkDirectory: string
  readonly channelId: string | undefined
  readonly appId: string | undefined
  readonly thread: ThreadChannel

  // Resource handles (not in Zustand — operational, not domain state).
  // These will be populated in Phase 2 when the event listener loop is added.
  private listenerController = new AbortController()

  constructor(opts: RuntimeOptions) {
    this.threadId = opts.threadId
    this.projectDirectory = opts.projectDirectory
    this.sdkDirectory = opts.sdkDirectory
    this.channelId = opts.channelId
    this.appId = opts.appId
    this.thread = opts.thread
  }

  // Read own state from global store
  get state(): threadState.ThreadRunState | undefined {
    return threadState.getThreadState(this.threadId)
  }

  // ── Lifecycle ────────────────────────────────────────────────

  dispose(): void {
    this.listenerController.abort()
    this.state?.runController?.abort()
    threadState.setRunController(this.threadId, undefined)
  }

  // ── Stubs for Phase 2+ ──────────────────────────────────────
  // These methods will be filled in during later migration phases.
  // They are declared here so that command handlers can start
  // referencing the runtime API shape.

  // Phase 2: Start persistent event.subscribe loop
  // async startEventListener(): Promise<void> { }

  // Phase 3: Enqueue incoming message/command, optionally interrupting active run
  // async enqueueIncoming(input: IngressInput): Promise<void> { }

  // Phase 3: Abort the currently active run
  // abortActiveRun(reason: string): void { }

  // Phase 4: Retry last user prompt (for model-change flow)
  // async retryLastUserPrompt(): Promise<void> { }
}
