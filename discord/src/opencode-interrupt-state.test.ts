// These tests are derived from real OpenCode event logs, not invented streams.
//
// Extraction workflow used:
// 1) Export persisted Kimaki runtime events for a session:
//    `pnpm tsx src/cli.ts session export-events-jsonl --session <id> --out ../tmp/<id>.jsonl`
// 2) Inspect timeline with jq:
//    `jq -r '[.timestamp, .event.type, (.event.properties.status.type // .event.properties.info.role // ""), (.event.properties.info.id // .event.properties.sessionID // ""), (.event.properties.info.parentID // "")] | @tsv' ../tmp/<id>.jsonl`
// 3) Trim to minimal events that affect interrupt state transitions:
//    - `session.status` (retry)
//    - `message.updated` assistant with `parentID` (marks queued message sent)
//    - `session.deleted` (cleanup)
//
// Real-world session used below for rate-limit regression:
// - session: ses_34227488cffeO6V9KFc4QRzCr1
// - queued message that stayed unsent in the incident: msg_cbdd923e5001ZSCxCbj9oGbdHV
//
// Real-world session used below for successful sleep interruption:
// - session: ses_342257e56ffeNdEEQ3lVVR3sZe
// - interrupting user message (while sleep tool was running):
//   msg_cbddad73c001LZrsb4XMZt5Lls
// - this trace was captured with the interrupt plugin enabled, so after abort the
//   next assistant parent points to a synthetic empty user message created by
//   `promptAsync({ parts: [] })`, not to the interrupting user message itself.

import { describe, expect, test } from 'vitest'
import {
  createInterruptState,
  getPendingInterruptMessage,
  hasUnsentPendingMessage,
  reduceInterruptState,
  type InterruptAction,
  type InterruptEvent,
  type InterruptState,
} from './opencode-interrupt-state.js'

const REAL_RATE_LIMIT_CASE = {
  sessionID: 'ses_34227488cffeO6V9KFc4QRzCr1',
  previousMessageID: 'msg_cbdd8fa01001UYKvAEc7rx3nTO',
  queuedMessageID: 'msg_cbdd923e5001ZSCxCbj9oGbdHV',
  events: [
    {
      type: 'session.status',
      properties: {
        sessionID: 'ses_34227488cffeO6V9KFc4QRzCr1',
        status: {
          type: 'retry',
          attempt: 1,
          message: 'Resource exhausted, please retry after 8.643s.',
          next: 1772711648923,
        },
      },
    },
    {
      type: 'message.updated',
      properties: {
        info: {
          role: 'assistant',
          sessionID: 'ses_34227488cffeO6V9KFc4QRzCr1',
          parentID: 'msg_cbdd8fa01001UYKvAEc7rx3nTO',
        },
      },
    },
  ] as InterruptEvent[],
}

const REAL_SLEEP_INTERRUPT_WITH_PLUGIN_RECOVERY = {
  sessionID: 'ses_342257e56ffeNdEEQ3lVVR3sZe',
  runningMessageID: 'msg_cbddaa49c00123dKnwvzTVjutL',
  interruptingMessageID: 'msg_cbddad73c001LZrsb4XMZt5Lls',
  events: [
    {
      type: 'message.updated',
      properties: {
        info: {
          role: 'assistant',
          sessionID: 'ses_342257e56ffeNdEEQ3lVVR3sZe',
          parentID: 'msg_cbddaa49c00123dKnwvzTVjutL',
        },
      },
    },
    {
      type: 'session.idle',
      properties: {
        sessionID: 'ses_342257e56ffeNdEEQ3lVVR3sZe',
      },
    },
    {
      type: 'session.error',
      properties: {
        sessionID: 'ses_342257e56ffeNdEEQ3lVVR3sZe',
        error: {
          name: 'MessageAbortedError',
          data: { message: 'The operation was aborted.' },
        },
      },
    },
  ] as InterruptEvent[],
}

const NORMALIZED_SLEEP_INTERRUPT_WITHOUT_PLUGIN = {
  sessionID: 'ses_342257e56ffeNdEEQ3lVVR3sZe',
  interruptingMessageID: 'msg_cbddad73c001LZrsb4XMZt5Lls',
  events: [
    {
      type: 'message.updated',
      properties: {
        info: {
          role: 'assistant',
          sessionID: 'ses_342257e56ffeNdEEQ3lVVR3sZe',
          parentID: 'msg_cbddad73c001LZrsb4XMZt5Lls',
        },
      },
    },
  ] as InterruptEvent[],
}

function queueMessage({
  state,
  sessionID,
  messageID,
}: {
  state: InterruptState
  sessionID: string
  messageID: string
}): InterruptState {
  return reduceInterruptState({
    state,
    action: {
      type: 'queue',
      sessionID,
      messageID,
    },
  })
}

function replayEvents({
  state,
  events,
}: {
  state: InterruptState
  events: InterruptEvent[]
}): InterruptState {
  return events.reduce((currentState, event) => {
    const action: InterruptAction = {
      type: 'event',
      event,
    }
    return reduceInterruptState({ state: currentState, action })
  }, state)
}

function sessionStatusRetry({ sessionID }: { sessionID: string }): InterruptEvent {
  return {
    type: 'session.status',
    properties: {
      sessionID,
      status: {
        type: 'retry',
        attempt: 1,
        message: 'rate limited',
        next: Date.now() + 1_000,
      },
    },
  } as InterruptEvent
}

function assistantStarted({
  sessionID,
  parentID,
}: {
  sessionID: string
  parentID: string
}): InterruptEvent {
  return {
    type: 'message.updated',
    properties: {
      info: {
        role: 'assistant',
        sessionID,
        parentID,
      },
    },
  } as InterruptEvent
}

function sessionDeleted({ sessionID }: { sessionID: string }): InterruptEvent {
  return {
    type: 'session.deleted',
    properties: {
      info: {
        id: sessionID,
      },
    },
  } as InterruptEvent
}

describe('opencode interrupt state', () => {
  test('retry-only stream keeps queued message unsent', () => {
    const sessionID = 'ses-rate-limit'
    const messageID = 'msg-queued'

    const queuedState = queueMessage({
      state: createInterruptState(),
      sessionID,
      messageID,
    })

    const nextState = replayEvents({
      state: queuedState,
      events: [
        sessionStatusRetry({ sessionID }),
        sessionStatusRetry({ sessionID }),
        sessionStatusRetry({ sessionID }),
      ],
    })

    expect(hasUnsentPendingMessage({ state: nextState, messageID })).toBe(true)
  })

  test('assistant parent event marks queued message as sent', () => {
    const sessionID = 'ses-sent'
    const messageID = 'msg-sent'

    const queuedState = queueMessage({
      state: createInterruptState(),
      sessionID,
      messageID,
    })

    const nextState = replayEvents({
      state: queuedState,
      events: [
        sessionStatusRetry({ sessionID }),
        assistantStarted({ sessionID, parentID: messageID }),
      ],
    })

    expect(getPendingInterruptMessage({ state: nextState, messageID })).toEqual({
      sessionID,
      messageID,
      sent: true,
    })
    expect(hasUnsentPendingMessage({ state: nextState, messageID })).toBe(false)
  })

  test('later interrupt message stays unsent after earlier one is marked sent', () => {
    const sessionID = 'ses-multi-interrupt'
    const firstMessageID = 'msg-first'
    const secondMessageID = 'msg-second'

    const queuedState = queueMessage({
      state: queueMessage({
        state: createInterruptState(),
        sessionID,
        messageID: firstMessageID,
      }),
      sessionID,
      messageID: secondMessageID,
    })

    const nextState = replayEvents({
      state: queuedState,
      events: [
        sessionStatusRetry({ sessionID }),
        assistantStarted({ sessionID, parentID: firstMessageID }),
        sessionStatusRetry({ sessionID }),
      ],
    })

    expect(hasUnsentPendingMessage({ state: nextState, messageID: firstMessageID })).toBe(false)
    expect(
      hasUnsentPendingMessage({ state: nextState, messageID: secondMessageID }),
    ).toBe(true)
  })

  test('real rate-limit replay keeps latest queued message unsent', () => {
    const queuedState = queueMessage({
      state: queueMessage({
        state: createInterruptState(),
        sessionID: REAL_RATE_LIMIT_CASE.sessionID,
        messageID: REAL_RATE_LIMIT_CASE.previousMessageID,
      }),
      sessionID: REAL_RATE_LIMIT_CASE.sessionID,
      messageID: REAL_RATE_LIMIT_CASE.queuedMessageID,
    })

    const nextState = replayEvents({
      state: queuedState,
      events: REAL_RATE_LIMIT_CASE.events,
    })

    expect(
      hasUnsentPendingMessage({
        state: nextState,
        messageID: REAL_RATE_LIMIT_CASE.previousMessageID,
      }),
    ).toBe(false)
    expect(
      hasUnsentPendingMessage({
        state: nextState,
        messageID: REAL_RATE_LIMIT_CASE.queuedMessageID,
      }),
    ).toBe(true)
  })

  test('real sleep interrupt replay keeps interrupt message unsent with plugin recovery trace', () => {
    const queuedState = queueMessage({
      state: queueMessage({
        state: createInterruptState(),
        sessionID: REAL_SLEEP_INTERRUPT_WITH_PLUGIN_RECOVERY.sessionID,
        messageID: REAL_SLEEP_INTERRUPT_WITH_PLUGIN_RECOVERY.runningMessageID,
      }),
      sessionID: REAL_SLEEP_INTERRUPT_WITH_PLUGIN_RECOVERY.sessionID,
      messageID: REAL_SLEEP_INTERRUPT_WITH_PLUGIN_RECOVERY.interruptingMessageID,
    })

    const nextState = replayEvents({
      state: queuedState,
      events: REAL_SLEEP_INTERRUPT_WITH_PLUGIN_RECOVERY.events,
    })

    expect(
      hasUnsentPendingMessage({
        state: nextState,
        messageID: REAL_SLEEP_INTERRUPT_WITH_PLUGIN_RECOVERY.runningMessageID,
      }),
    ).toBe(false)
    expect(
      hasUnsentPendingMessage({
        state: nextState,
        messageID: REAL_SLEEP_INTERRUPT_WITH_PLUGIN_RECOVERY.interruptingMessageID,
      }),
    ).toBe(true)
  })

  test('normalized sleep interrupt replay without plugin marks interrupt message sent', () => {
    const queuedState = queueMessage({
      state: createInterruptState(),
      sessionID: NORMALIZED_SLEEP_INTERRUPT_WITHOUT_PLUGIN.sessionID,
      messageID: NORMALIZED_SLEEP_INTERRUPT_WITHOUT_PLUGIN.interruptingMessageID,
    })

    const nextState = replayEvents({
      state: queuedState,
      events: NORMALIZED_SLEEP_INTERRUPT_WITHOUT_PLUGIN.events,
    })

    expect(
      hasUnsentPendingMessage({
        state: nextState,
        messageID: NORMALIZED_SLEEP_INTERRUPT_WITHOUT_PLUGIN.interruptingMessageID,
      }),
    ).toBe(false)
  })

  test('session deleted removes all pending messages for that session', () => {
    const targetSessionID = 'ses-delete-target'
    const otherSessionID = 'ses-other'

    const queuedState = queueMessage({
      state: queueMessage({
        state: createInterruptState(),
        sessionID: targetSessionID,
        messageID: 'msg-target',
      }),
      sessionID: otherSessionID,
      messageID: 'msg-other',
    })

    const nextState = replayEvents({
      state: queuedState,
      events: [sessionDeleted({ sessionID: targetSessionID })],
    })

    expect(nextState.pendingByMessageId).toMatchInlineSnapshot(`
      {
        "msg-other": {
          "messageID": "msg-other",
          "sent": false,
          "sessionID": "ses-other",
        },
      }
    `)
  })
})
