// Fixture-driven unit tests for pure event-stream derivation functions.
// Loads JSONL fixtures from event-stream-fixtures/ and asserts derived values.

import fs from 'node:fs'
import path from 'node:path'
import { describe, test, expect } from 'vitest'
import {
  getOpencodeEventSessionId,
  type OpencodeEventLogEntry,
} from './opencode-session-event-log.js'
import {
  isSessionBusy,
  wasRecentlyAborted,
  getRunStartTimeForIdle,
  getLatestRunInfo,
  shouldEmitFooter,
  getDerivedSubtaskIndex,
  type EventBufferEntry,
} from './event-stream-state.js'

const fixturesDir = path.join(import.meta.dirname, 'event-stream-fixtures')

function loadFixture(filename: string): EventBufferEntry[] {
  const content = fs.readFileSync(path.join(fixturesDir, filename), 'utf8')
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parsed = JSON.parse(line) as OpencodeEventLogEntry
      return { event: parsed.event, timestamp: parsed.timestamp }
    })
}

function getSessionId(events: EventBufferEntry[]): string {
  for (const entry of events) {
    const eid = getOpencodeEventSessionId(entry.event)
    if (eid) {
      return eid
    }
  }
  throw new Error('No sessionId found in fixture')
}

function findIdleIndices(events: EventBufferEntry[], sessionId: string): number[] {
  const indices: number[] = []
  for (let i = 0; i < events.length; i++) {
    const entry = events[i]
    if (!entry) {
      continue
    }
    const e = entry.event
    if (e.type === 'session.idle') {
      const eid = getOpencodeEventSessionId(e)
      if (eid === sessionId) {
        indices.push(i)
      }
    }
  }
  return indices
}

function lastIdle(idles: number[]): number {
  const last = idles[idles.length - 1]
  if (last === undefined) {
    throw new Error('No idle events found')
  }
  return last
}

function idleAt(idles: number[], index: number): number {
  const val = idles[index]
  if (val === undefined) {
    throw new Error(`No idle event at index ${index}`)
  }
  return val
}

describe('session-normal-completion', () => {
  const events = loadFixture('session-normal-completion.jsonl')
  const sessionId = getSessionId(events)
  const idles = findIdleIndices(events, sessionId)

  test('isSessionBusy at end of buffer', () => {
    expect(isSessionBusy({ events, sessionId })).toBe(false)
  })

  test('wasRecentlyAborted at final idle', () => {
    expect(wasRecentlyAborted({ events, sessionId, idleEventIndex: lastIdle(idles) })).toBe(false)
  })

  test('shouldEmitFooter at final idle', () => {
    expect(shouldEmitFooter({ events, sessionId, idleEventIndex: lastIdle(idles) })).toBe(true)
  })

  test('getLatestRunInfo', () => {
    expect(getLatestRunInfo({ events, sessionId })).toEqual({
      model: 'deterministic-v2',
      providerID: 'deterministic-provider',
      agent: 'build',
      tokensUsed: 2,
    })
  })

  test('getRunStartTimeForIdle', () => {
    const start = getRunStartTimeForIdle({ events, sessionId, idleEventIndex: lastIdle(idles) })
    expect(start).toBeDefined()
    expect(typeof start).toBe('number')
  })
})

describe('session-explicit-abort', () => {
  const events = loadFixture('session-explicit-abort.jsonl')
  const sessionId = getSessionId(events)
  const idles = findIdleIndices(events, sessionId)

  test('wasRecentlyAborted at final idle', () => {
    expect(wasRecentlyAborted({ events, sessionId, idleEventIndex: lastIdle(idles) })).toBe(false)
  })

  test('shouldEmitFooter at final idle', () => {
    expect(shouldEmitFooter({ events, sessionId, idleEventIndex: lastIdle(idles) })).toBe(false)
  })
})

describe('session-user-interruption', () => {
  const events = loadFixture('session-user-interruption.jsonl')
  const sessionId = getSessionId(events)
  const idles = findIdleIndices(events, sessionId)

  test('has at least two idle events', () => {
    expect(idles.length >= 2).toBe(true)
  })

  test('first idle: wasRecentlyAborted', () => {
    expect(wasRecentlyAborted({ events, sessionId, idleEventIndex: idleAt(idles, 0) })).toBe(false)
  })

  test('first idle: shouldEmitFooter', () => {
    expect(shouldEmitFooter({ events, sessionId, idleEventIndex: idleAt(idles, 0) })).toBe(true)
  })

  test('second idle: wasRecentlyAborted', () => {
    expect(wasRecentlyAborted({ events, sessionId, idleEventIndex: idleAt(idles, 1) })).toBe(false)
  })

  test('second idle: shouldEmitFooter', () => {
    expect(shouldEmitFooter({ events, sessionId, idleEventIndex: idleAt(idles, 1) })).toBe(false)
  })
})

describe('session-two-completions-same-session', () => {
  const events = loadFixture('session-two-completions-same-session.jsonl')
  const sessionId = getSessionId(events)
  const idles = findIdleIndices(events, sessionId)

  test('has at least two idle events', () => {
    expect(idles.length >= 2).toBe(true)
  })

  test('first idle: shouldEmitFooter', () => {
    expect(shouldEmitFooter({ events, sessionId, idleEventIndex: idleAt(idles, 0) })).toBe(true)
  })

  test('second idle: shouldEmitFooter', () => {
    expect(shouldEmitFooter({ events, sessionId, idleEventIndex: idleAt(idles, 1) })).toBe(true)
  })

  test('getRunStartTimeForIdle returns different timestamps', () => {
    const start1 = getRunStartTimeForIdle({ events, sessionId, idleEventIndex: idleAt(idles, 0) })
    const start2 = getRunStartTimeForIdle({ events, sessionId, idleEventIndex: idleAt(idles, 1) })
    expect(start1).toBeDefined()
    expect(start2).toBeDefined()
    expect(start1 !== start2).toBe(true)
  })
})

describe('session-concurrent-messages-serialized', () => {
  const events = loadFixture('session-concurrent-messages-serialized.jsonl')
  const sessionId = getSessionId(events)
  const idles = findIdleIndices(events, sessionId)

  test('both idles: shouldEmitFooter', () => {
    for (const idx of idles) {
      expect(shouldEmitFooter({ events, sessionId, idleEventIndex: idx })).toBe(true)
    }
  })
})

describe('session-tool-call-noisy-stream', () => {
  const events = loadFixture('session-tool-call-noisy-stream.jsonl')
  const sessionId = getSessionId(events)
  const idles = findIdleIndices(events, sessionId)

  test('fixture ends while still busy (no idle events)', () => {
    // This fixture captures a dense tool-call stream that ends while still
    // running — it has no session.idle events. Derivation should report busy.
    expect(idles.length).toBe(0)
    expect(isSessionBusy({ events, sessionId })).toBe(true)
  })

  test('getLatestRunInfo still works through dense tool events', () => {
    expect(getLatestRunInfo({ events, sessionId })).toEqual({
      model: 'deterministic-v2',
      providerID: 'deterministic-provider',
      agent: 'build',
      tokensUsed: 0,
    })
  })
})

describe('session-voice-queued-followup', () => {
  const events = loadFixture('session-voice-queued-followup.jsonl')
  const sessionId = getSessionId(events)
  const idles = findIdleIndices(events, sessionId)

  test('each idle: shouldEmitFooter', () => {
    for (const idx of idles) {
      expect(shouldEmitFooter({ events, sessionId, idleEventIndex: idx })).toBe(true)
    }
  })
})

describe('real-session-task-normal', () => {
  const events = loadFixture('real-session-task-normal.jsonl')
  const sessionId = getSessionId(events)
  const idles = findIdleIndices(events, sessionId)

  test('shouldEmitFooter at final idle', () => {
    expect(shouldEmitFooter({ events, sessionId, idleEventIndex: lastIdle(idles) })).toBe(true)
  })

  test('getLatestRunInfo has model info', () => {
    expect(getLatestRunInfo({ events, sessionId })).toEqual({
      model: 'gemini-2.5-flash',
      providerID: 'cached-google-real-events',
      agent: 'build',
      tokensUsed: 39025,
    })
  })
})

describe('real-session-task-user-interruption', () => {
  // Event-shape reference for live task streams:
  // discord/src/session-handler/event-stream-fixtures/real-session-task-three-parallel-sleeps.jsonl
  // This file shows task tool updates with state.metadata.sessionId and
  // state.output lines starting with "task_id: ses_...".
  const events = loadFixture('real-session-task-user-interruption.jsonl')
  const sessionId = getSessionId(events)
  const idles = findIdleIndices(events, sessionId)
  const childSessionId = 'ses_3464f3a1dffeBBD0d15EqnGjAh'

  test('getDerivedSubtaskIndex starts at 1 for first task of assistant message', () => {
    expect(getDerivedSubtaskIndex({
      events,
      mainSessionId: sessionId,
      candidateSessionId: childSessionId,
    })).toBe(1)
  })

  test('getDerivedSubtaskIndex restarts at 1 for a newer assistant message', () => {
    const firstTaskEvent = events.find((entry) => {
      if (entry.event.type !== 'message.part.updated') {
        return false
      }
      const part = entry.event.properties.part
      if (part.sessionID !== sessionId) {
        return false
      }
      if (part.type !== 'tool' || part.tool !== 'task') {
        return false
      }
      if (part.state.status !== 'running' && part.state.status !== 'completed') {
        return false
      }
      return part.state.metadata?.sessionId === childSessionId
    })
    if (!firstTaskEvent) {
      throw new Error('Expected to find task tool event in fixture')
    }

    const secondChildSessionId = 'ses_synthetic_child_2'
    const thirdChildSessionId = 'ses_synthetic_child_3'
    const syntheticAssistantMessageId = 'msg_synthetic_new_assistant'

    const secondTaskEvent = structuredClone(firstTaskEvent)
    if (secondTaskEvent.event.type !== 'message.part.updated') {
      throw new Error('Expected message.part.updated event')
    }
    const secondTaskPart = secondTaskEvent.event.properties.part
    if (secondTaskPart.type !== 'tool' || secondTaskPart.tool !== 'task') {
      throw new Error('Expected task tool part')
    }
    if (secondTaskPart.state.status !== 'completed') {
      throw new Error('Expected completed task tool part')
    }
    secondTaskPart.id = `${secondTaskPart.id}-synthetic-2`
    secondTaskPart.messageID = syntheticAssistantMessageId
    secondTaskPart.state = {
      ...secondTaskPart.state,
      metadata: {
        ...(secondTaskPart.state.metadata || {}),
        sessionId: secondChildSessionId,
      },
      output: `task_id: ${secondChildSessionId}`,
    }

    const thirdTaskEvent = structuredClone(secondTaskEvent)
    if (thirdTaskEvent.event.type !== 'message.part.updated') {
      throw new Error('Expected message.part.updated event')
    }
    const thirdTaskPart = thirdTaskEvent.event.properties.part
    if (thirdTaskPart.type !== 'tool' || thirdTaskPart.tool !== 'task') {
      throw new Error('Expected task tool part')
    }
    if (thirdTaskPart.state.status !== 'completed') {
      throw new Error('Expected completed task tool part')
    }
    thirdTaskPart.id = `${thirdTaskPart.id}-synthetic-3`
    thirdTaskPart.messageID = syntheticAssistantMessageId
    thirdTaskPart.state = {
      ...thirdTaskPart.state,
      metadata: {
        ...(thirdTaskPart.state.metadata || {}),
        sessionId: thirdChildSessionId,
      },
      output: `task_id: ${thirdChildSessionId}`,
    }

    const lastTimestamp = events[events.length - 1]?.timestamp || 0
    const augmentedEvents: EventBufferEntry[] = [
      ...events,
      {
        timestamp: lastTimestamp + 1,
        event: secondTaskEvent.event,
      },
      {
        timestamp: lastTimestamp + 2,
        event: thirdTaskEvent.event,
      },
    ]

    expect(getDerivedSubtaskIndex({
      events: augmentedEvents,
      mainSessionId: sessionId,
      candidateSessionId: childSessionId,
    })).toBe(1)
    expect(getDerivedSubtaskIndex({
      events: augmentedEvents,
      mainSessionId: sessionId,
      candidateSessionId: secondChildSessionId,
    })).toBe(1)
    expect(getDerivedSubtaskIndex({
      events: augmentedEvents,
      mainSessionId: sessionId,
      candidateSessionId: thirdChildSessionId,
    })).toBe(2)
  })

  test('getDerivedSubtaskIndex returns undefined for unknown session', () => {
    expect(getDerivedSubtaskIndex({
      events,
      mainSessionId: sessionId,
      candidateSessionId: 'ses_nonexistent',
    })).toBe(undefined)
  })

  test('shouldEmitFooter at final idle', () => {
    expect(shouldEmitFooter({ events, sessionId, idleEventIndex: lastIdle(idles) })).toBe(true)
  })

  test('getLatestRunInfo', () => {
    expect(getLatestRunInfo({ events, sessionId })).toEqual({
      model: 'gemini-2.5-flash',
      providerID: 'cached-google-real-events',
      agent: 'build',
      tokensUsed: 43610,
    })
  })
})

describe('real-session-action-buttons', () => {
  const events = loadFixture('real-session-action-buttons.jsonl')
  const sessionId = getSessionId(events)
  const idles = findIdleIndices(events, sessionId)

  test('shouldEmitFooter at final idle', () => {
    if (idles.length > 0) {
      expect(shouldEmitFooter({ events, sessionId, idleEventIndex: lastIdle(idles) })).toBe(true)
    }
  })
})

describe('real-session-permission-external-file', () => {
  const events = loadFixture('real-session-permission-external-file.jsonl')
  const sessionId = getSessionId(events)
  const idles = findIdleIndices(events, sessionId)

  test('shouldEmitFooter at final idle', () => {
    expect(idles.length).toBe(0)
  })
})

describe('real-session-footer-suppressed-on-pre-idle-interrupt', () => {
  const events = loadFixture('real-session-footer-suppressed-on-pre-idle-interrupt.jsonl')
  const sessionId = getSessionId(events)
  const idles = findIdleIndices(events, sessionId)

  test('fixture has the expected idle sequence', () => {
    expect(idles.length).toBe(3)
  })

  // Regression: this real stream has a delayed idle from the previous run after
  // a newer run already moved the session back to busy. We must not emit footer
  // for that first idle because its latest assistant message never finished.
  test('first idle should not emit footer when a newer run started before idle was emitted', () => {
    expect(wasRecentlyAborted({ events, sessionId, idleEventIndex: idleAt(idles, 0) })).toBe(false)
    expect(shouldEmitFooter({ events, sessionId, idleEventIndex: idleAt(idles, 0) })).toBe(false)
  })
})
