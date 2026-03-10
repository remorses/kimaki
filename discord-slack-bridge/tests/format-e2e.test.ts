// E2E: Markdown ↔ mrkdwn format conversion through the full bridge stack.
// Discord markdown → Slack mrkdwn (Discord → Slack direction)
// Slack mrkdwn → Discord markdown (Slack → Discord direction)

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import type { TextChannel, Message } from 'discord.js'
import { setupE2E, teardownE2E, type E2EContext } from './e2e-setup.js'

describe('format conversion e2e', () => {
  let ctx: E2EContext
  let channel: TextChannel

  beforeAll(async () => {
    ctx = await setupE2E({
      channels: [{ name: 'format-test' }],
      users: [{ name: 'alice' }],
    })
    const channelId = ctx.twin.resolveChannelId('format-test')
    channel = (await ctx.client.channels.fetch(channelId)) as TextChannel
  }, 30_000)

  afterAll(async () => {
    await teardownE2E(ctx)
  })

  test('Discord bold → Slack bold', async () => {
    await channel.send('**bold text**')

    const messages = await ctx.twin.channel('format-test').getMessages()
    const found = messages.find((m) => {
      return m.text?.includes('bold text')
    })
    expect(found).toBeDefined()
    // Bridge converts **bold** → *bold* for Slack mrkdwn
    expect(found!.text).toBe('*bold text*')
  })

  test('Discord strikethrough → Slack strikethrough', async () => {
    await channel.send('~~strike~~')

    const messages = await ctx.twin.channel('format-test').getMessages()
    const found = messages.find((m) => {
      return m.text?.includes('strike')
    })
    expect(found).toBeDefined()
    // Bridge converts ~~strike~~ → ~strike~ for Slack mrkdwn
    expect(found!.text).toBe('~strike~')
  })

  test('Discord link → Slack link', async () => {
    await channel.send('[example](https://example.com)')

    const messages = await ctx.twin.channel('format-test').getMessages()
    const found = messages.find((m) => {
      return m.text?.includes('example.com')
    })
    expect(found).toBeDefined()
    // Bridge converts [text](url) → <url|text> for Slack mrkdwn
    expect(found!.text).toBe('<https://example.com|example>')
  })

  test('Slack mrkdwn → Discord markdown (bold)', async () => {
    const received = new Promise<Message>((resolve) => {
      ctx.client.once('messageCreate', (msg) => {
        resolve(msg)
      })
    })

    const channelId = ctx.twin.resolveChannelId('format-test')
    await ctx.twin.user('alice').sendMessage({
      channel: channelId,
      text: '*bold from slack*',
    })

    const msg = await received
    // Bridge converts *bold* → **bold** for Discord markdown
    expect(msg.content).toBe('**bold from slack**')
  })

  test('code blocks pass through unchanged', async () => {
    await channel.send('`inline code` and ```block```')

    const messages = await ctx.twin.channel('format-test').getMessages()
    const found = messages.find((m) => {
      return m.text?.includes('inline code')
    })
    expect(found).toBeDefined()
    // Code should not be transformed
    expect(found!.text).toContain('`inline code`')
  })
})
