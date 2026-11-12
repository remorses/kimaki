// `--sort-channels`: a user message in a channel of this machine's category,
// or in one of its threads, moves the channel to the top of the category.

import fs from 'node:fs'
import { ChannelType } from 'discord.js'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { openDb } from './db.ts'
import type { BotHandle } from './main.ts'
import { createApi } from './project.ts'
import * as schema from './schema.ts'
import {
  TEST_USER_ID,
  startOpencodeTestServer,
  startTestBot,
  startTwin,
  tempDataDir,
  waitFor,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
let dataDir: string
let categoryId: string
const ids = new Map<string, string>()

beforeAll(async () => {
  dataDir = tempDataDir()
  ;[server, twin] = await Promise.all([startOpencodeTestServer({ matchers: [] }), startTwin()])
  const api = createApi({ token: twin.discord.botToken, restUrl: twin.discord.restUrl })
  const guildId = twin.discord.guildId
  const category = await api.guilds.createChannel(guildId, { name: 'Kimaki test', type: ChannelType.GuildCategory })
  categoryId = category.id
  for (const name of ['alpha', 'beta', 'gamma']) {
    const channel = await api.guilds.createChannel(guildId, { name, type: ChannelType.GuildText, parent_id: categoryId })
    ids.set(name, channel.id)
  }
  const opened = await openDb({ dataDir, migrate: true })
  if (opened instanceof Error) throw opened
  await opened.db.insert(schema.guild_categories).values({ guild_id: guildId, category_id: categoryId })
  opened.close()
  bot = await startTestBot({ dataDir, twin, server, sortChannelsDelayMs: 50 })
})

afterAll(async () => {
  await bot?.stop()
  await twin?.stop()
  await server?.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

async function categoryOrder() {
  const channels = await twin.discord.getGuildChannels()
  return channels.filter((channel) => 'parent_id' in channel && channel.parent_id === categoryId).map((channel) => channel.name).join(',')
}

async function waitForOrder(expected: string) {
  return waitFor({ label: `order ${expected}`, check: async () => (await categoryOrder()) === expected && expected })
}

test('latest used channel moves to the top, also from a thread; other channels change nothing', async () => {
  const { discord } = twin
  expect(await categoryOrder()).toBe('alpha,beta,gamma')

  await discord.channel(ids.get('beta')!).user(TEST_USER_ID).sendMessage({ content: 'sort-marker beta' })
  await waitForOrder('beta,alpha,gamma')

  // A channel outside the category: the order stays.
  await discord.channel(twin.unregisteredChannelId).user(TEST_USER_ID).sendMessage({ content: 'sort-marker outside' })

  const api = createApi({ token: discord.botToken, restUrl: discord.restUrl })
  const thread = await api.channels.createThread(ids.get('gamma')!, { name: 'gamma thread', type: ChannelType.PublicThread })
  await discord.thread(thread.id).user(TEST_USER_ID).sendMessage({ content: 'sort-marker gamma thread' })
  await waitForOrder('gamma,beta,alpha')

  expect(await discord.channel(ids.get('beta')!).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    sort-marker beta"
  `)
})
