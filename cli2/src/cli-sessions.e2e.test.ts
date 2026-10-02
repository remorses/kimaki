// CLI session commands: editors, search by channel, command, named fork, resume by folder.

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import os from 'node:os'
import { createRequire } from 'node:module'
import { eq } from 'drizzle-orm'
import { promisify } from 'node:util'
import { afterAll, beforeAll, expect, test } from 'vitest'

import { openDb } from './db.ts'
import type { BotHandle } from './main.ts'
import * as schema from './schema.ts'
import { scriptedTurn, seedProjectChannel, startOpencodeTestServer, startTestBot, startTwin, tempDataDir, textParts, waitForFooter, warmUp, type OpencodeTestServer, type TestTwin } from './test/harness.ts'
import { send } from './prompt.ts'

const exec = promisify(execFile)
const dataDir = tempDataDir()
let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle

beforeAll(async () => {
  ;[server, twin] = await Promise.all([
    startOpencodeTestServer({
      commands: { review: { template: 'Review this change: $ARGUMENTS' } },
      matchers: [
        { id: 'review', priority: 500, when: { latestUserTextIncludes: 'Review this change: focus --focus security' }, then: { parts: textParts('reviewed with passthrough') } },
        ...scriptedTurn({ marker: 'editor-marker', steps: [{ id: 'edit-write-1', tool: 'write', input: { path: 'edited.txt', content: 'by the agent\n' } }], finalText: 'wrote edited.txt' }),
        ...scriptedTurn({ marker: 'fail-marker', steps: [{ id: 'fail-edit-1', tool: 'edit', input: { path: 'missing.txt', oldString: 'a', newString: 'b' } }], finalText: 'edit failed' }),
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
  // Options must precede `--`: everything after it is passthrough.
  const separator = args.indexOf('--')
  const withDataDir = separator === -1 ? [...args, '--data-dir', dataDir] : [...args.slice(0, separator), '--data-dir', dataDir, ...args.slice(separator)]
  return exec(process.execPath, ['--import', createRequire(import.meta.url).resolve('tsx'), path.resolve('src/cli.ts'), ...withDataDir], {
    cwd: server.projectDirectory,
    env: { ...process.env, KIMAKI_LOCK_PORT: String(bot.lock.port), KIMAKI_OPENCODE_SERVICE_FILE: server.serviceFile, KIMAKI_DISCORD_REST_URL: twin.discord.restUrl },
  })
}

async function newSession(prompt: string) {
  const started = await send(bot, { channelId: twin.channelId, prompt })
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
  // An edit of a missing file fails and must not be recorded.
  await newSession('fail-marker edit')
  const written = await cli(['session', 'editors', 'edited.txt', '--json'])
  const failed = await cli(['session', 'editors', path.join(server.projectDirectory, 'missing.txt')]).catch((error: Error & { code: number }) => error)
  const searched = await cli(['session', 'search', 'editor-marker', '--channel', twin.channelId])
  expect(JSON.parse(written.stdout).map((row: { sessionId: string }) => row.sessionId)).toEqual([writer.sessionId])
  expect(failed instanceof Error && failed.code).toBe(1)
  expect(searched.stdout).toContain(writer.sessionId)
})

test('session command, named fork, and resume without a channel use the session folder', async () => {
  const source = await newSession('command-source')
  // Arguments after `--` reach the command template.
  await cli(['session', 'command', 'review', 'focus', '--session', source.sessionId, '--', '--focus', 'security'])
  await waitForFooter({ discord: twin.discord, threadId: source.threadId, count: 2 })
  const forked = JSON.parse((await cli(['session', 'fork', source.sessionId, '--name', 'named fork'])).stdout)
  const resumed = JSON.parse((await cli(['session', 'resume', source.sessionId])).stdout)
  expect(await twin.discord.thread(source.threadId).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    » **CLI:** command-source
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*
    reviewed with passthrough
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  expect((await twin.discord.thread(forked.threadId).getChannel())?.name).toBe('named fork')
  expect(resumed.sessionId).toBe(source.sessionId)
  expect(resumed.threadId).not.toBe(source.threadId)
})

test('session resume finds the project channel when SQLite stores a symlink alias', async () => {
  const alias = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-alias-')), 'project-link')
  fs.symlinkSync(server.projectDirectory, alias)
  const opened = await openDb({ dataDir, migrate: false })
  if (opened instanceof Error) throw opened
  await opened.db.update(schema.channel_directories).set({ directory: alias }).where(eq(schema.channel_directories.channel_id, twin.channelId))
  opened.close()
  try {
    const source = await newSession('alias-source')
    const resumed = JSON.parse((await cli(['session', 'resume', source.sessionId])).stdout)
    expect(resumed.sessionId).toBe(source.sessionId)
  } finally {
    const restore = await openDb({ dataDir, migrate: false })
    if (restore instanceof Error) throw restore
    await restore.db.update(schema.channel_directories).set({ directory: server.projectDirectory }).where(eq(schema.channel_directories.channel_id, twin.channelId))
    restore.close()
    fs.rmSync(path.dirname(alias), { recursive: true, force: true })
  }
})
