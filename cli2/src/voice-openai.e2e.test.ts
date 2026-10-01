// Voice transcription with an OpenAI key: a real Ogg Opus voice message is
// decoded to WAV (OpenAI accepts only wav and mp3) and sent to a local
// OpenAI-compatible server that answers with the transcription tool call.

import fs from 'node:fs'
import path from 'node:path'
import type { DeterministicMatcher } from 'opencode-deterministic-provider'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
import * as schema from './schema.ts'
import {
  TEST_USER_ID,
  seedProjectChannel,
  startFakeOpenAI,
  startOpencodeTestServer,
  startTestBot,
  startTwin,
  tempDataDir,
  textParts,
  waitForFooter,
  warmUp,
  type FakeOpenAI,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

const matchers: DeterministicMatcher[] = [
  { id: 'openai', priority: 500, when: { latestUserTextIncludes: 'voice-openai' }, then: { parts: textParts('openai voice ok') } },
]

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
let openai: FakeOpenAI
let dataDir: string

beforeAll(async () => {
  dataDir = tempDataDir()
  ;[server, twin, openai] = await Promise.all([
    startOpencodeTestServer({ matchers }),
    startTwin(),
    startFakeOpenAI({ result: { transcription: 'Hello from the phone voice-openai', route: 'steer' } }),
  ])
  await seedProjectChannel({ dataDir, channelId: twin.channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  await warmUp({ server })
  bot = await startTestBot({ dataDir, twin, server, openaiBaseUrl: openai.baseUrl })
  // The saved bot (self-hosted or gateway): the transcriber reads its keys.
  const savedBot = await bot.db.db.query.bot_tokens.findFirst()
  await bot.db.db.insert(schema.bot_api_keys).values({ app_id: savedBot!.app_id, openai_api_key: 'test-openai-key' })
})

afterAll(async () => {
  await bot?.stop()
  await twin?.stop()
  await server?.stop()
  await openai?.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('an Ogg Opus voice message is converted to WAV and transcribed by OpenAI', async () => {
  const ogg = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'voice.ogg'))
  await twin.discord
    .channel(twin.channelId)
    .user(TEST_USER_ID)
    .sendVoiceMessage({ url: `data:audio/ogg;base64,${ogg.toString('base64')}` })
  const thread = await twin.discord.channel(twin.channelId).waitForThread({ timeout: 8_000 })
  await waitForFooter({ discord: twin.discord, threadId: thread.id })
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    [attachment: voice-message.ogg]
    --- from: assistant (TestBot)
    » **tommy:** Hello from the phone voice-openai
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    openai voice ok
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  const [request] = openai.requests
  expect({
    model: request?.model,
    format: request?.format,
    header: request?.audio.subarray(0, 4).toString('ascii'),
    routes: request?.routes,
  }).toMatchInlineSnapshot(`
    {
      "format": "wav",
      "header": "RIFF",
      "model": "gpt-audio-1.5",
      "routes": [
        "steer",
        "new-session",
      ],
    }
  `)
  // 0.3 s of 48 kHz mono 16-bit PCM plus the 44-byte header.
  expect(request!.audio.length).toBeGreaterThan(20_000)
})
