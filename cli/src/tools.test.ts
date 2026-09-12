// Tests voice prompt admission correlation with native terminal executions.

import type {
  SessionExecutionFailed,
  SessionExecutionInterrupted,
  SessionExecutionSucceeded,
  SessionInboxDelivered,
  SessionLogOutput,
} from '@opencode/client'
import { describe, expect, test } from 'vitest'
import { deriveVoicePromptTerminal } from './tools.js'

const sessionId = 'ses_voice'
const inboxId = 'inbox_voice'

function delivered({ seq = 2, id = inboxId }: { seq?: number; id?: string } = {}): SessionInboxDelivered {
  return {
    id: `event-delivered-${seq}`,
    created: seq,
    type: 'session.inbox.delivered',
    durable: { aggregateID: sessionId, seq, version: 1 },
    data: { sessionID: sessionId, inboxID: id },
  }
}

function succeeded(seq: number): SessionExecutionSucceeded {
  return {
    id: `event-succeeded-${seq}`,
    created: seq,
    type: 'session.execution.succeeded',
    durable: { aggregateID: sessionId, seq, version: 1 },
    data: { sessionID: sessionId },
  }
}

function failed(seq: number): SessionExecutionFailed {
  return {
    id: `event-failed-${seq}`,
    created: seq,
    type: 'session.execution.failed',
    durable: { aggregateID: sessionId, seq, version: 1 },
    data: {
      sessionID: sessionId,
      error: { type: 'ProviderError', message: 'provider failed' },
    },
  }
}

function interrupted(seq: number): SessionExecutionInterrupted {
  return {
    id: `event-interrupted-${seq}`,
    created: seq,
    type: 'session.execution.interrupted',
    durable: { aggregateID: sessionId, seq, version: 1 },
    data: { sessionID: sessionId, reason: 'user' },
  }
}

function derive(events: SessionLogOutput[]) {
  return deriveVoicePromptTerminal({ events, sessionId, inboxId })
}

describe('deriveVoicePromptTerminal', () => {
  test('returns the successful execution after the admitted inbox delivery', () => {
    expect(derive([succeeded(1), delivered(), succeeded(3)])).toMatchObject({
      type: 'session.execution.succeeded',
      durable: { seq: 3 },
    })
  })

  test('returns errors for failed and interrupted admitted executions', () => {
    expect(derive([delivered(), failed(3)])).toMatchInlineSnapshot(
      `[VoicePromptExecutionError: Voice prompt execution failed: provider failed]`,
    )
    expect(derive([delivered(), interrupted(3)])).toMatchInlineSnapshot(
      `[VoicePromptExecutionError: Voice prompt execution was interrupted: user]`,
    )
  })

  test('requires delivery and a later terminal execution', () => {
    expect(derive([succeeded(3)])).toMatchInlineSnapshot(
      `[VoicePromptExecutionError: Voice prompt inbox item inbox_voice was not delivered]`,
    )
    expect(derive([delivered()])).toMatchInlineSnapshot(
      `[VoicePromptExecutionError: Voice prompt inbox item inbox_voice has no terminal execution]`,
    )
    expect(derive([delivered({ id: 'another-inbox' }), succeeded(3)]))
      .toMatchInlineSnapshot(
        `[VoicePromptExecutionError: Voice prompt inbox item inbox_voice was not delivered]`,
      )
  })
})
