import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test } from 'vitest'
import type { BotHandle } from './main.ts'
import { TEST_USER_ID, seedProjectChannel, startOpencodeTestServer, startTestBot, startTwin, tempDataDir, waitForFooter, warmUp, type OpencodeTestServer, type TestTwin } from './test/harness.ts'
import { send } from './prompt.ts'

const exec = promisify(execFile)
const dataDir = tempDataDir()
let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
beforeAll(async () => {
  ;[server, twin] = await Promise.all([startOpencodeTestServer(), startTwin()])
  await seedProjectChannel({ dataDir, channelId: twin.channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  bot = await startTestBot({ dataDir, twin, server })
  await warmUp({ server })
}, 60_000)
afterAll(async () => {
  await bot?.stop()
  await Promise.all([server?.stop(), twin?.stop()])
  fs.rmSync(dataDir, { recursive: true, force: true })
})
function cli(args: string[]) {
  return exec(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), ...args, '--data-dir', dataDir], { env: {
    ...process.env, KIMAKI_LOCK_PORT: String(bot.lock.port), KIMAKI_DISCORD_REST_URL: twin.discord.restUrl,
  } })
}
test('independent Discord CLI lists threads and users, uploads a file, and reads bot credentials', async () => {
  const started = await send(bot, { channelId: twin.channelId, prompt: 'Discord CLI flow' })
  if (started instanceof Error) throw started
  if (!started.sessionId) throw new Error('Expected an AI session')
  await waitForFooter({ discord: twin.discord, threadId: started.threadId })
  fs.writeFileSync(path.join(server.root, 'report.txt'), 'report')
  const threads = await cli(['thread', 'list', '--channel', twin.channelId, '--json'])
  const users = await cli(['user', 'list', '--guild', twin.discord.guildId, '--query', 'tommy', '--json'])
  await cli(['upload-to-discord', path.join(server.root, 'report.txt'), '--session', started.sessionId])
  // The agent learns that nothing was posted.
  const missing = await cli(['upload-to-discord', path.join(server.root, 'missing.png'), '--session', started.sessionId]).catch((error: { stderr: string }) => error)
  expect(missing.stderr.replace(server.root, '<root>')).toMatchInlineSnapshot(`
    "File not found: <root>/missing.png
    "
  `)
  const token = await cli(['bot', 'token'])
  const install = await cli(['bot', 'install-url'])
  expect(await twin.discord.thread(started.threadId).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    » **CLI:** Discord CLI flow
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*
    [attachment: report.txt]"
  `)
  expect(threads.stdout).toContain(started.threadId)
  expect(users.stdout).toContain(TEST_USER_ID)
  expect(token.stdout.trim()).toBe(twin.discord.botToken)
  // Self-hosted: the bot's own OAuth URL. Gateway: kimaki.dev with the client ID.
  expect(install.stdout).toContain(twin.discord.botToken.includes(':') ? `clientId=${twin.discord.botToken.split(':')[0]}` : twin.discord.botUserId)
  expect((await twin.discord.thread(started.threadId).getMessages()).some((message) => message.attachments.some((file) => file.filename === 'report.txt'))).toBe(true)
})
