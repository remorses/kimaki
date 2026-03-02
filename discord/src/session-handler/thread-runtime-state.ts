// Per-thread state type, transition functions, and selectors.
// All transitions operate on the global store from ../store.js.
//
// ThreadRunState is a value-type: one entry per active thread in the
// global store's `threads` Map. Transition functions produce new Map +
// new ThreadRunState objects each time (immutable updates).
//
// Derived helpers (isRunActive, canDispatchNext, etc.) compute from state
// and are never stored — they are always re-derived from ThreadRunState.

import type { DiscordFileAttachment } from '../message-formatting.js'
import { store } from '../store.js'
import type { MainRunState } from './state.js'

// ── Shared types ─────────────────────────────────────────────────

export type QueuedMessage = {
  prompt: string
  userId: string
  username: string
  queuedAt: number
  images?: DiscordFileAttachment[]
  appId?: string
  /** If set, uses session.command API instead of session.prompt */
  command?: { name: string; arguments: string }
  // First-dispatch-only overrides (used when creating a new session).
  // Subsequent queue drains ignore these since the session already exists.
  agent?: string
  model?: string
  sessionStartScheduleKind?: 'at' | 'cron'
  sessionStartScheduledTaskId?: number
}

// ── Per-run info (present while a prompt is in-flight) ───────────

export type SubtaskInfo = {
  label: string
  assistantMessageId: string | undefined
}

export type CurrentRunInfo = {
  model: string | undefined
  providerID: string | undefined
  agent: string | undefined
  tokensUsed: number
  dispatchStartTime: number
  // UI throttle state (per-run, reset on each dispatch)
  lastDisplayedContextPercentage: number
  lastRateLimitDisplayTime: number
  // Subtask routing: child sessionId → label + message tracking
  subtaskSessions: Map<string, SubtaskInfo>
  agentSpawnCounts: Record<string, number>
}

export function initialCurrentRunInfo(): CurrentRunInfo {
  return {
    model: undefined,
    providerID: undefined,
    agent: undefined,
    tokensUsed: 0,
    dispatchStartTime: Date.now(),
    lastDisplayedContextPercentage: 0,
    lastRateLimitDisplayTime: 0,
    subtaskSessions: new Map(),
    agentSpawnCounts: {},
  }
}

// ── Per-thread state (value inside the Map) ──────────────────────

export type ThreadRunState = {
  sessionId: string | undefined
  queueItems: QueuedMessage[]
  blockers: {
    permissionCount: number
    questionCount: number
    actionButtonsPending: boolean
    fileUploadPending: boolean
  }
  // Run lifecycle state (previously a separate MainRunStore).
  // Embedded here so one store is the single source of truth.
  runState: MainRunState
  // Per-prompt abort controller. Kept in store so any code with a
  // threadId can abort without needing a runtime instance reference
  // (e.g. /abort command just does getThreadState(id)?.runController?.abort()).
  runController: AbortController | undefined
  // Listener lifetime controller — only aborted on dispose or fatal error.
  // Run abort never kills the listener. Kept in store so lifecycle is
  // observable without needing the runtime class instance.
  listenerController: AbortController | undefined
  // Per-run state, present when a prompt is in-flight.
  // undefined when no run is active (waiting-dispatch/finished/aborted).
  currentRun: CurrentRunInfo | undefined
  // Output dedup: tracks which part IDs have been sent to Discord.
  // Lives at thread level (not in currentRun) because it accumulates
  // across runs for the lifetime of the runtime — never reset per-run.
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
    runState: {
      phase: 'waiting-dispatch',
      idleState: 'none',
      baselineAssistantIds: new Set<string>(),
      currentAssistantMessageId: undefined,
      eventSeq: 0,
      evidenceSeq: undefined,
      deferredIdleSeq: undefined,
    },
    runController: undefined,
    listenerController: undefined,
    currentRun: undefined,
    sentPartIds: new Set(),
  }
}

// ── Derived helpers (compute, never store) ───────────────────────

export function isRunActive(t: ThreadRunState): boolean {
  const phase = t.runState.phase
  return (
    phase === 'collecting-baseline' ||
    phase === 'dispatching' ||
    phase === 'prompt-resolved'
  )
}

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

// sessionId is NOT required here — ensureSession() creates it lazily
// inside dispatchPrompt(). Requiring it would deadlock the first message.
export function canDispatchNext(t: ThreadRunState): boolean {
  return hasQueue(t) && !isRunActive(t) && !hasBlockers(t)
}

export function isBusy(t: ThreadRunState): boolean {
  return isRunActive(t) || hasQueue(t) || hasBlockers(t)
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

export function setRunController(
  threadId: string,
  controller: AbortController | undefined,
): void {
  updateThread(threadId, (t) => ({ ...t, runController: controller }))
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

// ── Run state transitions ────────────────────────────────────────

export function updateRunState(
  threadId: string,
  updater: (rs: MainRunState) => MainRunState,
): void {
  updateThread(threadId, (t) => ({
    ...t,
    runState: updater(t.runState),
  }))
}

// ── Queries ──────────────────────────────────────────────────────

export function getThreadState(threadId: string): ThreadRunState | undefined {
  return store.getState().threads.get(threadId)
}

export function getThreadIds(): string[] {
  return [...store.getState().threads.keys()]
}
