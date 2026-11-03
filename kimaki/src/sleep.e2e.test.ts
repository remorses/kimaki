// `kimaki sleep` end to end (spec 10.5, 12.1, Phase 8): the agent runs the
// command through the shim, the bot stores the wake with its clock, the
// scheduler wakes the same thread, and a user message cancels the sleep.
// Sleeps of at most 45 minutes keep the prompt cache warm (plugin/coordinator.ts).

import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { DeterministicMatcher } from 'opencode-deterministic-provider'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
import {
  TEST_USER_ID,
  manualClock,
  seedProjectChannel,
  startOpencodeTestServer,
  startTestBot,
  startTwin,
  tempDataDir,
  textParts,
  toolParts,
  waitFor,
  waitForFooter,
  warmUp,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

const WARM_INTERVAL_MS = 200

function sleepTurn({ marker, command }: { marker: string; command: string }): DeterministicMatcher[] {
  const callId = `${marker}-call`
  return [
    { id: callId, priority: 100, when: { latestUserTextIncludes: marker }, then: { parts: [
      { type: 'text-start', id: 'intro' }, { type: 'text-delta', id: 'intro', delta: 'Waiting for the deploy.' }, { type: 'text-end', id: 'intro' },
      ...toolParts({ toolCallId: callId, toolName: 'shell', input: { command, description: 'Sleep until the deploy is done', hasSideEffect: true } }),
    ] } },
    // Only after the command printed its result: a failed call must not look like a sleep.
    { id: `${marker}-done`, priority: 110, when: { latestUserTextIncludes: marker, rawPromptIncludes: 'Sleeping until' }, then: { parts: textParts('Sleeping until the deploy is done.') } },
  ]
}

const dataDir = tempDataDir()
const clock = manualClock(Date.parse('2030-01-01T09:00:00Z'))
let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle

beforeAll(async () => {
  ;[server, twin] = await Promise.all([
    startOpencodeTestServer({ plugins: [path.resolve('src/test/generate-log-plugin')], matchers: [
      ...sleepTurn({ marker: 'sleep-marker', command: "kimaki sleep --duration 30m --reason 'waiting for the deploy'" }),
      ...sleepTurn({ marker: 'cancel-marker', command: 'kimaki sleep --until 2030-01-01T10:30:00Z' }),
      { id: 'wake', priority: 200, when: { latestUserTextIncludes: 'Woke after sleeping until' }, then: { parts: textParts('Awake, checking the deploy.') } },
      { id: 'never-mind', priority: 200, when: { latestUserTextIncludes: 'Never mind' }, then: { parts: textParts('Noted, no wake needed.') } },
    ] }),
    startTwin(),
  ])
  await seedProjectChannel({ dataDir, channelId: twin.channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  bot = await startTestBot({ dataDir, twin, server, clock, schedulerIntervalMs: null, warmupTimers: { intervalMs: WARM_INTERVAL_MS, maxMs: 60_000 } })
  await warmUp({ server })
}, 60_000)

afterAll(async () => {
  await bot?.stop()
  await Promise.all([server?.stop(), twin?.stop()])
  fs.rmSync(dataDir, { recursive: true, force: true })
})

async function start(prompt: string) {
  const { discord, channelId } = twin
  const before = new Set((await discord.channel(channelId).getThreads()).map((thread) => thread.id))
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: prompt })
  const thread = await discord.channel(channelId).waitForThread({ timeout: 8_000, predicate: (candidate) => !before.has(candidate.id) })
  await waitForFooter({ discord, threadId: thread.id })
  return { threadId: thread.id, sessionId: bot.store.getState().roots[thread.id]! }
}

// Keep-alive requests of a session, from the test plugin.
function keepAlives(sessionId: string): number {
  const file = path.join(server.root, 'generate.log')
  if (!fs.existsSync(file)) return 0
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line === sessionId).length
}

async function sleepRow(sessionId: string) {
  return bot.db.query.session_sleeps.findFirst({ where: { session_id: sessionId } })
}

test('kimaki sleep wakes the same thread at the clock time', async () => {
  const { threadId, sessionId } = await start('Deploy and then sleep-marker')
  expect((await sleepRow(sessionId))?.wake_at.toISOString()).toBe('2030-01-01T09:30:00.000Z')
  // A 30 minute sleep stays warm until the wake.
  await waitFor({ label: 'keep-alive while sleeping', check: async () => keepAlives(sessionId) > 0 || null })

  clock.set(Date.parse('2030-01-01T09:29:59Z'))
  await bot.scheduler.runDueTasks()
  clock.set(Date.parse('2030-01-01T09:30:00Z'))
  await bot.scheduler.runDueTasks()
  await waitForFooter({ discord: twin.discord, threadId, count: 2 })
  expect(await twin.discord.thread(threadId).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Deploy and then sleep-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    Waiting for the deploy.

    -# ┣ shell _Sleep until the deploy is done_

    Sleeping until the deploy is done.
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    -# Woke after sleeping until 2030-01-01 09:30 UTC. Reason: waiting for the deploy
    Awake, checking the deploy.
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  const row = await sleepRow(sessionId)
  expect(row?.status).toBe('consumed')
  // Consumed: running again does not wake twice.
  await bot.scheduler.runDueTasks()
  expect((await twin.discord.thread(threadId).getMessages()).filter((message) => message.content.includes('Woke after')).length).toBe(1)
  // A retried wake reuses the prompt ID: OpenCode returns the delivered item and starts nothing new.
  const client = await server.client()
  const retry = await client.session.prompt({ sessionID: sessionId, id: `msg_sleep_${row!.delivery_id}`, text: 'again' })
  expect(retry.payload.text.startsWith('Woke after sleeping until')).toBe(true)
  const users = await client.message.list({ sessionID: sessionId, type: 'user', order: 'asc' })
  expect(users.data.filter((message) => message.type === 'user' && message.text === 'again')).toEqual([])
})

test('a user message cancels the sleep', async () => {
  const { threadId, sessionId } = await start('Deploy and then cancel-marker')
  expect((await sleepRow(sessionId))?.status).toBe('planned')
  // The clock is at 09:30 after the first test: a 1 hour sleep is too long to keep warm, no keep-alive after a few intervals.
  await sleep(WARM_INTERVAL_MS * 3)
  expect(keepAlives(sessionId)).toBe(0)
  await twin.discord.thread(threadId).user(TEST_USER_ID).sendMessage({ content: 'Never mind, it is deployed' })
  await waitForFooter({ discord: twin.discord, threadId, count: 2 })
  expect((await sleepRow(sessionId))?.status).toBe('cancelled')

  clock.set(Date.parse('2030-01-01T10:30:00Z'))
  await bot.scheduler.runDueTasks()
  // Nothing may appear: poll briefly instead of a wait helper.
  for (let attempt = 0; attempt < 10; attempt++) {
    const texts = (await twin.discord.thread(threadId).getMessages()).map((message) => message.content)
    expect(texts.some((text) => text.includes('Woke after'))).toBe(false)
    await sleep(20)
  }
  expect(await twin.discord.thread(threadId).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Deploy and then cancel-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    Waiting for the deploy.

    -# ┣ shell _Sleep until the deploy is done_

    Sleeping until the deploy is done.
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    --- from: user (tommy)
    Never mind, it is deployed
    --- from: assistant (TestBot)
    Noted, no wake needed.
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})
