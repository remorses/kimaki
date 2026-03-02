// Tests pure session run-state transitions for idle/evidence race handling.

import { describe, expect, test } from 'vitest'
import {
  initialMainRunState,
  pureHandleMainSessionIdle,
  pureMarkCurrentPromptEvidence,
  pureMarkDispatching,
  pureMarkPromptResolvedAndConsumeDeferredIdle,
} from './state.js'

describe('session state transitions', () => {
  test('ignores deferred idle that arrived before evidence', () => {
    let state = initialMainRunState()
    state = pureMarkDispatching(state)

    const deferred = pureHandleMainSessionIdle(state)
    expect(deferred.decision).toBe('deferred')

    state = pureMarkCurrentPromptEvidence(deferred.state, 'assistant-msg-1')
    const consumed = pureMarkPromptResolvedAndConsumeDeferredIdle(state)

    expect(consumed.decision).toBe('ignore-before-evidence')
    expect(consumed.state.phase).toBe('prompt-resolved')
    expect(consumed.state.idleState).toBe('none')
    expect(consumed.state.deferredIdleSeq).toBeUndefined()
  })

  test('processes deferred idle when evidence arrived before idle', () => {
    let state = initialMainRunState()
    state = pureMarkDispatching(state)
    state = pureMarkCurrentPromptEvidence(state, 'assistant-msg-1')

    const deferred = pureHandleMainSessionIdle(state)
    expect(deferred.decision).toBe('deferred')

    const consumed = pureMarkPromptResolvedAndConsumeDeferredIdle(deferred.state)
    expect(consumed.decision).toBe('process')
    expect(consumed.state.phase).toBe('prompt-resolved')
    expect(consumed.state.idleState).toBe('none')
  })

  test('ignores deferred idle when no current prompt evidence exists', () => {
    let state = initialMainRunState()
    state = pureMarkDispatching(state)

    const deferred = pureHandleMainSessionIdle(state)
    expect(deferred.decision).toBe('deferred')

    const consumed = pureMarkPromptResolvedAndConsumeDeferredIdle(deferred.state)
    expect(consumed.decision).toBe('ignore-no-evidence')
    expect(consumed.state.phase).toBe('prompt-resolved')
    expect(consumed.state.currentAssistantMessageId).toBeUndefined()
  })
})
