import { expect, test } from 'vitest'
import {
  contextPercent,
  isSessionBusy,
  lastExecutionStartedAt,
  queuedInboxIds,
  sessionModel,
  shouldShowFooter,
  wasInterrupted,
  type EventEntry,
  type V2Event,
} from './event-stream-state.ts'

const sessionId = 'ses_1'

function events(
  ...types: Array<[string, V2Event['data']?, number?]>
): EventEntry[] {
  return types.map(([type, extra, timestamp]) => ({
    event: { type, data: { sessionID: sessionId, ...extra } },
    timestamp,
  }))
}

test('busy after execution.started, idle after succeeded', () => {
  expect(isSessionBusy({
    events: events(['session.execution.started']),
    sessionId,
  })).toBe(true)
  expect(isSessionBusy({
    events: events(
      ['session.execution.started'],
      ['session.execution.succeeded'],
    ),
    sessionId,
  })).toBe(false)
})

test('footer only on succeeded, never on interrupt', () => {
  expect(shouldShowFooter({
    events: events(['session.execution.succeeded']),
    sessionId,
  })).toBe(true)
  expect(shouldShowFooter({
    events: events(['session.execution.interrupted']),
    sessionId,
  })).toBe(false)
  expect(wasInterrupted({
    events: events(['session.execution.interrupted']),
    sessionId,
  })).toBe(true)
})

test('queued inbox ids drop on cancel and deliver', () => {
  expect(queuedInboxIds({
    events: events(
      ['session.inbox.enqueued', { inboxID: 'in_1' }],
      ['session.inbox.enqueued', { inboxID: 'in_2' }],
      ['session.inbox.cancelled', { inboxID: 'in_1' }],
      ['session.inbox.delivered', { inboxID: 'in_2' }],
    ),
    sessionId,
  })).toEqual([])
})

test('last execution started uses the latest started timestamp', () => {
  expect(lastExecutionStartedAt({
    events: events(
      ['session.execution.started', undefined, 1000],
      ['session.execution.succeeded', undefined, 2000],
      ['session.execution.started', undefined, 4000],
    ),
    sessionId,
  })).toBe(4000)
  expect(lastExecutionStartedAt({
    events: events(['session.execution.succeeded']),
    sessionId,
  })).toBeUndefined()
})

test('session model comes from created then step.started', () => {
  expect(sessionModel({
    events: events(['session.created']),
    sessionId,
  })).toBeUndefined()
  expect(sessionModel({
    events: events([
      'session.created',
      { model: { id: 'deterministic-v2', providerID: 'deterministic-provider' } },
    ]),
    sessionId,
  })).toEqual({
    providerID: 'deterministic-provider',
    modelID: 'deterministic-v2',
  })
  expect(sessionModel({
    events: events(
      [
        'session.created',
        { model: { id: 'old', providerID: 'p1' } },
      ],
      [
        'session.step.started',
        { model: { id: 'deterministic-v2', providerID: 'deterministic-provider' } },
      ],
    ),
    sessionId,
  })).toEqual({
    providerID: 'deterministic-provider',
    modelID: 'deterministic-v2',
  })
})

test('context percent is undefined without usage facts', () => {
  expect(contextPercent({
    events: events(['session.execution.succeeded']),
    sessionId,
  })).toBeUndefined()
  expect(contextPercent({
    events: events([
      'session.step.ended',
      { tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } },
    ]),
    sessionId,
  })).toBe(0)
})
