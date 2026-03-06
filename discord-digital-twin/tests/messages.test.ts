// Phase 2 tests: messages, edits, deletes, and reactions.
// Validates that discord.js Client can send/receive messages through the
// DigitalDiscord server and that state is correctly persisted in the DB.

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { Client, GatewayIntentBits, ChannelType } from 'discord.js'
import type { Message as DjsMessage, TextChannel } from 'discord.js'
import { DigitalDiscord } from '../src/index.js'

describe('messages and reactions', () => {
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

    // Resolve seeded IDs from DB
    const channels = await discord.prisma.channel.findMany()
    channelId = channels[0]!.id
    const users = await discord.prisma.user.findMany({ where: { bot: false } })
    testUserId = users[0]!.id

    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,

        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
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

  test('simulateUserMessage dispatches messageCreate to client', async () => {
    const received = new Promise<DjsMessage>((resolve) => {
      client.once('messageCreate', (msg) => {
        resolve(msg)
      })
    })

    await discord.simulateUserMessage({
      channelId,
      userId: testUserId,
      content: 'Hello from user!',
    })

    const msg = await received
    expect(await discord.channel(channelId).text()).toMatchInlineSnapshot(`
      "--- from: user (TestUser)
      Hello from user!"
    `)
    expect(msg.content).toBe('Hello from user!')
    expect(msg.author.bot).toBe(false)
    expect(msg.author.username).toBe('TestUser')
  })

  test('user actor helper can send a message and wait helper can observe it', async () => {
    const content = 'Actor helper message'

    await discord.channel(channelId).user(testUserId).sendMessage({
      content,
    })

    const observed = await discord.channel(channelId).waitForMessage({
      predicate: (message) => {
        return message.content === content
      },
    })

    expect(await discord.channel(channelId).text()).toMatchInlineSnapshot(`
      "--- from: user (TestUser)
      Hello from user!
      Actor helper message"
    `)
    expect(observed.content).toBe(content)
    expect(observed.author.id).toBe(testUserId)
  })

  test('channel.send stores message in DB', async () => {
    const guild = client.guilds.cache.first()!
    const channel = guild.channels.cache.find(
      (c) => c.name === 'general',
    ) as TextChannel

    const sent = await channel.send('Hello from bot!')
    expect(sent.content).toBe('Hello from bot!')

    expect(await discord.channel(channelId).text()).toMatchInlineSnapshot(`
      "--- from: user (TestUser)
      Hello from user!
      Actor helper message
      --- from: assistant (TestBot)
      Hello from bot!"
    `)
    const messages = await discord.channel(channelId).getMessages()
    const found = messages.find((m) => m.content === 'Hello from bot!')
    expect(found).toBeDefined()
    expect(found?.author.bot).toBe(true)
  })

  test('typing endpoint events are tracked for channel scope', async () => {
    const guild = client.guilds.cache.first()!
    const channel = guild.channels.cache.find(
      (c) => c.name === 'general',
    ) as TextChannel

    const ch = discord.channel(channelId)
    ch.clearTypingEvents()

    const start = Date.now()
    await channel.sendTyping()

    const typingEvent = await ch.waitForTypingEvent({
      timeout: 1000,
      afterTimestamp: start - 1,
    })

    expect(typingEvent.channelId).toBe(channelId)
    expect(typingEvent.timestamp).toBeGreaterThanOrEqual(start)

    await ch.waitForTypingToStop({
      timeout: 1000,
      idleMs: 100,
      afterTimestamp: typingEvent.timestamp,
    })
  })

  test('message edit updates content and edited_timestamp', async () => {
    const guild = client.guilds.cache.first()!
    const channel = guild.channels.cache.find(
      (c) => c.name === 'general',
    ) as TextChannel

    const sent = await channel.send('Original content')
    const edited = await sent.edit('Edited content')
    expect(edited.content).toBe('Edited content')

    expect(await discord.channel(channelId).text()).toMatchInlineSnapshot(`
      "--- from: user (TestUser)
      Hello from user!
      Actor helper message
      --- from: assistant (TestBot)
      Hello from bot!
      Edited content"
    `)
    const messages = await discord.channel(channelId).getMessages()
    const found = messages.find((m) => m.id === sent.id)
    expect(found?.content).toBe('Edited content')
    expect(found?.edited_timestamp).toBeTruthy()
  })

  test('message delete removes from DB', async () => {
    const guild = client.guilds.cache.first()!
    const channel = guild.channels.cache.find(
      (c) => c.name === 'general',
    ) as TextChannel

    const sent = await channel.send('To be deleted')
    const sentId = sent.id
    await sent.delete()

    expect(await discord.channel(channelId).text()).toMatchInlineSnapshot(`
      "--- from: user (TestUser)
      Hello from user!
      Actor helper message
      --- from: assistant (TestBot)
      Hello from bot!
      Edited content"
    `)
    const messages = await discord.channel(channelId).getMessages()
    const found = messages.find((m) => m.id === sentId)
    expect(found).toBeUndefined()
  })

  test('reactions can be added via message.react', async () => {
    const guild = client.guilds.cache.first()!
    const channel = guild.channels.cache.find(
      (c) => c.name === 'general',
    ) as TextChannel

    const sent = await channel.send('React to me')
    await sent.react('🔥')

    expect(await discord.channel(channelId).text()).toMatchInlineSnapshot(`
      "--- from: user (TestUser)
      Hello from user!
      Actor helper message
      --- from: assistant (TestBot)
      Hello from bot!
      Edited content
      React to me"
    `)
    const reactions = await discord.prisma.reaction.findMany({
      where: { messageId: sent.id },
    })
    expect(reactions).toHaveLength(1)
    expect(reactions[0]!.emoji).toBe('🔥')
    expect(reactions[0]!.userId).toBe(discord.botUserId)
  })
})
