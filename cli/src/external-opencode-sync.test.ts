/** Tests external OpenCode user-message filtering for Discord mirroring and ownership. */

import { describe, expect, test } from 'vitest'
import {
  getRenderableUserTextParts,
  isLatestUserTurnFromDiscord,
  type SessionMessageLike,
} from './external-opencode-sync.js'

function textMessage({
  text,
  ignored,
  synthetic,
}: {
  text: string
  ignored?: boolean
  synthetic?: boolean
}): SessionMessageLike {
  return {
    info: { role: 'user' },
    parts: [
      {
        id: 'part-1',
        sessionID: 'session-1',
        messageID: 'message-1',
        type: 'text',
        text,
        ignored,
        synthetic,
      },
    ],
  }
}

describe('external OpenCode user-message filtering', () => {
  test('keeps normal external user text renderable', () => {
    const message = textMessage({ text: 'Run the tests' })

    expect(getRenderableUserTextParts({ message })).toEqual([
      { id: 'part-1', text: 'Run the tests' },
    ])
  })

  test('skips ignored plugin notices', () => {
    const message = textMessage({
      text: 'Subrouter: xai/grok-4.6 was rate limited.',
      ignored: true,
    })

    expect(getRenderableUserTextParts({ message })).toEqual([])
  })

  test('skips synthetic context parts', () => {
    const message = textMessage({
      text: '<discord-user name="Tommy" />',
      synthetic: true,
    })

    expect(getRenderableUserTextParts({ message })).toEqual([])
  })

  test('does not treat an ignored notice as an external takeover', () => {
    const discordMessage: SessionMessageLike = {
      info: { role: 'user' },
      parts: [
        {
          id: 'part-2',
          sessionID: 'session-1',
          messageID: 'message-2',
          type: 'text',
          text: '<discord-user name="Tommy" />',
          synthetic: true,
        },
        {
          id: 'part-3',
          sessionID: 'session-1',
          messageID: 'message-2',
          type: 'text',
          text: 'What failed?',
        },
      ],
    }
    const notice = textMessage({
      text: 'Subrouter: xai/grok-4.6 was rate limited.',
      ignored: true,
    })

    expect(
      isLatestUserTurnFromDiscord({ messages: [discordMessage, notice] }),
    ).toBe(true)
  })
})
