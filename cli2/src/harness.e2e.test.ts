// Phase 0: the bot starts against the digital twin and an isolated OpenCode
// service, answers /health, and reconnects after the service restarts on a
// new port with a new password.

import fs from 'node:fs'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
import {
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

beforeAll(async () => {
  dataDir = tempDataDir()
  ;[server, twin] = await Promise.all([startOpencodeTestServer(), startTwin()])
  bot = await startTestBot({ dataDir, twin, server })
})

afterAll(async () => {
  await bot?.stop()
  await twin?.discord.stop()
  await server?.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('bot answers /health and reaches the OpenCode service', async () => {
  const health = await fetch(`http://127.0.0.1:${bot.lock.port}/health`).then((response) => response.json())
  expect(health).toEqual({ status: 'ok', pid: process.pid })
  expect(bot.discord.isReady()).toBe(true)
  expect(bot.opencode.connected).toBe(true)
  const client = bot.opencode.endpoint?.client
  expect(await client?.session.active()).toEqual({})
})

test('bot reconnects after the OpenCode service restarts with a new port', async () => {
  const before = bot.opencode.endpoint?.url
  await server.kill()
  await waitFor({ label: 'disconnect', check: async () => !bot.opencode.connected })
  await server.start()
  await waitFor({ label: 'reconnect', timeout: 10_000, check: async () => bot.opencode.connected })
  expect(bot.opencode.endpoint?.url).not.toBe(before)
  expect(await bot.opencode.endpoint?.client.session.active()).toEqual({})
}, 30_000)
