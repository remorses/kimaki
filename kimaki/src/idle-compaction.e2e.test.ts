// Idle compaction of thread sessions (plugin/coordinator.ts) with OpenCode's own
// `warming` on: a session over 500k tokens is compacted only when that warming ends,
// a smaller one never.

import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { DeterministicMatcher } from 'opencode-deterministic-provider'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
import {
  TEST_MODEL,
  TEST_USER_ID,
  seedProjectChannel,
  startOpencodeTestServer,
  startTestBot,
  startTwin,
  tempDataDir,
  textParts,
  waitFor,
  waitForFooter,
  warmUp,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
const dataDir = tempDataDir()

function reply({ marker, tokens, delayMs = 0 }: { marker: string; tokens: number; delayMs?: number }): DeterministicMatcher {
  const usage = { inputTokens: tokens, outputTokens: 1, totalTokens: tokens + 1 }
  return {
    id: marker,
    priority: 100,
    when: { latestUserTextIncludes: marker },
    then: {
      parts: [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Done.' }, { type: 'text-end', id: 't' }, { type: 'finish', finishReason: 'stop', usage }],
      partDelaysMs: [0, delayMs, 0, 0],
    },
  }
}

beforeAll(async () => {
  ;[server, twin] = await Promise.all([
    startOpencodeTestServer({
      plugins: [path.resolve('src/test/generate-log-plugin')],
      // 600k is 30% of this window, far below OpenCode's automatic compaction.
      models: { [TEST_MODEL]: { name: TEST_MODEL, limit: { context: 2_000_000, output: 32_000 } } },
      warming: { interval: '500 millis', duration: '2 seconds' },
      matchers: [
        // OpenCode rejects a summary without the template headings.
        { id: 'compaction-summary', priority: 900, when: { latestUserTextIncludes: 'You MUST use this format for your response' }, then: { parts: textParts('## Objective\n- Keep working') } },
        reply({ marker: 'big-marker', tokens: 600_000 }),
        reply({ marker: 'small-marker', tokens: 120_000 }),
        // Answers after the warming ends (2s): the checks before see a running session.
        reply({ marker: 'slow-marker', tokens: 600_000, delayMs: 2_500 }),
      ],
    }),
    startTwin(),
  ])
  await seedProjectChannel({ dataDir, channelId: twin.channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  await warmUp({ server })
  bot = await startTestBot({ dataDir, twin, server, warmupTimers: { intervalMs: 400, maxMs: 60_000 } })
}, 60_000)

afterAll(async () => {
  await bot?.stop()
  await twin?.stop()
  await server?.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

// Keep-alive requests of a session, from the test plugin.
function keepAlives(sessionId: string): number {
  const file = path.join(server.root, 'generate.log')
  if (!fs.existsSync(file)) return 0
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line === sessionId).length
}

async function compactions(sessionId: string): Promise<number> {
  const client = await server.client()
  const messages = await client.message.list({ sessionID: sessionId, order: 'desc', limit: 20 })
  return messages.data.filter((message) => message.type === 'compaction').length
}

async function startThread(content: string) {
  const { discord, channelId } = twin
  const before = new Set((await discord.channel(channelId).getThreads()).map((thread) => thread.id))
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content })
  const thread = await discord.channel(channelId).waitForThread({ timeout: 8_000, predicate: (found) => !before.has(found.id) })
  await waitForFooter({ discord, threadId: thread.id })
  return { threadId: thread.id, sessionId: bot.store.getState().roots[thread.id]! }
}

test('a big idle session is compacted when OpenCode warming ends, a small one never', async () => {
  const small = await startThread('Hello small-marker')
  const big = await startThread('Hello big-marker')
  await waitFor({ label: 'compaction of the big session', check: async () => (await compactions(big.sessionId)) === 1 || null })
  // OpenCode warmed it every 0.5s for 2s: Kimaki waited instead of compacting after 0.4s.
  const warmedBefore = keepAlives(big.sessionId)

  expect(await twin.discord.thread(big.threadId).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Hello big-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    Done.
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  expect(warmedBefore).toBeGreaterThanOrEqual(2)
  // The small session's warming ended first: its check may still run, so poll briefly.
  for (let i = 0; i < 10; i++) {
    expect(await compactions(small.sessionId)).toBe(0)
    await sleep(20)
  }
})

test('a big session whose last answer outlasts the checks is compacted once it ends', async () => {
  const slow = await startThread('Hello slow-marker')
  await waitFor({ label: 'compaction after the slow answer', check: async () => (await compactions(slow.sessionId)) === 1 || null })

  expect(await twin.discord.thread(slow.threadId).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Hello slow-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    Done.
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
})
