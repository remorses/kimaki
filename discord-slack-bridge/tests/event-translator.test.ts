// Tests event translation from Slack payloads into Discord gateway payloads.

import { describe, expect, test } from 'vitest'
import { translateReaction } from '../src/event-translator.js'

describe('translateReaction', () => {
  test('uses parent channel for top-level message reactions', () => {
    const translated = translateReaction({
      event: {
        type: 'reaction_added',
        user: 'U123',
        reaction: 'thumbsup',
        item: {
          type: 'message',
          channel: 'C123',
          ts: '1700000000.123456',
        },
      },
      guildId: 'T123',
      threadTs: '1700000000.123456',
    })

    expect(translated.data.channel_id).toBe('C123')
  })

  test('uses encoded thread channel for threaded reactions', () => {
    const translated = translateReaction({
      event: {
        type: 'reaction_removed',
        user: 'U123',
        reaction: 'eyes',
        item: {
          type: 'message',
          channel: 'C123',
          ts: '1700000001.123456',
        },
      },
      guildId: 'T123',
      threadTs: '1700000000.123456',
    })

    expect(translated.data.channel_id).toBe('THR_C123_1700000000123456')
  })
})
