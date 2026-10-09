// Non-interactive gateway onboarding through the real CLI process, like a
// cloud sandbox: stdout carries SSE events (install_url, authorized, ready).
// A local fake kimaki.dev answers /api/onboarding/status and, like the real
// OAuth callback, authorizes the new client in the twin, which plays
// gateway-proxy (REST scope rules enforced).

import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { createApi } from './project.ts'
import {
  freePort,
  startOpencodeTestServer,
  startTwin,
  tempDataDir,
  TEST_USER_ID,
  textParts,
  waitFor,
  waitForFooter,
  warmUp,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

const execFileAsync = promisify(execFile)
let server: OpencodeTestServer
let twin: TestTwin
let website: http.Server
let websiteUrl: string
let dataDir: string
let child: ChildProcessWithoutNullStreams | null = null

beforeAll(async () => {
  dataDir = tempDataDir()
  ;[server, twin] = await Promise.all([
    startOpencodeTestServer({
      matchers: [
        {
          id: 'onboarding-greeting',
          priority: 50,
          when: { latestUserTextIncludes: 'This is the Kimaki onboarding thread' },
          then: { parts: textParts('Want channels for your projects?') },
        },
      ],
    }),
    startTwin({ gateway: true }),
  ])
  await warmUp({ server })
  // Fake kimaki.dev: the user "installs" the bot as soon as the CLI polls.
  website = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== '/api/onboarding/status') {
      response.writeHead(404).end()
      return
    }
    twin.discord.authorizeGatewayClient({
      token: `${url.searchParams.get('client_id')}:${url.searchParams.get('secret')}`,
      guildIds: [twin.discord.guildId],
    })
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ guild_id: twin.discord.guildId, discord_user_id: TEST_USER_ID }))
  })
  const port = await freePort()
  await new Promise<void>((resolve) => website.listen(port, '127.0.0.1', resolve))
  websiteUrl = `http://127.0.0.1:${port}`
}, 60_000)

afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child?.once('exit', resolve))
    child.kill('SIGTERM')
    await exited
  }
  await new Promise<void>((resolve) => website?.close(() => resolve()))
  await twin?.stop()
  await server?.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function sseEvents(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length)) as Record<string, unknown>)
}

test('kimaki --gateway without a TTY installs, onboards and reports ready on stdout', async () => {
  const require = createRequire(import.meta.url)
  const proxy = new URL('/', twin.discord.restUrl).toString()
  const lockPort = await freePort()
  child = spawn(
    process.execPath,
    ['--import', require.resolve('tsx'), path.resolve('src/cli.ts'), '--data-dir', dataDir, '--gateway', '--machine-name', 'test-machine'],
    {
      env: {
        ...process.env,
        KIMAKI_WEBSITE_URL: websiteUrl,
        KIMAKI_GATEWAY_PROXY_URL: proxy,
        KIMAKI_LOCK_PORT: String(lockPort),
        KIMAKI_OPENCODE_SERVICE_FILE: server.serviceFile,
        OPENCODE_CONFIG_DIR: server.configDir,
      },
    },
  )
  const output = { stdout: '', stderr: '' }
  child.stdout.on('data', (chunk: Buffer) => (output.stdout += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (output.stderr += chunk.toString()))
  await waitFor({
    label: `ready event (stderr: ${output.stderr.slice(-500)})`,
    timeout: 10_000,
    check: async () => sseEvents(output.stdout).some((event) => event['type'] === 'ready'),
  })

  const token = (sseEvents(output.stdout)[0]?.['url'] as string).match(/clientId=([^&]+)&clientSecret=([^&]+)/)
  expect(
    sseEvents(output.stdout).map((event) =>
      JSON.parse(
        JSON.stringify(event)
          .replaceAll(websiteUrl, '<website>')
          .replaceAll(token?.[1] ?? '-', '<clientId>')
          .replaceAll(token?.[2] ?? '-', '<secret>')
          .replaceAll(twin.discord.guildId, '<guild>'),
      ),
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "type": "install_url",
        "url": "<website>/discord-install?clientId=<clientId>&clientSecret=<secret>",
      },
      {
        "guild_id": "<guild>",
        "type": "authorized",
      },
      {
        "app_id": "1477605701202481173",
        "guild_ids": [
          "<guild>",
        ],
        "type": "ready",
      },
    ]
  `)

  const channels = await createApi({ token: twin.discord.botToken, restUrl: twin.discord.restUrl }).guilds.getChannels(twin.discord.guildId)
  const names = new Map(channels.map((channel) => [channel.id, channel.name]))
  expect(channels.map((channel) => `${channel.name}${channel.parent_id ? ` (in ${names.get(channel.parent_id)})` : ''}`)).toMatchInlineSnapshot(`
    [
      "project",
      "random",
      "quiet",
      "Kimaki test-machine",
      "kimaki (in Kimaki test-machine)",
      "Kimaki voice (in Kimaki test-machine)",
    ]
  `)

  const kimakiChannel = channels.find((channel) => channel.name === 'kimaki')!
  const thread = await twin.discord.channel(kimakiChannel.id).waitForThread({ timeout: 8_000 })
  await waitForFooter({ discord: twin.discord, threadId: thread.id })
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    **Kimaki** lets you code from Discord. Each project channel is linked to a folder on your computer. A message there starts an AI coding session in that folder.
    Reply in the thread below to add channels for your projects. <@200000000000000001>
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    Want channels for your projects?
    -# *kimaki ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)

  // `kimaki restart`: the supervisor starts a new bot process, which reports ready again.
  const cli = (args: string[]) => execFileAsync(process.execPath, ['--import', require.resolve('tsx'), path.resolve('src/cli.ts'), ...args, '--data-dir', dataDir], {
    env: { ...process.env, KIMAKI_LOCK_PORT: String(lockPort) },
  })
  const before = JSON.parse((await cli(['status', '--json'])).stdout) as { pid: number }
  await cli(['restart'])
  await waitFor({
    label: `second ready event (stderr: ${output.stderr.slice(-500)})`,
    check: async () => sseEvents(output.stdout).filter((event) => event['type'] === 'ready').length === 2,
  })
  const after = JSON.parse((await cli(['status', '--json'])).stdout) as { pid: number }
  expect({ newPid: after.pid !== before.pid, supervisorAlive: child.exitCode === null }).toEqual({ newPid: true, supervisorAlive: true })
}, 40_000)

test('--install-url --gateway prints the install URL with the callback and exits', async () => {
  const otherDataDir = tempDataDir()
  const require = createRequire(import.meta.url)
  const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const process_ = spawn(
      process.execPath,
      [
        '--import', require.resolve('tsx'), path.resolve('src/cli.ts'),
        '--data-dir', otherDataDir, '--install-url', '--gateway', '--gateway-callback-url', 'https://example.com/done',
      ],
      { env: { ...process.env, KIMAKI_WEBSITE_URL: 'https://kimaki.test' } },
    )
    const output = { stdout: '' }
    process_.stdout.on('data', (chunk: Buffer) => (output.stdout += chunk.toString()))
    process_.once('exit', (code) => resolve({ code, stdout: output.stdout }))
  })
  fs.rmSync(otherDataDir, { recursive: true, force: true })
  expect({
    code: result.code,
    url: result.stdout.trim().replace(/clientId=[^&]+&clientSecret=[^&]+/, 'clientId=<clientId>&clientSecret=<secret>'),
  }).toMatchInlineSnapshot(`
    {
      "code": 0,
      "url": "https://kimaki.test/discord-install?clientId=<clientId>&clientSecret=<secret>&kimakiCallbackUrl=https%3A%2F%2Fexample.com%2Fdone",
    }
  `)
})
