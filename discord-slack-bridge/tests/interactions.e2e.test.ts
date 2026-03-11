// E2E coverage for Slack interactive payloads -> Discord interactionCreate events.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type Interaction,
  type StringSelectMenuInteraction,
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
        return getFirstActionId(message) !== undefined
      })
    expect(buttonMessage).toBeDefined()
    if (!buttonMessage?.ts) {
      return
    }
    const actionId = getFirstActionId(buttonMessage)
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

  test('button block action can be replied to and posts message to Slack', async () => {
    const guild = ctx.client.guilds.cache.first()
    const channel = guild?.channels.cache.find((c) => {
      return c.isTextBased() && c.name === 'interactions'
    }) as TextChannel

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('e2e-button-reply')
        .setLabel('Reply')
        .setStyle(ButtonStyle.Primary),
    )
    await channel.send({
      content: 'button reply test',
      components: [row],
    })

    const channelId = ctx.twin.resolveChannelId('interactions')
    const messages = await ctx.twin.channel(channelId).getMessages()
    const buttonMessage = [...messages]
      .reverse()
      .find((message) => {
        return getFirstActionId(message) !== undefined
      })
    expect(buttonMessage).toBeDefined()
    if (!buttonMessage?.ts) {
      return
    }
    const actionId = getFirstActionId(buttonMessage)
    expect(actionId).toBeTruthy()
    if (!actionId) {
      return
    }

    const webhookConfig = ctx.twin.webhookSenderConfig
    expect(webhookConfig).toBeDefined()
    if (!webhookConfig) {
      return
    }

    let replied = false
    const onInteraction = (interaction: Interaction): void => {
      if (!interaction.isButton()) {
        return
      }
      void interaction.reply({
        content: `button reply: ${interaction.customId}`,
      }).then(() => {
        replied = true
      })
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
        trigger_id: 'trigger-button-reply',
        response_url: 'https://example.invalid/response',
        actions: [
          {
            action_id: actionId,
            type: 'button',
            value: 'clicked',
            block_id: 'b1',
            action_ts: '1700000000.000010',
          },
        ],
      },
    })

    await waitFor({
      fn: async () => {
        return replied ? true : undefined
      },
      label: 'button interaction reply',
    })

    ctx.client.off('interactionCreate', onInteraction)

    await waitFor({
      fn: async () => {
        const text = await ctx.twin.channel(channelId).text()
        return text.includes('test-bot: button reply: e2e-button-reply')
          ? text
          : undefined
      },
      label: 'button reply posted to slack',
    })
  })

  test('static select block action maps to StringSelectMenuInteraction and supports replies', async () => {
    const guild = ctx.client.guilds.cache.first()
    const channel = guild?.channels.cache.find((c) => {
      return c.isTextBased() && c.name === 'interactions'
    }) as TextChannel

    const select = new StringSelectMenuBuilder()
      .setCustomId('e2e-select')
      .setPlaceholder('Choose level')
      .addOptions([
        { label: 'Low', value: 'low' },
        { label: 'Medium', value: 'medium' },
        { label: 'High', value: 'high' },
      ])
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)

    await channel.send({
      content: 'select test',
      components: [row],
    })

    const channelId = ctx.twin.resolveChannelId('interactions')
    const messages = await ctx.twin.channel(channelId).getMessages()
    const selectMessage = [...messages]
      .reverse()
      .find((message) => {
        return getFirstActionId(message) !== undefined
      })
    expect(selectMessage).toBeDefined()
    if (!selectMessage?.ts) {
      return
    }
    const actionId = getFirstActionId(selectMessage)
    expect(actionId).toBeTruthy()
    if (!actionId) {
      return
    }

    const webhookConfig = ctx.twin.webhookSenderConfig
    expect(webhookConfig).toBeDefined()
    if (!webhookConfig) {
      return
    }

    let received: StringSelectMenuInteraction | undefined
    const onInteraction = (interaction: Interaction): void => {
      if (!interaction.isStringSelectMenu()) {
        return
      }
      received = interaction
      void interaction.reply({
        content: `select reply: ${interaction.values.join(',')}`,
      })
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
        message: { ts: selectMessage.ts },
        container: {
          type: 'message',
          channel_id: channelId,
          message_ts: selectMessage.ts,
        },
        trigger_id: 'trigger-select-reply',
        response_url: 'https://example.invalid/response',
        actions: [
          {
            action_id: actionId,
            type: 'static_select',
            selected_option: {
              value: 'medium',
              text: {
                type: 'plain_text',
                text: 'Medium',
              },
            },
            block_id: 'b-select',
            action_ts: '1700000000.000020',
          },
        ],
      },
    })

    const interaction = await waitFor({
      fn: async () => {
        return received
      },
      label: 'select interaction event',
    })
    ctx.client.off('interactionCreate', onInteraction)

    expect({
      customId: interaction.customId,
      values: interaction.values,
      componentType: interaction.componentType,
    }).toMatchInlineSnapshot(`
      {
        "componentType": 3,
        "customId": "e2e-select",
        "values": [
          "medium",
        ],
      }
    `)

    await waitFor({
      fn: async () => {
        const text = await ctx.twin.channel(channelId).text()
        return text.includes('test-bot: select reply: medium') ? text : undefined
      },
      label: 'select reply posted to slack',
    })
  })
})

function getFirstActionId(message: SlackMessage): string | undefined {
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
