// Tests native OpenCode v2 and Kimaki-local event-stream derivations.

import type { V2Event } from '@opencode/client'
import { describe, expect, test } from 'vitest'
import {
  derivePendingPermissionRequests,
  didLatestExecutionUseTool,
  didQuestionQueueHandoffSinceLatestQuestionAsked,
  getAssistantMessageIdsForLatestExecution,
  compactSubagentRoutingEvidence,
  getDerivedSubagentSessions,
  getDerivedSubtaskAgentType,
  getDerivedSubtaskIndex,
  getEventBufferSessionId,
  getLatestAssistantMessageIdForLatestExecution,
  getLatestExecutionStartedTimestamp,
  getContextUsageNoticePercentage,
  getLatestRunInfo,
  getPromptCacheClear,
  formatPromptCacheClearMessage,
  getNativeDurableIdentity,
  getNativeExecutionUsage,
  hasSeenNativeDurableEvent,
  hasVisibleV2OutputSinceExecutionStart,
  isDerivedChildSession,
  isEventForSessionTree,
  isSessionBusy,
  parseEventBufferEvent,
  shouldRetainSessionEvent,
  shouldShowRetryNotice,
  trimEventBuffer,
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

function nativeSubagentProgress({
  mainSessionID,
  childSessionID,
  assistantMessageID = 'msg_parent',
  callID = 'call_subagent',
  status = 'running',
}: {
  mainSessionID: string
  childSessionID: string
  assistantMessageID?: string
  callID?: string
  status?: string
}): Extract<V2Event, { type: 'session.tool.progress' }> {
  return {
    id: `evt_${++eventId}`,
    created: eventId,
    type: 'session.tool.progress',
    data: {
      sessionID: mainSessionID,
      assistantMessageID,
      id: callID,
      metadata: {
        sessionID: childSessionID,
        status,
        output: 'x'.repeat(8_000),
      },
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

describe('native durable identity', () => {
  test('same aggregate and seq is already seen', () => {
    const first = executionSucceeded('ses_main')
    const replay = {
      ...first,
      id: 'evt_replay',
    }
    const events = [entry(first)]

    expect(getNativeDurableIdentity(first)).toEqual({
      aggregateID: first.durable.aggregateID,
      seq: first.durable.seq,
    })
    expect(hasSeenNativeDurableEvent({ events, event: replay })).toBe(true)
  })

  test('different aggregates with the same seq stay distinct', () => {
    const main = executionSucceeded('ses_main')
    const child: Extract<V2Event, { type: 'session.execution.succeeded' }> = {
      ...executionSucceeded('ses_child'),
      durable: {
        aggregateID: 'ses_child',
        seq: main.durable.seq,
        version: 1,
      },
    }

    expect(getNativeDurableIdentity(main)).toEqual({
      aggregateID: 'ses_main',
      seq: main.durable.seq,
    })
    expect(getNativeDurableIdentity(child)).toEqual({
      aggregateID: 'ses_child',
      seq: main.durable.seq,
    })
    expect(hasSeenNativeDurableEvent({
      events: [entry(main)],
      event: child,
    })).toBe(false)
  })

  test('different seq values in the same aggregate stay distinct', () => {
    const first = executionSucceeded('ses_main')
    const second = executionSucceeded('ses_main')

    expect(first.durable.aggregateID).toBe(second.durable.aggregateID)
    expect(first.durable.seq).not.toBe(second.durable.seq)
    expect(hasSeenNativeDurableEvent({
      events: [entry(first)],
      event: second,
    })).toBe(false)
  })

  test('ephemeral deltas without durable identity are never deduped', () => {
    const delta: Extract<V2Event, { type: 'session.text.delta' }> = {
      id: `evt_${++eventId}`,
      created: eventId,
      type: 'session.text.delta',
      data: {
        sessionID: 'ses_main',
        assistantMessageID: 'msg_1',
        ordinal: 0,
        delta: 'Hello',
      },
    }

    expect(getNativeDurableIdentity(delta)).toBeNull()
    expect(hasSeenNativeDurableEvent({
      events: [entry(delta)],
      event: delta,
    })).toBe(false)
  })
})

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

  test('finds a tool only in the latest execution', () => {
    const sessionID = 'ses_main'
    const toolStarted = (name: string): Extract<V2Event, { type: 'session.tool.input.started' }> => ({
      id: `evt_${++eventId}`,
      created: eventId,
      type: 'session.tool.input.started',
      durable: durable(),
      data: {
        sessionID,
        assistantMessageID: `msg_${eventId}`,
        id: `call_${eventId}`,
        name,
      },
    })
    const events = [
      entry(executionStarted(sessionID)),
      entry(toolStarted('kimaki_sleep')),
      entry(executionSucceeded(sessionID)),
      entry(executionStarted(sessionID)),
      entry(toolStarted('read')),
    ]

    expect(didLatestExecutionUseTool({ events, sessionId: sessionID, toolName: 'kimaki_sleep' }))
      .toBe(false)
    expect(didLatestExecutionUseTool({ events, sessionId: sessionID, toolName: 'read' }))
      .toBe(true)
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

  test('derives context notice thresholds from prior native steps', () => {
    const sessionID = 'ses_context'
    const events = [
      entry(executionStarted(sessionID)),
      entry(stepStarted({ sessionID, assistantMessageID: 'msg_a' })),
      entry(stepEnded({ sessionID, assistantMessageID: 'msg_a', input: 10_000, output: 1, cost: 0 })),
      entry(stepStarted({ sessionID, assistantMessageID: 'msg_b' })),
    ]

    expect(getContextUsageNoticePercentage({
      events,
      sessionId: sessionID,
      contextLimit: 100_000,
    })).toBe(10)
    events.push(entry(stepEnded({
      sessionID,
      assistantMessageID: 'msg_b',
      input: 10_500,
      output: 1,
      cost: 0,
    })))
    events.push(entry(stepStarted({ sessionID, assistantMessageID: 'msg_c' })))
    expect(getContextUsageNoticePercentage({
      events,
      sessionId: sessionID,
      contextLimit: 100_000,
    })).toBeUndefined()

    const nextExecution = [
      ...events,
      entry(executionSucceeded(sessionID)),
      entry(executionStarted(sessionID)),
      entry(stepStarted({ sessionID, assistantMessageID: 'msg_d' })),
      entry(stepEnded({ sessionID, assistantMessageID: 'msg_d', input: 10_000, output: 1, cost: 0 })),
      entry(stepStarted({ sessionID, assistantMessageID: 'msg_e' })),
    ]
    expect(getContextUsageNoticePercentage({
      events: nextExecution,
      sessionId: sessionID,
      contextLimit: 100_000,
    })).toBe(10)
  })

  test('derives retry throttling from retry status events', () => {
    const retry = (created: number): Extract<V2Event, { type: 'session.status' }> => ({
      id: `evt_${++eventId}`,
      created,
      type: 'session.status',
      data: {
        sessionID: 'ses_retry',
        status: { type: 'retry', attempt: 1, message: 'rate limited', next: created + 1_000 },
      },
    })
    const first = retry(1_000)
    const second = retry(5_000)
    const third = retry(12_000)

    expect(shouldShowRetryNotice({ events: [entry(first)], event: first })).toBe(true)
    expect(shouldShowRetryNotice({ events: [entry(first), entry(second)], event: second })).toBe(false)
    expect(shouldShowRetryNotice({ events: [entry(first), entry(third)], event: third })).toBe(true)
  })
})

describe('getPromptCacheClear', () => {
  const sessionID = 'ses_cache'

  function cacheStep({
    assistantMessageID,
    input,
    read,
    write,
    providerID = 'anthropic',
    modelID = 'claude-opus',
  }: {
    assistantMessageID: string
    input: number
    read: number
    write: number
    providerID?: string
    modelID?: string
  }): EventBufferEntry[] {
    const started = stepStarted({ sessionID, assistantMessageID })
    const ended = stepEnded({ sessionID, assistantMessageID, input, output: 10, cost: 0 })
    return [
      entry({ ...started, data: { ...started.data, model: { providerID, id: modelID } } }),
      entry({ ...ended, data: { ...ended.data, tokens: { ...ended.data.tokens, cache: { read, write } } } }),
    ]
  }

  function turn(steps: EventBufferEntry[][]): EventBufferEntry[] {
    return [
      entry(executionStarted(sessionID)),
      ...steps.flat(),
      entry(executionSucceeded(sessionID)),
    ]
  }

  function compactionEnded(): EventBufferEntry {
    return entry({
      id: `evt_${++eventId}`,
      created: eventId,
      type: 'session.compaction.ended',
      durable: durable(),
      data: { sessionID, reason: 'auto', text: 'summary', recent: 'msg_recent' },
    })
  }

  test('detects same-model cache drops only on the first step after an earlier turn', () => {
    const first = turn([cacheStep({ assistantMessageID: 'msg_1', input: 100, read: 0, write: 20_000 })])
    expect(getPromptCacheClear({ events: first, sessionId: sessionID, currentMessageId: 'msg_1' }))
      .toBeUndefined()

    const missed = [
      ...first,
      ...turn([
        cacheStep({ assistantMessageID: 'msg_2', input: 21_000, read: 0, write: 21_000 }),
        cacheStep({ assistantMessageID: 'msg_3', input: 100, read: 0, write: 21_500 }),
      ]),
    ]
    expect(getPromptCacheClear({ events: missed, sessionId: sessionID, currentMessageId: 'msg_2' }))
      .toMatchInlineSnapshot(`
        {
          "currentCacheRead": 0,
          "currentMessageId": "msg_2",
          "expectedCacheRead": 20000,
          "previousMessageId": "msg_1",
        }
      `)
    // Later steps in the same execution compare against their own writes, not the earlier turn.
    expect(getPromptCacheClear({ events: missed, sessionId: sessionID, currentMessageId: 'msg_3' }))
      .toBeUndefined()

    const hit = [
      ...first,
      ...turn([cacheStep({ assistantMessageID: 'msg_4', input: 500, read: 20_000, write: 500 })]),
    ]
    expect(getPromptCacheClear({ events: hit, sessionId: sessionID, currentMessageId: 'msg_4' }))
      .toBeUndefined()
  })

  test('skips model changes, compactions, and interrupted turns', () => {
    const first = turn([cacheStep({ assistantMessageID: 'msg_1', input: 100, read: 0, write: 20_000 })])
    const modelChanged = [
      ...first,
      ...turn([cacheStep({ assistantMessageID: 'msg_2', input: 20_000, read: 0, write: 20_000, modelID: 'gpt' })]),
    ]
    expect(getPromptCacheClear({ events: modelChanged, sessionId: sessionID, currentMessageId: 'msg_2' }))
      .toBeUndefined()

    const compacted = [
      ...first,
      compactionEnded(),
      ...turn([cacheStep({ assistantMessageID: 'msg_3', input: 20_000, read: 0, write: 20_000 })]),
    ]
    expect(getPromptCacheClear({ events: compacted, sessionId: sessionID, currentMessageId: 'msg_3' }))
      .toBeUndefined()

    const interrupted: EventBufferEntry = entry({
      id: `evt_${++eventId}`,
      created: eventId,
      type: 'session.execution.interrupted',
      durable: durable(),
      data: { sessionID, reason: 'user' },
    })
    const acrossInterrupt = [
      ...first,
      entry(executionStarted(sessionID)),
      ...cacheStep({ assistantMessageID: 'msg_aborted', input: 20_000, read: 0, write: 0 }),
      interrupted,
      ...turn([cacheStep({ assistantMessageID: 'msg_4', input: 20_500, read: 0, write: 20_500 })]),
    ]
    expect(getPromptCacheClear({ events: acrossInterrupt, sessionId: sessionID, currentMessageId: 'msg_4' }))
      .toMatchInlineSnapshot(`
        {
          "currentCacheRead": 0,
          "currentMessageId": "msg_4",
          "expectedCacheRead": 20000,
          "previousMessageId": "msg_1",
        }
      `)
  })

  test('formats a compact cache-miss notice', () => {
    expect(formatPromptCacheClearMessage({
      expectedCacheRead: 20_000,
      currentCacheRead: 1_234,
      previousMessageId: 'msg_1',
      currentMessageId: 'msg_2',
    })).toMatchInlineSnapshot(`"prompt cache missed (20k → 1.2k)"`)
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

  test('session.created puts the child in the tree before progress supplies an index', () => {
    // Native Session.create publishes session.created before subagent progress
    // and sessions.prompt, so child output cannot exist before this event.
    const mainSessionID = 'ses_main'
    const childSessionID = 'ses_child_1'
    const created = entry(sessionCreated({ sessionID: childSessionID, parentID: mainSessionID }))
    const events = [created]
    expect(isDerivedChildSession({
      events,
      mainSessionId: mainSessionID,
      candidateSessionId: childSessionID,
    })).toBe(true)
    expect(getDerivedSubtaskIndex({
      events,
      mainSessionId: mainSessionID,
      candidateSessionId: childSessionID,
    })).toBeUndefined()
  })

  test('keeps parallel sibling identity from compact progress and reversed terminal replay', () => {
    const mainSessionID = 'ses_main'
    const firstChild = 'ses_child_1'
    const secondChild = 'ses_child_2'
    const firstStarted: Extract<V2Event, { type: 'session.tool.input.started' }> = {
      id: `evt_${++eventId}`,
      created: eventId,
      type: 'session.tool.input.started',
      durable: durable(),
      data: {
        sessionID: mainSessionID,
        assistantMessageID: 'msg_parent',
        id: 'call_a',
        name: 'subagent',
      },
    }
    const firstCalled: Extract<V2Event, { type: 'session.tool.called' }> = {
      id: `evt_${++eventId}`,
      created: eventId,
      type: 'session.tool.called',
      durable: durable(),
      data: {
        sessionID: mainSessionID,
        assistantMessageID: 'msg_parent',
        id: 'call_a',
        input: {
          agent: 'explore',
          description: 'Inspect first',
          prompt: 'Inspect the first child',
        },
        executed: true,
      },
    }
    const secondStarted: Extract<V2Event, { type: 'session.tool.input.started' }> = {
      id: `evt_${++eventId}`,
      created: eventId,
      type: 'session.tool.input.started',
      durable: durable(),
      data: {
        sessionID: mainSessionID,
        assistantMessageID: 'msg_parent',
        id: 'call_b',
        name: 'subagent',
      },
    }
    const secondCalled: Extract<V2Event, { type: 'session.tool.called' }> = {
      id: `evt_${++eventId}`,
      created: eventId,
      type: 'session.tool.called',
      durable: durable(),
      data: {
        sessionID: mainSessionID,
        assistantMessageID: 'msg_parent',
        id: 'call_b',
        input: {
          agent: 'explore',
          description: 'Inspect second',
          prompt: 'Inspect the second child',
        },
        executed: true,
      },
    }
    const firstProgress = nativeSubagentProgress({
      mainSessionID,
      childSessionID: firstChild,
      callID: 'call_a',
    })
    const secondProgress = nativeSubagentProgress({
      mainSessionID,
      childSessionID: secondChild,
      callID: 'call_b',
    })
    const firstEvidence = compactSubagentRoutingEvidence(firstProgress)
    const secondEvidence = compactSubagentRoutingEvidence(secondProgress)
    if (!firstEvidence || !secondEvidence) {
      throw new Error('Missing compact subagent routing evidence')
    }
    expect(JSON.stringify(firstEvidence).length).toBeLessThan(400)
    expect(JSON.stringify(firstEvidence)).not.toContain('xxxxxxx')

    const running = [
      entry(firstStarted),
      entry(firstCalled),
      entry(secondStarted),
      entry(secondCalled),
      entry(firstEvidence),
      entry(secondEvidence),
    ]
    expect(getDerivedSubtaskIndex({
      events: running,
      mainSessionId: mainSessionID,
      candidateSessionId: firstChild,
    })).toBe(1)
    expect(getDerivedSubtaskIndex({
      events: running,
      mainSessionId: mainSessionID,
      candidateSessionId: secondChild,
    })).toBe(2)
    expect(getDerivedSubtaskAgentType({
      events: running,
      mainSessionId: mainSessionID,
      candidateSessionId: firstChild,
    })).toBe('explore')
    expect(getDerivedSubtaskAgentType({
      events: running,
      mainSessionId: mainSessionID,
      candidateSessionId: secondChild,
    })).toBe('explore')
    expect(isDerivedChildSession({
      events: running,
      mainSessionId: mainSessionID,
      candidateSessionId: firstChild,
    })).toBe(true)

    const secondSuccess: Extract<V2Event, { type: 'session.tool.success' }> = {
      id: `evt_${++eventId}`,
      created: eventId,
      type: 'session.tool.success',
      durable: { ...durable(), version: 2 },
      data: {
        sessionID: mainSessionID,
        assistantMessageID: 'msg_parent',
        id: 'call_b',
        content: [{ type: 'text', text: 'second done' }],
        metadata: { sessionID: secondChild, status: 'completed' },
        executed: true,
      },
    }
    const firstSuccess: Extract<V2Event, { type: 'session.tool.success' }> = {
      id: `evt_${++eventId}`,
      created: eventId,
      type: 'session.tool.success',
      durable: { ...durable(), version: 2 },
      data: {
        sessionID: mainSessionID,
        assistantMessageID: 'msg_parent',
        id: 'call_a',
        content: [{ type: 'text', text: 'first done' }],
        metadata: { sessionID: firstChild, status: 'completed' },
        executed: true,
      },
    }
    const replay = [
      entry(firstStarted),
      entry(firstCalled),
      entry(secondStarted),
      entry(secondCalled),
      entry(secondSuccess),
      entry(firstSuccess),
    ]
    expect(getDerivedSubtaskIndex({
      events: replay,
      mainSessionId: mainSessionID,
      candidateSessionId: firstChild,
    })).toBe(1)
    expect(getDerivedSubtaskIndex({
      events: replay,
      mainSessionId: mainSessionID,
      candidateSessionId: secondChild,
    })).toBe(2)
    expect(getDerivedSubagentSessions({ events: replay, mainSessionId: mainSessionID }))
      .toMatchInlineSnapshot(`
        [
          {
            "childSessionId": "ses_child_1",
            "description": "Inspect first",
            "subagentType": "explore",
            "timestamp": 1,
          },
          {
            "childSessionId": "ses_child_2",
            "description": "Inspect second",
            "subagentType": "explore",
            "timestamp": 1,
          },
        ]
      `)
  })
})

describe('event buffer trim and busy derivation during task children', () => {
  const mainSessionID = 'ses_parent'
  const childSessionID = 'ses_task_child'

  function parentBusy(): EventBufferEntry {
    return entry({
      id: `evt_${++eventId}`,
      created: eventId,
      type: 'session.status',
      data: {
        sessionID: mainSessionID,
        status: { type: 'busy' },
      },
    })
  }

  function taskInputStarted(): EventBufferEntry {
    return entry({
      id: `evt_${++eventId}`,
      created: eventId,
      type: 'session.tool.input.started',
      durable: durable(),
      data: {
        sessionID: mainSessionID,
        assistantMessageID: 'msg_asst',
        id: 'call_task',
        name: 'subagent',
      },
    })
  }

  function taskSuccess(): EventBufferEntry {
    return entry({
      id: `evt_${++eventId}`,
      created: eventId,
      type: 'session.tool.success',
      durable: { ...durable(), version: 2 },
      data: {
        sessionID: mainSessionID,
        assistantMessageID: 'msg_asst',
        id: 'call_task',
        content: [{ type: 'text', text: 'done' }],
        metadata: { sessionID: childSessionID, status: 'completed' },
        executed: true,
      },
    })
  }

  function childTextEnded(index: number): EventBufferEntry {
    return entry({
      id: `evt_${++eventId}`,
      created: eventId,
      type: 'session.text.ended',
      durable: durable(),
      data: {
        sessionID: childSessionID,
        assistantMessageID: 'msg_child',
        ordinal: index,
        text: 'child output',
      },
    })
  }

  test('isSessionBusy stays true for a running parent task even without status events', () => {
    expect(isSessionBusy({
      events: [taskInputStarted()],
      sessionId: mainSessionID,
    })).toBe(true)
  })

  test('isSessionBusy is false after the same parent task succeeds without status events', () => {
    expect(isSessionBusy({
      events: [taskInputStarted(), taskSuccess()],
      sessionId: mainSessionID,
    })).toBe(false)
  })

  test('trim keeps parent busy across a child-session event flood', () => {
    const events = [
      parentBusy(),
      taskInputStarted(),
      entry(sessionCreated({ sessionID: childSessionID, parentID: mainSessionID })),
      ...Array.from({ length: 1000 }, (_, index) => childTextEnded(index)),
    ]
    const trimmed = trimEventBuffer({
      events,
      mainSessionId: mainSessionID,
      max: 1000,
      isKnownChildSession: (sessionId) => sessionId === childSessionID,
    })
    expect(trimmed.length).toBeLessThanOrEqual(1000)
    expect(isSessionBusy({ events: trimmed, sessionId: mainSessionID })).toBe(true)
  })

  test('shouldRetainSessionEvent drops child output but keeps parent task starts', () => {
    expect(shouldRetainSessionEvent({
      event: taskInputStarted().event,
      mainSessionId: mainSessionID,
      isKnownChildSession: (sessionId) => sessionId === childSessionID,
    })).toBe(true)
    expect(shouldRetainSessionEvent({
      event: childTextEnded(1).event,
      mainSessionId: mainSessionID,
      isKnownChildSession: (sessionId) => sessionId === childSessionID,
    })).toBe(false)
    expect(shouldRetainSessionEvent({
      event: sessionCreated({ sessionID: childSessionID, parentID: mainSessionID }),
      mainSessionId: mainSessionID,
      isKnownChildSession: (sessionId) => sessionId === childSessionID,
    })).toBe(true)
  })
})

describe('parseEventBufferEvent', () => {
  test('parses kimaki-local queue markers without inventing extra fields', () => {
    const parsed = parseEventBufferEvent(JSON.stringify({
      type: 'kimaki.queue-dispatch.started',
      data: { sessionID: 'ses_main', extra: true },
    }))
    expect(parsed).toEqual({
      type: 'kimaki.queue-dispatch.started',
      data: { sessionID: 'ses_main' },
    })
  })

  test('rejects unknown undotted types', () => {
    const parsed = parseEventBufferEvent(JSON.stringify({ type: 'garbage' }))
    expect(parsed).toBeInstanceOf(Error)
  })
})
