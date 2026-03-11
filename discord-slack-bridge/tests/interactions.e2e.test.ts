// E2E coverage for Slack interactive payloads -> Discord interactionCreate events.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type Interaction,
  type TextChannel,
} from 'discord.js'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { sendInteractivePayload } from 'slack-digital-twin/src'
import type { SlackMessage } from 'slack-digital-twin/src'
import { setupE2E, teardownE2E, waitFor, type E2EContext } from './e2e-setup.js'

describe('interactive payloads: Slack -> Discord', () => {
  let ctx: E2EContext

  beforeAll(async () => {
    ctx = await setupE2E({
      channels: [{ name: 'interactions' }],
      users: [{ name: 'alice', realName: 'Alice' }],
    })
  }, 30_000)

  afterAll(async () => {
    await teardownE2E(ctx)
  })

  test('button click payload is emitted as discord.js ButtonInteraction', async () => {
    const guild = ctx.client.guilds.cache.first()
    const channel = guild?.channels.cache.find((c) => {
      return c.isTextBased() && c.name === 'interactions'
    }) as TextChannel

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('e2e-click')
        .setLabel('Click')
        .setStyle(ButtonStyle.Primary),
    )
    await channel.send({
      content: 'click test',
      components: [row],
    })

    const channelId = ctx.twin.resolveChannelId('interactions')
    expect(await ctx.twin.channel(channelId).text()).toMatchInlineSnapshot(`"test-bot: click test"`)

    const messages = await ctx.twin.channel(channelId).getMessages()
    const buttonMessage = [...messages]
      .reverse()
      .find((message) => {
        return getButtonActionId(message) !== undefined
      })
    expect(buttonMessage).toBeDefined()
    if (!buttonMessage?.ts) {
      return
    }
    const actionId = getButtonActionId(buttonMessage)
    expect(actionId).toBeTruthy()
    if (!actionId) {
      return
    }

    const webhookConfig = ctx.twin.webhookSenderConfig
    expect(webhookConfig).toBeDefined()
    if (!webhookConfig) {
      return
    }

    let received: ButtonInteraction | undefined
    const onInteraction = (interaction: Interaction): void => {
      if (interaction.isButton()) {
        received = interaction
      }
    }
    ctx.client.on('interactionCreate', onInteraction)

    await sendInteractivePayload({
      config: webhookConfig,
      payload: {
        type: 'block_actions',
        user: {
          id: ctx.twin.resolveUserId('alice'),
          username: 'alice',
          name: 'alice',
        },
        channel: { id: channelId },
        message: { ts: buttonMessage.ts },
        container: {
          type: 'message',
          channel_id: channelId,
          message_ts: buttonMessage.ts,
        },
        trigger_id: 'trigger-1',
        response_url: 'https://example.invalid/response',
        actions: [
          {
            action_id: actionId,
            type: 'button',
            value: 'clicked',
            block_id: 'b1',
            action_ts: '1700000000.000001',
          },
        ],
      },
    })

    const interaction = await waitFor({
      fn: async () => {
        return received
      },
      label: 'button interaction event',
    })

    ctx.client.off('interactionCreate', onInteraction)

    expect({
      customId: interaction.customId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
      componentType: interaction.componentType,
    }).toMatchInlineSnapshot(`
      {
        "channelId": null,
        "componentType": 2,
        "customId": "e2e-click",
        "userId": "U000000002",
      }
    `)
  })
})

function getButtonActionId(message: SlackMessage): string | undefined {
  const blocks = Array.isArray(message.blocks) ? message.blocks : []
  for (const block of blocks) {
    if (!(block && typeof block === 'object')) {
      continue
    }
    const elements = Reflect.get(block, 'elements')
    if (!Array.isArray(elements)) {
      continue
    }
    for (const element of elements) {
      if (!(element && typeof element === 'object')) {
        continue
      }
      const actionId = Reflect.get(element, 'action_id')
      if (typeof actionId === 'string') {
        return actionId
      }
    }
  }
  return undefined
}
