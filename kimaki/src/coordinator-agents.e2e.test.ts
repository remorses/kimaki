// Agent picks in a coordinator channel: `/<agent>-agent prompt:` and a spoken
// agent start a new thread with that agent, and `kimaki send --agent --model`
// to the coordinator (workers pass --agent <current_agent>) keeps its agent and model.

import fs from 'node:fs'
import type { DeterministicMatcher } from 'opencode-deterministic-provider'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
import { send } from './prompt.ts'
import { TRANSCRIPTION_KEY_MODAL } from './voice.ts'
import {
  TEST_USER_ID,
  isFooter,
  seedProjectChannel,
  startFakeGemini,
  startOpencodeTestServer,
  startTestBot,
  startTwin,
  tempDataDir,
  textParts,
  voiceUrl,
  waitForBotMessageContaining,
  waitForFooter,
  warmUp,
  type FakeGemini,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

function reply(marker: string, text: string): DeterministicMatcher {
  return { id: marker, priority: 50, when: { latestUserTextIncludes: marker }, then: { parts: textParts(text) } }
}

const matchers: DeterministicMatcher[] = [
  reply('hello-marker', 'hello'),
  reply('slash-agent-marker', 'slash agent ok'),
  reply('voice-agent-marker', 'voice agent ok'),
  reply('worker-note-marker', 'IDLE'),
]

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
let gemini: FakeGemini
const dataDir = tempDataDir()
// Agent and model of the coordinator session after its first turn.
let initial: Awaited<ReturnType<typeof coordinator>>

beforeAll(async () => {
  ;[server, twin, gemini] = await Promise.all([
    startOpencodeTestServer({
      matchers,
      models: { 'deterministic-thinker': { name: 'Thinker' } },
      agents: { thinker: { mode: 'primary', model: 'deterministic-provider/deterministic-thinker' } },
    }),
    startTwin(),
    startFakeGemini(),
  ])
  await seedProjectChannel({ dataDir, channelId: twin.channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  await warmUp({ server })
  bot = await startTestBot({ dataDir, twin, server, coordinator: true, geminiBaseUrl: gemini.baseUrl })
  const user = twin.discord.channel(twin.channelId).user(TEST_USER_ID)
  const { id } = await user.runSlashCommand({ name: 'transcription-key' })
  await twin.discord.channel(twin.channelId).waitForInteractionAck({ interactionId: id })
  await user.submitModal({ customId: TRANSCRIPTION_KEY_MODAL, fields: [{ customId: 'apikey', value: 'AIza-test-gemini-key' }] })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: twin.channelId, text: 'Gemini API key saved' })
  // The coordinator session exists before any test.
  await user.sendMessage({ content: 'Start hello-marker' })
  await waitForFooter({ discord: twin.discord, threadId: twin.channelId })
  initial = await coordinator()
}, 60_000)

afterAll(async () => {
  await bot?.stop()
  await twin?.stop()
  await server?.stop()
  await gemini?.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

async function coordinator() {
  const info = await (await server.client()).session.get({ sessionID: bot.store.getState().roots[twin.channelId]! })
  return { agent: info.agent, model: info.model?.id }
}

async function newThread(start: () => Promise<unknown>) {
  const { discord, channelId } = twin
  const before = new Set((await discord.channel(channelId).getThreads()).map((thread) => thread.id))
  await start()
  const thread = await discord.channel(channelId).waitForThread({ timeout: 8_000, predicate: (candidate) => !before.has(candidate.id) })
  await waitForFooter({ discord, threadId: thread.id })
  return thread
}

test('/<agent>-agent with a prompt starts a thread with that agent; the coordinator keeps its agent and model', async () => {
  const thread = await newThread(() =>
    twin.discord.channel(twin.channelId).user(TEST_USER_ID).runSlashCommand({ name: 'thinker-agent', options: [{ name: 'prompt', type: 3, value: 'Think slash-agent-marker' }] }),
  )
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    -# » **tommy:** Think slash-agent-marker
    -# *using deterministic-provider/deterministic-thinker ⋅ thinker*
    slash agent ok
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-thinker ⋅ thinker*"
  `)
  expect(await coordinator()).toEqual(initial)
})

test('a spoken agent starts a thread with that agent; the coordinator keeps its agent and model', async () => {
  const thread = await newThread(() =>
    twin.discord.channel(twin.channelId).user(TEST_USER_ID).sendVoiceMessage({ url: voiceUrl({ transcription: 'Think voice-agent-marker', route: 'steer', agent: 'thinker' }) }),
  )
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    -# » **tommy:** Think voice-agent-marker
    -# *using deterministic-provider/deterministic-thinker ⋅ thinker*
    voice agent ok
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-thinker ⋅ thinker*"
  `)
  expect(await coordinator()).toEqual(initial)
})

test('kimaki send --agent --model to the coordinator keeps its agent and model', async () => {
  const { discord, channelId } = twin
  const footers = (await discord.channel(channelId).getMessages()).filter(isFooter).length
  const root = bot.store.getState().roots[channelId]!
  const sent = await send(bot, { sessionId: root, prompt: 'Done worker-note-marker', agent: 'thinker', model: 'deterministic-provider/deterministic-thinker' })
  if (sent instanceof Error) throw sent
  await waitForBotMessageContaining({ discord, threadId: channelId, text: 'Done worker-note-marker' })
  // IDLE posts nothing; the next coordinator turn still runs on the default agent and model.
  await (await server.client()).session.wait({ sessionID: root })
  await discord.channel(channelId).user(TEST_USER_ID).sendMessage({ content: 'Again hello-marker' })
  await waitForFooter({ discord, threadId: channelId, count: footers + 1 })
  const text = await discord.channel(channelId).text()
  expect(text.slice(text.lastIndexOf('Done worker-note-marker'))).toMatchInlineSnapshot(`
    "Done worker-note-marker
    --- from: user (tommy)
    Again hello-marker
    --- from: assistant (TestBot)
    hello
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  expect(await coordinator()).toEqual(initial)
})
