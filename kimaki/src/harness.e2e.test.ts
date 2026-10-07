// Phase 0: the bot starts against the digital twin and an isolated OpenCode
// service, answers /health, and reconnects after the service restarts on a
// new port with a new password.

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import dedent from 'string-dedent'
import { afterAll, beforeAll, expect, onTestFinished, test } from 'vitest'

import { startLockServer } from './lock-server.ts'
import type { BotHandle } from './main.ts'
import {
  startOpencodeTestServer,
  freePort,
  seedProjectChannel,
  TEST_USER_ID,
  waitForFooter,
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
  await twin?.stop()
  await server?.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('bot answers /health and reaches the OpenCode service', async () => {
  const health = await fetch(`http://127.0.0.1:${bot.lock.port}/health`).then((response) => response.json())
  expect(health).toEqual({ status: 'ok', pid: process.pid, wrapperPid: null })
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

test('the lock server creates a missing data dir (fresh install)', async () => {
  const root = tempDataDir()
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }))
  const missing = path.join(root, 'not', 'created')
  const lock = await startLockServer({ port: await freePort(), dataDir: missing })
  if (lock instanceof Error) throw lock
  expect(fs.statSync(path.join(missing, 'lock-token')).mode & 0o777).toBe(0o600)
  await lock.close()
})

test('a second bot on the same lock port stops the running one and takes over', async () => {
  const otherData = tempDataDir()
  const port = await freePort()
  await seedProjectChannel({ dataDir: otherData, channelId: twin.quietChannelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  const code = dedent`
    import { startBot } from ${JSON.stringify(path.resolve('src/main.ts'))}
    import { startLockServer } from ${JSON.stringify(path.resolve('src/lock-server.ts'))}
    import { disabledAnalytics } from ${JSON.stringify(path.resolve('src/analytics.ts'))}
    const lock = await startLockServer({ port: ${port}, dataDir: ${JSON.stringify(otherData)} })
    if (lock instanceof Error) throw lock
    const result = await startBot({ analytics: disabledAnalytics, lock, ...${JSON.stringify({ dataDir: otherData, token: twin.discord.botToken, appId: twin.discord.botUserId, discordRestUrl: twin.discord.restUrl, opencodeServiceFile: server.serviceFile, opencodeConfigDir: server.configDir, ensureOpencode: false, kimakiCommand: 'kimaki' })} })
    if (result instanceof Error) throw result
    process.send({ ready: true })
    process.once('SIGTERM', async () => { await result.stop(); process.exit(0) })
  `
  const child = spawn(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'), '--input-type=module', '--eval', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited }
    fs.rmSync(otherData, { recursive: true, force: true })
  })
  const ready = new Promise<void>((resolve, reject) => { child.once('message', () => resolve()); child.once('error', reject); child.once('exit', () => reject(new Error('Old bot exited before ready'))) })
  await ready
  expect(await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json())).toEqual({ status: 'ok', pid: child.pid, wrapperPid: null })
  // The old bot gets SIGTERM, shuts down cleanly, then the new one binds the port.
  const replacement = await startTestBot({ dataDir: otherData, twin, server, lockPort: port })
  onTestFinished(() => replacement.stop())
  await exited
  expect(child.exitCode).toBe(0)
  expect(await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json())).toEqual({ status: 'ok', pid: process.pid, wrapperPid: null })
  await twin.discord.channel(twin.quietChannelId).user(TEST_USER_ID).sendMessage({ content: 'Lock takeover prompt' })
  const thread = await twin.discord.channel(twin.quietChannelId).waitForThread({ timeout: 8000 })
  await waitForFooter({ discord: twin.discord, threadId: thread.id })
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Lock takeover prompt
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*"
  `)
})
