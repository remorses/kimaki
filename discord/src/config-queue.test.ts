import { describe, expect, test } from 'vitest'
import { getQueueConfig, setQueueConfig } from './config.js'

describe('queue config', () => {
  test('defaults to interrupt-and-consume mode with no override', () => {
    setQueueConfig({ mode: 'interrupt-and-consume' })

    expect(getQueueConfig()).toEqual({
      mode: 'interrupt-and-consume',
    })
  })

  test('stores queue mode and interrupt override', () => {
    setQueueConfig({ mode: 'queue', interruptOverride: 'x' })

    expect(getQueueConfig()).toEqual({
      mode: 'queue',
      interruptOverride: 'x',
    })

    setQueueConfig({ mode: 'interrupt-and-consume' })
  })

  test('normalizes empty override to undefined', () => {
    setQueueConfig({ mode: 'queue', interruptOverride: '   ' })

    expect(getQueueConfig()).toEqual({
      mode: 'queue',
    })

    setQueueConfig({ mode: 'interrupt-and-consume' })
  })
})
