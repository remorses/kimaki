// Tests for the simplified session run-state transitions.

import { describe, expect, test } from 'vitest'
import {
  initialMainRunState,
  pureMarkRunning,
  pureMarkIdle,
  pureSetCurrentAssistant,
} from './state.js'

describe('session state transitions', () => {
  test('initial state is idle with no assistant', () => {
    const state = initialMainRunState()
    expect(state.phase).toBe('idle')
    expect(state.currentAssistantMessageId).toBeUndefined()
  })

  test('pureMarkRunning resets to running with no assistant', () => {
    let state = initialMainRunState()
    state = pureMarkRunning(state)
    state = pureSetCurrentAssistant(state, 'old-msg')
    // Starting a new run should clear the assistant
    state = pureMarkRunning(state)
    expect(state.phase).toBe('running')
    expect(state.currentAssistantMessageId).toBeUndefined()
  })

  test('pureMarkIdle resets to idle with no assistant', () => {
    let state = initialMainRunState()
    state = pureMarkRunning(state)
    state = pureSetCurrentAssistant(state, 'msg-1')
    state = pureMarkIdle(state)
    expect(state.phase).toBe('idle')
    expect(state.currentAssistantMessageId).toBeUndefined()
  })

  test('pureSetCurrentAssistant sets ID during running phase', () => {
    let state = initialMainRunState()
    state = pureMarkRunning(state)
    state = pureSetCurrentAssistant(state, 'assistant-msg-1')
    expect(state.currentAssistantMessageId).toBe('assistant-msg-1')
  })

  test('pureSetCurrentAssistant ignores during idle phase', () => {
    let state = initialMainRunState()
    state = pureSetCurrentAssistant(state, 'assistant-msg-1')
    expect(state.currentAssistantMessageId).toBeUndefined()
  })

  test('pureSetCurrentAssistant keeps first assistant (no overwrite)', () => {
    let state = initialMainRunState()
    state = pureMarkRunning(state)
    state = pureSetCurrentAssistant(state, 'first-msg')
    state = pureSetCurrentAssistant(state, 'second-msg')
    expect(state.currentAssistantMessageId).toBe('first-msg')
  })
})
