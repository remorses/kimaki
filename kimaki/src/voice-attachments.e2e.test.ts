// Phase 5: attachments and voice messages. Attachments are saved locally and
// sent as file:// URIs; OpenCode reads them into the prompt. Voice messages
// are transcribed by Gemini (a local fake here, same HTTP API) with a tool
// call that also picks the route: steer, queue, btw or new-session.

import fs from 'node:fs'
import type { DeterministicMatcher } from 'opencode-deterministic-provider'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
import { TRANSCRIPTION_KEY_MODAL } from './voice.ts'
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
    // The plugin adds the numbered <attachments>, the concise reminder and <discord-user> to the model request only.
    when: {
      latestUserTextRegex: 'image-marker[\\s\\S]*<attachments>[\\s\\S]*1\\. dot\\.png \\(inline\\): [^\\n]*\\n2\\. notes\\.txt: [^\\n]*\\n3\\. archive\\.zip: [^\\n]*\\n</attachments>\\n<system-reminder>[^\\n]*</system-reminder>\\n<discord-user ',
      rawPromptIncludes: 'image/png',
    },
    then: { parts: textParts('I see an image') },
  },
  reply('voice-steer', 'voice steer ok'),
  reply('voice-queue', 'voice queue ok'),
  reply('voice-btw', 'voice btw ok'),
  reply('voice-new', 'voice new session ok'),
  reply('voice-plan', 'voice plan ok'),
  reply('order-start', 'order start ok'),
  // Above order-start: the thread name in <discord-user> repeats that marker.
  { ...reply('order-voice', 'order voice ok'), priority: 600 },
  { ...reply('order-text', 'order text ok'), priority: 600 },
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
  // The owner stores the key like a user: /transcription-key opens a modal.
  const user = twin.discord.channel(twin.channelId).user(TEST_USER_ID)
  const { id } = await user.runSlashCommand({ name: 'transcription-key' })
  await twin.discord.channel(twin.channelId).waitForInteractionAck({ interactionId: id })
  await user.submitModal({ customId: TRANSCRIPTION_KEY_MODAL, fields: [{ customId: 'apikey', value: 'AIza-test-gemini-key' }] })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: twin.channelId, text: 'Gemini API key saved' })
  const savedBot = await bot.db.query.bot_tokens.findFirst({ with: { api_keys: true } })
  expect(savedBot?.api_keys?.gemini_api_key).toBe('AIza-test-gemini-key')
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
        {
          id: '3',
          filename: 'archive.zip',
          size: 6,
          url: `data:application/zip;base64,${Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]).toString('base64')}`,
          proxy_url: '',
          content_type: 'application/zip',
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
    [attachment: archive.zip]
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    I see an image
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  const sessionId = bot.store.getState().roots[thread.id]!
  const messages = await (await server.client()).message.list({ sessionID: sessionId })
  const user = messages.data.find((message) => message.type === 'user')
  expect(JSON.stringify(user)).toContain('image/png')
  expect(JSON.stringify(user)).toContain('notes.txt')
  // OpenCode drops binary files: the model gets their local paths from metadata, the stored text stays clean.
  expect(user?.type === 'user' && user.text).toBe('What is this image-marker')
  const discord = user?.type === 'user' ? user.metadata?.['discord'] : null
  expect(JSON.stringify(discord).replaceAll(dataDir, '<data>').replace(/\/\d+\//g, '/<message>/').replace(/\d{6,}/g, 'ID')).toMatchInlineSnapshot(`"{"userId":"ID","username":"tommy","messageId":"ID","threadId":"ID","threadName":"What is this image-marker","attachments":[{"name":"dot.png","path":"<data>/attachments/<message>/0-dot.png","inline":true},{"name":"notes.txt","path":"<data>/attachments/<message>/1-notes.txt","inline":false},{"name":"archive.zip","path":"<data>/attachments/<message>/2-archive.zip","inline":false}]}"`)
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
    -# » **tommy:** Plan the refactor voice-plan
    -# *using deterministic-provider/deterministic-v2 ⋅ plan*
    voice plan ok
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2 ⋅ plan*"
  `)
})

test('a text sent while a voice message is transcribed waits for it', async () => {
  const thread = await newThread(() => twin.discord.channel(twin.channelId).user(TEST_USER_ID).sendMessage({ content: 'Start order-start' }))
  await waitForFooter({ discord: twin.discord, threadId: thread.id })
  const user = twin.discord.thread(thread.id).user(TEST_USER_ID)
  await user.sendVoiceMessage({ url: voiceUrl({ transcription: 'Spoken first order-voice', route: 'queue', delayMs: 500 }) })
  await user.sendMessage({ content: 'Typed second order-text' })
  await waitForBotMessageContaining({ discord: twin.discord, threadId: thread.id, text: 'order text ok' })
  await waitForFooter({ discord: twin.discord, threadId: thread.id, count: 2 })
  expect(await twin.discord.thread(thread.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Start order-start
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    order start ok
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    --- from: user (tommy)
    [attachment: voice-message.ogg]
    Typed second order-text
    --- from: assistant (TestBot)
    -# » **tommy:** Spoken first order-voice
    order text ok
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  const sessionId = bot.store.getState().roots[thread.id]!
  const messages = await (await server.client()).message.list({ sessionID: sessionId, order: 'asc' })
  expect(messages.data.flatMap((message) => (message.type === 'user' ? [message.text] : []))).toMatchInlineSnapshot(`
    [
      "Start order-start",
      "Spoken first order-voice",
      "Typed second order-text",
    ]
  `)
})

// https://github.com/remorses/kimaki/issues/246
test('a long voice transcript is echoed in full over several messages, in a channel and in a thread', async () => {
  const words = Array.from({ length: 450 }, (_, index) => `w${index}`)
  const transcription = `Long voice-steer ${words.join(' ')}`
  const voice = { url: voiceUrl({ transcription, route: 'steer' }) }
  const thread = await newThread(() => twin.discord.channel(twin.channelId).user(TEST_USER_ID).sendVoiceMessage(voice))
  await waitForFooter({ discord: twin.discord, threadId: thread.id })
  await twin.discord.thread(thread.id).user(TEST_USER_ID).sendVoiceMessage(voice)
  await waitForFooter({ discord: twin.discord, threadId: thread.id, count: 2 })
  const text = await twin.discord.thread(thread.id).text()
  expect(text.replace(/w\d+( w\d+)*/g, (run) => `<${run.split(' ')[0]}..${run.split(' ').at(-1)}>`)).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    [attachment: voice-message.ogg]
    --- from: assistant (TestBot)
    -# » **tommy:** Long voice-steer <w0..w414>
    -# <w415..w449>
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    voice steer ok
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    --- from: user (tommy)
    [attachment: voice-message.ogg]
    --- from: assistant (TestBot)
    -# » **tommy:** Long voice-steer <w0..w414>
    -# <w415..w449>
    voice steer ok
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  const echoed = (await twin.discord.thread(thread.id).getMessages()).map((message) => message.content).filter((content) => /\bw\d/.test(content))
  expect(echoed.join(' ').replaceAll('-# ', '')).toBe(`» **tommy:** ${transcription} » **tommy:** ${transcription}`)
})

// https://github.com/remorses/kimaki/issues/235
test('uploaded audio files with odd Discord media types are transcribed', async () => {
  const user = twin.discord.channel(twin.channelId).user(TEST_USER_ID)
  const before = gemini.requests.length
  const m4a = await newThread(() =>
    user.sendVoiceMessage({ url: voiceUrl({ transcription: 'From m4a voice-steer', route: 'steer' }), contentType: 'video/mp4', filename: 'memo.m4a' }),
  )
  await waitForFooter({ discord: twin.discord, threadId: m4a.id })
  const mp3 = await newThread(() =>
    user.sendVoiceMessage({ url: voiceUrl({ transcription: 'From mp3 voice-steer', route: 'steer' }), contentType: 'audio/mpeg3', filename: 'memo.mp3' }),
  )
  await waitForFooter({ discord: twin.discord, threadId: mp3.id })
  expect(await twin.discord.thread(m4a.id).text()).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    [attachment: memo.m4a]
    --- from: assistant (TestBot)
    -# » **tommy:** From m4a voice-steer
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    voice steer ok
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  expect([m4a.name, mp3.name]).toMatchInlineSnapshot(`
    [
      "From m4a voice-steer",
      "From mp3 voice-steer",
    ]
  `)
  expect(gemini.requests.slice(before).map((request) => request.mimeType)).toMatchInlineSnapshot(`
    [
      "audio/mp4",
      "audio/mpeg",
    ]
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
  await waitForFooter({ discord: twin.discord, threadId: thread.id, count: 2 })

  const hide = (text: string) => text.replace(/<#\d+>/g, '<#THREAD>')
  expect(hide(await twin.discord.thread(thread.id).text({ showReplies: true }))).toMatchInlineSnapshot(`
    "--- from: user (tommy)
    Long work slow-marker
    --- from: assistant (TestBot)
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    --- from: user (tommy)
    [attachment: voice-message.ogg]
    --- from: assistant (TestBot)
    [reply to tommy: ]
    -# » **tommy:** Afterwards voice-queue
    [reply to tommy: ]
    -# Queued
    --- from: user (tommy)
    [attachment: voice-message.ogg]
    --- from: assistant (TestBot)
    [reply to tommy: ]
    -# » **tommy:** Side voice-btw
    [reply to tommy: ]
    Session forked! Continue in <#THREAD>
    --- from: user (tommy)
    [attachment: voice-message.ogg]
    --- from: assistant (TestBot)
    [reply to tommy: ]
    -# » **tommy:** Fresh start voice-new
    [reply to tommy: ]
    Started a new session in <#THREAD>
    slow-done
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
    [reply to tommy: ]
    -# Queued message sent
    voice queue ok
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
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
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
  `)
  expect(hide(await twin.discord.thread(fresh.id).text())).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    -# » **tommy:** Fresh start voice-new
    -# *using deterministic-provider/deterministic-v2 ⋅ build*
    voice new session ok
    -# *main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
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
        "new-session",
      ],
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
