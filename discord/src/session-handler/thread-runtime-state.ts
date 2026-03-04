// Per-thread state type, transition functions, and selectors.
// All transitions operate on the global store from ../store.js.
//
// ThreadRunState is a value-type: one entry per active thread in the
// global store's `threads` Map. Transition functions produce new Map +
// new ThreadRunState objects each time (immutable updates).
//
// Derived helpers (queue/blocker checks) compute from state and are never
// stored — they are always re-derived from ThreadRunState.
//
// STATE DISCIPLINE: keep as little state as possible. Before adding any new
// state field, ask if it can be derived from existing state instead.

import type { DiscordFileAttachment } from '../message-formatting.js'
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
  // Set by --agent/--model flags on kimaki send or slash commands.
  agent?: string
  model?: string
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

  // FIFO queue of pending inputs waiting for kimaki-local dispatch.
  // Normal user messages default to opencode queue mode; this queue is
  // for explicit local-queue flows (for example /queue).
  // Changes: enqueueItem (append), dequeueItem (head removal), clearQueueItems.
  // Read by: runtime queue gating, hasQueue helpers, /queue command display.
  queueItems: QueuedMessage[]

  // Blockers prevent the queue from draining while the user is being
  // asked an interactive question. Runtime dispatch gating checks these
  // blockers before dequeuing. Each blocker maps to a specific Discord UI:
  blockers: {
    // Number of pending permission dialogs (Accept/Deny buttons) in this
    // thread. Incremented when showPermissionButtons sends a message,
    // decremented when the user clicks or when a permission response arrives.
    permissionCount: number
    // Number of pending AskUserQuestion dropdowns in this thread.
    // Incremented when dropdowns are shown, decremented when all answered
    // or cancelled.
    questionCount: number
    // True while action buttons (from kimaki_action_buttons tool) are
    // shown and awaiting the user's click. Set false on click or cancel.
    actionButtonsPending: boolean
    // True while a file upload modal (from kimaki_file_upload tool) is
    // shown and awaiting the user's submission. Set false on submit or cancel.
    fileUploadPending: boolean
  }

  // Listener lifetime controller — scoped to the entire runtime lifetime,
  // NOT per-prompt. Only aborted on dispose() or fatal error. Run abort
  // never kills the listener — the SSE event loop stays alive across runs
  // so subsequent prompts reuse the same listener.
  // Changes: created in constructor, aborted only on dispose.
  listenerController: AbortController | undefined

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
    queueItems: [],
    blockers: {
      permissionCount: 0,
      questionCount: 0,
      actionButtonsPending: false,
      fileUploadPending: false,
    },
    listenerController: undefined,
    sentPartIds: new Set(),
  }
}

// ── Derived helpers (compute, never store) ───────────────────────

export function hasQueue(t: ThreadRunState): boolean {
  return t.queueItems.length > 0
}

export function hasBlockers(t: ThreadRunState): boolean {
  const b = t.blockers
  return (
    b.permissionCount > 0 ||
    b.questionCount > 0 ||
    b.actionButtonsPending ||
    b.fileUploadPending
  )
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

// ── Blocker transitions ──────────────────────────────────────────

export function incrementBlocker(
  threadId: string,
  blocker: 'permissionCount' | 'questionCount',
): void {
  updateThread(threadId, (t) => ({
    ...t,
    blockers: { ...t.blockers, [blocker]: t.blockers[blocker] + 1 },
  }))
}

export function decrementBlocker(
  threadId: string,
  blocker: 'permissionCount' | 'questionCount',
): void {
  updateThread(threadId, (t) => ({
    ...t,
    blockers: { ...t.blockers, [blocker]: Math.max(0, t.blockers[blocker] - 1) },
  }))
}

export function setBlockerFlag(
  threadId: string,
  flag: 'actionButtonsPending' | 'fileUploadPending',
  value: boolean,
): void {
  updateThread(threadId, (t) => ({
    ...t,
    blockers: { ...t.blockers, [flag]: value },
  }))
}

// ── Queries ──────────────────────────────────────────────────────

export function getThreadState(threadId: string): ThreadRunState | undefined {
  return store.getState().threads.get(threadId)
}

export function getThreadIds(): string[] {
  return [...store.getState().threads.keys()]
}
