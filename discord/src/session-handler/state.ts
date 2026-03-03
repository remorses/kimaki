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
//   2. currentAssistantMessageId: which assistant message are we outputting?

export type MainRunPhase = 'idle' | 'running'

export type MainRunState = {
  // 'idle'    — no active run, ready to dispatch next queued message.
  // 'running' — prompt sent, model is producing output.
  phase: MainRunPhase

  // The OpenCode assistant message ID for the current run's response.
  // Set when the first assistant message.updated event arrives during 'running'.
  // Used to route SSE part events to the correct Discord message.
  // Cleared on every new run start (pureMarkRunning) and on finish (pureMarkIdle).
  currentAssistantMessageId: string | undefined
}

export function initialMainRunState(): MainRunState {
  return {
    phase: 'idle',
    currentAssistantMessageId: undefined,
  }
}

// ── Pure transition functions ────────────────────────────────────

export function pureMarkRunning(state: MainRunState): MainRunState {
  return {
    phase: 'running',
    currentAssistantMessageId: undefined,
  }
}

export function pureMarkIdle(_state: MainRunState): MainRunState {
  return {
    phase: 'idle',
    currentAssistantMessageId: undefined,
  }
}

/** Set the current assistant message ID. Only takes effect during 'running'. */
export function pureSetCurrentAssistant(
  state: MainRunState,
  messageId: string,
): MainRunState {
  if (state.phase !== 'running') {
    return state
  }
  // Only set once per run — first new assistant message wins.
  if (state.currentAssistantMessageId) {
    return state
  }
  return {
    ...state,
    currentAssistantMessageId: messageId,
  }
}
