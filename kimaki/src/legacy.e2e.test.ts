// Upgrade from V1: the data dir has only a V1 discord-sessions.db (fake rows,
// real V1 schema from fixtures/v1-schema.sql) that binds an existing thread
// to a session V1 created without metadata.kimaki. The bot start imports the
// database, and a message in the old thread continues that same session,
// which the bot adopts (marker + instructions entry).

import fs from 'node:fs'
import path from 'node:path'
import { createClient } from '@libsql/client'
import { ChannelType } from 'discord.js'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
import { LEGACY_DB_FILE } from './migrations.ts'
import { createApi } from './project.ts'
import {
  startOpencodeTestServer,
  startTestBot,
  startTwin,
  tempDataDir,
  TEST_USER_ID,
  waitForFooter,
  warmUp,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
let dataDir: string

beforeAll(async () => {
  dataDir = tempDataDir()
  ;[server, twin] = await Promise.all([startOpencodeTestServer(), startTwin()])
  await warmUp({ server })
}, 60_000)

afterAll(async () => {
  await bot?.stop()
  await twin?.stop()
  await server?.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('bot starts on a V1 database and answers in an old thread with the old session', async () => {
  const { discord } = twin
  // What V1 left behind: a thread, and a session with history but no Kimaki marker.
  const thread = await createApi({ token: discord.botToken, restUrl: discord.restUrl }).channels.createThread(twin.channelId, {
    name: 'old v1 thread',
    type: ChannelType.PublicThread,
  })
  const client = await server.client()
  const session = await client.session.create({ location: { directory: server.projectDirectory } })
  await client.session.prompt({ sessionID: session.id, text: 'message from the V1 days' })
  await client.session.wait({ sessionID: session.id })

  const schemaSql = fs.readFileSync(path.join(import.meta.dirname, 'fixtures/v1-schema.sql'), 'utf8')
  const v1 = createClient({ url: `file:${path.join(dataDir, LEGACY_DB_FILE)}` })
  await v1.executeMultiple(schemaSql)
  await v1.execute({
    sql: `INSERT INTO bot_tokens (app_id, token, created_at, bot_mode) VALUES (?, ?, '2025-09-30 15:18:00', 'self-hosted')`,
    args: [discord.botUserId, discord.botToken],
  })
  await v1.execute({
    sql: `INSERT INTO channel_directories (channel_id, directory, channel_type, created_at) VALUES (?, ?, 'text', '2025-09-30 16:45:03')`,
    args: [twin.channelId, server.projectDirectory],
  })
  await v1.execute({
    sql: `INSERT INTO thread_sessions (thread_id, session_id, created_at, source) VALUES (?, ?, '2026-10-01 07:15:53', 'kimaki')`,
    args: [thread.id, session.id],
  })
  v1.close()

  bot = await startTestBot({ dataDir, twin, server, saveTwinCredentials: false })
  expect(fs.existsSync(path.join(dataDir, 'kimaki.db'))).toBe(true)

  await discord.thread(thread.id).user(TEST_USER_ID).sendMessage({ content: 'hello again after the upgrade' })
  await waitForFooter({ discord, threadId: thread.id })
  expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    hello again after the upgrade
    --- from: assistant (TestBot)
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*"
  `)

  const messages = await client.message.list({ sessionID: session.id })
  const userTexts = messages.data.flatMap((message) => (message.type === 'user' ? [message.text.split('\n')[0]] : []))
  expect(userTexts).toMatchInlineSnapshot(`
    [
      "hello again after the upgrade",
      "message from the V1 days",
    ]
  `)
  const adopted = await client.session.get({ sessionID: session.id })
  const marker = adopted.metadata?.['kimaki']
  expect(marker && typeof marker === 'object' && !Array.isArray(marker) ? { threadId: marker['threadId'], channelId: marker['channelId'], dataDir: marker['dataDir'] } : null).toEqual({
    threadId: thread.id,
    channelId: twin.channelId,
    dataDir,
  })
  const entries = await client.session.instructions.entry.list({ sessionID: session.id })
  expect(entries.length).toBe(1)
}, 30_000)
