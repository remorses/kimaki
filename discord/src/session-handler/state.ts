// Session handler run-state transitions.
// Centralizes prompt/idle race state so interrupt handling stays consistent.
//
// Pure transition functions: `(state: MainRunState) => MainRunState`
// Used by the runtime via `updateRunState(threadId, pureTransition)`.
//
// STATE DISCIPLINE: keep as little state as possible. Before adding any new
// state field, ask if it can be derived from existing state instead.

export type MainRunPhase =
  | 'waiting-dispatch'
  | 'collecting-baseline'
  | 'dispatching'
  | 'prompt-resolved'
  | 'finished'
  | 'aborted'

export type MainIdleState = 'none' | 'deferred'

export type MainRunState = {
  // The current lifecycle phase of the prompt run. Transitions:
  //   waiting-dispatch → collecting-baseline → dispatching → prompt-resolved → finished
  //   aborted can be reached from any phase except finished.
  // "collecting-baseline" fetches existing assistant message IDs before dispatch
  // so the event handler can distinguish old messages from new ones.
  // "dispatching" means the SDK call (session.prompt) is in-flight.
  // "prompt-resolved" means the SDK call returned but session.idle hasn't arrived yet.
  // Changes: on every phase transition via pure transition functions.
  // Read by: isRunActive(), canDispatchNext(), event handlers, finishRun.
  phase: MainRunPhase

  // Handles the race between session.idle (SSE event) and the SDK call returning.
  // If session.idle arrives while phase is not yet 'prompt-resolved' (e.g. still
  // 'dispatching' or 'collecting-baseline'), it can't be processed yet, so idleState
  // is set to 'deferred'. When the SDK call returns and phase transitions to
  // 'prompt-resolved', the deferred idle is consumed.
  // Changes: set to 'deferred' by pureHandleMainSessionIdle, cleared to 'none' on consume.
  // Read by: pureMarkPromptResolvedAndConsumeDeferredIdle.
  idleState: MainIdleState

  // Set of assistant message IDs that existed BEFORE the current prompt was dispatched.
  // Populated during 'collecting-baseline' phase by fetching the session's messages.
  // Used to filter out old parts in the SSE stream — only parts from NEW messages
  // (not in this set) are treated as evidence of the current prompt's response.
  // Changes: set once during collecting-baseline, cleared on next pureBeginPromptCycle.
  baselineAssistantIds: Set<string>

  // The OpenCode assistant message ID for the current prompt's response.
  // Set when the first non-baseline assistant message update arrives
  // (pureMarkCurrentPromptEvidence called from the message event handler).
  // Used to: (a) confirm that the prompt produced output, (b) route parts to the
  // correct Discord message, (c) gate session.idle processing (no evidence = ignore idle).
  // Changes: set on first evidence message, cleared on next pureBeginPromptCycle.
  currentAssistantMessageId: string | undefined

  // Monotonically incrementing counter for ordering SSE events within a run.
  // Incremented by pureMarkCurrentPromptEvidence (message update path) and
  // pureHandleMainSessionIdle (idle path). Used to determine whether a
  // deferred idle arrived before or after the first evidence message.
  // Changes: incremented on message-update evidence and idle events.
  eventSeq: number

  // The eventSeq value when the first evidence (new assistant message) was seen.
  // undefined until evidence arrives. Used to filter stale deferred idles:
  // if deferredIdleSeq <= evidenceSeq, the idle arrived before any output
  // and is ignored (the model will send another idle when truly done).
  // Changes: set once on first evidence, cleared on next pureBeginPromptCycle.
  evidenceSeq: number | undefined

  // The eventSeq value when a deferred idle was recorded (idleState='deferred').
  // Compared against evidenceSeq to decide if the deferred idle is stale.
  // Changes: set when idle is deferred, cleared when consumed or on reset.
  deferredIdleSeq: number | undefined
}

export type MainSessionIdleDecision =
  | 'deferred'
  | 'ignore-no-evidence'
  | 'ignore-inactive-phase'
  | 'process'

export type DeferredIdleDecision =
  | 'none'
  | 'ignore-no-evidence'
  | 'ignore-before-evidence'
  | 'process'

export function initialMainRunState(): MainRunState {
  return {
    phase: 'waiting-dispatch',
    idleState: 'none',
    baselineAssistantIds: new Set<string>(),
    currentAssistantMessageId: undefined,
    eventSeq: 0,
    evidenceSeq: undefined,
    deferredIdleSeq: undefined,
  }
}

// ── Pure transition functions ────────────────────────────────────
// Take MainRunState, return new MainRunState. No side effects.
// Used by updateRunState(threadId, transition) in the runtime.

export function pureBeginPromptCycle(state: MainRunState): MainRunState {
  return {
    ...state,
    phase: 'collecting-baseline',
    idleState: 'none',
    baselineAssistantIds: new Set<string>(),
    currentAssistantMessageId: undefined,
    eventSeq: 0,
    evidenceSeq: undefined,
    deferredIdleSeq: undefined,
  }
}

export function pureSetBaselineAssistantIds(
  state: MainRunState,
  messageIds: Set<string>,
): MainRunState {
  return {
    ...state,
    baselineAssistantIds: new Set<string>(messageIds),
  }
}

export function pureMarkDispatching(state: MainRunState): MainRunState {
  return {
    ...state,
    phase: 'dispatching',
  }
}

export function pureMarkCurrentPromptEvidence(
  state: MainRunState,
  messageId: string,
): MainRunState {
  const eventSeq = state.eventSeq + 1
  const canTrackCurrentPrompt =
    state.phase === 'dispatching' || state.phase === 'prompt-resolved'
  if (!canTrackCurrentPrompt) {
    return {
      ...state,
      eventSeq,
    }
  }
  if (state.baselineAssistantIds.has(messageId)) {
    return {
      ...state,
      eventSeq,
    }
  }
  return {
    ...state,
    eventSeq,
    currentAssistantMessageId: messageId,
    evidenceSeq: state.evidenceSeq ?? eventSeq,
  }
}

/**
 * Pure version of handleMainSessionIdle.
 * Returns both the new state and the decision, since the caller needs both.
 */
export function pureHandleMainSessionIdle(
  state: MainRunState,
): { state: MainRunState; decision: MainSessionIdleDecision } {
  if (
    state.phase === 'waiting-dispatch' ||
    state.phase === 'finished' ||
    state.phase === 'aborted'
  ) {
    return {
      state,
      decision: 'ignore-inactive-phase',
    }
  }

  const idleSeq = state.eventSeq + 1

  if (state.phase !== 'prompt-resolved') {
    return {
      state: {
        ...state,
        eventSeq: idleSeq,
        idleState: 'deferred',
        deferredIdleSeq: idleSeq,
      },
      decision: 'deferred',
    }
  }

  if (!state.currentAssistantMessageId) {
    return {
      state: {
        ...state,
        eventSeq: idleSeq,
      },
      decision: 'ignore-no-evidence',
    }
  }

  return {
    state: {
      ...state,
      eventSeq: idleSeq,
    },
    decision: 'process',
  }
}

/**
 * Pure version of markPromptResolvedAndConsumeDeferredIdle.
 * Returns both the new state and the decision.
 */
export function pureMarkPromptResolvedAndConsumeDeferredIdle(
  state: MainRunState,
): { state: MainRunState; decision: DeferredIdleDecision } {
  const nextState: MainRunState = {
    ...state,
    phase: 'prompt-resolved',
  }

  if (state.idleState !== 'deferred') {
    return { state: nextState, decision: 'none' }
  }

  const resolvedState: MainRunState = {
    ...nextState,
    idleState: 'none',
    deferredIdleSeq: undefined,
  }

  if (!state.currentAssistantMessageId) {
    return { state: resolvedState, decision: 'ignore-no-evidence' }
  }

  if (
    typeof state.deferredIdleSeq === 'number' &&
    typeof state.evidenceSeq === 'number' &&
    state.deferredIdleSeq <= state.evidenceSeq
  ) {
    return { state: resolvedState, decision: 'ignore-before-evidence' }
  }

  return { state: resolvedState, decision: 'process' }
}

export function pureMarkFinished(state: MainRunState): MainRunState {
  return {
    ...state,
    phase: 'finished',
  }
}

export function pureMarkAborted(state: MainRunState): MainRunState {
  if (state.phase === 'finished') {
    return state
  }
  return {
    ...state,
    phase: 'aborted',
  }
}

export function pureHasCurrentPromptEvidence(state: MainRunState): boolean {
  return Boolean(state.currentAssistantMessageId)
}
