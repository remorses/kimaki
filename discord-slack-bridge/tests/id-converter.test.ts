import { describe, test, expect } from 'vitest'
import {
  encodeThreadId,
  decodeThreadId,
  encodeMessageId,
  decodeMessageId,
  isThreadChannelId,
  isEncodedMessageId,
  resolveSlackTarget,
  slackTsToIso,
  resolveDiscordChannelId,
} from '../src/id-converter.js'

describe('encodeThreadId / decodeThreadId', () => {
  test('roundtrips correctly', () => {
    const channel = 'C04ABC123'
    const threadTs = '1503435956.000247'
    const encoded = encodeThreadId(channel, threadTs)
    expect(encoded).toMatchInlineSnapshot(`"THR_C04ABC123_1503435956000247"`)

    const decoded = decodeThreadId(encoded)
    expect(decoded).toMatchInlineSnapshot(`
      {
        "channel": "C04ABC123",
        "threadTs": "1503435956.000247",
      }
    `)
  })

  test('handles different channels', () => {
    expect(encodeThreadId('G0PRIVATE', '1700000000.123456')).toMatchInlineSnapshot(
      `"THR_G0PRIVATE_1700000000123456"`,
    )
  })

  test('throws on invalid thread ID', () => {
    expect(() => decodeThreadId('C04ABC123')).toThrow('Invalid thread channel ID')
    expect(() => decodeThreadId('MSG_C04_123')).toThrow('Invalid thread channel ID')
    expect(() => decodeThreadId('')).toThrow('Invalid thread channel ID')
    expect(() => decodeThreadId('THR_C04ABC123_123456')).toThrow(
      'Invalid encoded Slack timestamp',
    )
  })

  test('throws when encoding malformed Slack timestamp', () => {
    expect(() => encodeThreadId('C04ABC123', '1503435956')).toThrow(
      'Invalid Slack timestamp',
    )
  })
})

describe('encodeMessageId / decodeMessageId', () => {
  test('roundtrips correctly', () => {
    const channel = 'C04ABC123'
    const ts = '1503435956.000247'
    const encoded = encodeMessageId(channel, ts)
    expect(encoded).toMatchInlineSnapshot(`"MSG_C04ABC123_1503435956000247"`)

    const decoded = decodeMessageId(encoded)
    expect(decoded).toMatchInlineSnapshot(`
      {
        "channel": "C04ABC123",
        "ts": "1503435956.000247",
      }
    `)
  })

  test('throws on invalid message ID', () => {
    expect(() => decodeMessageId('THR_C04_123')).toThrow('Invalid message ID')
    expect(() => decodeMessageId('random')).toThrow('Invalid message ID')
    expect(() => decodeMessageId('MSG_C04ABC123_123456')).toThrow(
      'Invalid encoded Slack timestamp',
    )
  })

  test('throws when encoding malformed message timestamp', () => {
    expect(() => encodeMessageId('C04ABC123', '1503435956')).toThrow(
      'Invalid Slack timestamp',
    )
  })
})

describe('isThreadChannelId', () => {
  test('identifies thread IDs', () => {
    expect(isThreadChannelId('THR_C04ABC123_1503435956000247')).toBe(true)
    expect(isThreadChannelId('C04ABC123')).toBe(false)
    expect(isThreadChannelId('MSG_C04ABC123_1503435956000247')).toBe(false)
  })
})

describe('isEncodedMessageId', () => {
  test('identifies encoded message IDs', () => {
    expect(isEncodedMessageId('MSG_C04ABC123_1503435956000247')).toBe(true)
    expect(isEncodedMessageId('THR_C04ABC123_1503435956000247')).toBe(false)
    expect(isEncodedMessageId('C04ABC123')).toBe(false)
  })
})

describe('resolveSlackTarget', () => {
  test('resolves thread channel to channel + threadTs', () => {
    const result = resolveSlackTarget('THR_C04ABC123_1503435956000247')
    expect(result).toMatchInlineSnapshot(`
      {
        "channel": "C04ABC123",
        "threadTs": "1503435956.000247",
      }
    `)
  })

  test('passes through regular channel ID', () => {
    const result = resolveSlackTarget('C04ABC123')
    expect(result.channel).toBe('C04ABC123')
    expect(result.threadTs).toBeUndefined()
  })
})

describe('slackTsToIso', () => {
  test('converts Slack timestamp to ISO', () => {
    const iso = slackTsToIso('1503435956.000247')
    // Verify it's a valid ISO date string (exact value depends on timezone)
    expect(new Date(iso).getTime()).toBe(1503435956000)
  })
})

describe('resolveDiscordChannelId', () => {
  test('returns thread ID for thread replies', () => {
    const result = resolveDiscordChannelId(
      'C04ABC123',
      '1503435900.000100',
      '1503435956.000247',
    )
    expect(result).toMatchInlineSnapshot(`"THR_C04ABC123_1503435900000100"`)
  })

  test('returns channel ID for parent messages', () => {
    // thread_ts == ts means this is the parent message
    const result = resolveDiscordChannelId(
      'C04ABC123',
      '1503435956.000247',
      '1503435956.000247',
    )
    expect(result).toBe('C04ABC123')
  })

  test('returns channel ID for non-thread messages', () => {
    const result = resolveDiscordChannelId('C04ABC123', undefined, '1503435956.000247')
    expect(result).toBe('C04ABC123')
  })
})
