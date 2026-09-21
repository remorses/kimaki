import { describe, expect, test } from 'vitest'
import { parseQueuedMessagePayload } from '../session-handler/thread-runtime-state.js'
import {
  buildQueueRemoveCustomId,
  parseQueueRemoveCustomId,
} from './queue.js'

describe('parseQueuedMessagePayload', () => {
  test('keeps required fields and known optionals', () => {
    const parsed = parseQueuedMessagePayload({
      queueId: 'q1',
      payloadJson: JSON.stringify({
        prompt: 'hello',
        userId: '1',
        username: 'tommy',
        agent: 'build',
        command: { name: 'review', arguments: 'src' },
        extraGarbage: true,
      }),
    })
    expect(parsed).toMatchInlineSnapshot(`
      {
        "agent": "build",
        "command": {
          "arguments": "src",
          "name": "review",
        },
        "prompt": "hello",
        "queueId": "q1",
        "userId": "1",
        "username": "tommy",
      }
    `)
  })

  test('rejects missing required fields', () => {
    const parsed = parseQueuedMessagePayload({
      queueId: 'q1',
      payloadJson: JSON.stringify({ prompt: 'hello' }),
    })
    expect(parsed).toBeInstanceOf(Error)
  })
})

describe('queue remove custom id', () => {
  test('round-trips thread and queue ids under Discord custom_id limit', () => {
    const customId = buildQueueRemoveCustomId({
      threadId: '1550106184055398531',
      queueId: 'a1b2c3d4e5f60789',
    })
    expect(customId.length).toBeLessThanOrEqual(100)
    expect(parseQueueRemoveCustomId(customId)).toEqual({
      threadId: '1550106184055398531',
      queueId: 'a1b2c3d4e5f60789',
    })
  })
})
