// Per-thread state type, transition functions, and selectors.
// All transitions operate on the global store from ../store.js.
//
// ThreadRunState is a value-type: one entry per active thread in the
// global store's `threads` Map. Transition functions produce new Map +
// new ThreadRunState objects each time (immutable updates).
//
// Derived helpers (queue checks) compute from state and are never
// stored — they are always re-derived from ThreadRunState.
//
// STATE DISCIPLINE: keep as little state as possible. Before adding any new
// state field, ask if it can be derived from existing state instead.

import type { DiscordFileAttachment } from '../message-formatting.js'
import type { PermissionRuleset } from '@opencode-ai/sdk/v2'
import type { RepliedMessageContext } from '../system-message.js'
import { store } from '../store.js'

// ── Shared types ─────────────────────────────────────────────────

export type QueuedMessage = {
  // The text content to send to the OpenCode session (user message or
  // transcribed voice message). Always present.
  prompt: string
  // Discord user ID of the message author. Used for permission checks
  // and attribution in the session start source tracking.
  userId: string
  // Discord display name. Used in runtime drain logging.
  username: string
  // Image/file attachments extracted from the Discord message. Sent as
  // file parts alongside the prompt in the SDK call.
  images?: DiscordFileAttachment[]
  // Bot application ID. Used for model-preference resolution fallback
  // (looking up channel/session model overrides keyed by appId).
  appId?: string
  // When set, dispatches via session.command() instead of session.prompt().
  // Used by /queue-command and user-defined slash commands.
  command?: { name: string; arguments: string }
  // First-dispatch-only overrides — used when creating a new session.
  // Subsequent queue drains ignore these since the session already exists.
  // Set by --agent/--model/--permission flags on kimaki send or slash commands.
  agent?: string
  model?: string
  // Raw permission rule strings ("tool:action" or "tool:pattern:action").
  // Parsed and merged into session permissions on creation.
  permissions?: string[]
  // Already-resolved permission rules discovered at message ingress, for
  // example #channel project directory references.
  permissionRules?: PermissionRuleset
  // Injection guard scan patterns (e.g. "bash:*", "webfetch:*").
  // Written to a temp config file after session creation so the plugin
  // can check per-session whether to scan tool outputs.
  injectionGuardPatterns?: string[]
  // Discord message ID and thread ID of the source message. Embedded in
  // <discord-user> synthetic context so the external sync loop can detect
  // messages that originated from Discord and skip re-mirroring them.
  sourceMessageId?: string
  sourceThreadId?: string
  repliedMessage?: RepliedMessageContext
  // Tracking fields for scheduled tasks. Stored in the DB via
  // setSessionStartSource() after the session is created, so the session
  // list can show which sessions were started by scheduled tasks.
  sessionStartScheduleKind?: 'at' | 'cron'
  sessionStartScheduledTaskId?: number
}

// ── Per-thread state (value inside the Map) ──────────────────────

export type ThreadRunState = {
  // OpenCode session ID for this thread. Set lazily by ensureSession()
  // on first dispatch (not on thread creation). Persists across multiple
  // prompt runs — the same session is reused for the thread's lifetime.
  // Also stored in the DB (thread_sessions table) for recovery after restart.
  // Changes: set on first dispatch, may be re-set if the old session is
  // invalid and a new one is created. Never cleared except on dispose.
  // Read by: dispatchPrompt, ensureSession, abortSessionViaApi, footer.
  sessionId: string | undefined

  // Stable first author for this thread runtime. Used for session-stable
  // system prompt examples like `kimaki send --user ...` so notifications keep
  // working without changing the cached system prompt on every follow-up.
  sessionUsername: string | undefined
  sessionUserId: string | undefined

  // FIFO queue of pending inputs waiting for kimaki-local dispatch.
  // Normal user messages default to opencode queue mode; this queue is
  // for explicit local-queue flows (for example /queue).
  // Changes: enqueueItem (append), dequeueItem (head removal),
  // clearQueueItems, removeQueueItemAtPosition.
  // Read by: runtime queue gating, hasQueue helpers, /queue command display.
  queueItems: QueuedMessage[]

  // Output dedup: tracks which part IDs have already been sent to Discord.
  // Prevents resending the same tool output or text part on SSE reconnect.
  // Lives at thread level because it accumulates
  // across runs for the runtime's lifetime — never reset per-run.
  // Changes: bootstrapped from DB on session resume, added on each part
  // sent to Discord, removed on send failure, also updated in subtask flows.
  // Read by: handleMainPart() dedup check, subtask routing.
  sentPartIds: Set<string>
}

// ── Initial state factory ────────────────────────────────────────

export function initialThreadState(): ThreadRunState {
  return {
    sessionId: undefined,
    sessionUsername: undefined,
    sessionUserId: undefined,
    queueItems: [],
    sentPartIds: new Set(),
  }
}

// ── Derived helpers (compute, never store) ───────────────────────

export function hasQueue(t: ThreadRunState): boolean {
  return t.queueItems.length > 0
}

// ── Pure transition helpers ──────────────────────────────────────
// Immutable: produces new Map + new ThreadRunState object each time.

export function updateThread(
  threadId: string,
  updater: (t: ThreadRunState) => ThreadRunState,
): void {
  store.setState((s) => {
    const existing = s.threads.get(threadId)
    if (!existing) {
      return s
    }
    const newThreads = new Map(s.threads)
    newThreads.set(threadId, updater(existing))
    return { threads: newThreads }
  })
}

export function ensureThread(threadId: string): void {
  if (store.getState().threads.has(threadId)) {
    return
  }
  store.setState((s) => {
    const newThreads = new Map(s.threads)
    newThreads.set(threadId, initialThreadState())
    return { threads: newThreads }
  })
}

export function removeThread(threadId: string): void {
  store.setState((s) => {
    if (!s.threads.has(threadId)) {
      return s
    }
    const newThreads = new Map(s.threads)
    newThreads.delete(threadId)
    return { threads: newThreads }
  })
}

export function setSessionId(threadId: string, sessionId: string): void {
  updateThread(threadId, (t) => ({ ...t, sessionId }))
}

export function setSessionUsername(threadId: string, username: string): void {
  updateThread(threadId, (t) => {
    if (t.sessionUsername) {
      return t
    }
    return { ...t, sessionUsername: username }
  })
}

export function setSessionUserId(threadId: string, userId: string): void {
  updateThread(threadId, (t) => {
    if (t.sessionUserId) {
      return t
    }
    return { ...t, sessionUserId: userId }
  })
}

export function enqueueItem(threadId: string, item: QueuedMessage): void {
  updateThread(threadId, (t) => ({
    ...t,
    queueItems: [...t.queueItems, item],
  }))
}

// Atomic dequeue: read + write in one setState call to prevent
// a concurrent enqueue between read and write from losing items.
export function dequeueItem(threadId: string): QueuedMessage | undefined {
  let next: QueuedMessage | undefined
  store.setState((s) => {
    const t = s.threads.get(threadId)
    if (!t || t.queueItems.length === 0) {
      return s
    }
    const [head, ...rest] = t.queueItems
    next = head
    const newThreads = new Map(s.threads)
    newThreads.set(threadId, { ...t, queueItems: rest })
    return { threads: newThreads }
  })
  return next
}

export function clearQueueItems(threadId: string): void {
  updateThread(threadId, (t) => ({ ...t, queueItems: [] }))
}

export function removeQueueItemAtPosition(
  threadId: string,
  position: number,
): QueuedMessage | undefined {
  if (position < 1) {
    return undefined
  }

  let removedItem: QueuedMessage | undefined
  store.setState((s) => {
    const t = s.threads.get(threadId)
    if (!t) {
      return s
    }

    const index = position - 1
    const removed = t.queueItems[index]
    if (!removed) {
      return s
    }

    removedItem = removed
    const newThreads = new Map(s.threads)
    newThreads.set(threadId, {
      ...t,
      queueItems: t.queueItems.filter((_, itemIndex) => {
        return itemIndex !== index
      }),
    })
    return { threads: newThreads }
  })
  return removedItem
}

/**
 * Find a queued item by its Discord source message ID and apply an updater.
 * If the updater returns null, the item is removed from the queue.
 * Returns the original (pre-update) item, or undefined if not found.
 */
export function updateQueueItemBySourceMessageId(
  threadId: string,
  sourceMessageId: string,
  updater: (item: QueuedMessage) => QueuedMessage | null,
): QueuedMessage | undefined {
  let originalItem: QueuedMessage | undefined
  store.setState((s) => {
    const t = s.threads.get(threadId)
    if (!t) return s

    const index = t.queueItems.findIndex((item) => {
      return item.sourceMessageId === sourceMessageId
    })
    if (index === -1) return s

    originalItem = t.queueItems[index]!
    const updated = updater(originalItem)

    const newThreads = new Map(s.threads)
    newThreads.set(threadId, {
      ...t,
      queueItems: updated === null
        ? t.queueItems.filter((_, i) => i !== index)
        : t.queueItems.map((item, i) => (i === index ? updated : item)),
    })
    return { threads: newThreads }
  })
  return originalItem
}

// ── Queries ──────────────────────────────────────────────────────

export function getThreadState(threadId: string): ThreadRunState | undefined {
  return store.getState().threads.get(threadId)
}

export function getThreadIds(): string[] {
  return [...store.getState().threads.keys()]
}
