// `. btw` and /btw fork the session into a new "btw:" thread that answers a
// side question while the source session keeps running.

import fs from 'node:fs'
import type { DeterministicMatcher } from 'opencode-deterministic-provider'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
import {
  TEST_USER_ID,
  seedProjectChannel,
  slowTextMatcher,
  startOpencodeTestServer,
  startTestBot,
  startTwin,
  tempDataDir,
  textParts,
  waitForBotMessageContaining,
  waitForFooter,
  warmUp,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

const matchers: DeterministicMatcher[] = [
  slowTextMatcher({ marker: 'slow-marker', text: 'slow-done', delayMs: 2_000 }),
  { id: 'side', priority: 50, when: { latestUserTextIncludes: 'side-marker' }, then: { parts: textParts('side answer') } },
  { id: 'slash', priority: 50, when: { latestUserTextIncludes: 'slash-marker' }, then: { parts: textParts('slash answer') } },
]

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
let dataDir: string

beforeAll(async () => {
  dataDir = tempDataDir()
  ;[server, twin] = await Promise.all([startOpencodeTestServer({ matchers }), startTwin()])
  await seedProjectChannel({
    dataDir,
    channelId: twin.channelId,
    guildId: twin.discord.guildId,
    directory: server.projectDirectory,
  })
  await warmUp({ server })
  bot = await startTestBot({ dataDir, twin, server })
})

afterAll(async () => {
  await bot?.stop()
  await twin?.stop()
  await server?.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function hideIds(text: string): string {
  return text.replace(/<#\d+>/g, '<#THREAD>').replace(/ses_\w+/g, 'ses_ID')
}

async function waitForBtwThread(existing: Set<string>) {
  return twin.discord.channel(twin.channelId).waitForThread({
    timeout: 8_000,
    predicate: (thread) => !existing.has(thread.id) && (thread.name?.startsWith('btw:') ?? false),
  })
}

test('. btw forks into a side thread while the source run continues', async () => {
  const { discord, channelId } = twin
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'Long task slow-marker' })
  const source = await discord.channel(channelId).waitForThread({ timeout: 8_000 })
  await waitForBotMessageContaining({ discord, threadId: source.id, text: '*using ' })
  const existing = new Set((await discord.channel(channelId).getThreads()).map((thread) => thread.id))

  await discord.thread(source.id).user(TEST_USER_ID).sendMessage({ content: 'What is 2+2 side-marker. btw' })
  const fork = await waitForBtwThread(existing)
  await waitForFooter({ discord, threadId: fork.id })
  await waitForFooter({ discord, threadId: source.id })

  expect(fork.name).toBe('btw: What is 2+2 side-marker')
  expect(hideIds(await discord.thread(source.id).text())).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Long task slow-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    --- from: user (tommy)
    What is 2+2 side-marker. btw
    --- from: assistant (TestBot)
    Session forked! Continue in <#THREAD>
    slow-done
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  expect(hideIds(await discord.thread(fork.id).text())).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    Reusing context from <#THREAD> to answer prompt...
    What is 2+2 side-marker
    side answer
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  const rows = await bot.db.query.thread_sessions.findMany({ where: { thread_id: fork.id } })
  expect(rows.length).toBe(1)
  // The plugin only exports KIMAKI_TOOL_CALL to shells when the marker has the CLI context,
  // so `kimaki buttons` failed on the first turn of every fork.
  const info = await (await server.client()).session.get({ sessionID: rows[0]!.session_id })
  expect(info.metadata?.['kimaki']).toMatchObject({ threadId: fork.id, dataDir, lockPort: expect.any(Number) })
})

test('/btw forks from a thread with an idle session, with the picked agent', async () => {
  const { discord, channelId } = twin
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'Short task' })
  const source = await discord.channel(channelId).waitForThread({
    timeout: 8_000,
    predicate: (thread) => thread.name === 'Short task',
  })
  await waitForFooter({ discord, threadId: source.id })
  const existing = new Set((await discord.channel(channelId).getThreads()).map((thread) => thread.id))
  const user = discord.thread(source.id).user(TEST_USER_ID)

  const choices = await user.autocomplete({
    name: 'btw',
    options: [{ name: 'prompt', type: 3, value: 'x' }, { name: 'agent', type: 3, value: 'pla' }],
    focused: 'agent',
  })
  expect(choices.map((choice) => choice.value)).toEqual(['plan'])

  // An unknown agent fails before any thread is created.
  await user.runSlashCommand({
    name: 'btw',
    options: [{ name: 'prompt', type: 3, value: 'Side slash-marker' }, { name: 'agent', type: 3, value: 'nope' }],
  })
  await waitForBotMessageContaining({ discord, threadId: source.id, text: 'Agent `nope` is not available' })

  await user.runSlashCommand({
    name: 'btw',
    options: [{ name: 'prompt', type: 3, value: 'Side slash-marker' }, { name: 'agent', type: 3, value: 'plan' }],
  })
  const fork = await waitForBtwThread(existing)
  await waitForFooter({ discord, threadId: fork.id })
  expect((await discord.channel(channelId).getThreads()).filter((thread) => !existing.has(thread.id)).length).toBe(1)
  expect(hideIds(await discord.thread(fork.id).text())).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    Reusing context from <#THREAD> to answer prompt...
    Side slash-marker
    -# Switched agent to Plan
    slash answer
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2 ⋅ plan*"
  `)
  const row = await bot.db.query.thread_sessions.findFirst({ where: { thread_id: fork.id } })
  const info = await (await server.client()).session.get({ sessionID: row!.session_id })
  expect(info.agent).toBe('plan')
})
