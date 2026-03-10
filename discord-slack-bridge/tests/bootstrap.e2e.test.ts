// E2E: verify bridge boots correctly with port:0, READY payload, and basic wiring.

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { setupE2E, teardownE2E, type E2EContext } from './e2e-setup.js'

describe('bootstrap', () => {
  let ctx: E2EContext

  beforeAll(async () => {
    ctx = await setupE2E()
  }, 30_000)

  afterAll(async () => {
    await teardownE2E(ctx)
  })

  test('bridge port is non-zero after start()', () => {
    expect(ctx.bridge.port).toBeGreaterThan(0)
  })

  test('bridge restUrl contains actual port', () => {
    expect(ctx.bridge.restUrl).toContain(String(ctx.bridge.port))
    expect(ctx.bridge.restUrl).not.toContain(':0/')
  })

  test('bridge gatewayUrl contains actual port', () => {
    expect(ctx.bridge.gatewayUrl).toContain(String(ctx.bridge.port))
    expect(ctx.bridge.gatewayUrl).not.toContain(':0/')
  })

  test('bridge webhookUrl contains actual port', () => {
    expect(ctx.bridge.webhookUrl).toContain(String(ctx.bridge.port))
    expect(ctx.bridge.webhookUrl).not.toContain(':0/')
  })

  test('discord.js client is ready and has one guild', () => {
    expect(ctx.client.isReady()).toBe(true)
    expect(ctx.client.guilds.cache.size).toBe(1)
    const guild = ctx.client.guilds.cache.first()!
    expect(guild.id).toBe(ctx.twin.workspaceId)
  })

  test('guild has channels mapped from Slack', async () => {
    const guild = ctx.client.guilds.cache.first()!
    const channels = await guild.channels.fetch()
    const names = channels.map((c) => {
      return c?.name
    }).filter(Boolean)
    expect(names).toContain('general')
    expect(names).toContain('project')
  })
})
