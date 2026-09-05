// Unit tests for the per-thread Discord arrival FIFO.
// /plan-agent and a follow-up message must keep Discord order.

import { describe, expect, test } from 'vitest'
import {
  reserveThreadIngress,
  runInThreadIngressSlot,
  waitForCurrentThreadIngress,
} from './thread-session-runtime.js'

describe('thread ingress FIFO', () => {
  test('later waiters stay behind an unreleased earlier slot', async () => {
    const first = reserveThreadIngress('thread-fifo')
    const second = reserveThreadIngress('thread-fifo')
    const order: string[] = []

    const firstWork = runInThreadIngressSlot(first, async () => {
      await waitForCurrentThreadIngress()
      order.push('first-write')
      first.release()
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push('first-work')
    })

    const secondWork = runInThreadIngressSlot(second, async () => {
      await waitForCurrentThreadIngress()
      order.push('second')
      second.release()
    })

    await Promise.all([firstWork, secondWork])
    expect(order).toEqual(['first-write', 'second', 'first-work'])
  })

  test('runInThreadIngressSlot releases after a thrown callback', async () => {
    const first = reserveThreadIngress('thread-fifo-throw')
    const second = reserveThreadIngress('thread-fifo-throw')
    const order: string[] = []

    const firstWork = runInThreadIngressSlot(first, async () => {
      await waitForCurrentThreadIngress()
      order.push('first')
      throw new Error('boom')
    }).catch(() => {})

    const secondWork = runInThreadIngressSlot(second, async () => {
      await waitForCurrentThreadIngress()
      order.push('second')
    })

    await Promise.all([firstWork, secondWork])
    expect(order).toEqual(['first', 'second'])
  })
})
