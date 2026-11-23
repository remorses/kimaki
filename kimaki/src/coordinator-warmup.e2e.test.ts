// The coordinator warmup (plugin/coordinator.ts) with short windows: keep-alives while
// a worker thread runs, compaction when the channel is idle again, and the cap
// that stops the warmup while a worker is stuck.

import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
import { send } from './prompt.ts'
import {
  TEST_MODEL,
  TEST_USER_ID,
  isFooter,
  seedProjectChannel,
  startOpencodeTestServer,
  startTestBot,
  startTwin,
  tempDataDir,
  textParts,
  toolParts,
  waitFor,
  waitForBotMessageContaining,
  waitForFooter,
  warmUp,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
const dataDir = tempDataDir()
// Big enough to be worth compacting (plugin/coordinator.ts COORDINATOR_COMPACT_TOKENS).
const bigUsage = { inputTokens: 120_000, outputTokens: 1, totalTokens: 120_001 }
const WARM_INTERVAL_MS = 400
const WARM_MAX_MS = 1_500

function bigText(text: string) {
  return [
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
    { type: 'finish', finishReason: 'stop', usage: bigUsage },
  ] as const
}

// The coordinator starts a worker thread, then answers IDLE.
function delegate({ marker, worker, channelId }: { marker: string; worker: string; channelId: string }) {
  const command = `kimaki send --channel ${channelId} --name 'Worker ${worker}' --prompt '${worker} run' --parent-session "$OPENCODE_SESSION_ID"`
  return [
    {
      id: `${marker}-send`,
      priority: 100,
      when: { latestUserTextIncludes: marker },
      then: { parts: toolParts({ toolCallId: `${marker}-call`, toolName: 'shell', input: { command, description: 'Start the worker', hasSideEffect: true } }) },
    },
    { id: `${marker}-idle`, priority: 101, when: { latestUserTextIncludes: marker, rawPromptIncludes: `${marker}-call` }, then: { parts: [...bigText('IDLE')] } },
  ]
}

beforeAll(async () => {
  twin = await startTwin()
  server = await startOpencodeTestServer({
    plugins: [path.resolve('src/test/generate-log-plugin')],
    models: { [TEST_MODEL]: { name: TEST_MODEL, limit: { context: 1_000_000, output: 32_000 } } },
    matchers: [
      // OpenCode rejects a summary without the template headings.
      { id: 'compaction-summary', priority: 900, when: { latestUserTextIncludes: 'You MUST use this format for your response' }, then: { parts: textParts('## Objective\n- Keep coordinating') } },
      ...delegate({ marker: 'keepwarm-marker', worker: 'quickjob-marker', channelId: twin.channelId }),
      { id: 'capped', priority: 100, when: { latestUserTextIncludes: 'capped-marker' }, then: { parts: [...bigText('IDLE')] } },
      { id: 'quickjob', priority: 100, when: { latestUserTextIncludes: 'quickjob-marker' }, then: { parts: textParts('Quick job done.'), partDelaysMs: [0, 1_200, 0, 0] } },
      { id: 'stuckjob', priority: 100, when: { latestUserTextIncludes: 'stuckjob-marker' }, then: { parts: textParts('Stuck job done.'), partDelaysMs: [0, 5_000, 0, 0] } },
      { id: 'woken', priority: 300, when: { latestUserTextRegex: '<session-finished[\\s\\S]*Quick job done\\.' }, then: { parts: [...bigText('The worker finished.')] } },
    ],
  })
  await seedProjectChannel({ dataDir, channelId: twin.channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  await warmUp({ server })
  bot = await startTestBot({ dataDir, twin, server, coordinator: true, warmupTimers: { intervalMs: WARM_INTERVAL_MS, maxMs: WARM_MAX_MS } })
  // Bot startup writes the plugin shim; OpenCode activates it asynchronously.
  const plugin = await bot.features.waitForPlugin(server.projectDirectory)
  if (plugin instanceof Error) throw plugin
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
  const messages = await client.message.list({ sessionID: sessionId, order: 'desc', limit: 50 })
  return messages.data.filter((message) => message.type === 'compaction').length
}

test('the coordinator stays warm while its worker runs, then compacts', async () => {
  const { discord, channelId } = twin
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'Start keepwarm-marker' })
  const root = await waitFor({ label: 'coordinator session', check: async () => bot.store.getState().roots[channelId] })
  const worker = await discord.channel(channelId).waitForThread({ predicate: (thread) => thread.name === 'Worker quickjob-marker' })
  await waitForFooter({ discord, threadId: worker.id })
  await waitForBotMessageContaining({ discord, threadId: channelId, text: 'The worker finished.' })
  await waitForFooter({ discord, threadId: channelId })
  await waitFor({ label: 'compaction after the wake', check: async () => (await compactions(root)) === 1 || null })

  expect(await discord.channel(channelId).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Start keepwarm-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    -# Coordinator mode is on: this channel is one session that starts and manages project threads for you. Use /new-session for a thread without it. Turn it off with /toggle-coordinator or start kimaki with \`--coordinator false\`.
    -# ┣ shell _Start the worker_
    The worker finished.
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  // The worker runs 1.2s, a keep-alive is due every 0.4s.
  expect(keepAlives(root)).toBeGreaterThan(0)
  const client = await server.client()
  const messages = await client.message.list({ sessionID: root, order: 'asc', limit: 30 })
  // No compaction before the wake: the channel was busy.
  expect(messages.data.map((message) => message.type)).toMatchInlineSnapshot(`
    [
      "synthetic",
      "synthetic",
      "user",
      "assistant",
      "assistant",
      "idle",
      "synthetic",
      "assistant",
      "idle",
      "compaction",
      "idle",
    ]
  `)
})

test('a stuck worker stops the warmup at the cap', async () => {
  const { discord, channelId } = twin
  const root = bot.store.getState().roots[channelId]!
  // Start the worker outside the coordinator turn so neither a shell follow-up
  // request nor a worker-finished wake resets the coordinator's cap.
  const worker = await send(bot, { channelId, prompt: 'stuckjob-marker run' })
  if (worker instanceof Error) throw worker
  await waitForBotMessageContaining({ discord, threadId: worker.threadId, text: '*using ' })
  const before = keepAlives(root)
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'Start capped-marker' })
  // The cap ends the warmup while the worker still runs: compaction, no footer in the worker yet.
  await waitFor({ label: 'compaction at the cap', check: async () => (await compactions(root)) === 2 })
  const workerMessagesAtCap = await discord.thread(worker.threadId).getMessages()
  const atCap = keepAlives(root)
  await waitForFooter({ discord, threadId: worker.threadId })

  expect(workerMessagesAtCap.some(isFooter)).toBe(false)
  expect(atCap - before).toBeGreaterThan(0)
  expect(atCap - before).toBeLessThanOrEqual(Math.floor(WARM_MAX_MS / WARM_INTERVAL_MS))
  expect(keepAlives(root)).toBe(atCap)
})
