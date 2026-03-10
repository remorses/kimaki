// E2E: Slack → Discord event flow (webhook events through the bridge).
// Slack user actions trigger webhooks → bridge translates → discord.js receives Gateway events.

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import type { Message, MessageReaction, PartialMessageReaction } from 'discord.js'
import { setupE2E, teardownE2E, waitFor, type E2EContext } from './e2e-setup.js'
import type { TextChannel } from 'discord.js'

describe('Slack → Discord events', () => {
  let ctx: E2EContext

  beforeAll(async () => {
    ctx = await setupE2E({
      channels: [{ name: 'slack-events' }],
      users: [{ name: 'alice', realName: 'Alice' }],
    })
  }, 30_000)

  afterAll(async () => {
    await teardownE2E(ctx)
  })

  test('Slack user sends message → discord.js receives messageCreate', async () => {
    const received = new Promise<Message>((resolve) => {
      ctx.client.once('messageCreate', (msg) => {
        resolve(msg)
      })
    })

    const channelId = ctx.twin.resolveChannelId('slack-events')
    await ctx.twin.user('alice').sendMessage({
      channel: channelId,
      text: 'Hello from Slack!',
    })

    const msg = await received
    expect(msg.content).toBe('Hello from Slack!')
    expect(msg.author.id).toBe(ctx.twin.resolveUserId('alice'))
  })

  test('Slack user sends thread reply → discord.js receives messageCreate in thread channel', async () => {
    // First, bot posts a parent message from Discord side
    const channelId = ctx.twin.resolveChannelId('slack-events')
    const ch = (await ctx.client.channels.fetch(channelId)) as TextChannel
    const parent = await ch.send('Parent message for thread')

    // Get the Slack ts for this message from the twin
    const messages = await ctx.twin.channel('slack-events').getMessages()
    const parentMsg = messages.find((m) => {
      return m.text === 'Parent message for thread'
    })
    expect(parentMsg).toBeDefined()

    const received = new Promise<Message>((resolve) => {
      ctx.client.once('messageCreate', (msg) => {
        resolve(msg)
      })
    })

    // Alice replies in the Slack thread
    await ctx.twin.user('alice').sendMessage({
      channel: channelId,
      text: 'Thread reply from Slack',
      threadTs: parentMsg!.ts,
    })

    const msg = await received
    expect(msg.content).toBe('Thread reply from Slack')
  })

  test('Slack user adds reaction → discord.js receives messageReactionAdd', async () => {
    // Bot posts a message first
    const channelId = ctx.twin.resolveChannelId('slack-events')
    const ch = (await ctx.client.channels.fetch(channelId)) as TextChannel
    await ch.send('React target')

    // Get the Slack ts
    const messages = await ctx.twin.channel('slack-events').getMessages()
    const target = messages.find((m) => {
      return m.text === 'React target'
    })
    expect(target).toBeDefined()

    const received = new Promise<MessageReaction | PartialMessageReaction>((resolve) => {
      ctx.client.once('messageReactionAdd', (reaction) => {
        resolve(reaction)
      })
    })

    await ctx.twin.user('alice').addReaction({
      channel: channelId,
      messageTs: target!.ts,
      name: 'thumbsup',
    })

    const reaction = await received
    expect(reaction.emoji.name).toBe('thumbsup')
  })
})
