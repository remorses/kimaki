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
  isDerivedSubtaskSession,
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
    expect(isSessionBusy({ events, sessionId })).toMatchInlineSnapshot(`false`)
  })

  test('wasRecentlyAborted at final idle', () => {
    expect(wasRecentlyAborted({ events, sessionId, idleEventIndex: lastIdle(idles) })).toMatchInlineSnapshot(`false`)
  })

  test('shouldEmitFooter at final idle', () => {
    expect(shouldEmitFooter({ events, sessionId, idleEventIndex: lastIdle(idles) })).toMatchInlineSnapshot(`true`)
  })

  test('getLatestRunInfo', () => {
    expect(getLatestRunInfo({ events, sessionId })).toMatchInlineSnapshot(`
      {
        "agent": "build",
        "model": "deterministic-v2",
        "providerID": "deterministic-provider",
        "tokensUsed": 2,
      }
    `)
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
    expect(wasRecentlyAborted({ events, sessionId, idleEventIndex: lastIdle(idles) })).toMatchInlineSnapshot(`false`)
  })

  test('shouldEmitFooter at final idle', () => {
    expect(shouldEmitFooter({ events, sessionId, idleEventIndex: lastIdle(idles) })).toMatchInlineSnapshot(`false`)
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
    expect(wasRecentlyAborted({ events, sessionId, idleEventIndex: idleAt(idles, 0) })).toMatchInlineSnapshot(`false`)
  })

  test('first idle: shouldEmitFooter', () => {
    expect(shouldEmitFooter({ events, sessionId, idleEventIndex: idleAt(idles, 0) })).toMatchInlineSnapshot(`true`)
  })

  test('second idle: wasRecentlyAborted', () => {
    expect(wasRecentlyAborted({ events, sessionId, idleEventIndex: idleAt(idles, 1) })).toMatchInlineSnapshot(`false`)
  })

  test('second idle: shouldEmitFooter', () => {
    expect(shouldEmitFooter({ events, sessionId, idleEventIndex: idleAt(idles, 1) })).toMatchInlineSnapshot(`false`)
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
    expect(shouldEmitFooter({ events, sessionId, idleEventIndex: idleAt(idles, 0) })).toMatchInlineSnapshot(`true`)
  })

  test('second idle: shouldEmitFooter', () => {
    expect(shouldEmitFooter({ events, sessionId, idleEventIndex: idleAt(idles, 1) })).toMatchInlineSnapshot(`true`)
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
    expect(isSessionBusy({ events, sessionId })).toMatchInlineSnapshot(`true`)
  })

  test('getLatestRunInfo still works through dense tool events', () => {
    expect(getLatestRunInfo({ events, sessionId })).toMatchInlineSnapshot(`
      {
        "agent": "build",
        "model": "deterministic-v2",
        "providerID": "deterministic-provider",
        "tokensUsed": 0,
      }
    `)
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
    expect(shouldEmitFooter({ events, sessionId, idleEventIndex: lastIdle(idles) })).toMatchInlineSnapshot(`true`)
  })

  test('getLatestRunInfo has model info', () => {
    expect(getLatestRunInfo({ events, sessionId })).toMatchInlineSnapshot(`
      {
        "agent": "build",
        "model": "gemini-2.5-flash",
        "providerID": "cached-google-real-events",
        "tokensUsed": 39025,
      }
    `)
  })
})

describe('real-session-task-user-interruption', () => {
  const events = loadFixture('real-session-task-user-interruption.jsonl')
  const sessionId = getSessionId(events)
  const idles = findIdleIndices(events, sessionId)

  test('isDerivedSubtaskSession detects child session from tool output', () => {
    // The task tool output contains "task_id: ses_3464f3a1dffeBBD0d15EqnGjAh"
    const childSessionId = 'ses_3464f3a1dffeBBD0d15EqnGjAh'
    expect(isDerivedSubtaskSession({
      events,
      mainSessionId: sessionId,
      candidateSessionId: childSessionId,
    })).toMatchInlineSnapshot(`true`)
  })

  test('isDerivedSubtaskSession returns false for unknown session', () => {
    expect(isDerivedSubtaskSession({
      events,
      mainSessionId: sessionId,
      candidateSessionId: 'ses_nonexistent',
    })).toMatchInlineSnapshot(`false`)
  })

  test('shouldEmitFooter at final idle', () => {
    expect(shouldEmitFooter({ events, sessionId, idleEventIndex: lastIdle(idles) })).toMatchInlineSnapshot(`true`)
  })

  test('getLatestRunInfo', () => {
    expect(getLatestRunInfo({ events, sessionId })).toMatchInlineSnapshot(`
      {
        "agent": "build",
        "model": "gemini-2.5-flash",
        "providerID": "cached-google-real-events",
        "tokensUsed": 43610,
      }
    `)
  })
})

describe('real-session-action-buttons', () => {
  const events = loadFixture('real-session-action-buttons.jsonl')
  const sessionId = getSessionId(events)
  const idles = findIdleIndices(events, sessionId)

  test('shouldEmitFooter at final idle', () => {
    if (idles.length > 0) {
      expect(shouldEmitFooter({ events, sessionId, idleEventIndex: lastIdle(idles) })).toMatchInlineSnapshot(`true`)
    }
  })
})

describe('real-session-permission-external-file', () => {
  const events = loadFixture('real-session-permission-external-file.jsonl')
  const sessionId = getSessionId(events)
  const idles = findIdleIndices(events, sessionId)

  test('shouldEmitFooter at final idle', () => {
    if (idles.length > 0) {
      expect(shouldEmitFooter({ events, sessionId, idleEventIndex: lastIdle(idles) })).toMatchInlineSnapshot()
    }
  })
})

describe('real-session-footer-suppressed-on-pre-idle-interrupt', () => {
  const events = loadFixture('real-session-footer-suppressed-on-pre-idle-interrupt.jsonl')
  const sessionId = getSessionId(events)
  const idles = findIdleIndices(events, sessionId)

  test('fixture has the expected idle sequence', () => {
    expect(idles.length).toMatchInlineSnapshot(`3`)
  })

  test('first idle should not emit footer when a newer run started before idle was emitted', () => {
    expect(wasRecentlyAborted({ events, sessionId, idleEventIndex: idleAt(idles, 0) })).toMatchInlineSnapshot(`false`)
    expect(shouldEmitFooter({ events, sessionId, idleEventIndex: idleAt(idles, 0) })).toMatchInlineSnapshot(`false`)
  })
})
