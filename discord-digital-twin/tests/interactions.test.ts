// Phase 4 tests: interactions (slash commands, replies, deferred responses, follow-ups).
// Validates that discord.js Client can receive INTERACTION_CREATE events and
// respond via interaction callback, webhook follow-up, and edit endpoints.

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  InteractionType,
} from 'discord.js'
import type {
  ChatInputCommandInteraction,
  Interaction,
  ButtonInteraction,
  TextChannel,
} from 'discord.js'
import { DigitalDiscord } from '../src/index.js'

describe('interactions', () => {
  let discord: DigitalDiscord
  let client: Client
  let channelId: string
  let testUserId: string

  beforeAll(async () => {
    discord = new DigitalDiscord({
      guild: { name: 'Test Server' },
      channels: [
        {
          name: 'general',
          type: ChannelType.GuildText,
          topic: 'test channel',
        },
      ],
      users: [{ username: 'TestUser' }],
    })
    await discord.start()

    const channels = await discord.prisma.channel.findMany()
    channelId = channels[0]!.id
    const users = await discord.prisma.user.findMany({ where: { bot: false } })
    testUserId = users[0]!.id

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      rest: {
        api: discord.restUrl,
        version: '10',
      },
    })

    await client.login(discord.botToken)
    await new Promise<void>((resolve) => {
      if (client.isReady()) {
        resolve()
        return
      }
      client.once('ready', () => {
        resolve()
      })
    })
  }, 15000)

  afterAll(async () => {
    client?.destroy()
    await discord?.stop()
  })

  test('simulateInteraction dispatches interactionCreate to client', async () => {
    const received = new Promise<Interaction>((resolve) => {
      client.once('interactionCreate', (i) => {
        resolve(i)
      })
    })

    const { id } = await discord.simulateInteraction({
      type: InteractionType.ApplicationCommand,
      channelId,
      userId: testUserId,
      data: {
        id: '1234567890',
        name: 'test-command',
        type: 1,
      },
    })

    const interaction = await received
    expect(await discord.channel(channelId).text()).toMatchInlineSnapshot(`""`)
    expect(interaction.id).toBe(id)
    expect(interaction.type).toBe(InteractionType.ApplicationCommand)
    expect(interaction.isChatInputCommand()).toBe(true)
  })

  test('user actor helper can run slash command and wait for ack', async () => {
    const commandName = 'actor-ack-test'

    const interactionHandled = new Promise<void>((resolve) => {
      client.once('interactionCreate', async (interaction) => {
        if (!interaction.isChatInputCommand()) {
          return
        }
        if (interaction.commandName !== commandName) {
          return
        }
        await interaction.reply({ content: 'ack via actor' })
        resolve()
      })
    })

    const interaction = await discord.channel(channelId).user(testUserId).runSlashCommand({
      name: commandName,
    })

    const response = await discord.channel(channelId).waitForInteractionAck({
      interactionId: interaction.id,
    })

    await interactionHandled
    expect(await discord.channel(channelId).text()).toMatchInlineSnapshot(`
      "--- from: assistant (TestBot)
      ack via actor"
    `)
    expect(response.acknowledged).toBe(true)
    expect(response.messageId).toBeTruthy()
  })

  test('interaction.reply() creates a message via callback endpoint', async () => {
    const received = new Promise<ChatInputCommandInteraction>((resolve) => {
      client.once('interactionCreate', (i) => {
        if (i.isChatInputCommand()) {
          resolve(i)
        }
      })
    })

    const { id } = await discord.simulateInteraction({
      type: InteractionType.ApplicationCommand,
      channelId,
      userId: testUserId,
      data: {
        id: '1234567891',
        name: 'reply-test',
        type: 1,
      },
    })

    const interaction = await received
    await interaction.reply({ content: 'Reply from bot' })

    const response = await discord.channel(channelId).getInteractionResponse(id)
    expect(response).toBeDefined()
    expect(response!.acknowledged).toBe(true)
    expect(response!.messageId).toBeTruthy()

    expect(await discord.channel(channelId).text()).toMatchInlineSnapshot(`
      "--- from: assistant (TestBot)
      ack via actor
      --- from: assistant (TestBot)
      Reply from bot"
    `)
    const messages = await discord.channel(channelId).getMessages()
    const replyMsg = messages.find((m) => m.content === 'Reply from bot')
    expect(replyMsg).toBeDefined()
    expect(replyMsg!.application_id).toBe(discord.botUserId)
  })

  test('interaction.deferReply() + editReply() creates message on edit', async () => {
    const received = new Promise<ChatInputCommandInteraction>((resolve) => {
      client.once('interactionCreate', (i) => {
        if (i.isChatInputCommand()) {
          resolve(i)
        }
      })
    })

    const { id } = await discord.simulateInteraction({
      type: InteractionType.ApplicationCommand,
      channelId,
      userId: testUserId,
      data: {
        id: '1234567892',
        name: 'defer-test',
        type: 1,
      },
    })

    const interaction = await received
    await interaction.deferReply()

    // After deferring, interaction is acknowledged but no message yet
    const ch = discord.channel(channelId)
    const afterDefer = await ch.getInteractionResponse(id)
    expect(afterDefer!.acknowledged).toBe(true)
    expect(afterDefer!.messageId).toBeNull()

    await interaction.editReply({ content: 'Deferred then edited' })

    // After editReply, message should exist
    expect(await ch.text()).toMatchInlineSnapshot(`
      "--- from: assistant (TestBot)
      ack via actor
      --- from: assistant (TestBot)
      Reply from bot
      --- from: assistant (TestBot)
      Deferred then edited"
    `)
    const afterEdit = await ch.getInteractionResponse(id)
    expect(afterEdit!.messageId).toBeTruthy()

    const messages = await ch.getMessages()
    const msg = messages.find((m) => m.content === 'Deferred then edited')
    expect(msg).toBeDefined()
  })

  test('interaction.deleteReply() removes the message', async () => {
    const received = new Promise<ChatInputCommandInteraction>((resolve) => {
      client.once('interactionCreate', (i) => {
        if (i.isChatInputCommand()) {
          resolve(i)
        }
      })
    })

    await discord.simulateInteraction({
      type: InteractionType.ApplicationCommand,
      channelId,
      userId: testUserId,
      data: {
        id: '1234567893',
        name: 'delete-test',
        type: 1,
      },
    })

    const interaction = await received
    await interaction.reply({ content: 'To be deleted' })
    const reply = await interaction.fetchReply()
    expect(reply.content).toBe('To be deleted')

    await interaction.deleteReply()

    expect(await discord.channel(channelId).text()).toMatchInlineSnapshot(`
      "--- from: assistant (TestBot)
      ack via actor
      --- from: assistant (TestBot)
      Reply from bot
      --- from: assistant (TestBot)
      Deferred then edited"
    `)
    const messages = await discord.channel(channelId).getMessages()
    const found = messages.find((m) => m.id === reply.id)
    expect(found).toBeUndefined()
  })

  test('interaction.followUp() creates an additional message', async () => {
    const received = new Promise<ChatInputCommandInteraction>((resolve) => {
      client.once('interactionCreate', (i) => {
        if (i.isChatInputCommand()) {
          resolve(i)
        }
      })
    })

    await discord.simulateInteraction({
      type: InteractionType.ApplicationCommand,
      channelId,
      userId: testUserId,
      data: {
        id: '1234567894',
        name: 'followup-test',
        type: 1,
      },
    })

    const interaction = await received
    await interaction.reply({ content: 'Initial reply' })
    const followUp = await interaction.followUp({
      content: 'Follow-up message',
    })

    expect(followUp.content).toBe('Follow-up message')

    expect(await discord.channel(channelId).text()).toMatchInlineSnapshot(`
      "--- from: assistant (TestBot)
      ack via actor
      --- from: assistant (TestBot)
      Reply from bot
      --- from: assistant (TestBot)
      Deferred then edited
      --- from: assistant (TestBot)
      Initial reply
      --- from: assistant (TestBot)
      Follow-up message"
    `)
    const messages = await discord.channel(channelId).getMessages()
    expect(messages.some((m) => m.content === 'Initial reply')).toBe(true)
    expect(messages.some((m) => m.content === 'Follow-up message')).toBe(true)
  })

  test('interaction.fetchReply() returns the original reply', async () => {
    const received = new Promise<ChatInputCommandInteraction>((resolve) => {
      client.once('interactionCreate', (i) => {
        if (i.isChatInputCommand()) {
          resolve(i)
        }
      })
    })

    await discord.simulateInteraction({
      type: InteractionType.ApplicationCommand,
      channelId,
      userId: testUserId,
      data: {
        id: '1234567895',
        name: 'fetch-test',
        type: 1,
      },
    })

    const interaction = await received
    await interaction.reply({ content: 'Fetch this reply' })
    const fetched = await interaction.fetchReply()

    expect(await discord.channel(channelId).text()).toMatchInlineSnapshot(`
      "--- from: assistant (TestBot)
      ack via actor
      --- from: assistant (TestBot)
      Reply from bot
      --- from: assistant (TestBot)
      Deferred then edited
      --- from: assistant (TestBot)
      Initial reply
      --- from: assistant (TestBot)
      Follow-up message
      --- from: assistant (TestBot)
      Fetch this reply"
    `)
    expect(fetched.content).toBe('Fetch this reply')
    expect(fetched.author.id).toBe(discord.botUserId)
  })

  test('double reply is guarded by discord.js (interaction.replied = true)', async () => {
    const received = new Promise<ChatInputCommandInteraction>((resolve) => {
      client.once('interactionCreate', (i) => {
        if (i.isChatInputCommand()) {
          resolve(i)
        }
      })
    })

    await discord.simulateInteraction({
      type: InteractionType.ApplicationCommand,
      channelId,
      userId: testUserId,
      data: {
        id: '1234567896',
        name: 'double-reply-test',
        type: 1,
      },
    })

    const interaction = await received
    await interaction.reply({ content: 'First reply' })

    // discord.js guards against double reply client-side
    expect(await discord.channel(channelId).text()).toMatchInlineSnapshot(`
      "--- from: assistant (TestBot)
      ack via actor
      --- from: assistant (TestBot)
      Reply from bot
      --- from: assistant (TestBot)
      Deferred then edited
      --- from: assistant (TestBot)
      Initial reply
      --- from: assistant (TestBot)
      Follow-up message
      --- from: assistant (TestBot)
      Fetch this reply
      --- from: assistant (TestBot)
      First reply"
    `)
    expect(interaction.replied).toBe(true)
  })

  test('editReply() edits existing message content', async () => {
    const received = new Promise<ChatInputCommandInteraction>((resolve) => {
      client.once('interactionCreate', (i) => {
        if (i.isChatInputCommand()) {
          resolve(i)
        }
      })
    })

    const { id } = await discord.simulateInteraction({
      type: InteractionType.ApplicationCommand,
      channelId,
      userId: testUserId,
      data: {
        id: '1234567897',
        name: 'edit-existing-test',
        type: 1,
      },
    })

    const interaction = await received
    await interaction.reply({ content: 'Original reply' })
    await interaction.editReply({ content: 'Edited reply' })

    expect(await discord.channel(channelId).text()).toMatchInlineSnapshot(`
      "--- from: assistant (TestBot)
      ack via actor
      --- from: assistant (TestBot)
      Reply from bot
      --- from: assistant (TestBot)
      Deferred then edited
      --- from: assistant (TestBot)
      Initial reply
      --- from: assistant (TestBot)
      Follow-up message
      --- from: assistant (TestBot)
      Fetch this reply
      --- from: assistant (TestBot)
      First reply
      --- from: assistant (TestBot)
      Edited reply"
    `)
    const response = await discord.channel(channelId).getInteractionResponse(id)
    const messages = await discord.channel(channelId).getMessages()
    const msg = messages.find((m) => m.id === response!.messageId)
    expect(msg?.content).toBe('Edited reply')
    expect(msg?.edited_timestamp).toBeTruthy()
  })

  test('editReply() twice correctly updates the message', async () => {
    const received = new Promise<ChatInputCommandInteraction>((resolve) => {
      client.once('interactionCreate', (i) => {
        if (i.isChatInputCommand()) {
          resolve(i)
        }
      })
    })

    const { id } = await discord.simulateInteraction({
      type: InteractionType.ApplicationCommand,
      channelId,
      userId: testUserId,
      data: {
        id: '1234567898',
        name: 'double-edit-test',
        type: 1,
      },
    })

    const interaction = await received
    await interaction.deferReply()

    // First edit creates the message
    await interaction.editReply({ content: 'First edit' })

    // Second edit changes ONLY embeds
    await interaction.editReply({ embeds: [{ title: 'Test Embed' }] })

    const response = await discord.channel(channelId).getInteractionResponse(id)
    const messages = await discord.channel(channelId).getMessages()
    const msg = messages.find((m) => m.id === response!.messageId)

    expect(await discord.channel(channelId).text()).toMatchInlineSnapshot(`
      "--- from: assistant (TestBot)
      ack via actor
      --- from: assistant (TestBot)
      Reply from bot
      --- from: assistant (TestBot)
      Deferred then edited
      --- from: assistant (TestBot)
      Initial reply
      --- from: assistant (TestBot)
      Follow-up message
      --- from: assistant (TestBot)
      Fetch this reply
      --- from: assistant (TestBot)
      First reply
      --- from: assistant (TestBot)
      Edited reply
      --- from: assistant (TestBot)
      First edit
      [embed: "Test Embed"]"
    `)
    expect(msg?.content).toBe('First edit')
    expect(msg!.embeds.length).toBe(1)
    expect(msg!.embeds[0]!.title).toBe('Test Embed')
  })

  test('UpdateMessage component interaction updates the original message', async () => {
    // First create a message that the component is attached to
    const channel = client.channels.cache.get(channelId) as TextChannel
    const targetMsg = await channel.send({ content: 'Target message' })
    expect(targetMsg).toBeDefined()

    const received = new Promise<ButtonInteraction>((resolve) => {
      client.once('interactionCreate', (i) => {
        if (i.isButton()) {
          resolve(i)
        }
      })
    })

    const { id } = await discord.simulateInteraction({
      type: InteractionType.MessageComponent,
      channelId,
      userId: testUserId,
      messageId: targetMsg!.id,
      data: {
        custom_id: 'test-button',
        component_type: 2,
      },
    })

    const interaction = await received
    await interaction.update({ content: 'Updated by component' })

    expect(await discord.channel(channelId).text()).toMatchInlineSnapshot(`
      "--- from: assistant (TestBot)
      ack via actor
      --- from: assistant (TestBot)
      Reply from bot
      --- from: assistant (TestBot)
      Deferred then edited
      --- from: assistant (TestBot)
      Initial reply
      --- from: assistant (TestBot)
      Follow-up message
      --- from: assistant (TestBot)
      Fetch this reply
      --- from: assistant (TestBot)
      First reply
      --- from: assistant (TestBot)
      Edited reply
      --- from: assistant (TestBot)
      First edit
      [embed: "Test Embed"]
      --- from: assistant (TestBot)
      Updated by component"
    `)
    const response = await discord.channel(channelId).getInteractionResponse(id)
    expect(response!.messageId).toBe(targetMsg!.id)

    const messages = await discord.channel(channelId).getMessages()
    const msg = messages.find((m) => m.id === targetMsg!.id)
    expect(msg?.content).toBe('Updated by component')
    expect(msg?.edited_timestamp).toBeTruthy()
  })

  test('deferUpdate() followed by editReply() updates the original message', async () => {
    const channel = client.channels.cache.get(channelId) as TextChannel
    const targetMsg = await channel.send({ content: 'Message for deferUpdate' })

    const received = new Promise<ButtonInteraction>((resolve) => {
      client.once('interactionCreate', (i) => {
        if (i.isButton()) {
          resolve(i)
        }
      })
    })

    const { id } = await discord.simulateInteraction({
      type: InteractionType.MessageComponent,
      channelId,
      userId: testUserId,
      messageId: targetMsg.id,
      data: {
        custom_id: 'defer-update-button',
        component_type: 2,
      },
    })

    const interaction = await received
    await interaction.deferUpdate()
    await interaction.editReply({ content: 'Edited after deferUpdate' })

    expect(await discord.channel(channelId).text()).toMatchInlineSnapshot(`
      "--- from: assistant (TestBot)
      ack via actor
      --- from: assistant (TestBot)
      Reply from bot
      --- from: assistant (TestBot)
      Deferred then edited
      --- from: assistant (TestBot)
      Initial reply
      --- from: assistant (TestBot)
      Follow-up message
      --- from: assistant (TestBot)
      Fetch this reply
      --- from: assistant (TestBot)
      First reply
      --- from: assistant (TestBot)
      Edited reply
      --- from: assistant (TestBot)
      First edit
      [embed: "Test Embed"]
      --- from: assistant (TestBot)
      Updated by component
      --- from: assistant (TestBot)
      Edited after deferUpdate"
    `)
    const response = await discord.channel(channelId).getInteractionResponse(id)
    expect(response!.messageId).toBe(targetMsg.id)

    const messages = await discord.channel(channelId).getMessages()
    const msg = messages.find((m) => m.id === targetMsg.id)
    expect(msg?.content).toBe('Edited after deferUpdate')
    expect(msg?.edited_timestamp).toBeTruthy()
  })
})
