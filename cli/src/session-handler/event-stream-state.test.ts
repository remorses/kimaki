// Tests native OpenCode v2 and Kimaki-local event-stream derivations.

import type { V2Event } from '@opencode/client'
import { describe, expect, test } from 'vitest'
import {
  derivePendingPermissionRequests,
  didQuestionQueueHandoffSinceLatestQuestionAsked,
  getAssistantMessageIdsForLatestExecution,
  getDerivedSubagentSessions,
  getDerivedSubtaskIndex,
  getEventBufferSessionId,
  getLatestAssistantMessageIdForLatestExecution,
  getLatestExecutionStartedTimestamp,
  getLatestRunInfo,
  getNativeExecutionUsage,
  hasVisibleV2OutputSinceExecutionStart,
  isDerivedChildSession,
  isEventForSessionTree,
  isSessionBusy,
  type EventBufferEntry,
  type EventBufferEvent,
} from './event-stream-state.js'

let eventId = 0

function entry(event: EventBufferEvent, timestamp = 1): EventBufferEntry {
  return { event, timestamp }
}

function durable() {
  return { aggregateID: 'ses_main', seq: ++eventId, version: 1 as const }
}

function executionStarted(sessionID: string): Extract<V2Event, { type: 'session.execution.started' }> {
  return {
    id: `evt_${++eventId}`,
    created: eventId,
    type: 'session.execution.started',
    durable: durable(),
    data: { sessionID },
  }
}

function executionSucceeded(sessionID: string): Extract<V2Event, { type: 'session.execution.succeeded' }> {
  return {
    id: `evt_${++eventId}`,
    created: eventId,
    type: 'session.execution.succeeded',
    durable: durable(),
    data: { sessionID },
  }
}

function stepStarted({
  sessionID,
  assistantMessageID,
  agent = 'build',
}: {
  sessionID: string
  assistantMessageID: string
  agent?: string
}): Extract<V2Event, { type: 'session.step.started' }> {
  return {
    id: `evt_${++eventId}`,
    created: eventId,
    type: 'session.step.started',
    durable: durable(),
    data: {
      sessionID,
      assistantMessageID,
      agent,
      model: { providerID: 'openai', id: 'gpt-5.3-codex' },
    },
  }
}

function stepEnded({
  sessionID,
  assistantMessageID,
  input,
  output,
  cost,
}: {
  sessionID: string
  assistantMessageID: string
  input: number
  output: number
  cost: number
}): Extract<V2Event, { type: 'session.step.ended' }> {
  return {
    id: `evt_${++eventId}`,
    created: eventId,
    type: 'session.step.ended',
    durable: durable(),
    data: {
      sessionID,
      assistantMessageID,
      finish: 'stop',
      cost,
      tokens: {
        input,
        output,
        reasoning: 1,
        cache: { read: 2, write: 3 },
      },
    },
  }
}

function sessionCreated({
  sessionID,
  parentID,
}: {
  sessionID: string
  parentID?: string
}): Extract<V2Event, { type: 'session.created' }> {
  return {
    id: `evt_${++eventId}`,
    created: eventId,
    type: 'session.created',
    durable: durable(),
    data: {
      sessionID,
      projectID: 'prj_1',
      location: { directory: '/test' },
      parentID,
      slug: sessionID,
      title: 'session',
      version: '2.0.2',
    },
  }
}

function nativeSubagentEvents({
  mainSessionID,
  childSessionID,
  assistantMessageID = 'msg_parent',
  callID = 'call_subagent',
}: {
  mainSessionID: string
  childSessionID: string
  assistantMessageID?: string
  callID?: string
}): EventBufferEntry[] {
  const inputStarted: Extract<V2Event, { type: 'session.tool.input.started' }> = {
    id: `evt_${++eventId}`,
    created: eventId,
    type: 'session.tool.input.started',
    durable: durable(),
    data: {
      sessionID: mainSessionID,
      assistantMessageID,
      id: callID,
      name: 'subagent',
    },
  }
  const called: Extract<V2Event, { type: 'session.tool.called' }> = {
    id: `evt_${++eventId}`,
    created: eventId,
    type: 'session.tool.called',
    durable: durable(),
    data: {
      sessionID: mainSessionID,
      assistantMessageID,
      id: callID,
      input: {
        agent: 'explore',
        description: `Inspect ${childSessionID}`,
        prompt: 'Inspect the repository',
      },
      executed: true,
    },
  }
  const success: Extract<V2Event, { type: 'session.tool.success' }> = {
    id: `evt_${++eventId}`,
    created: eventId,
    type: 'session.tool.success',
    durable: { ...durable(), version: 2 },
    data: {
      sessionID: mainSessionID,
      assistantMessageID,
      id: callID,
      content: [{ type: 'text', text: 'complete' }],
      metadata: { sessionID: childSessionID, status: 'completed' },
      executed: true,
    },
  }
  return [entry(inputStarted), entry(called), entry(success)]
}

describe('native execution state', () => {
  test('Kimaki queue markers close the admission race without v1 status events', () => {
    const sessionID = 'ses_queue'
    const started = entry({
      type: 'kimaki.queue-dispatch.started',
      data: { sessionID },
    })
    const settled = entry({
      type: 'kimaki.queue-dispatch.settled',
      data: { sessionID },
    })

    expect(isSessionBusy({ events: [started], sessionId: sessionID })).toBe(true)
    expect(isSessionBusy({ events: [started, settled], sessionId: sessionID })).toBe(false)
    expect(getEventBufferSessionId(started.event)).toBe(sessionID)
  })

  test('latest execution start ignores earlier completed runs', () => {
    const sessionID = 'ses_abort_wait'
    const events = [
      { event: executionStarted(sessionID), timestamp: 10 },
      { event: executionSucceeded(sessionID), timestamp: 20 },
      { event: executionStarted(sessionID), timestamp: 30 },
    ]

    expect(getLatestExecutionStartedTimestamp({ events, sessionId: sessionID })).toBe(30)
    expect(getLatestExecutionStartedTimestamp({
      events,
      sessionId: sessionID,
      upToIndex: 1,
    })).toBe(10)
  })

  test('native execution terminal events settle busy state', () => {
    const sessionID = 'ses_execution'
    const events = [
      entry(executionStarted(sessionID)),
      entry(stepStarted({ sessionID, assistantMessageID: 'msg_a' })),
      entry(executionSucceeded(sessionID)),
    ]

    expect(isSessionBusy({ events: events.slice(0, 2), sessionId: sessionID })).toBe(true)
    expect(isSessionBusy({ events, sessionId: sessionID })).toBe(false)
  })

  test('assistant message ids are scoped to the latest execution', () => {
    const sessionID = 'ses_messages'
    const events = [
      entry(executionStarted(sessionID)),
      entry(stepStarted({ sessionID, assistantMessageID: 'msg_old' })),
      entry(executionSucceeded(sessionID)),
      entry(executionStarted(sessionID)),
      entry(stepStarted({ sessionID, assistantMessageID: 'msg_new_1' })),
      entry(stepStarted({ sessionID, assistantMessageID: 'msg_new_2' })),
    ]

    expect(getAssistantMessageIdsForLatestExecution({ events, sessionId: sessionID }))
      .toEqual(new Set(['msg_new_1', 'msg_new_2']))
    expect(getLatestAssistantMessageIdForLatestExecution({ events, sessionId: sessionID }))
      .toBe('msg_new_2')
  })

  test('visible output does not leak across executions', () => {
    const sessionID = 'ses_output'
    const textEnded: Extract<V2Event, { type: 'session.text.ended' }> = {
      id: `evt_${++eventId}`,
      created: eventId,
      type: 'session.text.ended',
      durable: durable(),
      data: {
        sessionID,
        assistantMessageID: 'msg_old',
        ordinal: 0,
        text: 'old output',
      },
    }
    const events = [
      entry(executionStarted(sessionID)),
      entry(textEnded),
      entry(executionSucceeded(sessionID)),
      entry(executionStarted(sessionID)),
      entry(executionSucceeded(sessionID)),
    ]

    expect(hasVisibleV2OutputSinceExecutionStart({ events, sessionId: sessionID })).toBe(false)
    expect(hasVisibleV2OutputSinceExecutionStart({ events: events.slice(0, 3), sessionId: sessionID }))
      .toBe(true)
  })

  test('derives run info and usage from native steps', () => {
    const sessionID = 'ses_usage'
    const events = [
      entry(executionStarted(sessionID), 100),
      entry(stepStarted({ sessionID, assistantMessageID: 'msg_a', agent: 'plan' })),
      entry(stepEnded({ sessionID, assistantMessageID: 'msg_a', input: 10, output: 4, cost: 0.01 })),
      entry(stepEnded({ sessionID, assistantMessageID: 'msg_b', input: 20, output: 5, cost: 0.02 })),
    ]

    expect(getLatestRunInfo({ events, sessionId: sessionID })).toMatchInlineSnapshot(`
      {
        "agent": "plan",
        "model": "gpt-5.3-codex",
        "providerID": "openai",
        "tokensUsed": 31,
      }
    `)
    expect(getNativeExecutionUsage({ events, sessionId: sessionID })).toMatchInlineSnapshot(`
      {
        "agent": "plan",
        "assistantMessageCount": 2,
        "cacheRead": 4,
        "cacheWrite": 6,
        "cost": 0.03,
        "input": 30,
        "model": "gpt-5.3-codex",
        "output": 9,
        "providerID": "openai",
        "reasoning": 2,
        "startedAt": 100,
        "total": 51,
      }
    `)
  })
})

describe('native permissions and forms', () => {
  test('tracks unresolved permission requests from native data', () => {
    const sessionID = 'ses_permission'
    const asked = (id: string): Extract<V2Event, { type: 'permission.asked' }> => ({
      id: `evt_${++eventId}`,
      created: eventId,
      type: 'permission.asked',
      data: {
        id,
        sessionID,
        action: 'read',
        resources: ['src/**'],
        metadata: {},
      },
    })
    const replied: Extract<V2Event, { type: 'permission.replied' }> = {
      id: `evt_${++eventId}`,
      created: eventId,
      type: 'permission.replied',
      data: { sessionID, requestID: 'perm_1', reply: 'once' },
    }
    const events = [entry(asked('perm_1')), entry(asked('perm_2')), entry(replied)]

    expect(derivePendingPermissionRequests({ events, sessionId: sessionID }))
      .toEqual(['perm_2'])
  })

  test('replayed forms do not reset a completed local queue handoff', () => {
    const sessionID = 'ses_form'
    const form = (id: string): Extract<V2Event, { type: 'form.created' }> => ({
      id: `evt_${++eventId}`,
      created: eventId,
      type: 'form.created',
      data: {
        form: {
          id,
          sessionID,
          title: 'Question',
          metadata: { kind: 'question' },
          fields: [{ key: 'answer', type: 'string', title: 'Answer' }],
        },
      },
    })
    const handoff = entry({
      type: 'kimaki.question-queue-handoff.started',
      data: { sessionID, requestID: 'form_one' },
    })

    expect(didQuestionQueueHandoffSinceLatestQuestionAsked({
      events: [entry(form('form_one')), handoff, entry(form('form_one'))],
      sessionId: sessionID,
    })).toBe(true)
    expect(didQuestionQueueHandoffSinceLatestQuestionAsked({
      events: [entry(form('form_one')), handoff, entry(form('form_two'))],
      sessionId: sessionID,
    })).toBe(false)
  })
})

describe('native subagent session tree', () => {
  test('derives labels, ordering, and child routing from native tool events', () => {
    const mainSessionID = 'ses_main'
    const firstChild = 'ses_child_1'
    const secondChild = 'ses_child_2'
    const first = nativeSubagentEvents({ mainSessionID, childSessionID: firstChild })
    const second = nativeSubagentEvents({
      mainSessionID,
      childSessionID: secondChild,
      assistantMessageID: 'msg_parent_2',
      callID: 'call_subagent_2',
    }).map((item, index) => ({ ...item, timestamp: 10 + index }))
    const childCreated = entry(sessionCreated({ sessionID: firstChild, parentID: mainSessionID }))
    const events = [...first, ...second, childCreated]

    expect(getDerivedSubagentSessions({ events, mainSessionId: mainSessionID }))
      .toMatchInlineSnapshot(`
        [
          {
            "childSessionId": "ses_child_2",
            "description": "Inspect ses_child_2",
            "subagentType": "explore",
            "timestamp": 12,
          },
          {
            "childSessionId": "ses_child_1",
            "description": "Inspect ses_child_1",
            "subagentType": "explore",
            "timestamp": 1,
          },
        ]
      `)
    expect(getDerivedSubtaskIndex({
      events,
      mainSessionId: mainSessionID,
      candidateSessionId: firstChild,
    })).toBe(1)
    expect(getDerivedSubtaskIndex({
      events,
      mainSessionId: mainSessionID,
      candidateSessionId: secondChild,
    })).toBe(1)
    expect(isDerivedChildSession({
      events,
      mainSessionId: mainSessionID,
      candidateSessionId: firstChild,
    })).toBe(true)
    expect(isEventForSessionTree({
      events: first,
      event: childCreated.event,
      mainSessionId: mainSessionID,
    })).toBe(true)
    expect(isEventForSessionTree({
      events,
      event: executionStarted('ses_unrelated'),
      mainSessionId: mainSessionID,
    })).toBe(false)
  })
})
