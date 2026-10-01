// CLI session commands: editors, search by channel, command, named fork, resume by folder.

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
import { scriptedTurn, seedProjectChannel, startOpencodeTestServer, startTestBot, startTwin, tempDataDir, waitForFooter, warmUp, type OpencodeTestServer, type TestTwin } from './test/harness.ts'

const exec = promisify(execFile)
const dataDir = tempDataDir()
let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle

beforeAll(async () => {
  ;[server, twin] = await Promise.all([
    startOpencodeTestServer({
      matchers: [
        ...scriptedTurn({ marker: 'editor-marker', steps: [{ id: 'edit-write-1', tool: 'write', input: { path: 'edited.txt', content: 'by the agent\n' } }], finalText: 'wrote edited.txt' }),
        ...scriptedTurn({ marker: 'patch-marker', steps: [{ id: 'patch-1', tool: 'patch', input: { patchText: '*** Begin Patch\n*** Add File: patched.txt\n+hello\n*** End Patch' } }], finalText: 'patched' }),
      ],
    }),
    startTwin(),
  ])
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
  return exec(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'), path.resolve('src/cli.ts'), ...args, '--data-dir', dataDir], {
    cwd: server.projectDirectory,
    env: { ...process.env, KIMAKI_LOCK_PORT: String(bot.lock.port), KIMAKI_OPENCODE_SERVICE_FILE: server.serviceFile, KIMAKI_DISCORD_REST_URL: twin.discord.restUrl },
  })
}

async function newSession(prompt: string) {
  const started = await bot.actions.send({ channelId: twin.channelId, prompt })
  if (started instanceof Error || !started.sessionId) throw new Error('Expected a session')
  await waitForFooter({ discord: twin.discord, threadId: started.threadId })
  return { threadId: started.threadId, sessionId: started.sessionId }
}

// Runs first: critique only goes online when the working tree has changes.
test('session diff prints critique output for the session folder', async () => {
  const clean = await newSession('diff-source')
  const diff = await cli(['session', 'diff', '--session', clean.sessionId])
  expect(diff.stdout).toContain('No changes to display')
})

test('session editors lists sessions that wrote a file, skips failed tool calls; search accepts a channel', async () => {
  const writer = await newSession('editor-marker write')
  // The deterministic model has no patch tool: this call fails and must not count.
  await newSession('patch-marker patch')
  const written = await cli(['session', 'editors', 'edited.txt', '--json'])
  const failed = await cli(['session', 'editors', path.join(server.projectDirectory, 'patched.txt')]).catch((error: Error & { code: number }) => error)
  const searched = await cli(['session', 'search', 'editor-marker', '--channel', twin.channelId])
  expect(JSON.parse(written.stdout).map((row: { sessionId: string }) => row.sessionId)).toEqual([writer.sessionId])
  expect(failed instanceof Error && failed.code).toBe(1)
  expect(searched.stdout).toContain(writer.sessionId)
})

test('session command, named fork, and resume without a channel use the session folder', async () => {
  const source = await newSession('command-source')
  await cli(['session', 'command', 'unknown-cmd', 'with', 'args', '--session', source.sessionId])
  await waitForFooter({ discord: twin.discord, threadId: source.threadId, count: 2 })
  const forked = JSON.parse((await cli(['session', 'fork', source.sessionId, '--name', 'named fork'])).stdout)
  const resumed = JSON.parse((await cli(['session', 'resume', source.sessionId])).stdout)
  const history = await (await server.client()).message.list({ sessionID: source.sessionId, order: 'asc' })
  expect(history.data.flatMap((message) => (message.type === 'user' ? [message.text] : [])).some((text) => text.startsWith('/unknown-cmd with args'))).toBe(true)
  expect(await twin.discord.thread(source.threadId).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    » **CLI:** command-source
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*"
  `)
  expect((await twin.discord.thread(forked.threadId).getChannel())?.name).toBe('named fork')
  expect(resumed.sessionId).toBe(source.sessionId)
  expect(resumed.threadId).not.toBe(source.threadId)
})
