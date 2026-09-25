/** Tests external OpenCode user-message filtering for Discord mirroring and ownership. */

import { describe, expect, test } from 'vitest'
import {
  externalOpencodeSyncInternals,
  getRenderableUserTextParts,
  isExternalSyncRootSession,
  isLatestUserTurnFromDiscord,
  type SessionMessageLike,
} from './external-opencode-sync.js'

function textMessage(text: string): SessionMessageLike {
  return {
    info: { role: 'user' },
    parts: [
      {
        id: 'part-1',
        sessionID: 'session-1',
        messageID: 'message-1',
        type: 'text',
        text,
      },
    ],
  }
}

describe('external OpenCode user-message filtering', () => {
  test('does not sync task child sessions into Discord', () => {
    expect(isExternalSyncRootSession({
      title: 'Design shader visual stack',
      parentID: 'ses_parent',
    })).toBe(false)
    expect(isExternalSyncRootSession({
      title: 'Main session',
    })).toBe(true)
  })

  test('keeps normal external user text renderable', () => {
    const message = textMessage('Run the tests')

    expect(getRenderableUserTextParts({ message })).toEqual([
      { id: 'part-1', text: 'Run the tests' },
    ])
  })

  test('extracts native v2 user text without Discord context XML', () => {
    const message = textMessage(
      'What failed?\n<discord-user name="Tommy" thread-id="thread-1" />',
    )

    expect(getRenderableUserTextParts({ message })).toEqual([
      { id: 'part-1', text: 'What failed?' },
    ])
    expect(isLatestUserTurnFromDiscord({ messages: [message] })).toBe(true)
  })

  test('finds the latest Discord turn when v2 returns newest messages first', () => {
    const oldDiscordMessage: SessionMessageLike = {
      info: { role: 'user', time: { created: 10 } },
      parts: [
        {
          id: 'discord-origin',
          sessionID: 'session-1',
          messageID: 'message-1',
          type: 'text',
          text: 'old Discord turn\n<discord-user name="Tommy" />',
        },
      ],
    }
    const latestExternalMessage: SessionMessageLike = {
      ...textMessage('latest external turn'),
      info: { role: 'user', time: { created: 20 } },
    }

    expect(
      isLatestUserTurnFromDiscord({
        messages: [latestExternalMessage, oldDiscordMessage],
      }),
    ).toBe(false)
  })
})

describe('external OpenCode session cutoff', () => {
  test('keeps only sessions updated after the directory sync start', () => {
    const sessions = [
      { id: 'recent', title: 'Recent', time: { created: 100, updated: 301 } },
      { id: 'old', title: 'Old', time: { created: 100, updated: 299 } },
      { id: 'boundary', title: 'Boundary', time: { created: 100, updated: 300 } },
    ]

    expect(
      externalOpencodeSyncInternals
        .selectSessionsForSync({ sessions, startMs: 300 })
        .map((session) => session.id),
    ).toEqual(['recent', 'boundary'])
  })
})
