// E2E: Discord → Slack message operations (post, edit, delete, fetch).

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import type { TextChannel } from 'discord.js'
import { setupE2E, teardownE2E, type E2EContext } from './e2e-setup.js'

describe('messages: Discord → Slack', () => {
  let ctx: E2EContext
  let channel: TextChannel

  beforeAll(async () => {
    ctx = await setupE2E()
    const generalId = ctx.twin.resolveChannelId('general')
    const fetched = await ctx.client.channels.fetch(generalId)
    channel = fetched as TextChannel
  }, 30_000)

  afterAll(async () => {
    await teardownE2E(ctx)
  })

  test('bot posts message → appears in Slack twin', async () => {
    await channel.send('Hello from Discord!')

    const messages = await ctx.twin.channel('general').getMessages()
    const found = messages.find((m) => {
      return m.text === 'Hello from Discord!'
    })
    expect(found).toBeDefined()
    expect(found!.bot_id).toBeDefined()
  })

  test('bot edits message → Slack twin reflects edit', async () => {
    const msg = await channel.send('Original text')
    await msg.edit('Edited text')

    const messages = await ctx.twin.channel('general').getMessages()
    const edited = messages.find((m) => {
      return m.text === 'Edited text'
    })
    expect(edited).toBeDefined()
  })

  test('bot deletes message → soft-deleted in Slack twin', async () => {
    const msg = await channel.send('Delete me')
    await msg.delete()

    const messages = await ctx.twin.channel('general').getMessages()
    const found = messages.find((m) => {
      return m.text === 'Delete me'
    })
    // getMessages() excludes deleted messages
    expect(found).toBeUndefined()
  })

  test('bot fetches messages from channel', async () => {
    // Clear state by using a different channel
    const projectId = ctx.twin.resolveChannelId('project')
    const projectCh = (await ctx.client.channels.fetch(projectId)) as TextChannel

    await projectCh.send('Message one')
    await projectCh.send('Message two')

    const fetched = await projectCh.messages.fetch({ limit: 10 })
    expect(fetched.size).toBeGreaterThanOrEqual(2)

    const texts = fetched.map((m) => {
      return m.content
    })
    expect(texts).toContain('Message one')
    expect(texts).toContain('Message two')
  })

  test('text snapshot of channel messages', async () => {
    const projectId = ctx.twin.resolveChannelId('project')
    const text = await ctx.twin.channel(projectId).text()
    expect(text).toContain('Message one')
    expect(text).toContain('Message two')
  })
})
