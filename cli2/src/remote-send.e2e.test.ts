import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test } from 'vitest'
import type { BotHandle } from './main.ts'
import { seedProjectChannel, startOpencodeTestServer, startTestBot, startTwin, tempDataDir, waitForFooter, warmUp, type OpencodeTestServer, type TestTwin } from './test/harness.ts'

const exec = promisify(execFile)
const dataA = tempDataDir()
const dataB = tempDataDir()
let server: OpencodeTestServer
let twin: TestTwin
let a: BotHandle
let b: BotHandle
beforeAll(async () => {
  ;[server, twin] = await Promise.all([startOpencodeTestServer(), startTwin()])
  await seedProjectChannel({ dataDir: dataA, channelId: twin.channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  await seedProjectChannel({ dataDir: dataB, channelId: twin.quietChannelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  ;[a, b] = await Promise.all([startTestBot({ dataDir: dataA, twin, server }), startTestBot({ dataDir: dataB, twin, server })])
  await warmUp({ server })
}, 60_000)
afterAll(async () => {
  await Promise.all([a?.stop(), b?.stop()])
  await Promise.all([server?.stop(), twin?.stop()])
  fs.rmSync(dataA, { recursive: true, force: true })
  fs.rmSync(dataB, { recursive: true, force: true })
})
function cli(args: string[]) {
  return exec(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), ...args, '--data-dir', dataA], { env: { ...process.env, KIMAKI_LOCK_PORT: String(a.lock.port) } })
}
test('CLI remote envelope runs only on the owning bot and returns its IDs', async () => {
  const file = path.join(server.root, 'remote.txt')
  fs.writeFileSync(file, 'Remote file content')
  const ids = JSON.parse((await cli(['send', '--channel', twin.quietChannelId, '-p', 'Remote first', '--file', file])).stdout) as { threadId: string; sessionId: string }
  await waitForFooter({ discord: twin.discord, threadId: ids.threadId })
  await cli(['send', '--thread', ids.threadId, '-p', 'Remote queued. queue'])
  await waitForFooter({ discord: twin.discord, threadId: ids.threadId, count: 2 })
  expect((await twin.discord.thread(ids.threadId).text()).replaceAll(ids.threadId, 'THREAD')).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    » **CLI:** Remote first
    Files: remote.txt
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*
    Remote queued. queue
    [embed]
    Delivered to <#THREAD>
    [embed]
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*"
  `)
  expect(a.store.getState().roots[ids.threadId]).toBeUndefined()
  expect(b.store.getState().roots[ids.threadId]).toBe(ids.sessionId)
  const messages = await (await server.client()).message.list({ sessionID: ids.sessionId })
  const first = messages.data.find((message) => message.type === 'user' && message.text.startsWith('Remote first'))
  expect(first?.type === 'user' && first.files?.length).toBe(1)
})
