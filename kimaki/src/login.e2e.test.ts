import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import type { BotHandle } from './main.ts'
import { TEST_USER_ID, seedProjectChannel, startOpencodeTestServer, startTestBot, startTwin, tempDataDir, waitFor, waitForSelectMenu, warmUp, type OpencodeTestServer, type TestTwin } from './test/harness.ts'

const exec = promisify(execFile)
const dataDir = tempDataDir()
let bot: BotHandle
let server: OpencodeTestServer
let twin: TestTwin
beforeAll(async () => {
  ;[server, twin] = await Promise.all([startOpencodeTestServer({ plugins: [path.resolve('src/test/auth-plugin')] }), startTwin()])
  await seedProjectChannel({ dataDir, channelId: twin.channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  bot = await startTestBot({ dataDir, twin, server })
  await warmUp({ server })
}, 60_000)
afterAll(async () => {
  await bot?.stop()
  await Promise.all([server?.stop(), twin?.stop()])
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('/login API key stores an OpenCode credential and makes its provider available to /model', async () => {
  const { discord, channelId } = twin
  const user = discord.channel(channelId).user(TEST_USER_ID)
  await user.runSlashCommand({ name: 'login' })
  const provider = await waitForSelectMenu({ discord, channelId, prefix: 'login_provider:' })
  await user.selectMenu({ messageId: provider.message.id, customId: provider.select.custom_id, values: ['openai'] })
  const method = await waitForSelectMenu({ discord, channelId, prefix: provider.select.custom_id.replace('login_provider:', 'login_method:') })
  await user.selectMenu({ messageId: method.message.id, customId: method.select.custom_id, values: ['key'] })
  await user.submitModal({ customId: method.select.custom_id.replace('login_method:', 'login_key:'), fields: [{ customId: 'key', value: 'p7-test-key' }] })
  await waitFor({ label: 'login success', check: async () => (await discord.channel(channelId).text()).includes('Connected OpenAI') })
  await user.runSlashCommand({ name: 'model' })
  const models = await waitForSelectMenu({ discord, channelId, prefix: 'model:' })
  expect(await discord.channel(channelId).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    Connect OpenAI
    Connected OpenAI. Use /model to select a model.
    **Set Model Preference**
    **Current:** OpenCode default
    Select a provider:"
  `)
  expect(models.select.options.some((option) => option.value === 'openai')).toBe(true)
  const client = await server.client()
  const integration = await client.integration.get({ integrationID: 'openai', location: { directory: server.projectDirectory } })
  expect(integration.data.connections.length).toBeGreaterThan(0)
})

test('CLI login uses integration key login and credential activation without exposing the secret', async () => {
  const result = await exec(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), 'login', 'anthropic', '--key', 'p7-anthropic-key', '--data-dir', dataDir], {
    env: { ...process.env, KIMAKI_LOCK_PORT: String(bot.lock.port) },
  })
  expect(result.stdout).toContain('Connected')
  expect(result.stdout).not.toContain('p7-anthropic-key')
  const info = await (await server.client()).integration.get({ integrationID: 'anthropic', location: { directory: server.projectDirectory } })
  expect(info.data.connections.length).toBeGreaterThan(0)
})

test('/login OAuth code uses native attempts and can activate a stored credential', async () => {
  const { discord, channelId } = twin
  const user = discord.channel(channelId).user(TEST_USER_ID)
  await user.runSlashCommand({ name: 'login' })
  const provider = await waitForSelectMenu({ discord, channelId, prefix: 'login_provider:' })
  await user.selectMenu({ messageId: provider.message.id, customId: provider.select.custom_id, values: ['openai'] })
  const method = await waitForSelectMenu({ discord, channelId, prefix: provider.select.custom_id.replace('login_provider:', 'login_method:') })
  await user.selectMenu({ messageId: method.message.id, customId: method.select.custom_id, values: ['oauth:p7-code'] })
  await waitFor({ label: 'authorization URL', check: async () => (await discord.channel(channelId).text()).includes('Enter the test authorization code') })
  await user.submitModal({ customId: method.select.custom_id.replace('login_method:', 'login_code:'), fields: [{ customId: 'code', value: 'test-code' }] })
  await waitFor({ label: 'OAuth complete', check: async () => (await discord.channel(channelId).text()).includes('OAuth connected') })
  expect(await discord.channel(channelId).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    Connect OpenAI
    Connected OpenAI. Use /model to select a model.
    **Set Model Preference**
    **Current:** OpenCode default
    Select a provider:
    http://127.0.0.1/authorize
    Enter the test authorization code.
    OpenAI OAuth connected. Use /model to select a model."
  `)
  const info = await (await server.client()).integration.get({ integrationID: 'openai', location: { directory: server.projectDirectory } })
  expect(info.data.connections.some((connection) => connection.type === 'credential' && connection.method === 'oauth')).toBe(true)
})
