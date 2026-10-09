// gateway-proxy buffers message events while the bot is offline and replays
// them right after READY. Those messages must start or continue sessions like
// live ones, even though they arrive before OpenCode is connected.

import fs from 'node:fs'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
import {
  TEST_USER_ID,
  seedProjectChannel,
  startOpencodeTestServer,
  startTestBot,
  startTwin,
  tempDataDir,
  waitForFooter,
  warmUp,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle | null = null
let dataDir: string

beforeAll(async () => {
  dataDir = tempDataDir()
  ;[server, twin] = await Promise.all([startOpencodeTestServer(), startTwin({ gateway: true })])
  await seedProjectChannel({
    dataDir,
    channelId: twin.channelId,
    guildId: twin.discord.guildId,
    directory: server.projectDirectory,
  })
  await warmUp({ server })
})

afterAll(async () => {
  await bot?.stop()
  await twin?.stop()
  await server?.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('messages sent while the bot is offline are handled after it reconnects', async () => {
  const { discord, channelId } = twin
  bot = await startTestBot({ dataDir, twin, server })
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'thread before going offline' })
  const thread = await discord.channel(channelId).waitForThread({ timeout: 8_000 })
  await waitForFooter({ discord, threadId: thread.id })

  await bot.stop()
  bot = null
  // The twin buffers these like gateway-proxy does for a disconnected client.
  await discord.thread(thread.id).user(TEST_USER_ID).sendMessage({ content: 'thread message while offline' })
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'channel message while offline' })
  bot = await startTestBot({ dataDir, twin, server })

  await waitForFooter({ discord, threadId: thread.id, count: 2 })
  const offlineThread = await discord.channel(channelId).waitForThread({
    timeout: 8_000,
    predicate: (candidate) => candidate.name === 'channel message while offline',
  })
  await waitForFooter({ discord, threadId: offlineThread.id })

  expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    thread before going offline
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*
    --- from: user (tommy)
    thread message while offline
    --- from: assistant (TestBot)
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*"
  `)
  expect(await discord.thread(offlineThread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    channel message while offline
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*"
  `)
})

// @discordjs/rest clears its token on any 401. A gateway-proxy restart with an
// empty client registry answered 401 for a minute and every later request failed
// with "Expected token to be set" until the bot restarted.
test('the bot keeps working after the gateway answered 401 for a while', async () => {
  const { discord, channelId } = twin
  bot ??= await startTestBot({ dataDir, twin, server })
  discord.revokeGatewayClient({ token: discord.botToken })
  // The permission check gets 401, so this message is ignored.
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'message during the 401 window' })
  const ignored = await bot.discord.guilds.cache.get(discord.guildId)!.members.fetch({ user: TEST_USER_ID, force: true }).catch((error: Error) => error)
  expect(ignored).toBeInstanceOf(Error)
  discord.authorizeGatewayClient({ token: discord.botToken, guildIds: [discord.guildId] })
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'message after the gateway recovered' })
  const thread = await discord.channel(channelId).waitForThread({
    timeout: 8_000,
    predicate: (candidate) => candidate.name === 'message after the gateway recovered',
  })
  await waitForFooter({ discord, threadId: thread.id })
  expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    message after the gateway recovered
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*"
  `)
})
