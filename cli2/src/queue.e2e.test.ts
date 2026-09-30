// Phase 3: interrupt and queue on the native OpenCode inbox. A plain message
// interrupts the run, `. queue` waits for it, the Remove button and message
// delete/edit change the inbox, /abort stops and clears, and a restarted bot
// still shows the queue it did not see being created.

import fs from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import type { APIMessage } from 'discord.js'
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
  waitFor,
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

function removeButton(message: APIMessage): string | null {
  for (const row of message.components ?? []) {
    if (!('components' in row)) continue
    for (const component of row.components) {
      if ('custom_id' in component && component.custom_id.startsWith('queue_remove:')) return component.custom_id
    }
  }
  return null
}

// The queue ack is a reply to the queued message.
async function waitForAck({ threadId, messageId }: { threadId: string; messageId: string }) {
  return waitFor({
    label: `queue ack of ${messageId}`,
    check: async () => {
      const messages = await twin.discord.thread(threadId).getMessages()
      return messages.find((message) => message.message_reference?.message_id === messageId)
    },
  })
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

test('. queue waits for the run, acks with position, echoes when it starts', async () => {
  const thread = await startSlowThread('Queue after me')
  const user = twin.discord.thread(thread.id).user(TEST_USER_ID)
  await user.sendMessage({ content: 'First queued-one. queue' })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: 'position 1' })
  await user.sendMessage({ content: 'Second queued-two. queue' })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: 'queued two ok' })
  await waitForFooter({ discord: twin.discord, threadId: thread.id })
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Queue after me slow-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    --- from: user (tommy)
    First queued-one. queue
    --- from: assistant (TestBot)
    -# Queued message sent
    --- from: user (tommy)
    Second queued-two. queue
    --- from: assistant (TestBot)
    -# Queued message sent
    slow-done
    » **tommy:** First queued-one
    queued one ok
    » **tommy:** Second queued-two
    queued two ok
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})

test('Remove button and message delete take items out of the queue, edit re-queues', async () => {
  const thread = await startSlowThread('Queue edits')
  const user = twin.discord.thread(thread.id).user(TEST_USER_ID)
  const removed = await user.sendMessage({ content: 'Remove me queued-one. queue' })
  const ack = await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: 'position 1' })
  const customId = removeButton(ack)
  expect(customId).toBeTruthy()
  await user.clickButton({ messageId: ack.id, customId: customId! })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: 'Removed from queue' })

  const deleted = await user.sendMessage({ content: 'Delete me queued-two. queue' })
  await waitForAck({ threadId: thread.id, messageId: deleted.id })
  await user.deleteMessage({ messageId: deleted.id })

  const edited = await user.sendMessage({ content: 'Old text. queue' })
  await waitForAck({ threadId: thread.id, messageId: edited.id })
  await user.editMessage({ messageId: edited.id, content: 'New text edited-marker. queue' })

  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: 'edited ok' })
  await waitForFooter({ discord: twin.discord, threadId: thread.id })
  expect(removed.id).toBeTruthy()
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Queue edits slow-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    --- from: user (tommy)
    Remove me queued-one. queue
    --- from: assistant (TestBot)
    -# Removed from queue
    -# Removed from queue
    --- from: user (tommy)
    New text edited-marker. queue
    --- from: assistant (TestBot)
    -# Removed from queue
    -# Queued message sent
    slow-done
    » **tommy:** New text edited-marker
    edited ok
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  await expectNever({ threadId: thread.id, text: 'queued one ok' })
  await expectNever({ threadId: thread.id, text: 'queued two ok' })
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

test('/queue and /clear-queue', async () => {
  const thread = await startSlowThread('Slash queue')
  const user = twin.discord.thread(thread.id).user(TEST_USER_ID)
  await user.runSlashCommand({ name: 'queue', options: [{ name: 'message', type: 3, value: 'Slash queued-one' }] })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: 'position 1' })
  await user.runSlashCommand({ name: 'queue', options: [{ name: 'message', type: 3, value: 'Slash queued-two' }] })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: 'position 2' })
  await user.runSlashCommand({ name: 'clear-queue', options: [{ name: 'position', type: 4, value: 1 }] })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: 'queued two ok' })
  await waitForFooter({ discord: twin.discord, threadId: thread.id })
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Slash queue slow-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    » **tommy:** Slash queued-one
    -# Removed from queue
    » **tommy:** Slash queued-two
    -# Queued message sent
    -# Cleared 1 queued message
    slow-done
    » **tommy:** Slash queued-two
    queued two ok
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  await expectNever({ threadId: thread.id, text: 'queued one ok' })
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
    -# Queued at position 1. Edit or delete your message to update the queue
    slow-done
    » **tommy:** Survives restart queued-one
    queued one ok
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})

test('slash commands are registered in the guild', async () => {
  const names = await waitFor({
    label: 'registered commands',
    check: async () => {
      const rows = await twin.discord.prisma.applicationCommand.findMany({ where: { guildId: twin.discord.guildId } })
      return rows.length > 0 ? rows.map((row) => row.name).sort() : null
    },
  })
  expect(names).toMatchInlineSnapshot(`
    [
      "abort",
      "btw",
      "clear-queue",
      "queue",
      "session-id",
    ]
  `)
})
