// Ticket #55 diagnostic repro — STOCK kimaki 0.27.0 queue-drain gates during
// manual compaction. Imports the PRISTINE npm 0.27.0 dist event-stream-state.js
// (the file is byte-identical to the deployed one, verified 2026-09-11) and
// drives it with realistic compaction event streams to expose the three gate
// races that strand or misroute prompts submitted mid-/compact.
//
// Diagnostic only: these tests document the STOCK bug, they are not a
// regression suite for the fix (the fix's tests live alongside the patch).
import { describe, expect, test } from 'vitest'

// Byte-identical fixture of stock kimaki 0.27.0 dist/session-handler/
// event-stream-state.js (npm tarball), captured 2026-09-11.
const ess = await import('./__fixtures__/stock-0.27.0-event-stream-state.js')
const {
  isSessionBusy,
  doesLatestUserTurnHaveNaturalCompletion,
  getLatestUserMessage,
} = ess as typeof import('./event-stream-state.js')

const SID = 'ses_f8c58fe0'

let clock = 1
function msgUpdated(info) {
  return {
    id: `evt_${clock}`,
    type: 'message.updated',
    properties: { sessionID: SID, info },
  }
}
function userMsg(id, created) {
  return msgUpdated({
    id,
    sessionID: SID,
    role: 'user',
    parentID: undefined,
    time: { created },
  })
}
function assistantMsg(id, parentID, created, extra = {}) {
  return msgUpdated({
    id,
    sessionID: SID,
    role: 'assistant',
    parentID,
    time: { created, ...(extra.completed ? { completed: extra.completed } : {}) },
    ...(extra.finish ? { finish: extra.finish } : {}),
    ...(extra.error ? { error: extra.error } : {}),
    ...(extra.summary ? { summary: true } : {}),
  })
}
function statusBusy() {
  return {
    id: `evt_${clock}`,
    type: 'session.status',
    properties: { sessionID: SID, status: { type: 'busy' } },
  }
}
function sessionIdle() {
  return {
    id: `evt_${clock}`,
    type: 'session.idle',
    properties: { sessionID: SID },
  }
}
function buffer(events) {
  clock = 1
  return events.map((event) => {
    clock += 1
    return { event, timestamp: clock, eventIndex: clock }
  })
}

describe('#55 stock 0.27.0 — busy-gate races during manual compaction', () => {
  test('B1: before the first session.status busy event, isSessionBusy reads idle — /queue drain fires mid-compaction', () => {
    // User ran /compact a moment ago. The server has already persisted the
    // compaction user message (message.updated user reaches kimaki first) but
    // the run loop has not yet published session.status busy.
    const events = buffer([
      userMsg('msg_u0', 1),
      assistantMsg('msg_a0', 'msg_u0', 2, { finish: 'stop', completed: 3 }),
      userMsg('msg_cu', 5), // compaction user message
    ])
    // /queue arrives here: enqueueViaLocalQueue -> willDrainNow gate
    expect(isSessionBusy({ events, sessionId: SID })).toBe(false)
  })

  test('B2: >1000 non-delta message.updated events during a long summary evict the busy marker — isSessionBusy reads idle mid-compaction', () => {
    const events = [
      userMsg('msg_u0', 1),
      assistantMsg('msg_a0', 'msg_u0', 2, { finish: 'stop', completed: 3 }),
      userMsg('msg_cu', 5),
      statusBusy(),
    ]
    // Incident-era evidence (2026-09-06 crash #4: "message.updated SKIP-BYPASS
    // flood"): long compactions stream hundreds-to-thousands of
    // message.updated events for the summary assistant message. Only
    // message.part.delta is excluded from the 1000-slot buffer.
    for (let i = 0; i < 1100; i++) {
      events.push(assistantMsg('msg_summary', 'msg_cu', 6))
    }
    const buf = buffer(events)
    expect(buf.length).toBeGreaterThan(1000)
    // appendEventToBuffer caps the buffer at 1000 entries (EVENT_BUFFER_MAX);
    // simulate the splice, then check the gate the runtime would consult.
    const capped = buf.slice(-1000)
    // The busy marker has been evicted; backward scan finds no lifecycle
    // event at all -> returns false -> tryDrainQueue dispatches MID-compaction.
    expect(isSessionBusy({ events: capped, sessionId: SID })).toBe(false)
  })

  test('B2 control: with the busy marker still in the buffer the gate holds', () => {
    const events = buffer([
      userMsg('msg_cu', 5),
      statusBusy(),
      assistantMsg('msg_summary', 'msg_cu', 6),
      assistantMsg('msg_summary', 'msg_cu', 6),
    ])
    expect(isSessionBusy({ events, sessionId: SID })).toBe(true)
  })
})

describe('#55 stock 0.27.0 — post-compaction idle drain gate', () => {
  test('B3: clean compaction summary counts as a natural completion — idle gate drains (queue-held case works)', () => {
    const events = buffer([
      userMsg('msg_u0', 1),
      assistantMsg('msg_a0', 'msg_u0', 2, { finish: 'stop', completed: 3 }),
      userMsg('msg_cu', 5),
      statusBusy(),
      assistantMsg('msg_summary', 'msg_cu', 6),
      assistantMsg('msg_summary', 'msg_cu', 6, { finish: 'stop', completed: 7, summary: true }),
      sessionIdle(),
    ])
    expect(
      doesLatestUserTurnHaveNaturalCompletion({ events, sessionId: SID }),
    ).toBe(true)
  })

  test('B4 STRAND: dispatched-mid-compaction prompt with no assistant turn makes the idle gate reject — nothing re-dispatches it', () => {
    // /q was dispatched mid-compaction (B1/B2 race). Its user message is in
    // the buffer. The server dropped the work (Runner.ensureRunning discards
    // submitted work while Running; the run loop's final read already
    // happened). At idle, the latest user turn is the stranded prompt with
    // NO assistant children -> natural completion is false.
    const events = buffer([
      userMsg('msg_u0', 1),
      assistantMsg('msg_a0', 'msg_u0', 2, { finish: 'stop', completed: 3 }),
      userMsg('msg_cu', 5),
      statusBusy(),
      userMsg('msg_queued_prompt', 6), // dispatched mid-compaction, persisted
      assistantMsg('msg_summary', 'msg_cu', 7, { finish: 'stop', completed: 8, summary: true }),
      sessionIdle(),
    ])
    // The summary is NOT the assistant of the latest user turn (parentID is
    // the compaction user message, not the queued prompt).
    expect(getLatestUserMessage({ events, sessionId: SID })?.id).toBe('msg_queued_prompt')
    expect(
      doesLatestUserTurnHaveNaturalCompletion({ events, sessionId: SID }),
    ).toBe(false)
    // Consequence: handleSessionIdle returns without draining. The local
    // queue is already empty (item was dequeued at dispatch — fire-and-forget
    // with no delivery tracking), so the prompt is stranded forever.
  })

  test('B5: aborted/errored compaction summary is not a natural completion — idle gate also rejects', () => {
    const events = buffer([
      userMsg('msg_cu', 5),
      statusBusy(),
      assistantMsg('msg_summary', 'msg_cu', 6, {
        finish: 'error',
        completed: 7,
        summary: true,
        error: { name: 'AbortedError' },
      }),
      sessionIdle(),
    ])
    expect(
      doesLatestUserTurnHaveNaturalCompletion({ events, sessionId: SID }),
    ).toBe(false)
  })
})
