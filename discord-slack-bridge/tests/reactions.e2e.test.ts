// E2E: Reaction operations through the bridge (Discord → Slack).

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import type { TextChannel } from 'discord.js'
import { setupE2E, teardownE2E, type E2EContext } from './e2e-setup.js'

describe('reactions: Discord → Slack', () => {
  let ctx: E2EContext
  let channel: TextChannel

  beforeAll(async () => {
    ctx = await setupE2E({
      channels: [{ name: 'reactions-test' }],
    })
    const channelId = ctx.twin.resolveChannelId('reactions-test')
    channel = (await ctx.client.channels.fetch(channelId)) as TextChannel
  }, 30_000)

  afterAll(async () => {
    await teardownE2E(ctx)
  })

  test('bot adds reaction → appears in Slack twin', async () => {
    const msg = await channel.send('React to this')
    await msg.react('👍')

    const messages = await ctx.twin.channel('reactions-test').getMessages()
    const target = messages.find((m) => {
      return m.text === 'React to this'
    })
    expect(target).toBeDefined()
    expect(target!.reactions).toBeDefined()
    // The bridge passes the Unicode emoji as the Slack reaction name.
    // A real Slack API would require the short name (thumbsup), but
    // the twin stores whatever name it receives.
    const thumbsUp = target!.reactions?.find((r) => {
      return r.name === '👍' || r.name === 'thumbsup' || r.name === '+1'
    })
    expect(thumbsUp).toBeDefined()
  })

  test('bot removes reaction → removed from Slack twin', async () => {
    const msg = await channel.send('Remove reaction test')
    await msg.react('👍')

    // Verify it exists first
    const before = await ctx.twin.channel('reactions-test').getMessages()
    const msgBefore = before.find((m) => {
      return m.text === 'Remove reaction test'
    })
    expect(msgBefore!.reactions?.length).toBeGreaterThan(0)

    // Remove via discord.js
    const reaction = msg.reactions.cache.first()
    if (reaction) {
      await reaction.users.remove(ctx.client.user!.id)
    }

    const after = await ctx.twin.channel('reactions-test').getMessages()
    const msgAfter = after.find((m) => {
      return m.text === 'Remove reaction test'
    })
    // Reaction should be gone (or count 0)
    const remaining = msgAfter!.reactions?.filter((r) => {
      return r.count > 0
    }) ?? []
    expect(remaining.length).toBe(0)
  })
})
