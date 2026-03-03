// Session run-state: minimal phase tracking.
//
// The abort→resume race (stale SSE events after abort) is handled by the
// runtime event-wait mechanism in thread-session-runtime.ts, NOT by state fields.
// After an abort, the runtime waits for the actual session.idle SSE event
// before starting the next dispatch — so stale events have already passed
// through by the time the new run begins.
//
// This file only tracks two things:
//   1. phase: is a run active? ('idle' or 'running')
//   2. assistant message routing for the active run.

export type MainRunPhase = 'idle' | 'running'

export type MainRunState = {
  // 'idle'    — no active run, ready to dispatch next queued message.
  // 'running' — prompt sent, model is producing output.
  phase: MainRunPhase

  // Assistant message IDs seen during the active run.
  // A single user turn can produce multiple assistant messages (for example
  // tool-call loops and follow-up generations), so routing by one fixed ID is
  // incorrect. Part updates are valid when their messageID is in this set.
  assistantMessageIds: ReadonlySet<string>

  // Most recently observed assistant message for the active run. Used as a
  // convenience pointer for places that need a "latest" message target.
  // Cleared on every new run start (pureMarkRunning) and on finish (pureMarkIdle).
  latestAssistantMessageId: string | undefined
}

export function initialMainRunState(): MainRunState {
  return {
    phase: 'idle',
    assistantMessageIds: new Set<string>(),
    latestAssistantMessageId: undefined,
  }
}

// ── Pure transition functions ────────────────────────────────────

export function pureMarkRunning(state: MainRunState): MainRunState {
  return {
    phase: 'running',
    assistantMessageIds: new Set<string>(),
    latestAssistantMessageId: undefined,
  }
}

export function pureMarkIdle(_state: MainRunState): MainRunState {
  return {
    phase: 'idle',
    assistantMessageIds: new Set<string>(),
    latestAssistantMessageId: undefined,
  }
}

/**
 * Register an assistant message for the active run.
 * Only takes effect during 'running'.
 */
export function pureRegisterAssistantMessage(
  state: MainRunState,
  messageId: string,
): MainRunState {
  if (state.phase !== 'running') {
    return state
  }

  const alreadyTracked = state.assistantMessageIds.has(messageId)
  if (alreadyTracked && state.latestAssistantMessageId === messageId) {
    return state
  }

  const assistantMessageIds = new Set(state.assistantMessageIds)
  assistantMessageIds.add(messageId)

  return {
    ...state,
    assistantMessageIds,
    latestAssistantMessageId: messageId,
  }
}
