/** Tests external OpenCode user-message filtering for Discord mirroring and ownership. */

import { describe, expect, test } from 'vitest'
import {
  getIgnoredNoticeTextParts,
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

  test('skips ignored plugin notices from user mirroring', () => {
    const message = textMessage({
      text: 'Subrouter: xai/grok-4.6 was rate limited.',
      ignored: true,
    })

    expect(getRenderableUserTextParts({ message })).toEqual([])
  })

  test('collects ignored plugin notices as bot text', () => {
    const message = textMessage({
      text: 'Subrouter: Using openai/gpt-5.6-sol because xai/grok-4.6 is rate limited.',
      ignored: true,
    })

    expect(getIgnoredNoticeTextParts({ message })).toEqual([
      {
        id: 'part-1',
        text: 'Subrouter: Using openai/gpt-5.6-sol because xai/grok-4.6 is rate limited.',
      },
    ])
  })

  test('does not collect synthetic or normal user text as ignored notices', () => {
    expect(getIgnoredNoticeTextParts({
      message: textMessage({ text: 'Run the tests' }),
    })).toEqual([])
    expect(getIgnoredNoticeTextParts({
      message: textMessage({
        text: '<discord-user name="Tommy" />',
        synthetic: true,
      }),
    })).toEqual([])
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
