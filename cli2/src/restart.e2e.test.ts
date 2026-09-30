// Phase 1: the thread <-> session binding lives in SQLite, so a restarted bot
// continues the session of an existing thread.

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
  ;[server, twin] = await Promise.all([startOpencodeTestServer(), startTwin()])
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
  await twin?.discord.stop()
  await server?.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('restarted bot continues the session of an existing thread', async () => {
  const { discord, channelId } = twin
  bot = await startTestBot({ dataDir, twin, server })
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'first message before restart' })
  const thread = await discord.channel(channelId).waitForThread({ timeout: 8_000 })
  await waitForFooter({ discord, threadId: thread.id })
  const [binding] = await bot.db.db.query.thread_sessions.findMany()

  await bot.stop()
  bot = await startTestBot({ dataDir, twin, server })

  await discord.thread(thread.id).user(TEST_USER_ID).sendMessage({ content: 'second message after restart' })
  await waitForFooter({ discord, threadId: thread.id, count: 2 })

  expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    first message before restart
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*
    --- from: user (tommy)
    second message after restart
    --- from: assistant (TestBot)
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*"
  `)
  const rows = await bot.db.db.query.thread_sessions.findMany()
  expect(rows.map((row) => row.session_id)).toEqual([binding?.session_id])
  const client = await server.client()
  const messages = await client.message.list({ sessionID: binding!.session_id })
  expect(messages.data.filter((message) => message.type === 'user').length).toBe(2)
})
