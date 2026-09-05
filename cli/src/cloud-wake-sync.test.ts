// Tests for cloud next-wake payload construction.

import { afterEach, describe, expect, test } from 'vitest'
import { store } from './store.js'
import {
  buildCloudNextWakeBody,
  syncCloudNextWakeAt,
  syncSoonestCloudWakeAt,
} from './cloud-wake-sync.js'

describe('cloud wake sync', () => {
  afterEach(() => {
    delete process.env['KIMAKI_SCALE_TO_ZERO']
    store.setState({ gatewayToken: null })
  })

  test('skips when scale-to-zero is off even with a gateway token', async () => {
    store.setState({ gatewayToken: 'client-id:secret' })
    const result = await syncCloudNextWakeAt({
      nextWakeAt: new Date('2026-09-05T12:00:00Z'),
    })
    expect(result).toBeUndefined()
  })

  test('fails closed when scale-to-zero is on without a gateway token', async () => {
    process.env['KIMAKI_SCALE_TO_ZERO'] = '1'
    const result = await syncCloudNextWakeAt({
      nextWakeAt: new Date('2026-09-05T12:00:00Z'),
    })
    expect(result).toBeInstanceOf(Error)
  })

  test('serializes ISO next_wake_at or null', () => {
    expect(buildCloudNextWakeBody({
      nextWakeAt: new Date('2026-09-05T12:00:00.000Z'),
    })).toEqual({
      next_wake_at: '2026-09-05T12:00:00.000Z',
    })
    expect(buildCloudNextWakeBody({ nextWakeAt: null })).toEqual({
      next_wake_at: null,
    })
  })

  test('posts the latest SQLite wake time after overlapping mutations', async () => {
    process.env['KIMAKI_SCALE_TO_ZERO'] = '1'
    store.setState({ gatewayToken: 'client-id:secret' })
    const posted: Array<string | null> = []
    let current: Date | null = new Date('2026-09-05T14:00:00.000Z')
    let resolveFirst: (() => void) | undefined
    const firstGate = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })
    let fetchCount = 0
    const fetchImpl: typeof fetch = (async (_input, init) => {
      fetchCount += 1
      const body = JSON.parse(String(init?.body)) as { next_wake_at: string | null }
      posted.push(body.next_wake_at)
      if (fetchCount === 1) {
        await firstGate
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch

    const first = syncSoonestCloudWakeAt({
      getSoonestWakeAt: async () => current,
      fetchImpl,
    })
    current = new Date('2026-09-05T13:00:00.000Z')
    const second = syncSoonestCloudWakeAt({
      getSoonestWakeAt: async () => current,
      fetchImpl,
    })
    resolveFirst?.()
    await Promise.all([first, second])
    expect(posted.at(-1)).toBe('2026-09-05T13:00:00.000Z')
  })
})
