/** Tests external OpenCode user-message filtering for Discord mirroring and ownership. */

import { describe, expect, test } from 'vitest'
import {
  externalOpencodeSyncInternals,
  getIgnoredNoticeTextParts,
  getRenderableUserTextParts,
  isExternalSyncRootSession,
  isInternalOpenCodeUserMessage,
  isLatestUserTurnFromDiscord,
  shouldSkipExternalAssistantMessage,
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

  test('finds the latest Discord turn when v2 returns newest messages first', () => {
    const oldDiscordMessage: SessionMessageLike = {
      info: { role: 'user', time: { created: 10 } },
      parts: [
        {
          id: 'discord-origin',
          sessionID: 'session-1',
          messageID: 'message-1',
          type: 'text',
          text: '<discord-user name="Tommy" />',
          synthetic: true,
        },
        {
          id: 'discord-text',
          sessionID: 'session-1',
          messageID: 'message-1',
          type: 'text',
          text: 'old Discord turn',
        },
      ],
    }
    const latestExternalMessage: SessionMessageLike = {
      ...textMessage({ text: 'latest external turn' }),
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
