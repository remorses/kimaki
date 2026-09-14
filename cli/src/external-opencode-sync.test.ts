/** Tests external OpenCode user-message filtering for Discord mirroring and ownership. */

import { describe, expect, test } from 'vitest'
import {
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

  test('skips compaction user messages when deciding Discord ownership', () => {
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
          text: 'Fix the tabs',
        },
      ],
    }
    const compactionUser: SessionMessageLike = {
      info: { role: 'user' },
      parts: [
        {
          id: 'part-4',
          sessionID: 'session-1',
          messageID: 'message-4',
          type: 'compaction',
          auto: true,
        },
      ],
    }

    expect(isInternalOpenCodeUserMessage({ message: compactionUser })).toBe(true)
    expect(
      isLatestUserTurnFromDiscord({ messages: [discordMessage, compactionUser] }),
    ).toBe(true)
  })

  test('skips compaction continue users when deciding Discord ownership', () => {
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
          text: 'Fix the tabs',
        },
      ],
    }
    const continueUser: SessionMessageLike = {
      info: { role: 'user' },
      parts: [
        {
          id: 'part-5',
          sessionID: 'session-1',
          messageID: 'message-5',
          type: 'text',
          text: 'Continue if you have next steps',
          synthetic: true,
          metadata: { compaction_continue: true },
        },
      ],
    }

    expect(isInternalOpenCodeUserMessage({ message: continueUser })).toBe(true)
    expect(
      isLatestUserTurnFromDiscord({ messages: [discordMessage, continueUser] }),
    ).toBe(true)
  })

  test('skips compaction summary assistants from external mirroring', () => {
    expect(shouldSkipExternalAssistantMessage({
      message: {
        info: { role: 'assistant', summary: true },
        parts: [
          {
            id: 'part-6',
            sessionID: 'session-1',
            messageID: 'message-6',
            type: 'text',
            text: 'internal compaction summary must not reach Discord',
          },
        ],
      },
    })).toBe(true)
  })

  test('does not skip a user-facing assistant just because the agent is named compaction', () => {
    expect(shouldSkipExternalAssistantMessage({
      message: {
        info: { role: 'assistant', agent: 'compaction' },
        parts: [
          {
            id: 'part-7',
            sessionID: 'session-1',
            messageID: 'message-7',
            type: 'text',
            text: 'user-facing reply',
          },
        ],
      },
    })).toBe(false)
  })
})
