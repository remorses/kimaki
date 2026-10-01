// Phase 5: attachments and voice messages. Attachments are saved locally and
// sent as file:// URIs; OpenCode reads them into the prompt. Voice messages
// are transcribed by Gemini (a local fake here, same HTTP API) with a tool
// call that also picks the route: steer, queue, btw or new-session.

import fs from 'node:fs'
import type { DeterministicMatcher } from 'opencode-deterministic-provider'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
import * as schema from './schema.ts'
import {
  TEST_USER_ID,
  seedProjectChannel,
  slowTextMatcher,
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

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

function reply(marker: string, text: string): DeterministicMatcher {
  return { id: marker, priority: 500, when: { latestUserTextIncludes: marker }, then: { parts: textParts(text) } }
}

const matchers: DeterministicMatcher[] = [
  slowTextMatcher({ marker: 'slow-marker', text: 'slow-done', delayMs: 2_000 }),
  {
    id: 'image',
    priority: 500,
    when: { latestUserTextIncludes: 'image-marker', rawPromptIncludes: 'image/png' },
    then: { parts: textParts('I see an image') },
  },
  reply('voice-steer', 'voice steer ok'),
  reply('voice-queue', 'voice queue ok'),
  reply('voice-btw', 'voice btw ok'),
  reply('voice-new', 'voice new session ok'),
  reply('voice-plan', 'voice plan ok'),
]

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
let gemini: FakeGemini
let dataDir: string

beforeAll(async () => {
  dataDir = tempDataDir()
  ;[server, twin, gemini] = await Promise.all([startOpencodeTestServer({ matchers }), startTwin(), startFakeGemini()])
  await seedProjectChannel({
    dataDir,
    channelId: twin.channelId,
    guildId: twin.discord.guildId,
    directory: server.projectDirectory,
  })
  await warmUp({ server })
  bot = await startTestBot({ dataDir, twin, server, geminiBaseUrl: gemini.baseUrl })
  // The saved bot (self-hosted or gateway): the transcriber reads its keys.
  const savedBot = await bot.db.db.query.bot_tokens.findFirst()
  await bot.db.db.insert(schema.bot_api_keys).values({ app_id: savedBot!.app_id, gemini_api_key: 'test-gemini-key' })
})

afterAll(async () => {
  await bot?.stop()
  await twin?.stop()
  await server?.stop()
  await gemini?.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

async function newThread(send: () => Promise<unknown>) {
  const { discord, channelId } = twin
  const before = new Set((await discord.channel(channelId).getThreads()).map((thread) => thread.id))
  await send()
  return discord.channel(channelId).waitForThread({ timeout: 8_000, predicate: (thread) => !before.has(thread.id) })
}

test('image and text attachments reach the model as files', async () => {
  const thread = await newThread(() =>
    twin.discord.channel(twin.channelId).user(TEST_USER_ID).sendMessage({
      content: 'What is this image-marker',
      attachments: [
        { id: '1', filename: 'dot.png', size: 70, url: `data:image/png;base64,${PNG_1X1}`, proxy_url: '', content_type: 'image/png' },
        {
          id: '2',
          filename: 'notes.txt',
          size: 20,
          url: `data:text/plain;base64,${Buffer.from('attached-text-body').toString('base64')}`,
          proxy_url: '',
          content_type: 'text/plain',
        },
      ],
    }),
  )
  await waitForFooter({ discord: twin.discord, threadId: thread.id })
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    What is this image-marker
    [attachment: dot.png]
    [attachment: notes.txt]
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    I see an image
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  const sessionId = bot.store.getState().roots[thread.id]!
  const messages = await (await server.client()).message.list({ sessionID: sessionId })
  const user = messages.data.find((message) => message.type === 'user')
  expect(JSON.stringify(user)).toContain('image/png')
  expect(JSON.stringify(user)).toContain('notes.txt')
})

test('voice in a channel starts a session with the transcription and the spoken agent', async () => {
  const thread = await newThread(() =>
    twin.discord
      .channel(twin.channelId)
      .user(TEST_USER_ID)
      .sendVoiceMessage({ url: voiceUrl({ transcription: 'Plan the refactor voice-plan', route: 'steer', agent: 'plan' }) }),
  )
  await waitForFooter({ discord: twin.discord, threadId: thread.id })
  expect(thread.name).toBe('Plan the refactor voice-plan')
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    [attachment: voice-message.ogg]
    --- from: assistant (TestBot)
    » **tommy:** Plan the refactor voice-plan
    -# *using deterministic-provider/deterministic-v2 ⋅ plan*
    voice plan ok
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2 ⋅ plan*"
  `)
})

test('voice in a busy thread: queue waits, btw forks, new-session starts a thread', async () => {
  const thread = await newThread(() =>
    twin.discord.channel(twin.channelId).user(TEST_USER_ID).sendMessage({ content: 'Long work slow-marker' }),
  )
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: '*using ' })
  const user = twin.discord.thread(thread.id).user(TEST_USER_ID)
  await user.sendVoiceMessage({ url: voiceUrl({ transcription: 'Afterwards voice-queue', route: 'queue' }) })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: 'position 1' })

  const btw = await newThread(() => user.sendVoiceMessage({ url: voiceUrl({ transcription: 'Side voice-btw', route: 'btw' }) }))
  await waitForFooter({ discord: twin.discord, threadId: btw.id })
  const fresh = await newThread(() =>
    user.sendVoiceMessage({ url: voiceUrl({ transcription: 'Fresh start voice-new', route: 'new-session' }) }),
  )
  await waitForFooter({ discord: twin.discord, threadId: fresh.id })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: 'voice queue ok' })
  await waitForFooter({ discord: twin.discord, threadId: thread.id })

  const hide = (text: string) => text.replace(/<#\d+>/g, '<#THREAD>')
  expect(hide(await twin.discord.thread(thread.id).text())).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Long work slow-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    --- from: user (tommy)
    [attachment: voice-message.ogg]
    --- from: assistant (TestBot)
    » **tommy:** Afterwards voice-queue
    -# Queued message sent
    --- from: user (tommy)
    [attachment: voice-message.ogg]
    --- from: assistant (TestBot)
    » **tommy:** Side voice-btw
    Session forked! Continue in <#THREAD>
    --- from: user (tommy)
    [attachment: voice-message.ogg]
    --- from: assistant (TestBot)
    » **tommy:** Fresh start voice-new
    Started a new session in <#THREAD>
    slow-done
    » **tommy:** Afterwards voice-queue
    voice queue ok
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  expect([btw.name, fresh.name]).toMatchInlineSnapshot(`
    [
      "btw: Side voice-btw",
      "Fresh start voice-new",
    ]
  `)
  expect(hide(await twin.discord.thread(btw.id).text())).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    Reusing context from <#THREAD> to answer prompt...
    Side voice-btw
    voice btw ok
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  expect(hide(await twin.discord.thread(fresh.id).text())).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    » **tommy:** Fresh start voice-new
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    voice new session ok
    -# *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  // The transcription request offers btw and queue only inside a session thread.
  expect(gemini.requests.map((request) => request.routes)).toMatchInlineSnapshot(`
    [
      [
        "steer",
        "new-session",
      ],
      [
        "steer",
        "queue",
        "btw",
        "new-session",
      ],
      [
        "steer",
        "queue",
        "btw",
        "new-session",
      ],
      [
        "steer",
        "queue",
        "btw",
        "new-session",
      ],
    ]
  `)
})
