// Phase 3: a plain message interrupts the run, /abort stops it and clears
// the queue, a restarted bot still shows the queue it did not see being
// created, and the slash commands are registered. Split from queue.e2e so
// both files run in parallel.

import fs from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
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

function reply(marker: string, text: string): DeterministicMatcher {
  return { id: marker, priority: 50, when: { latestUserTextIncludes: marker }, then: { parts: textParts(text) } }
}

const matchers: DeterministicMatcher[] = [
  slowTextMatcher({ marker: 'slow-marker', text: 'slow-done', delayMs: 2_500 }),
  reply('steer-marker', 'steer ok'),
  reply('queued-one', 'queued one ok'),
  reply('queued-two', 'queued two ok'),
  reply('edited-marker', 'edited ok'),
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

// Starts a slow turn in a new thread and waits until it runs (banner posted).
async function startSlowThread(content: string) {
  const { discord, channelId } = twin
  const before = new Set((await discord.channel(channelId).getThreads()).map((thread) => thread.id))
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: `${content} slow-marker` })
  const thread = await discord.channel(channelId).waitForThread({
    timeout: 8_000,
    predicate: (candidate) => !before.has(candidate.id),
  })
  await waitForBotMessageContaining({ discord, threadId: thread.id, text: '*using ' })
  return thread
}

// Polls 200ms: the text must never appear in the thread.
async function expectNever({ threadId, text }: { threadId: string; text: string }) {
  for (let index = 0; index < 10; index++) {
    await sleep(20)
    const messages = await twin.discord.thread(threadId).getMessages()
    expect(messages.some((message) => message.content.includes(text))).toBe(false)
  }
}

test('plain message interrupts the run and is answered', async () => {
  const thread = await startSlowThread('Interrupt me')
  await twin.discord.thread(thread.id).user(TEST_USER_ID).sendMessage({ content: 'Stop and do this steer-marker' })
  await waitForFooter({ discord: twin.discord, threadId: thread.id })
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Interrupt me slow-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    --- from: user (tommy)
    Stop and do this steer-marker
    --- from: assistant (TestBot)
    steer ok
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  await expectNever({ threadId: thread.id, text: 'slow-done' })
})

test('/abort stops the run and clears the queue', async () => {
  const thread = await startSlowThread('Abort me')
  const user = twin.discord.thread(thread.id).user(TEST_USER_ID)
  await user.sendMessage({ content: 'Never runs queued-one. queue' })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: 'position 1' })
  await user.runSlashCommand({ name: 'abort' })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: 'aborted' })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: 'Removed from queue' })
  await expectNever({ threadId: thread.id, text: 'slow-done' })
  await expectNever({ threadId: thread.id, text: 'queued one ok' })
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Abort me slow-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    --- from: user (tommy)
    Never runs queued-one. queue
    --- from: assistant (TestBot)
    -# Removed from queue
    Request **aborted**, cleared 1 queued message"
  `)
})

test('a restarted bot still echoes and runs the queue it did not see', async () => {
  const thread = await startSlowThread('Restart during queue')
  const user = twin.discord.thread(thread.id).user(TEST_USER_ID)
  await user.sendMessage({ content: 'Survives restart queued-one. queue' })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: 'position 1' })
  await bot.stop()
  bot = await startTestBot({ dataDir, twin, server })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: 'queued one ok' })
  await waitForFooter({ discord: twin.discord, threadId: thread.id })
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Restart during queue slow-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    --- from: user (tommy)
    Survives restart queued-one. queue
    --- from: assistant (TestBot)
    -# Queued at position 1. Delete the original message to remove it, or use /clear-queue position:1
    slow-done
    » **tommy:** Survives restart queued-one
    queued one ok
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})
