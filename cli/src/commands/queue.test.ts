import { describe, expect, test } from 'vitest'
import {
  buildQueueRemoveCustomId,
  parseQueueRemoveCustomId,
} from './queue.js'

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
