// Tests the pure v2 message completion check used by session waiting.

import { describe, expect, test } from 'vitest'
import type { SessionMessageInfo, V2Event } from '@opencode/client'
import { hasCompletedUserTurn } from './wait-session.js'
import type { EventBufferEntry } from './session-handler/event-stream-state.js'

const sessionId = 'ses_wait'

function user(created: number): SessionMessageInfo {
  return {
    id: `user-${created}`,
    type: 'user',
    text: 'request',
    time: { created },
  }
}

function assistant({
  created,
  finish = 'stop',
  text = 'done',
  error,
  toolStatus = 'completed',
  completed = true,
}: {
  created: number
  finish?: 'stop' | 'tool-calls' | 'error'
  text?: string
  error?: { type: string; message: string }
  toolStatus?: 'completed' | 'error' | 'running'
  completed?: boolean
}): SessionMessageInfo {
  return {
    id: `assistant-${created}`,
    type: 'assistant',
    agent: 'build',
    model: { providerID: 'test', id: 'model' },
    time: { created, ...(completed && { completed: created + 1 }) },
    content: text
      ? [{ type: 'text', text }]
      : [{
          type: 'tool',
          id: 'tool-1',
          name: 'read',
          time: { created },
          state: toolStatus === 'completed'
            ? {
                status: 'completed',
                input: {},
                content: [{ type: 'text', text: 'tool output' }],
              }
            : toolStatus === 'error'
              ? {
                  status: 'error',
                  input: {},
                  error: { type: 'ToolError', message: 'tool failed' },
                }
              : { status: 'running', input: {}, metadata: {} },
        }],
    finish,
    error,
  }
}

function executionEvent(
  type: 'session.execution.succeeded' | 'session.execution.failed' | 'session.execution.interrupted',
  created = 30,
): V2Event {
  const common = {
    id: `evt-${type}`,
    created,
    durable: { aggregateID: sessionId, seq: 1, version: 1 as const },
  }
  if (type === 'session.execution.succeeded') {
    return { ...common, type, data: { sessionID: sessionId } }
  }
  if (type === 'session.execution.failed') {
    return {
      ...common,
      type,
      data: {
        sessionID: sessionId,
        error: { type: 'ProviderError', message: 'failed' },
      },
    }
  }
  return { ...common, type, data: { sessionID: sessionId, reason: 'user' } }
}

function completionResult({
  messages,
  terminal = 'session.execution.succeeded',
}: {
  messages: SessionMessageInfo[]
  terminal?: Parameters<typeof executionEvent>[0] | null
}) {
  const events: EventBufferEntry[] = terminal
    ? [{ event: executionEvent(terminal), timestamp: 30 }]
    : []
  return hasCompletedUserTurn({
    messages,
    events,
    sessionId,
    waitStartedAtMs: 0,
  })
}

describe('hasCompletedUserTurn', () => {
  test('accepts a natural text completion after the latest user turn', () => {
    expect(
      hasCompletedUserTurn({
        messages: [assistant({ created: 20 }), user(10)],
        events: [{ event: executionEvent('session.execution.succeeded'), timestamp: 30 }],
        sessionId,
        waitStartedAtMs: 10,
      }),
    ).toBe(true)
  })

  test('accepts a successful tool-only terminal execution', () => {
    expect(completionResult({
      messages: [user(10), assistant({ created: 20, finish: 'tool-calls', text: '' })],
    })).toBe(true)
  })

  test('rejects failed and interrupted executions', () => {
    expect(
      completionResult({
        messages: [user(10), assistant({ created: 20, finish: 'error', error: { type: 'Error', message: 'failed' } })],
        terminal: 'session.execution.failed',
      }),
    ).toBe(false)
    expect(
      completionResult({
        messages: [user(10), assistant({ created: 20 })],
        terminal: 'session.execution.interrupted',
      }),
    ).toBe(false)
  })

  test('rejects sessions without a user turn in the wait window', () => {
    expect(
      hasCompletedUserTurn({
        messages: [user(10), assistant({ created: 20 })],
        events: [{ event: executionEvent('session.execution.succeeded'), timestamp: 30 }],
        sessionId,
        waitStartedAtMs: 11,
      }),
    ).toBe(false)
  })

  test('rejects assistant messages that completed before the latest user turn', () => {
    expect(
      completionResult({
        messages: [assistant({ created: 10 }), user(20)],
      }),
    ).toBe(false)
  })

  test('rejects incomplete assistant and tool states', () => {
    expect(completionResult({
      messages: [user(10), assistant({ created: 20, completed: false })],
    })).toBe(false)
    expect(completionResult({
      messages: [user(10), assistant({ created: 20, text: '', toolStatus: 'running' })],
    })).toBe(false)
    expect(completionResult({
      messages: [user(10), assistant({ created: 20, text: '', toolStatus: 'error' })],
    })).toBe(false)
    expect(completionResult({
      messages: [user(10), assistant({ created: 20 })],
      terminal: null,
    })).toBe(false)
    expect(hasCompletedUserTurn({
      messages: [user(10), assistant({ created: 20 })],
      events: [{
        event: executionEvent('session.execution.succeeded', 20),
        timestamp: 20,
      }],
      sessionId,
      waitStartedAtMs: 0,
    })).toBe(false)
  })

  test('uses the latest completed assistant result for the turn', () => {
    expect(
      completionResult({
        messages: [
          user(10),
          assistant({ created: 20 }),
          assistant({
            created: 30,
            finish: 'error',
            error: { type: 'ProviderError', message: 'failed' },
          }),
        ],
      }),
    ).toBe(false)
  })
})
