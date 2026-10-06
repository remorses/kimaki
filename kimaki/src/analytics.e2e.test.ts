// Product analytics end to end: the real Strada SDK exports OTLP JSON logs to
// a local receiver instead of strada.sh. One Discord turn produces the funnel
// events with the common identity props. The deterministic model reports zero
// tokens, so tokens_used is skipped here; analytics.test.ts covers it.

import fs from 'node:fs'
import http from 'node:http'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { createAnalytics } from './analytics.ts'
import type { BotHandle } from './main.ts'
import {
  freePort,
  seedProjectChannel,
  startOpencodeTestServer,
  startTestBot,
  startTwin,
  tempDataDir,
  TEST_USER_ID,
  waitFor,
  waitForFooter,
  warmUp,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

type OtlpValue = { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean }
type OtlpLogs = {
  resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<{ attributes: Array<{ key: string; value: OtlpValue }> }> }> }>
}

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
let dataDir: string
let receiver: http.Server
const received: Array<Record<string, unknown>> = []

beforeAll(async () => {
  dataDir = tempDataDir()
  receiver = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      if (request.url === '/v1/logs') {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as OtlpLogs
        for (const record of body.resourceLogs.flatMap((logs) => logs.scopeLogs.flatMap((scope) => scope.logRecords))) {
          received.push(Object.fromEntries(record.attributes.map(({ key, value }) => [key, value.stringValue ?? value.boolValue ?? value.doubleValue ?? Number(value.intValue)])))
        }
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  const port = await freePort()
  await new Promise<void>((resolve) => receiver.listen(port, '127.0.0.1', resolve))
  ;[server, twin] = await Promise.all([startOpencodeTestServer(), startTwin()])
  await warmUp({ server })
  await seedProjectChannel({ dataDir, channelId: twin.channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  bot = await startTestBot({
    dataDir,
    twin,
    server,
    analytics: createAnalytics({ dataDir, botMode: 'self_hosted', enabled: true, endpoint: `http://127.0.0.1:${port}` }),
  })
}, 60_000)

afterAll(async () => {
  await bot?.stop()
  await twin?.stop()
  await server?.stop()
  await new Promise<void>((resolve) => receiver?.close(() => resolve()))
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('a Discord turn sends the funnel events with anonymous identity props', async () => {
  await twin.discord.channel(twin.channelId).user(TEST_USER_ID).sendMessage({ content: 'analytics turn' })
  const thread = await twin.discord.channel(twin.channelId).waitForThread({ timeout: 8_000 })
  await waitForFooter({ discord: twin.discord, threadId: thread.id })
  await waitFor({
    label: 'turn_completed exported',
    check: async () => {
      await bot.analytics.flush()
      return received.some((event) => event['event.name'] === 'turn_completed')
    },
  })
  const installId = fs.readFileSync(`${dataDir}/install-id`, 'utf8').trim()
  expect(
    received.map((event) => {
      const { ['custom.install_id']: id, ['custom.platform']: platform, ['custom.arch']: arch, ...rest } = event
      return {
        ...rest,
        'custom.install_id': id === installId ? '<install-id>' : id,
        'custom.platform': platform === process.platform ? '<platform>' : platform,
        'custom.arch': arch === process.arch ? '<arch>' : arch,
      }
    }),
  ).toMatchInlineSnapshot(`
    [
      {
        "custom.arch": "<arch>",
        "custom.bot_mode": "self_hosted",
        "custom.guild_count": 1,
        "custom.install_id": "<install-id>",
        "custom.platform": "<platform>",
        "custom.schema_version": 1,
        "custom.user_project_count": 1,
        "event.name": "bot_started",
      },
      {
        "custom.arch": "<arch>",
        "custom.bot_mode": "self_hosted",
        "custom.has_worktree": false,
        "custom.install_id": "<install-id>",
        "custom.platform": "<platform>",
        "custom.schema_version": 1,
        "custom.source": "discord",
        "event.name": "session_created",
      },
      {
        "custom.arch": "<arch>",
        "custom.bot_mode": "self_hosted",
        "custom.install_id": "<install-id>",
        "custom.platform": "<platform>",
        "custom.schema_version": 1,
        "event.name": "turn_started",
      },
      {
        "custom.arch": "<arch>",
        "custom.bot_mode": "self_hosted",
        "custom.duration_sec": 0,
        "custom.install_id": "<install-id>",
        "custom.platform": "<platform>",
        "custom.schema_version": 1,
        "event.name": "turn_completed",
      },
    ]
  `)
})
