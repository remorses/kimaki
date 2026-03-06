// Phase 3 tests: channels, threads, thread members, archiving.
// Validates that discord.js Client can create threads, send messages in them,
// archive them, and manage thread members through the DigitalDiscord server.

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { Client, GatewayIntentBits, ChannelType } from 'discord.js'
import type { TextChannel, ThreadChannel } from 'discord.js'
import { DigitalDiscord } from '../src/index.js'

describe('threads and channels', () => {
  let discord: DigitalDiscord
  let client: Client
  let channelId: string
  let testUserId: string
  let createdThreadId: string

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

  test('GET channel returns channel data', async () => {
    const channel = await discord.channel(channelId).getChannel()
    expect(channel).toBeDefined()
    expect(channel!.name).toBe('general')
  })

  test('create thread from message via startThread()', async () => {
    const guild = client.guilds.cache.first()!
    const channel = guild.channels.cache.find(
      (c) => c.name === 'general',
    ) as TextChannel

    const message = await channel.send('Thread starter message')

    const threadCreatePromise = new Promise<ThreadChannel>((resolve) => {
      client.once('threadCreate', (thread) => {
        resolve(thread as ThreadChannel)
      })
    })

    const thread = await message.startThread({
      name: 'test-thread',
      autoArchiveDuration: 1440,
    })
    createdThreadId = thread.id

    expect(await discord.channel(channelId).text()).toMatchInlineSnapshot(`
      "--- from: assistant (TestBot)
      Thread starter message"
    `)
    expect(thread.name).toBe('test-thread')
    expect(thread.parentId).toBe(channelId)
    expect(thread.type).toBe(ChannelType.PublicThread)

    // Verify thread persisted in DB
    const dbThread = await discord.prisma.channel.findUnique({
      where: { id: thread.id },
    })
    expect(dbThread).toBeDefined()
    expect(dbThread!.name).toBe('test-thread')
    expect(dbThread!.type).toBe(ChannelType.PublicThread)
    expect(dbThread!.parentId).toBe(channelId)

    // Verify THREAD_CREATE event fired on the client
    const createdThread = await threadCreatePromise
    expect(createdThread.id).toBe(thread.id)
  })

  test('send message in thread', async () => {
    const thread = client.channels.cache.get(createdThreadId) as ThreadChannel

    const sent = await thread.send('Message in thread')
    expect(sent.content).toBe('Message in thread')

    expect(await discord.thread(createdThreadId).text()).toMatchInlineSnapshot(`
      "--- from: assistant (TestBot)
      Thread starter message
      --- from: assistant (TestBot)
      Message in thread"
    `)
    const messages = await discord.thread(createdThreadId).getMessages()
    expect(messages.some((m) => m.content === 'Message in thread')).toBe(true)
  })

  test('archive thread via setArchived(true)', async () => {
    const thread = client.channels.cache.get(createdThreadId) as ThreadChannel

    const archived = await thread.setArchived(true)
    expect(archived.archived).toBe(true)

    // Verify archived flag in DB
    const dbThread = await discord.prisma.channel.findUniqueOrThrow({
      where: { id: createdThreadId },
    })
    expect(dbThread.archived).toBe(true)
    expect(dbThread.archiveTimestamp).toBeTruthy()
  })

  test('unarchive and add thread member', async () => {
    const thread = client.channels.cache.get(createdThreadId) as ThreadChannel

    // Unarchive first so we can modify the thread
    await thread.setArchived(false)

    await thread.members.add(testUserId)

    const members = await discord.prisma.threadMember.findMany({
      where: { channelId: createdThreadId },
    })
    // Bot (auto-added at creation) + TestUser
    expect(members).toHaveLength(2)
    expect(members.some((m) => m.userId === testUserId)).toBe(true)
    expect(members.some((m) => m.userId === discord.botUserId)).toBe(true)
  })

  test('create standalone thread via channel.threads.create()', async () => {
    const guild = client.guilds.cache.first()!
    const channel = guild.channels.cache.find(
      (c) => c.name === 'general',
    ) as TextChannel

    const thread = await channel.threads.create({
      name: 'standalone-thread',
      autoArchiveDuration: 1440,
      type: ChannelType.PublicThread,
    })

    expect(thread.name).toBe('standalone-thread')
    expect(thread.parentId).toBe(channelId)

    // Verify in DB
    const dbThread = await discord.prisma.channel.findUnique({
      where: { id: thread.id },
    })
    expect(dbThread).toBeDefined()
    expect(dbThread!.name).toBe('standalone-thread')
    expect(dbThread!.type).toBe(ChannelType.PublicThread)
  })

  test('getThreads returns threads for parent channel', async () => {
    const threads = await discord.channel(channelId).getThreads()
    expect(threads.length).toBeGreaterThanOrEqual(2)
    const names = threads.map((t) => t.name)
    expect(names).toContain('test-thread')
    expect(names).toContain('standalone-thread')
  })
})
