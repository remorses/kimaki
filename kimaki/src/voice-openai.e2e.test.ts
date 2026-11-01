// Voice transcription with an OpenAI key: a real Ogg Opus voice message is
// decoded to WAV (OpenAI accepts only wav and mp3) and sent to a local
// OpenAI-compatible server that answers with the transcription tool call.
// A ChatGPT credential stored by OpenCode is the fallback when the key fails, and gets the raw audio.
// KIMAKI_WHISPER_URL replaces them all with a local Whisper server.

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { DeterministicMatcher } from 'opencode-deterministic-provider'
import { afterAll, beforeAll, expect, onTestFinished, test } from 'vitest'

import type { BotHandle } from './main.ts'
import {
  TEST_USER_ID,
  seedProjectChannel,
  startFakeChatGPT,
  startFakeOpenAI,
  startOpencodeTestServer,
  startTestBot,
  startTwin,
  tempDataDir,
  textParts,
  waitForFooter,
  warmUp,
  writeOpencodeCredential,
  type FakeChatGPT,
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
let chatgpt: FakeChatGPT
let whisper: FakeChatGPT
let dataDir: string
// Created by the ChatGPT test: the tests before it run with no credential.
let opencodeDbFile: string

beforeAll(async () => {
  dataDir = tempDataDir()
  opencodeDbFile = path.join(dataDir, 'opencode.db')
  ;[server, twin, openai, chatgpt, whisper] = await Promise.all([
    startOpencodeTestServer({ matchers }),
    startTwin(),
    startFakeOpenAI({ result: { transcription: 'Hello from the phone voice-openai', route: 'steer' } }),
    startFakeChatGPT({ text: 'Hello from ChatGPT voice-openai' }),
    startFakeChatGPT({ text: 'Hello from Whisper voice-openai' }),
  ])
  await seedProjectChannel({ dataDir, channelId: twin.channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  await warmUp({ server })
  bot = await startTestBot({ dataDir, twin, server, openaiBaseUrl: openai.baseUrl, chatgptBaseUrl: chatgpt.baseUrl, opencodeDbFile })
  // Stored with the CLI, like a user would.
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), 'bot', 'keys', 'set', '--openai', 'sk-test-openai-key', '--data-dir', dataDir])
  expect(stdout).toBe('Saved OpenAI API key\n')
})

afterAll(async () => {
  await bot?.stop()
  await twin?.stop()
  await server?.stop()
  await openai?.stop()
  await chatgpt?.stop()
  await whisper?.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

const ogg = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'voice.ogg'))

async function sendVoice() {
  const before = new Set((await twin.discord.channel(twin.channelId).getThreads()).map((thread) => thread.id))
  await twin.discord
    .channel(twin.channelId)
    .user(TEST_USER_ID)
    .sendVoiceMessage({ url: `data:audio/ogg;base64,${ogg.toString('base64')}` })
  const thread = await twin.discord.channel(twin.channelId).waitForThread({ timeout: 8_000, predicate: (thread) => !before.has(thread.id) })
  await waitForFooter({ discord: twin.discord, threadId: thread.id })
  return thread.id
}

test('an Ogg Opus voice message is converted to WAV and transcribed by OpenAI', async () => {
  const thread = await sendVoice()
  expect(await twin.discord.thread(thread).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    [attachment: voice-message.ogg]
    --- from: assistant (TestBot)
    -# » **tommy:** Hello from the phone voice-openai
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    openai voice ok
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
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

test('the OpenAI key wins over the ChatGPT credential from OpenCode, which takes over when the key fails', async () => {
  const claims = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-test' } })).toString('base64url')
  await writeOpencodeCredential({ file: opencodeDbFile, access: `header.${claims}.signature`, expires: Date.now() + 3_600_000 })
  const openaiRequests = openai.requests.length

  const viaKey = await sendVoice()
  expect(await twin.discord.thread(viaKey).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    [attachment: voice-message.ogg]
    --- from: assistant (TestBot)
    -# » **tommy:** Hello from the phone voice-openai
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    openai voice ok
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  expect({ chatgptRequests: chatgpt.requests.length, openaiRequests: openai.requests.length - openaiRequests }).toMatchInlineSnapshot(`
    {
      "chatgptRequests": 0,
      "openaiRequests": 1,
    }
  `)

  openai.status = 401
  const viaChatGPT = await sendVoice()
  openai.status = 200
  expect(await twin.discord.thread(viaChatGPT).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    [attachment: voice-message.ogg]
    --- from: assistant (TestBot)
    -# » **tommy:** Hello from ChatGPT voice-openai
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    openai voice ok
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  const [request] = chatgpt.requests
  expect({
    authorization: request?.authorization?.replace(claims, '<claims>'),
    accountId: request?.accountId,
    filename: request?.filename,
    type: request?.type,
    sameAudio: request?.audio.equals(ogg),
  }).toMatchInlineSnapshot(`
    {
      "accountId": "acct-test",
      "authorization": "Bearer header.<claims>.signature",
      "filename": "voice.ogg",
      "sameAudio": true,
      "type": "audio/ogg",
    }
  `)
})

test('KIMAKI_WHISPER_URL is the only transcriber: no cloud request, and its failure is shown', async () => {
  process.env['KIMAKI_WHISPER_URL'] = `${whisper.baseUrl}/v1/`
  process.env['KIMAKI_WHISPER_MODEL'] = 'Systran/faster-whisper-large-v3'
  onTestFinished(() => {
    delete process.env['KIMAKI_WHISPER_URL']
    delete process.env['KIMAKI_WHISPER_MODEL']
  })
  const cloudRequests = openai.requests.length + chatgpt.requests.length

  const thread = await sendVoice()
  expect(await twin.discord.thread(thread).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    [attachment: voice-message.ogg]
    --- from: assistant (TestBot)
    -# » **tommy:** Hello from Whisper voice-openai
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    openai voice ok
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  const request = whisper.requests.at(-1)
  expect({ ...request, audio: request?.audio.equals(ogg) }).toMatchInlineSnapshot(`
    {
      "accountId": null,
      "audio": true,
      "authorization": null,
      "filename": "voice.ogg",
      "model": "Systran/faster-whisper-large-v3",
      "path": "/v1/audio/transcriptions",
      "type": "audio/ogg",
    }
  `)

  // 400 is not retried; a 5xx would be retried twice first.
  whisper.status = 400
  await twin.discord.channel(twin.channelId).user(TEST_USER_ID).sendVoiceMessage({ url: `data:audio/ogg;base64,${ogg.toString('base64')}` })
  const reply = await twin.discord.channel(twin.channelId).waitForMessage({ timeout: 8_000, predicate: (message) => message.content.includes('Transcription API returned 400') })
  whisper.status = 200
  expect(reply.content).toMatchInlineSnapshot(`"✗ Transcription API returned 400: {"detail":"unauthorized"}"`)
  expect(openai.requests.length + chatgpt.requests.length).toBe(cloudRequests)
})
