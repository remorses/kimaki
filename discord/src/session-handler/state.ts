// Session handler run-state transitions.
// Centralizes prompt/idle race state so interrupt handling stays consistent.
//
// Pure transition functions: `(state: MainRunState) => MainRunState`
// Used by the runtime via `updateRunState(threadId, pureTransition)`.

export type MainRunPhase =
  | 'waiting-dispatch'
  | 'collecting-baseline'
  | 'dispatching'
  | 'prompt-resolved'
  | 'finished'
  | 'aborted'

export type MainIdleState = 'none' | 'deferred'

export type MainRunState = {
  phase: MainRunPhase
  idleState: MainIdleState
  baselineAssistantIds: Set<string>
  currentAssistantMessageId: string | undefined
  eventSeq: number
  evidenceSeq: number | undefined
  deferredIdleSeq: number | undefined
}

export type MainSessionIdleDecision =
  | 'deferred'
  | 'ignore-no-evidence'
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

