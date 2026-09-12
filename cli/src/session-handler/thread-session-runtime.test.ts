// Tests durable native event recovery and terminal analytics derivation.

import type { V2Event } from '@opencode/client'
import { describe, expect, test } from 'vitest'
import {
  deriveNativeExecutionTerminalAnalytics,
  orderNativeRecoveryEvents,
} from './thread-session-runtime.js'
import type { EventBufferEntry } from './event-stream-state.js'

let eventSequence = 0

function durable(sessionID: string) {
  return {
    aggregateID: sessionID,
    seq: ++eventSequence,
    version: 1 as const,
  }
}

function executionStarted(
  sessionID: string,
  created: number,
): Extract<V2Event, { type: 'session.execution.started' }> {
  return {
    id: `evt_${++eventSequence}`,
    created,
    type: 'session.execution.started',
    durable: durable(sessionID),
    data: { sessionID },
  }
}

function stepStarted(sessionID: string, created: number): V2Event {
  return {
    id: `evt_${++eventSequence}`,
    created,
    type: 'session.step.started',
    durable: durable(sessionID),
    data: {
      sessionID,
      assistantMessageID: 'msg_assistant',
      agent: 'build',
      model: { providerID: 'openai', id: 'gpt-5.3-codex' },
    },
  }
}

function stepEnded(sessionID: string, created: number): V2Event {
  return {
    id: `evt_${++eventSequence}`,
    created,
    type: 'session.step.ended',
    durable: durable(sessionID),
    data: {
      sessionID,
      assistantMessageID: 'msg_assistant',
      finish: 'stop',
      cost: 0.04,
      tokens: {
        input: 10,
        output: 4,
        reasoning: 2,
        cache: { read: 3, write: 1 },
      },
    },
  }
}

function stepFailed(
  sessionID: string,
  created: number,
): Extract<V2Event, { type: 'session.step.failed' }> {
  return {
    id: `evt_${++eventSequence}`,
    created,
    type: 'session.step.failed',
    durable: durable(sessionID),
    data: {
      sessionID,
      assistantMessageID: 'msg_assistant',
      error: { type: 'provider', message: 'Provider failed' },
      cost: 0.04,
      tokens: {
        input: 10,
        output: 4,
        reasoning: 2,
        cache: { read: 3, write: 1 },
      },
    },
  }
}

function terminalEvent({
  sessionID,
  created,
  type,
}: {
  sessionID: string
  created: number
  type:
    | 'session.execution.succeeded'
    | 'session.execution.failed'
    | 'session.execution.interrupted'
}): Extract<V2Event, { type: typeof type }> {
  const common = {
    id: `evt_${++eventSequence}`,
    created,
    durable: durable(sessionID),
  }
  if (type === 'session.execution.failed') {
    return {
      ...common,
      type,
      data: {
        sessionID,
        error: { type: 'provider', message: 'Provider failed' },
      },
    }
  }
  if (type === 'session.execution.interrupted') {
    return {
      ...common,
      type,
      data: { sessionID, reason: 'user' },
    }
  }
  return { ...common, type, data: { sessionID } }
}

describe('native reconnect recovery', () => {
  test('orders ascending main and subagent logs chronologically', () => {
    const mainStart = executionStarted('ses_main', 100)
    const childStart = executionStarted('ses_child', 110)
    const childEnd = terminalEvent({
      sessionID: 'ses_child',
      created: 120,
      type: 'session.execution.succeeded',
    })
    const mainEnd = terminalEvent({
      sessionID: 'ses_main',
      created: 130,
      type: 'session.execution.succeeded',
    })

    expect(orderNativeRecoveryEvents([
      mainStart,
      mainEnd,
      childStart,
      childEnd,
    ]).map((event) => [event.created, event.durable.aggregateID])).toEqual([
      [100, 'ses_main'],
      [110, 'ses_child'],
      [120, 'ses_child'],
      [130, 'ses_main'],
    ])
  })
})

describe('native terminal analytics', () => {
  test.each([
    ['session.execution.succeeded', 'succeeded'],
    ['session.execution.failed', 'failed'],
    ['session.execution.interrupted', 'interrupted'],
  ] as const)('records %s as %s', (type, outcome) => {
    const sessionID = `ses_${outcome}`
    const terminal = terminalEvent({ sessionID, created: 4_100, type })
    const events: EventBufferEntry[] = [
      { event: executionStarted(sessionID, 1_000), timestamp: 1_000 },
      { event: stepStarted(sessionID, 2_000), timestamp: 2_000 },
      {
        event: outcome === 'succeeded'
          ? stepEnded(sessionID, 3_000)
          : stepFailed(sessionID, 3_000),
        timestamp: 3_000,
      },
      { event: terminal, timestamp: 4_100 },
    ]

    expect(deriveNativeExecutionTerminalAnalytics({
      events,
      event: terminal,
    })).toMatchObject({
      outcome,
      durationSec: 3,
      usage: {
        input: 10,
        output: 4,
        reasoning: 2,
        cacheRead: 3,
        cacheWrite: 1,
        total: 20,
        cost: 0.04,
        assistantMessageCount: 1,
      },
    })
  })
})
