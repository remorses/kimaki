import { describe, expect, test } from 'vitest'
import {
  getOpencodeEventSessionId,
  serializeOpencodeEventsJsonl,
} from './opencode-session-event-log.js'

describe('OpenCode event JSONL', () => {
  test('serializes native v2 events without a Kimaki wrapper', () => {
    const events = [
      {
        id: 'evt_created',
        created: 1_700_000_000_000,
        type: 'session.created',
        location: {
          directory: '/projects/example',
        },
        data: {
          sessionID: 'ses_native',
          projectID: 'project-native',
          location: {
            directory: '/projects/example',
          },
          slug: 'native-session',
          version: '1',
        },
      },
      {
        id: 'evt_succeeded',
        created: 1_700_000_000_100,
        type: 'session.execution.succeeded',
        data: {
          sessionID: 'ses_native',
          executionID: 'exe_native',
        },
      },
    ]

    expect(serializeOpencodeEventsJsonl(events)).toMatchInlineSnapshot(`
      "{\"id\":\"evt_created\",\"created\":1700000000000,\"type\":\"session.created\",\"location\":{\"directory\":\"/projects/example\"},\"data\":{\"sessionID\":\"ses_native\",\"projectID\":\"project-native\",\"location\":{\"directory\":\"/projects/example\"},\"slug\":\"native-session\",\"version\":\"1\"}}
      {\"id\":\"evt_succeeded\",\"created\":1700000000100,\"type\":\"session.execution.succeeded\",\"data\":{\"sessionID\":\"ses_native\",\"executionID\":\"exe_native\"}}
      "
    `)
  })

  test('does not add export-only fields', () => {
    const event = {
      id: 'evt_text',
      created: 1_700_000_000_200,
      type: 'session.text.delta',
      data: {
        sessionID: 'ses_native',
        partID: 'part_native',
        delta: 'hello',
      },
    }
    const jsonl = serializeOpencodeEventsJsonl([event])

    expect({
      hasEventWrapper: jsonl.includes('"event"'),
      hasProjectDirectory: jsonl.includes('"projectDirectory"'),
      hasThreadId: jsonl.includes('"threadId"'),
      hasTimestamp: jsonl.includes('"timestamp"'),
    }).toMatchInlineSnapshot(`
      {
        "hasEventWrapper": false,
        "hasProjectDirectory": false,
        "hasThreadId": false,
        "hasTimestamp": false,
      }
    `)
  })

  test('keeps session routing compatible with native and old stored events', () => {
    expect([
      getOpencodeEventSessionId({
        type: 'session.created',
        data: { sessionID: 'ses_native' },
      }),
      getOpencodeEventSessionId({
        type: 'session.updated',
        properties: { info: { id: 'ses_legacy' } },
      }),
    ]).toEqual(['ses_native', 'ses_legacy'])
  })

  test('serializes an empty stream as an empty file', () => {
    expect(serializeOpencodeEventsJsonl([])).toBe('')
  })
})
