// Phase 5: `!cmd` and `/command` messages. Shell
// commands run through native session.shell: they do not interrupt a busy
// run, their output shows in the thread and reaches the model context.

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
  // Shell output reaches the model as a synthetic user message.
  {
    id: 'shell-check',
    priority: 500,
    when: { latestUserTextIncludes: 'shell-check', rawPromptIncludes: 'kimaki-shell-output' },
    then: { parts: textParts('I saw your shell output') },
  },
  { id: 'review', priority: 500, when: { latestUserTextIncludes: 'Review this change: cmd-marker' }, then: { parts: textParts('reviewed') } },
  { id: 'unknown', priority: 500, when: { latestUserTextIncludes: '/nope unknown-marker' }, then: { parts: textParts('plain text') } },
]

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
let dataDir: string

beforeAll(async () => {
  dataDir = tempDataDir()
  ;[server, twin] = await Promise.all([
    startOpencodeTestServer({ matchers, commands: { review: { template: 'Review this change: $ARGUMENTS' } } }),
    startTwin(),
  ])
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

async function newThread(content: string) {
  const { discord, channelId } = twin
  const before = new Set((await discord.channel(channelId).getThreads()).map((thread) => thread.id))
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content })
  return discord.channel(channelId).waitForThread({ timeout: 8_000, predicate: (thread) => !before.has(thread.id) })
}

test('!cmd while busy runs at once, does not interrupt, and its output reaches the model', async () => {
  const thread = await newThread('Work slow-marker')
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: '*using ' })
  const user = twin.discord.thread(thread.id).user(TEST_USER_ID)
  await user.sendMessage({ content: '!echo kimaki-shell-output' })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: 'slow-done' })
  await waitForFooter({ discord: twin.discord, threadId: thread.id })
  await user.sendMessage({ content: 'What did it print? shell-check' })
  await waitForFooter({ discord: twin.discord, threadId: thread.id, count: 2 })
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Work slow-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    --- from: user (tommy)
    !echo kimaki-shell-output
    --- from: assistant (TestBot)
    -# $ echo kimaki-shell-output
    \`\`\`
    kimaki-shell-output
    \`\`\`

    slow-done
    ok
    -# *project ⋅ main ⋅ Ns ⋅ deterministic-v2*
    --- from: user (tommy)
    What did it print? shell-check
    --- from: assistant (TestBot)
    I saw your shell output
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})

test('!cmd in a channel creates a thread and runs there', async () => {
  const thread = await newThread('!echo from-the-channel && exit 3')
  // "-# exit 3" is the status under the output, not the "$ …" line.
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: '-# exit 3' })
  expect(thread.name).toBe('!echo from-the-channel && exit 3')
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    !echo from-the-channel && exit 3
    --- from: assistant (TestBot)
    -# $ echo from-the-channel && exit 3
    \`\`\`
    from-the-channel
    \`\`\`
    -# exit 3"
  `)
})

test('!cmd in a thread runs there; /abort kills a running command', async () => {
  const thread = await newThread('!echo first')
  // The output block, not the "$ echo first" line.
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: '```\nfirst' })
  const user = twin.discord.thread(thread.id).user(TEST_USER_ID)
  await user.sendMessage({ content: '!sleep 30' })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: '$ sleep 30' })
  await user.runSlashCommand({ name: 'abort' })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: 'killed' })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: 'Request **aborted**' })
  // The /abort reply and the killed shell's output race; the reply is checked above.
  const text = (await twin.discord.thread(thread.id).text()).replace('\nRequest **aborted**', '')
  expect(text).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    !echo first
    --- from: assistant (TestBot)
    -# $ echo first
    \`\`\`
    first
    \`\`\`
    --- from: user (tommy)
    !sleep 30
    --- from: assistant (TestBot)
    -# $ sleep 30
    \`\`\`
    Shell command output is no longer available.
    \`\`\`
    -# killed"
  `)
})

test('/command args runs an OpenCode command; unknown names are plain text', async () => {
  const thread = await newThread('/review cmd-marker')
  await waitForFooter({ discord: twin.discord, threadId: thread.id })
  await twin.discord.thread(thread.id).user(TEST_USER_ID).sendMessage({ content: '/nope unknown-marker' })
  await waitForFooter({ discord: twin.discord, threadId: thread.id, count: 2 })
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    /review cmd-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    reviewed
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    --- from: user (tommy)
    /nope unknown-marker
    --- from: assistant (TestBot)
    plain text
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})
