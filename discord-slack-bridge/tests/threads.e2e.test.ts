// E2E: Thread creation and replies through the bridge.
// Discord threads map to Slack threads (thread_ts replies).

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import type { TextChannel, ThreadChannel } from 'discord.js'
import { setupE2E, teardownE2E, type E2EContext } from './e2e-setup.js'
import { decodeThreadId } from '../src/id-converter.js'

describe('threads: Discord → Slack', () => {
  let ctx: E2EContext
  let channel: TextChannel

  beforeAll(async () => {
    ctx = await setupE2E({
      channels: [{ name: 'threads-test' }],
    })
    const channelId = ctx.twin.resolveChannelId('threads-test')
    channel = (await ctx.client.channels.fetch(channelId)) as TextChannel
  }, 30_000)

  afterAll(async () => {
    await teardownE2E(ctx)
  })

  test('create thread → posts parent message in Slack, returns thread channel', async () => {
    const thread = await channel.threads.create({
      name: 'Bug discussion',
    })

    expect(thread).toBeDefined()
    expect(thread.name).toBe('Bug discussion')

    // Thread IDs are pure numeric (encoded Slack ts, valid BigInt snowflake)
    expect(/^\d{7,}$/.test(thread.id)).toBe(true)

    // Decode to verify it produces a valid Slack thread_ts
    const decoded = decodeThreadId(thread.id)
    expect(decoded.threadTs).toMatch(/^\d+\.\d{6}$/)
  })

  test('send messages in thread → appear as Slack thread replies', async () => {
    const thread = await channel.threads.create({
      name: 'Reply test',
    })

    await (thread as ThreadChannel).send('First reply')
    await (thread as ThreadChannel).send('Second reply')

    // Check Slack side: parent + 2 replies
    const channelId = ctx.twin.resolveChannelId('threads-test')
    const text = await ctx.twin.channel(channelId).text()
    expect(text).toContain('First reply')
    expect(text).toContain('Second reply')
  })

  test('fetch messages in thread returns thread replies', async () => {
    const thread = await channel.threads.create({
      name: 'Fetch test',
    })

    await (thread as ThreadChannel).send('Reply A')
    await (thread as ThreadChannel).send('Reply B')

    const messages = await (thread as ThreadChannel).messages.fetch({ limit: 10 })
    const texts = messages.map((m) => {
      return m.content
    })
    expect(texts).toContain('Reply A')
    expect(texts).toContain('Reply B')
  })
})
