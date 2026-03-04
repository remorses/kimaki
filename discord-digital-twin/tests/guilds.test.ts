// Phase 5 tests: guild routes (channels, roles, members, active threads).
// Validates that discord.js managers can call guild REST endpoints against
// the DigitalDiscord server and that gateway updates stay in sync.

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  TextChannel,
  Role,
} from 'discord.js'
import { DigitalDiscord } from '../src/index.js'

describe('guild management routes', () => {
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
          topic: 'phase-5-test',
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
        GatewayIntentBits.GuildMembers,
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

  test('guild fetch route returns seeded guild', async () => {
    const guild = await client.guilds.fetch(discord.guildId)
    expect(guild.id).toBe(discord.guildId)
    expect(guild.name).toBe('Test Server')
  })

  test('guild channels list and create route work', async () => {
    const guild = await client.guilds.fetch(discord.guildId)
    const existing = await guild.channels.fetch()
    const existingNames = [...existing.values()].map((channel) => {
      return channel?.name
    })
    expect(existingNames).toContain('general')

    const channelCreateEvent = new Promise<TextChannel>((resolve) => {
      client.once('channelCreate', (channel) => {
        resolve(channel as TextChannel)
      })
    })

    const created = await guild.channels.create({
      name: 'phase5-created-channel',
      type: ChannelType.GuildText,
      topic: 'created by phase 5 test',
    })

    const emittedChannel = await channelCreateEvent
    expect(emittedChannel.id).toBe(created.id)

    const dbChannel = await discord.prisma.channel.findUnique({
      where: { id: created.id },
    })
    expect(dbChannel?.name).toBe('phase5-created-channel')
    expect(dbChannel?.guildId).toBe(discord.guildId)
  })

  test('guild roles list/create/update routes work', async () => {
    const guild = await client.guilds.fetch(discord.guildId)
    const roles = await guild.roles.fetch()
    const roleNames = [...roles.values()].map((role) => {
      return role.name
    })
    expect(roleNames).toContain('@everyone')

    const roleCreateEvent = new Promise<Role>((resolve) => {
      client.once('roleCreate', (role) => {
        resolve(role)
      })
    })

    const role = await guild.roles.create({ name: 'phase5-role' })
    const createdRole = await roleCreateEvent
    expect(createdRole.id).toBe(role.id)

    const roleUpdateEvent = new Promise<Role>((resolve) => {
      client.once('roleUpdate', (_oldRole, newRole) => {
        resolve(newRole)
      })
    })

    const updatedRole = await role.edit({
      name: 'phase5-role-updated',
      mentionable: true,
    })
    const emittedUpdatedRole = await roleUpdateEvent
    expect(emittedUpdatedRole.id).toBe(updatedRole.id)
    expect(emittedUpdatedRole.name).toBe('phase5-role-updated')

    const dbRole = await discord.prisma.role.findUnique({ where: { id: role.id } })
    expect(dbRole?.name).toBe('phase5-role-updated')
    expect(dbRole?.mentionable).toBe(true)
  })

  test('guild members list/search/get routes work', async () => {
    const listResponse = await fetch(
      `${discord.restUrl}/v10/guilds/${discord.guildId}/members?limit=10`,
    )
    expect(listResponse.status).toBe(200)
    const listMembers = (await listResponse.json()) as Array<{ user: { id: string } }>
    const listIds = listMembers.map((member) => {
      return member.user.id
    })
    expect(listIds).toContain(testUserId)

    const searchResponse = await fetch(
      `${discord.restUrl}/v10/guilds/${discord.guildId}/members/search?query=Test&limit=10`,
    )
    expect(searchResponse.status).toBe(200)
    const searchMembers = (await searchResponse.json()) as Array<{ user: { id: string } }>
    const searchIds = searchMembers.map((member) => {
      return member.user.id
    })
    expect(searchIds).toContain(testUserId)

    const singleResponse = await fetch(
      `${discord.restUrl}/v10/guilds/${discord.guildId}/members/${testUserId}`,
    )
    expect(singleResponse.status).toBe(200)
    const singleMember = (await singleResponse.json()) as {
      user: { id: string; username: string }
    }
    expect(singleMember.user.id).toBe(testUserId)
    expect(singleMember.user.username).toBe('TestUser')
  })

  test('guild active threads route returns active thread list', async () => {
    const guild = await client.guilds.fetch(discord.guildId)
    const channel = (await guild.channels.fetch(channelId)) as TextChannel
    const starter = await channel.send('phase5 active thread starter')
    const thread = await starter.startThread({
      name: 'phase5-active-thread',
      autoArchiveDuration: 1440,
    })

    expect(await discord.channel(channelId).text()).toMatchInlineSnapshot(`
      "--- from: assistant (TestBot)
      phase5 active thread starter"
    `)
    const activeThreads = await guild.channels.fetchActiveThreads()
    expect(activeThreads.threads.has(thread.id)).toBe(true)
    expect(activeThreads.threads.get(thread.id)?.name).toBe('phase5-active-thread')
  })
})
