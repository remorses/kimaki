// E2E: Attachment parity flows used by Kimaki (Discord<->Slack bridge).
// Covers discord.js multipart sends and Slack webhook file payload mapping.

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import type { Message, TextChannel } from 'discord.js'
import { setupE2E, teardownE2E, type E2EContext } from './e2e-setup.js'
import { sendWebhookEvent } from 'slack-digital-twin/src'

describe('attachments: bridge parity for kimaki', () => {
  let ctx: E2EContext
  let channel: TextChannel

  beforeAll(async () => {
    ctx = await setupE2E({
      channels: [{ name: 'attachments' }],
      users: [{ name: 'alice', realName: 'Alice' }],
    })
    const channelId = ctx.twin.resolveChannelId('attachments')
    const fetched = await ctx.client.channels.fetch(channelId)
    channel = fetched as TextChannel
  }, 30_000)

  afterAll(async () => {
    await teardownE2E(ctx)
  })

  test('discord.js can send multipart files through bridge', async () => {
    await channel.send({
      content: 'multipart upload from discord',
      files: [
        {
          attachment: Buffer.from('hello from kimaki tests', 'utf8'),
          name: 'hello.txt',
        },
      ],
    })

    const messages = await ctx.twin.channel('attachments').getMessages()
    const posted = messages.find((message) => {
      return message.text === 'multipart upload from discord'
    })
    expect(posted).toBeDefined()
  })

  test('slack image files map to discord message attachments', async () => {
    const received = new Promise<Message>((resolve) => {
      ctx.client.once('messageCreate', (message) => {
        resolve(message)
      })
    })

    const channelId = ctx.twin.resolveChannelId('attachments')
    const aliceId = ctx.twin.resolveUserId('alice')
    const webhookConfig = ctx.twin.webhookSenderConfig
    expect(webhookConfig).toBeDefined()
    if (!webhookConfig) {
      return
    }

    await sendWebhookEvent({
      config: webhookConfig,
      event: {
        type: 'message',
        channel: channelId,
        user: aliceId,
        text: 'image from slack',
        ts: '1700000100.000001',
        files: [
          {
            id: 'FIMG001',
            name: 'diagram.png',
            mimetype: 'image/png',
            url_private: 'https://slack.example/files/FIMG001',
            permalink: 'https://slack.example/permalink/FIMG001',
            size: 2048,
          },
        ],
      },
    })

    const message = await received
    expect(message.content).toBe('image from slack')
    expect(message.attachments.size).toBe(1)
    const first = message.attachments.first()
    expect(first?.name).toBe('diagram.png')
    expect(first?.contentType).toBe('image/png')
  })

  test('slack audio files map to discord audio attachments for transcription', async () => {
    const received = new Promise<Message>((resolve) => {
      ctx.client.once('messageCreate', (message) => {
        resolve(message)
      })
    })

    const channelId = ctx.twin.resolveChannelId('attachments')
    const aliceId = ctx.twin.resolveUserId('alice')
    const webhookConfig = ctx.twin.webhookSenderConfig
    expect(webhookConfig).toBeDefined()
    if (!webhookConfig) {
      return
    }

    await sendWebhookEvent({
      config: webhookConfig,
      event: {
        type: 'message',
        channel: channelId,
        user: aliceId,
        text: 'voice note from slack',
        ts: '1700000101.000001',
        files: [
          {
            id: 'FAUD001',
            name: 'voice-message.ogg',
            mimetype: 'audio/ogg',
            url_private: 'https://slack.example/files/FAUD001',
            permalink: 'https://slack.example/permalink/FAUD001',
            size: 4096,
          },
        ],
      },
    })

    const message = await received
    const first = message.attachments.first()
    expect(first?.name).toBe('voice-message.ogg')
    expect(first?.contentType).toBe('audio/ogg')
  })
})
