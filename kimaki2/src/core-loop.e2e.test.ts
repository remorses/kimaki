// Digital Twin e2e: project message → thread → assistant ok → footer.
// Follow-up in the same thread. Queue suffix drains after the current turn.

import { expect, test } from 'vitest'
import {
  TEXT_CHANNEL_ID,
  TEST_USER_ID,
  bootKimaki2E2e,
  waitForThreadText,
} from './e2e-boot.ts'

test('project message creates thread, assistant reply, and footer', async () => {
  const { discord, stop } = await bootKimaki2E2e({ dirName: 'kimaki2-core-loop' })
  const prompt = 'Reply with exactly: cold-start-stream'
  await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({ content: prompt })

  const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
    timeout: 8_000,
    predicate: (item) => item.name === prompt,
  })
  await waitForThreadText({
    discord,
    threadId: thread.id,
    includes: '*project ⋅ main ⋅',
  })

  expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (queue-tester)
    Reply with exactly: cold-start-stream
    --- from: assistant (TestBot)
    *using deterministic-provider/deterministic-v2*
    ok
    *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2* <@200000000000000777>"
  `)

  await stop()
}, 30_000)

test('follow-up in the same thread gets a second reply', async () => {
  const { discord, stop } = await bootKimaki2E2e({ dirName: 'kimaki2-follow-up' })
  await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
    content: 'Reply with exactly: alpha',
  })
  const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
    timeout: 8_000,
    predicate: (item) => item.name === 'Reply with exactly: alpha',
  })
  await waitForThreadText({
    discord,
    threadId: thread.id,
    includes: '*project ⋅ main ⋅',
  })

  await discord.thread(thread.id).user(TEST_USER_ID).sendMessage({
    content: 'Reply with exactly: beta',
  })
  await waitForThreadText({
    discord,
    threadId: thread.id,
    includes: 'Reply with exactly: beta\n--- from: assistant (TestBot)\nok\n*project ⋅ main ⋅',
  })

  expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (queue-tester)
    Reply with exactly: alpha
    --- from: assistant (TestBot)
    *using deterministic-provider/deterministic-v2*
    ok
    *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2* <@200000000000000777>
    --- from: user (queue-tester)
    Reply with exactly: beta
    --- from: assistant (TestBot)
    ok
    *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2* <@200000000000000777>"
  `)

  await stop()
}, 30_000)

test('queue suffix waits for the current turn then drains', async () => {
  const { discord, stop } = await bootKimaki2E2e({
    dirName: 'kimaki2-queue-drain',
    turnDelayMs: 400,
  })
  await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
    content: 'Reply with exactly: setup',
  })
  const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
    timeout: 8_000,
    predicate: (item) => item.name === 'Reply with exactly: setup',
  })
  await discord.thread(thread.id).user(TEST_USER_ID).sendMessage({
    content: 'Reply with exactly: queued. queue',
  })

  await waitForThreadText({
    discord,
    threadId: thread.id,
    includes: '» **queue-tester:** Reply with exactly: queued\nok',
  })

  expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (queue-tester)
    Reply with exactly: setup
    Reply with exactly: queued. queue
    --- from: assistant (TestBot)
    *using deterministic-provider/deterministic-v2*
    ok
    » **queue-tester:** Reply with exactly: queued
    ok"
  `)

  await stop()
}, 30_000)

test('slash queue waits for the current turn then drains', async () => {
  const { discord, stop } = await bootKimaki2E2e({
    dirName: 'kimaki2-slash-queue',
    turnDelayMs: 400,
  })
  await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
    content: 'Reply with exactly: setup',
  })
  const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
    timeout: 8_000,
    predicate: (item) => item.name === 'Reply with exactly: setup',
  })
  await discord.thread(thread.id).user(TEST_USER_ID).runSlashCommand({
    name: 'queue',
    options: [{ name: 'message', type: 3, value: 'Reply with exactly: queued' }],
  })
  await waitForThreadText({
    discord,
    threadId: thread.id,
    includes: '» **queue-tester:** Reply with exactly: queued\nok',
  })
  expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (queue-tester)
    Reply with exactly: setup
    --- from: assistant (TestBot)
    Queued: Reply with exactly: queued
    *using deterministic-provider/deterministic-v2*
    ok
    » **queue-tester:** Reply with exactly: queued
    ok"
  `)
  await stop()
}, 30_000)

test('btw suffix forks a side thread', async () => {
  const { discord, stop } = await bootKimaki2E2e({ dirName: 'kimaki2-btw' })
  await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
    content: 'Reply with exactly: parent',
  })
  const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
    timeout: 8_000,
    predicate: (item) => item.name === 'Reply with exactly: parent',
  })
  await waitForThreadText({
    discord,
    threadId: thread.id,
    includes: '*project ⋅ main ⋅',
  })

  await discord.thread(thread.id).user(TEST_USER_ID).sendMessage({
    content: 'Reply with exactly: side. btw',
  })

  const btwThread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
    timeout: 8_000,
    predicate: (item) => Boolean(item.name?.startsWith('btw:')),
  })
  await waitForThreadText({
    discord,
    threadId: btwThread.id,
    includes: '*project ⋅ main ⋅',
  })

  expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (queue-tester)
    Reply with exactly: parent
    --- from: assistant (TestBot)
    *using deterministic-provider/deterministic-v2*
    ok
    *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2* <@200000000000000777>
    --- from: user (queue-tester)
    Reply with exactly: side. btw"
  `)
  expect(await discord.thread(btwThread.id).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    *using deterministic-provider/deterministic-v2*
    ok
    *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2* <@200000000000000777>"
  `)

  await stop()
}, 30_000)
