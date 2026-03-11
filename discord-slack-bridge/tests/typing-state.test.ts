// Unit tests for pure event-sourced typing intent derivation.

import { describe, expect, test } from 'vitest'
import {
  appendTypingEvent,
  deriveTypingIntent,
  type TypingEvent,
} from '../src/typing-state.js'

describe('typing-state', () => {
  test('starts immediately on first start-requested', () => {
    const events: TypingEvent[] = [
      {
        type: 'typing.start-requested',
        atMs: 1000,
        source: 'discord-route',
      },
    ]

    const intent = deriveTypingIntent({
      events,
      nowMs: 1000,
    })

    expect(intent).toMatchInlineSnapshot(`
      {
        "blockedByRateLimit": false,
        "clearReason": undefined,
        "hasStartAfterStatus": true,
        "isTypingActive": false,
        "nextWakeAtMs": undefined,
        "shouldClearStatus": false,
        "shouldSendStatus": true,
        "statusMode": "start",
      }
    `)
  })

  test('dedupes repeated start requests while lease is active', () => {
    const events: TypingEvent[] = [
      {
        type: 'typing.start-requested',
        atMs: 1000,
        source: 'discord-route',
      },
      {
        type: 'slack.status-sent',
        atMs: 1000,
        channelId: 'C1',
        threadTs: '1710000000.000001',
        statusText: 'Typing...',
        mode: 'start',
      },
      {
        type: 'typing.start-requested',
        atMs: 1500,
        source: 'discord-route',
      },
      {
        type: 'typing.start-requested',
        atMs: 2000,
        source: 'discord-route',
      },
    ]

    const intent = deriveTypingIntent({ events, nowMs: 2500 })

    expect(intent).toMatchInlineSnapshot(`
      {
        "blockedByRateLimit": false,
        "clearReason": undefined,
        "hasStartAfterStatus": true,
        "isTypingActive": true,
        "nextWakeAtMs": 11000,
        "shouldClearStatus": false,
        "shouldSendStatus": false,
        "statusMode": undefined,
      }
    `)
  })

  test('refreshes at lease boundary when new start arrived during lease', () => {
    const events: TypingEvent[] = [
      {
        type: 'slack.status-sent',
        atMs: 1000,
        channelId: 'C1',
        threadTs: '1710000000.000001',
        statusText: 'Typing...',
        mode: 'start',
      },
      {
        type: 'typing.start-requested',
        atMs: 5000,
        source: 'discord-route',
      },
    ]

    const intent = deriveTypingIntent({ events, nowMs: 11_100 })

    expect(intent).toMatchInlineSnapshot(`
      {
        "blockedByRateLimit": false,
        "clearReason": undefined,
        "hasStartAfterStatus": true,
        "isTypingActive": true,
        "nextWakeAtMs": undefined,
        "shouldClearStatus": false,
        "shouldSendStatus": true,
        "statusMode": "refresh",
      }
    `)
  })

  test('does not stop immediately on assistant message; stops after debounce', () => {
    const baseEvents: TypingEvent[] = [
      {
        type: 'slack.status-sent',
        atMs: 1000,
        channelId: 'C1',
        threadTs: '1710000000.000001',
        statusText: 'Typing...',
        mode: 'start',
      },
      {
        type: 'assistant.message-sent',
        atMs: 3000,
        source: 'bridge-rest',
        channelId: 'C1',
        threadTs: '1710000000.000001',
      },
    ]

    const beforeDebounce = deriveTypingIntent({ events: baseEvents, nowMs: 4500 })
    const afterDebounce = deriveTypingIntent({ events: baseEvents, nowMs: 5000 })

    expect({ beforeDebounce, afterDebounce }).toMatchInlineSnapshot(`
      {
        "afterDebounce": {
          "blockedByRateLimit": false,
          "clearReason": "assistant-debounce",
          "hasStartAfterStatus": false,
          "isTypingActive": true,
          "nextWakeAtMs": undefined,
          "shouldClearStatus": true,
          "shouldSendStatus": false,
          "statusMode": undefined,
        },
        "beforeDebounce": {
          "blockedByRateLimit": false,
          "clearReason": undefined,
          "hasStartAfterStatus": false,
          "isTypingActive": true,
          "nextWakeAtMs": 5000,
          "shouldClearStatus": false,
          "shouldSendStatus": false,
          "statusMode": undefined,
        },
      }
    `)
  })

  test('new start during stop debounce keeps typing active', () => {
    const events: TypingEvent[] = [
      {
        type: 'slack.status-sent',
        atMs: 1000,
        channelId: 'C1',
        threadTs: '1710000000.000001',
        statusText: 'Typing...',
        mode: 'start',
      },
      {
        type: 'assistant.message-sent',
        atMs: 3000,
        source: 'bridge-rest',
        channelId: 'C1',
        threadTs: '1710000000.000001',
      },
      {
        type: 'typing.start-requested',
        atMs: 3500,
        source: 'discord-route',
      },
    ]

    const intent = deriveTypingIntent({ events, nowMs: 5200 })

    expect(intent).toMatchInlineSnapshot(`
      {
        "blockedByRateLimit": false,
        "clearReason": undefined,
        "hasStartAfterStatus": true,
        "isTypingActive": true,
        "nextWakeAtMs": 11000,
        "shouldClearStatus": false,
        "shouldSendStatus": false,
        "statusMode": undefined,
      }
    `)
  })

  test('clears on lease expiry when no new start was requested', () => {
    const events: TypingEvent[] = [
      {
        type: 'slack.status-sent',
        atMs: 1000,
        channelId: 'C1',
        threadTs: '1710000000.000001',
        statusText: 'Typing...',
        mode: 'start',
      },
    ]

    const intent = deriveTypingIntent({ events, nowMs: 11_100 })

    expect(intent).toMatchInlineSnapshot(`
      {
        "blockedByRateLimit": false,
        "clearReason": "lease-expired",
        "hasStartAfterStatus": false,
        "isTypingActive": true,
        "nextWakeAtMs": undefined,
        "shouldClearStatus": true,
        "shouldSendStatus": false,
        "statusMode": undefined,
      }
    `)
  })

  test('rate limit blocks immediate send and schedules wake at retry', () => {
    const events: TypingEvent[] = [
      {
        type: 'typing.start-requested',
        atMs: 1000,
        source: 'discord-route',
      },
      {
        type: 'slack.rate-limited',
        atMs: 1100,
        channelId: 'C1',
        threadTs: '1710000000.000001',
        retryAfterMs: 1500,
        retryAtMs: 2600,
        method: 'assistant.threads.setStatus',
      },
    ]

    const blocked = deriveTypingIntent({ events, nowMs: 1200 })
    const unblocked = deriveTypingIntent({ events, nowMs: 2600 })

    expect({ blocked, unblocked }).toMatchInlineSnapshot(`
      {
        "blocked": {
          "blockedByRateLimit": true,
          "clearReason": undefined,
          "hasStartAfterStatus": true,
          "isTypingActive": false,
          "nextWakeAtMs": 2600,
          "shouldClearStatus": false,
          "shouldSendStatus": false,
          "statusMode": undefined,
        },
        "unblocked": {
          "blockedByRateLimit": false,
          "clearReason": undefined,
          "hasStartAfterStatus": true,
          "isTypingActive": false,
          "nextWakeAtMs": undefined,
          "shouldClearStatus": false,
          "shouldSendStatus": true,
          "statusMode": "start",
        },
      }
    `)
  })

  test('appendTypingEvent keeps only newest maxEvents entries', () => {
    const events: TypingEvent[] = [
      {
        type: 'typing.start-requested',
        atMs: 1,
        source: 'discord-route',
      },
      {
        type: 'tick',
        atMs: 2,
      },
    ]

    const appended = appendTypingEvent({
      events,
      event: {
        type: 'tick',
        atMs: 3,
      },
      maxEvents: 2,
    })

    expect(appended).toMatchInlineSnapshot(`
      [
        {
          "atMs": 2,
          "type": "tick",
        },
        {
          "atMs": 3,
          "type": "tick",
        },
      ]
    `)
  })
})
