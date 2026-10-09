// Voice transcription with an OpenAI key: a real Ogg Opus voice message is
// decoded to WAV (OpenAI accepts only wav and mp3) and sent to a local
// OpenAI-compatible server that answers with the transcription tool call.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { DeterministicMatcher } from 'opencode-deterministic-provider'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
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
  // Stored with the CLI, like a user would.
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), 'bot', 'keys', 'set', '--openai', 'sk-test-openai-key', '--data-dir', dataDir])
  expect(stdout).toBe('Saved OpenAI API key\n')
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

// https://github.com/remorses/kimaki/issues/235: Discord labels some MP3 uploads audio/mpeg3.
test('an MP3 upload labeled audio/mpeg3 goes to OpenAI as mp3', async () => {
  const mp3 = Buffer.from('ID3-fake-mp3-bytes')
  const before = new Set((await twin.discord.channel(twin.channelId).getThreads()).map((thread) => thread.id))
  await twin.discord
    .channel(twin.channelId)
    .user(TEST_USER_ID)
    .sendVoiceMessage({ url: `data:audio/mpeg3;base64,${mp3.toString('base64')}`, contentType: 'audio/mpeg3', filename: 'memo.mp3' })
  const thread = await twin.discord.channel(twin.channelId).waitForThread({ timeout: 8_000, predicate: (thread) => !before.has(thread.id) })
  await waitForFooter({ discord: twin.discord, threadId: thread.id })
  const request = openai.requests.at(-1)
  expect({ format: request?.format, audio: request?.audio.toString('utf8') }).toMatchInlineSnapshot(`
    {
      "audio": "ID3-fake-mp3-bytes",
      "format": "mp3",
    }
  `)
})
