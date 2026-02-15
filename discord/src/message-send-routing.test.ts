import { describe, expect, test } from 'vitest'
import { getMessageSendAction } from './message-send-routing.js'

describe('getMessageSendAction', () => {
  test('returns undefined for normal send behavior', () => {
    const action = getMessageSendAction({
      queueConfig: { mode: 'interrupt-and-consume' },
      messageContent: 'continue',
      hasActiveRequest: true,
    })

    expect(action).toBeUndefined()
  })

  test('queues when mode is queue and request is active', () => {
    const action = getMessageSendAction({
      queueConfig: { mode: 'queue' },
      messageContent: 'continue',
      hasActiveRequest: true,
    })

    expect(action).toBe('queue')
  })

  test('interrupt override consumes message when active', () => {
    const action = getMessageSendAction({
      queueConfig: { mode: 'queue', interruptOverride: 'x' },
      messageContent: 'x',
      hasActiveRequest: true,
    })

    expect(action).toBe('interrupt-and-consume')
  })

  test('interrupt override consumes message when no active request', () => {
    const action = getMessageSendAction({
      queueConfig: { mode: 'interrupt-and-consume', interruptOverride: 'x' },
      messageContent: 'x',
      hasActiveRequest: false,
    })

    expect(action).toBe('interrupt-and-consume')
  })

  test('requires exact override match', () => {
    const action = getMessageSendAction({
      queueConfig: { mode: 'queue', interruptOverride: 'x' },
      messageContent: 'x please',
      hasActiveRequest: true,
    })

    expect(action).toBe('queue')
  })
})
