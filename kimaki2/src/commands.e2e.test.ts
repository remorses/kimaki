// Digital Twin e2e for /abort and /new-session.

import { expect, test } from 'vitest'
import {
  TEXT_CHANNEL_ID,
  TEST_USER_ID,
  bootKimaki2E2e,
  waitForThreadText,
} from './e2e-boot.ts'

test('abort during a busy turn does not crash', async () => {
  const { discord, stop } = await bootKimaki2E2e({
    dirName: 'kimaki2-abort',
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
    name: 'abort',
  })
  await waitForThreadText({
    discord,
    threadId: thread.id,
    includes: 'Aborted.',
  })

  expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (queue-tester)
    Reply with exactly: setup
    --- from: assistant (TestBot)
    Aborted."
  `)

  await stop()
}, 30_000)

test('new-session in a thread starts a fresh OpenCode session', async () => {
  const { discord, stop } = await bootKimaki2E2e({ dirName: 'kimaki2-new-session' })
  await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
    content: 'Reply with exactly: first-session',
  })
  const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
    timeout: 8_000,
    predicate: (item) => item.name === 'Reply with exactly: first-session',
  })
  await waitForThreadText({
    discord,
    threadId: thread.id,
    includes: '*project ⋅ main ⋅',
  })
  await discord.thread(thread.id).user(TEST_USER_ID).runSlashCommand({
    name: 'new-session',
    options: [{ name: 'prompt', type: 3, value: 'Reply with exactly: second-session' }],
  })
  await waitForThreadText({
    discord,
    threadId: thread.id,
    includes: 'Started a new session.\n*using deterministic-provider/deterministic-v2*\nok\n*project ⋅ main ⋅',
  })

  expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (queue-tester)
    Reply with exactly: first-session
    --- from: assistant (TestBot)
    *using deterministic-provider/deterministic-v2*
    ok
    *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2* <@200000000000000777>
    Started a new session.
    *using deterministic-provider/deterministic-v2*
    ok
    *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2* <@200000000000000777>"
  `)

  await stop()
}, 30_000)
