// The queue in a coordinator channel: the channel itself is the conversation, so
// acks and "Queued message sent" replies land in the channel. Every queued
// prompt that got an ack is marked when it starts, also when the coordinator
// answers IDLE; its answer is then not a second reply to the same message.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { DeterministicMatcher } from 'opencode-deterministic-provider'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
import {
  TEST_USER_ID,
  isFooter,
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

const exec = promisify(execFile)

function reply(marker: string, text: string): DeterministicMatcher {
  return { id: marker, priority: 50, when: { latestUserTextIncludes: marker }, then: { parts: textParts(text) } }
}

const matchers: DeterministicMatcher[] = [
  slowTextMatcher({ marker: 'slow-marker', text: 'slow-done', delayMs: 1_200 }),
  reply('queued-idle', 'IDLE'),
  reply('queued-one', 'queued one ok'),
  reply('queued-two', 'queued two ok'),
  reply('steer-marker', 'steer ok'),
  reply('idle-marker', 'idle ok'),
  reply('hello-marker', 'hello'),
]

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
const dataDir = tempDataDir()

beforeAll(async () => {
  ;[server, twin] = await Promise.all([startOpencodeTestServer({ matchers }), startTwin()])
  await seedProjectChannel({ dataDir, channelId: twin.channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  await warmUp({ server })
  bot = await startTestBot({ dataDir, twin, server, coordinator: true })
  // The coordinator session exists before any test: its banner is not part of one test's snapshot.
  await twin.discord.channel(twin.channelId).user(TEST_USER_ID).sendMessage({ content: 'Start hello-marker' })
  await waitForFooter({ discord: twin.discord, threadId: twin.channelId })
}, 60_000)

afterAll(async () => {
  await bot?.stop()
  await twin?.stop()
  await server?.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

// The channel holds every test's turns: the text from the user message that starts with `content`.
async function channelTextFrom(content: string): Promise<string> {
  const text = await twin.discord.channel(twin.channelId).text({ showReplies: true })
  return text.slice(text.lastIndexOf('--- from:', text.lastIndexOf(`\n${content}`)))
}

function footers(): Promise<number> {
  return twin.discord.channel(twin.channelId).getMessages().then((messages) => messages.filter(isFooter).length)
}

// Sends a slow prompt and waits until the coordinator runs it.
async function startSlowTurn(content: string) {
  const channel = twin.discord.channel(twin.channelId)
  channel.clearTypingEvents()
  await channel.user(TEST_USER_ID).sendMessage({ content: `${content} slow-marker` })
  await channel.waitForTypingEvent()
}

async function waitForIdle() {
  await waitFor({ label: 'coordinator idle', check: async () => !bot.store.getState().threads[twin.channelId]?.turn || null })
}

function rootSession(): string {
  const sessionID = bot.store.getState().roots[twin.channelId]
  if (!sessionID) throw new Error('no coordinator session')
  return sessionID
}

test('. queue in a busy coordinator: each queued message gets a reply when it starts, also when it answers IDLE', async () => {
  const before = await footers()
  await startSlowTurn('First a long one')
  const user = twin.discord.channel(twin.channelId).user(TEST_USER_ID)
  const silent = await user.sendMessage({ content: 'Start a worker queued-idle. queue' })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: twin.channelId, text: 'position 1' })
  const answered = await user.sendMessage({ content: 'Then answer queued-two. queue' })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: twin.channelId, text: 'queued two ok' })
  // The IDLE turn posts no footer: slow-done and queued two get one each.
  await waitForFooter({ discord: twin.discord, threadId: twin.channelId, count: before + 2 })
  expect(await channelTextFrom('First a long one')).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    First a long one slow-marker
    Start a worker queued-idle. queue
    --- from: assistant (TestBot)
    [reply to tommy: Start a worker queued-idle. queue]
    -# Queued
    --- from: user (tommy)
    Then answer queued-two. queue
    --- from: assistant (TestBot)
    [reply to tommy: Then answer queued-two. queue]
    -# Queued
    [reply to tommy: First a long one slow-marker]
    slow-done
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    [reply to tommy: Start a worker queued-idle. queue]
    -# Queued message sent
    [reply to tommy: Then answer queued-two. queue]
    -# Queued message sent
    queued two ok
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  const messages = await twin.discord.channel(twin.channelId).getMessages()
  const sent = messages.filter((message) => message.content === '-# Queued message sent')
  expect(sent.map((message) => message.message_reference?.message_id)).toEqual([silent.id, answered.id])
})

test('/queue and /clear-queue in a coordinator', async () => {
  const before = await footers()
  await startSlowTurn('Slash queue here')
  const user = twin.discord.channel(twin.channelId).user(TEST_USER_ID)
  await user.runSlashCommand({ name: 'queue', options: [{ name: 'message', type: 3, value: 'Slash queued-one' }] })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: twin.channelId, text: 'position 1' })
  await user.runSlashCommand({ name: 'queue', options: [{ name: 'message', type: 3, value: 'Slash queued-two' }] })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: twin.channelId, text: 'position 2' })
  await user.runSlashCommand({ name: 'clear-queue', options: [{ name: 'position', type: 4, value: 1 }] })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: twin.channelId, text: 'queued two ok' })
  await waitForFooter({ discord: twin.discord, threadId: twin.channelId, count: before + 2 })
  expect(await channelTextFrom('Slash queue here')).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Slash queue here slow-marker
    --- from: assistant (TestBot)
    -# » **tommy:** Slash queued-one
    [reply to TestBot: -# » **tommy:** Slash queued-one]
    -# Removed from queue
    -# » **tommy:** Slash queued-two
    [reply to TestBot: -# » **tommy:** Slash queued-two]
    -# Queued
    -# Cleared 1 queued message
    [reply to tommy: Slash queue here slow-marker]
    slow-done
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    [reply to TestBot: -# » **tommy:** Slash queued-two]
    -# Queued message sent
    queued two ok
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})

test('deleting a queued coordinator message removes it from the queue', async () => {
  const before = await footers()
  await startSlowTurn('Delete in coordinator')
  const user = twin.discord.channel(twin.channelId).user(TEST_USER_ID)
  const queued = await user.sendMessage({ content: 'Never mind queued-one. queue' })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: twin.channelId, text: 'position 1' })
  await user.deleteMessage({ messageId: queued.id })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: twin.channelId, text: 'Removed from queue' })
  await waitForFooter({ discord: twin.discord, threadId: twin.channelId, count: before + 1 })
  await waitForIdle()
  expect(await channelTextFrom('Delete in coordinator')).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Delete in coordinator slow-marker
    --- from: assistant (TestBot)
    [reply to unknown message]
    -# Removed from queue
    [reply to tommy: Delete in coordinator slow-marker]
    slow-done
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})

test('kimaki send . queue and a TUI prompt queued on the coordinator show their text, then a reply when they run', async () => {
  const before = await footers()
  await startSlowTurn('Other sources')
  await exec(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), 'send', '--session', rootSession(), '--prompt', 'From the CLI queued-one. queue', '--data-dir', dataDir], {
    env: { ...process.env, KIMAKI_LOCK_PORT: String(bot.lock.port) },
  })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: twin.channelId, text: 'position 1' })
  await (await server.client()).session.prompt({ sessionID: rootSession(), text: 'From the TUI queued-two', delivery: 'queue' })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: twin.channelId, text: 'queued two ok' })
  await waitForFooter({ discord: twin.discord, threadId: twin.channelId, count: before + 3 })
  expect(await channelTextFrom('Other sources')).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Other sources slow-marker
    --- from: assistant (TestBot)
    -# » **CLI:** From the CLI queued-one
    -# » **user:** From the TUI queued-two
    [reply to tommy: Other sources slow-marker]
    slow-done
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    [reply to TestBot: -# » **CLI:** From the CLI queued-one]
    -# Queued message sent
    queued one ok
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    [reply to TestBot: -# » **user:** From the TUI queued-two]
    -# Queued message sent
    queued two ok
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})

test('a plain message in a busy coordinator runs first, then the queued one gets its reply', async () => {
  const before = await footers()
  await startSlowTurn('Steer the coordinator')
  const user = twin.discord.channel(twin.channelId).user(TEST_USER_ID)
  await user.sendMessage({ content: 'Afterwards queued-one. queue' })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: twin.channelId, text: 'position 1' })
  await user.sendMessage({ content: 'Right now steer-marker' })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: twin.channelId, text: 'queued one ok' })
  await waitForFooter({ discord: twin.discord, threadId: twin.channelId, count: before + 2 })
  expect(await channelTextFrom('Steer the coordinator')).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Steer the coordinator slow-marker
    Afterwards queued-one. queue
    --- from: assistant (TestBot)
    [reply to tommy: Afterwards queued-one. queue]
    -# Queued
    --- from: user (tommy)
    Right now steer-marker
    --- from: assistant (TestBot)
    [reply to tommy: Right now steer-marker]
    steer ok
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    [reply to tommy: Afterwards queued-one. queue]
    -# Queued message sent
    queued one ok
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})

test('/abort in a coordinator stops the run and clears the queue', async () => {
  await startSlowTurn('Abort the coordinator')
  const user = twin.discord.channel(twin.channelId).user(TEST_USER_ID)
  await user.sendMessage({ content: 'Never runs queued-one. queue' })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: twin.channelId, text: 'position 1' })
  await user.runSlashCommand({ name: 'abort' })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: twin.channelId, text: 'Removed from queue' })
  await waitForIdle()
  expect(await channelTextFrom('Abort the coordinator')).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Abort the coordinator slow-marker
    Never runs queued-one. queue
    --- from: assistant (TestBot)
    [reply to tommy: Never runs queued-one. queue]
    -# Removed from queue
    Request **aborted**, cleared 1 queued message"
  `)
})

test('. queue on an idle coordinator runs at once: the answer replies to the message', async () => {
  const before = await footers()
  await twin.discord.channel(twin.channelId).user(TEST_USER_ID).sendMessage({ content: 'Nothing waits idle-marker. queue' })
  await waitForFooter({ discord: twin.discord, threadId: twin.channelId, count: before + 1 })
  expect(await channelTextFrom('Nothing waits idle-marker')).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Nothing waits idle-marker. queue
    --- from: assistant (TestBot)
    [reply to tommy: Nothing waits idle-marker. queue]
    idle ok
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})
