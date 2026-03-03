// Tests for the simplified session run-state transitions.

import { describe, expect, test } from 'vitest'
import {
  initialMainRunState,
  pureMarkRunning,
  pureMarkIdle,
  pureRegisterAssistantMessage,
} from './state.js'

describe('session state transitions', () => {
  test('initial state is idle with no assistant', () => {
    const state = initialMainRunState()
    expect(state.phase).toBe('idle')
    expect(state.latestAssistantMessageId).toBeUndefined()
    expect(state.assistantMessageIds.size).toBe(0)
  })

  test('pureMarkRunning resets to running with no assistant', () => {
    let state = initialMainRunState()
    state = pureMarkRunning(state)
    state = pureRegisterAssistantMessage(state, 'old-msg')
    // Starting a new run should clear the assistant
    state = pureMarkRunning(state)
    expect(state.phase).toBe('running')
    expect(state.latestAssistantMessageId).toBeUndefined()
    expect(state.assistantMessageIds.size).toBe(0)
  })

  test('pureMarkIdle resets to idle with no assistant', () => {
    let state = initialMainRunState()
    state = pureMarkRunning(state)
    state = pureRegisterAssistantMessage(state, 'msg-1')
    state = pureMarkIdle(state)
    expect(state.phase).toBe('idle')
    expect(state.latestAssistantMessageId).toBeUndefined()
    expect(state.assistantMessageIds.size).toBe(0)
  })

  test('pureRegisterAssistantMessage tracks message during running phase', () => {
    let state = initialMainRunState()
    state = pureMarkRunning(state)
    state = pureRegisterAssistantMessage(state, 'assistant-msg-1')
    expect(state.latestAssistantMessageId).toBe('assistant-msg-1')
    expect(state.assistantMessageIds.has('assistant-msg-1')).toBe(true)
  })

  test('pureRegisterAssistantMessage ignores during idle phase', () => {
    let state = initialMainRunState()
    state = pureRegisterAssistantMessage(state, 'assistant-msg-1')
    expect(state.latestAssistantMessageId).toBeUndefined()
    expect(state.assistantMessageIds.size).toBe(0)
  })

  test('pureRegisterAssistantMessage tracks multiple assistants and latest', () => {
    let state = initialMainRunState()
    state = pureMarkRunning(state)
    state = pureRegisterAssistantMessage(state, 'first-msg')
    state = pureRegisterAssistantMessage(state, 'second-msg')
    expect(state.latestAssistantMessageId).toBe('second-msg')
    expect(state.assistantMessageIds.has('first-msg')).toBe(true)
    expect(state.assistantMessageIds.has('second-msg')).toBe(true)
  })
})
