// E2E: Channel operations through the bridge.

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { setupE2E, teardownE2E, type E2EContext } from './e2e-setup.js'

describe('channels', () => {
  let ctx: E2EContext

  beforeAll(async () => {
    ctx = await setupE2E({
      channels: [
        { name: 'general', topic: 'General discussion' },
        { name: 'private-ch', isPrivate: true },
      ],
    })
  }, 30_000)

  afterAll(async () => {
    await teardownE2E(ctx)
  })

  test('guild channels list includes seeded channels', async () => {
    const guild = ctx.client.guilds.cache.first()!
    const channels = await guild.channels.fetch()
    const names = channels.map((c) => {
      return c?.name
    }).filter(Boolean)
    expect(names).toContain('general')
  })

  test('fetch single channel returns correct metadata', async () => {
    const channelId = ctx.twin.resolveChannelId('general')
    const ch = await ctx.client.channels.fetch(channelId)
    expect(ch).toBeDefined()
    expect(ch!.id).toBe(channelId)
  })
})
