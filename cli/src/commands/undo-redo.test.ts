// Tests native user-message history and boundaries for undo and redo.

import http from 'node:http'
import { OpenCode } from '@opencode/client'
import { describe, expect, test } from 'vitest'
import {
  getRedoBoundary,
  getUndoBoundary,
  listAllUserMessages,
} from './undo-redo.js'

describe('undo and redo boundaries', () => {
  const messages = [{ id: 'msg-z' }, { id: 'msg-a' }, { id: 'msg-m' }]

  test('uses history order instead of opaque message ID order', () => {
    expect(getUndoBoundary({ messages })).toEqual({ id: 'msg-m' })
    expect(getUndoBoundary({
      messages,
      revertMessageId: 'msg-m',
    })).toEqual({ id: 'msg-a' })
  })

  test('moves redo to the next user message', () => {
    expect(getRedoBoundary({
      messages,
      revertMessageId: 'msg-a',
    })).toEqual({ id: 'msg-m' })
    expect(getRedoBoundary({
      messages,
      revertMessageId: 'msg-m',
    })).toBeUndefined()
  })

  test('fails closed when the revert boundary is absent', () => {
    expect(getUndoBoundary({
      messages,
      revertMessageId: 'missing',
    })).toBeUndefined()
    expect(getRedoBoundary({
      messages,
      revertMessageId: 'missing',
    })).toBeUndefined()
  })
})

test('loads more than 200 messages through opaque native cursors', async () => {
  const messageIds = Array.from({ length: 451 }, (_, index) => {
    return `msg-${String(index).padStart(3, '0')}`
  })
  const firstCursor = 'opaque:first+/='
  const secondCursor = 'opaque:second?&value'
  const requests: Array<Record<string, string>> = []
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    requests.push(Object.fromEntries(url.searchParams))
    const cursor = url.searchParams.get('cursor')
    const start = cursor === firstCursor ? 200 : cursor === secondCursor ? 400 : 0
    const next = start === 0 ? firstCursor : start === 200 ? secondCursor : null
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      data: messageIds.slice(start, start + 200).map((id) => ({
        id,
        type: 'user',
      })),
      cursor: { next },
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port')
    const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${address.port}` })
    const messages = await listAllUserMessages({
      client,
      sessionId: 'session-with-long-history',
    })

    expect(messages.map((message) => message.id)).toEqual(messageIds)
    expect(getUndoBoundary({
      messages,
      revertMessageId: 'msg-201',
    })?.id).toBe('msg-200')
    expect(getRedoBoundary({
      messages,
      revertMessageId: 'msg-199',
    })?.id).toBe('msg-200')
    expect(requests).toMatchInlineSnapshot(`
      [
        {
          "limit": "200",
          "order": "asc",
          "type": "user",
        },
        {
          "cursor": "opaque:first+/=",
          "limit": "200",
          "type": "user",
        },
        {
          "cursor": "opaque:second?&value",
          "limit": "200",
          "type": "user",
        },
      ]
    `)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    })
  }
})
