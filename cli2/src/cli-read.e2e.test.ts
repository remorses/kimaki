import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test } from 'vitest'
import type { BotHandle } from './main.ts'
import { scriptedTurn, seedProjectChannel, startOpencodeTestServer, startTestBot, startTwin, tempDataDir, waitForFooter, waitForSelectMenu, warmUp, type OpencodeTestServer, type TestTwin } from './test/harness.ts'

const exec = promisify(execFile)
const dataDir = tempDataDir()
let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
beforeAll(async () => {
  ;[server, twin] = await Promise.all([startOpencodeTestServer({ matchers: scriptedTurn({ marker: 'wait-form-marker', steps: [{ id: 'wait-question', tool: 'question', input: { questions: [{ question: 'Continue?', header: 'Next', options: [{ label: 'Yes', description: 'Continue' }] }] } }], finalText: 'Question answered' }) }), startTwin()])
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
  return exec(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), ...args, '--data-dir', dataDir], {
    cwd: process.cwd(), env: { ...process.env, KIMAKI_LOCK_PORT: String(bot.lock.port), KIMAKI_OPENCODE_SERVICE_FILE: server.serviceFile, KIMAKI_DISCORD_REST_URL: twin.discord.restUrl },
  })
}
test('session read, list, search, wait, url and events read real session history', async () => {
  const first = await bot.actions.send({ channelId: twin.channelId, prompt: 'Reader content marker' })
  if (first instanceof Error) throw first
  if (!first.sessionId) throw new Error('Expected an AI session')
  await waitForFooter({ discord: twin.discord, threadId: first.threadId })
  const list = await cli(['session', 'list', '--project', server.projectDirectory, '--json'])
  const search = await cli(['session', 'search', 'Reader content', '--project', server.projectDirectory, '--json'])
  const read = await cli(['session', 'read', first.threadId])
  const wait = await cli(['session', 'wait', first.sessionId, '--timeout', '10s'])
  const url = await cli(['session', 'url', first.sessionId])
  const events = await cli(['session', 'events', first.sessionId])
  expect(await twin.discord.thread(first.threadId).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    » **CLI:** Reader content marker
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*"
  `)
  expect(list.stdout).toContain(first.sessionId)
  expect(search.stdout).toContain(first.sessionId)
  expect(read.stdout).toContain('Reader content marker')
  expect(wait.stdout).toContain('Reader content marker')
  expect(url.stdout).toContain(first.threadId)
  expect(events.stdout).toContain('session.execution.succeeded')
  const none = await cli(['session', 'list', '--active', '--all']).catch((error: Error & { code: number }) => error)
  expect(none instanceof Error && none.code).toBe(1)
})

test('session wait returns for a real pending question; active discovery errors use exit 64', async () => {
  const first = await bot.actions.send({ channelId: twin.channelId, prompt: 'wait-form-marker' })
  if (first instanceof Error || !first.sessionId) throw new Error('Expected a session')
  await waitForSelectMenu({ discord: twin.discord, channelId: first.threadId, prefix: 'form:' })
  const result = await cli(['session', 'wait', first.sessionId, '--timeout', '3s'])
  expect(await twin.discord.thread(first.threadId).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    » **CLI:** wait-form-marker
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    **Next**
    Continue?"
  `)
  expect(result.stdout).toContain('Continue?')
  const failure = await exec(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), 'session', 'list', '--active'], {
    env: { ...process.env, KIMAKI_OPENCODE_SERVICE_FILE: path.join(server.root, 'missing-service.json') },
  }).catch((error: Error & { code: number }) => error)
  expect(failure instanceof Error && failure.code).toBe(64)
  const aborted = await bot.actions.abort({ threadId: first.threadId })
  if (aborted instanceof Error) throw aborted
})
