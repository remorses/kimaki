import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ChannelType, Client, Events, GatewayIntentBits } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import { setDataDir } from './config.js'
import { closeDb } from './db.js'
import {
  createDefaultKimakiChannel,
  createProjectChannels,
  ensureKimakiCategory,
} from './channel-management.js'
import {
  getGuildCategories,
  initDatabase,
  setChannelDirectory,
} from './database.js'

const guildId = '100000000000000111'
const otherGuildId = '100000000000000222'
let directory: string
let discord: DigitalDiscord
let client: Client

async function startDiscord({ dataDir }: { dataDir: string }) {
  discord = new DigitalDiscord({
    dbUrl: `file:${path.join(dataDir, 'discord.db')}`,
    users: [{ id: '100000000000000555', username: 'server-owner' }],
    guilds: [
      { id: guildId, name: 'Studio', ownerId: '100000000000000555' },
      { id: otherGuildId, name: 'Office', ownerId: '100000000000000555' },
    ],
  })
  await discord.start()
  client = new Client({
    intents: [GatewayIntentBits.Guilds],
    rest: { api: discord.restUrl, version: '10' },
  })
  const ready = new Promise<void>((resolve) =>
    client.once(Events.ClientReady, () => resolve()),
  )
  await client.login(discord.botToken)
  await ready
}

async function openDataDir() {
  const root = path.resolve('tmp/guild-categories')
  fs.mkdirSync(root, { recursive: true })
  directory = fs.mkdtempSync(path.join(root, 'run-'))
  setDataDir(directory)
  await closeDb()
  await initDatabase()
}

beforeEach(async () => {
  await openDataDir()
  await startDiscord({ dataDir: directory })
})

afterEach(async () => {
  await client?.destroy()
  await discord?.stop()
  await closeDb()
  fs.rmSync(directory, { recursive: true, force: true })
})

function guild() {
  return client.guilds.cache.get(guildId)!
}

test('first project creates a Kimaki group and stores its id', async () => {
  const created = await createProjectChannels({
    guild: guild(),
    projectDirectory: path.join(directory, 'web'),
  })
  const channel = await guild().channels.fetch(created.textChannelId)
  expect(channel?.parentId).toBeTruthy()
  const category = await guild().channels.fetch(channel!.parentId!)
  expect(category?.name).toBe('Kimaki')
  expect(await getGuildCategories(guildId)).toEqual({
    guild_id: guildId,
    category_id: category!.id,
    audio_category_id: null,
  })
})

test('renamed group still receives new project channels', async () => {
  const first = await createProjectChannels({
    guild: guild(),
    projectDirectory: path.join(directory, 'web'),
  })
  const firstChannel = await guild().channels.fetch(first.textChannelId)
  const category = await guild().channels.fetch(firstChannel!.parentId!)
  await category!.setName('laptop')
  const second = await createProjectChannels({
    guild: guild(),
    projectDirectory: path.join(directory, 'api'),
  })
  const secondChannel = await guild().channels.fetch(second.textChannelId)
  expect(secondChannel?.parentId).toBe(firstChannel?.parentId)
  expect((await guild().channels.fetch(secondChannel!.parentId!))?.name).toBe(
    'laptop',
  )
})

test('a second machine creates its own Kimaki group', async () => {
  const first = await createProjectChannels({
    guild: guild(),
    projectDirectory: path.join(directory, 'web'),
  })
  const firstParent = (await guild().channels.fetch(first.textChannelId))
    ?.parentId
  await closeDb()

  await openDataDir()
  const second = await createProjectChannels({
    guild: guild(),
    projectDirectory: path.join(directory, 'api'),
  })
  const secondParent = (await guild().channels.fetch(second.textChannelId))
    ?.parentId
  expect(secondParent).toBeTruthy()
  expect(secondParent).not.toBe(firstParent)
  const categories = [...guild().channels.cache.values()].filter(
    (channel) => channel.type === ChannelType.GuildCategory,
  )
  expect(categories.map((channel) => channel.name).sort()).toEqual([
    'Kimaki',
    'Kimaki',
  ])
})

test('existing project channels adopt their parent without creating a new group', async () => {
  const category = await guild().channels.create({
    name: 'studio',
    type: ChannelType.GuildCategory,
  })
  const text = await guild().channels.create({
    name: 'web',
    type: ChannelType.GuildText,
    parent: category,
  })
  await setChannelDirectory({
    channelId: text.id,
    directory: path.join(directory, 'web'),
    channelType: 'text',
    guildId,
  })
  const resolved = await ensureKimakiCategory(guild())
  expect(resolved.id).toBe(category.id)
  expect(await getGuildCategories(guildId)).toMatchObject({
    guild_id: guildId,
    category_id: category.id,
  })
  const categoryCount = [...guild().channels.cache.values()].filter(
    (channel) => channel.type === ChannelType.GuildCategory,
  ).length
  expect(categoryCount).toBe(1)
})

test('a second machine gets its own default kimaki channel', async () => {
  const first = await createDefaultKimakiChannel({
    guild: guild(),
    appId: discord.botUserId,
    isGatewayMode: true,
  })
  expect(first).toBeTruthy()
  await closeDb()

  await openDataDir()
  const second = await createDefaultKimakiChannel({
    guild: guild(),
    appId: discord.botUserId,
    isGatewayMode: true,
  })
  expect(second).toBeTruthy()
  expect(second!.textChannelId).not.toBe(first!.textChannelId)
  expect(second!.textChannel.parentId).not.toBe(first!.textChannel.parentId)
})

test('legacy rows from another guild do not block adoption', async () => {
  const otherGuild = client.guilds.cache.get(otherGuildId)!
  const foreignCategory = await otherGuild.channels.create({
    name: 'foreign',
    type: ChannelType.GuildCategory,
  })
  const foreignChannel = await otherGuild.channels.create({
    name: 'web',
    type: ChannelType.GuildText,
    parent: foreignCategory,
  })
  const localCategory = await guild().channels.create({
    name: 'studio',
    type: ChannelType.GuildCategory,
  })
  const localChannel = await guild().channels.create({
    name: 'api',
    type: ChannelType.GuildText,
    parent: localCategory,
  })
  await setChannelDirectory({
    channelId: foreignChannel.id,
    directory: path.join(directory, 'foreign'),
    channelType: 'text',
  })
  await setChannelDirectory({
    channelId: localChannel.id,
    directory: path.join(directory, 'api'),
    channelType: 'text',
  })
  const resolved = await ensureKimakiCategory(guild())
  expect(resolved.id).toBe(localCategory.id)
})

test('a kimaki-prefixed project channel does not block the default channel', async () => {
  await createProjectChannels({
    guild: guild(),
    projectDirectory: path.join(directory, 'kimaki-tools'),
  })
  const created = await createDefaultKimakiChannel({
    guild: guild(),
    appId: discord.botUserId,
    isGatewayMode: true,
  })
  expect(created).toBeTruthy()
  expect(created!.channelName).toBe('kimaki')
})

test('concurrent first creates share one group', async () => {
  const [first, second] = await Promise.all([
    ensureKimakiCategory(guild()),
    ensureKimakiCategory(guild()),
  ])
  expect(first.id).toBe(second.id)
  const categories = [...guild().channels.cache.values()].filter(
    (channel) => channel.type === ChannelType.GuildCategory,
  )
  expect(categories).toHaveLength(1)
})

test('deleted group is replaced and SQLite is updated', async () => {
  const first = await createProjectChannels({
    guild: guild(),
    projectDirectory: path.join(directory, 'web'),
  })
  const firstParent = (await guild().channels.fetch(first.textChannelId))
    ?.parentId
  await (await guild().channels.fetch(firstParent!))!.delete()
  const second = await createProjectChannels({
    guild: guild(),
    projectDirectory: path.join(directory, 'api'),
  })
  const secondParent = (await guild().channels.fetch(second.textChannelId))
    ?.parentId
  expect(secondParent).toBeTruthy()
  expect(secondParent).not.toBe(firstParent)
  expect(await getGuildCategories(guildId)).toMatchObject({
    category_id: secondParent,
  })
})
