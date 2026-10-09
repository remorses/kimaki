// Voice calls: the twin plays Discord voice (wss + UDP), a local OpenAI
// Realtime fake plays the model. A user joins the Kimaki voice channel, the bot
// joins and greets, the user speaks, the model runs `kimaki project list` with
// the shell tool and answers. Leaving ends the call; so does end_call.

import fs from 'node:fs'
import path from 'node:path'
import { getVoiceConnection } from '@discordjs/voice'
import prism from 'prism-media'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
import { saveAudioKeys } from './voice.ts'
import { ensureVoiceChannels } from './voice-call.ts'
import {
  TEST_USER_ID,
  seedProjectChannel,
  startFakeRealtime,
  startOpencodeTestServer,
  startTestBot,
  startTwin,
  tempDataDir,
  waitFor,
  type FakeRealtime,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
let realtime: FakeRealtime
let dataDir: string
let voiceChannelId: string

async function opusPackets(): Promise<Buffer[]> {
  const packets: Buffer[] = []
  const demuxer = fs.createReadStream(path.join(import.meta.dirname, 'fixtures', 'voice.ogg')).pipe(new prism.opus.OggDemuxer())
  for await (const packet of demuxer) packets.push(packet as Buffer)
  return packets
}

function botVoiceChannel(): string | null {
  return bot.discord.guilds.cache.get(twin.discord.guildId)?.members.me?.voice.channelId ?? null
}

async function waitForChat(text: string) {
  return waitFor({
    label: `voice chat message containing ${JSON.stringify(text)}`,
    check: async () => (await twin.discord.channel(voiceChannelId).getMessages()).find((message) => message.content.includes(text)),
  })
}

beforeAll(async () => {
  dataDir = tempDataDir()
  ;[server, twin, realtime] = await Promise.all([startOpencodeTestServer(), startTwin({ voice: true }), startFakeRealtime()])
  await seedProjectChannel({ dataDir, channelId: twin.channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  bot = await startTestBot({ dataDir, twin, server, realtimeBaseUrl: realtime.url })
  const saved = await saveAudioKeys({ db: bot.db, token: bot.token, openai: 'sk-test-realtime' })
  if (saved instanceof Error) throw saved
})

afterAll(async () => {
  await bot?.stop()
  await twin?.stop()
  await server?.stop()
  await realtime?.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('the voice channel is created once per machine, in its category', async () => {
  const first = await ensureVoiceChannels(bot, { machine: 'test-machine' })
  if (first instanceof Error) throw first
  const second = await ensureVoiceChannels(bot, { machine: 'test-machine' })
  expect(second).toEqual(first)
  voiceChannelId = first[0]!
  const channel = await twin.discord.prisma.channel.findUniqueOrThrow({ where: { id: voiceChannelId } })
  const category = await twin.discord.prisma.channel.findUniqueOrThrow({ where: { id: channel.parentId! } })
  expect({ name: channel.name, type: channel.type, category: category.name }).toMatchInlineSnapshot(`
    {
      "category": "Kimaki test-machine",
      "name": "Kimaki voice",
      "type": 2,
    }
  `)
})

test('a user joins, speaks, the model runs a kimaki command and answers; leaving ends the call', async () => {
  realtime.replies.push(
    { type: 'say', text: 'Hello tommy.' },
    { type: 'call', name: 'shell', args: { command: 'kimaki project list' } },
    { type: 'say', text: 'You have one project.' },
  )
  realtime.transcripts.push('Which projects do I have?')
  await twin.discord.channel(voiceChannelId).user(TEST_USER_ID).joinVoice()
  await waitFor({ label: 'bot in the voice channel', check: async () => botVoiceChannel() === voiceChannelId })
  // The greeting is real audio the twin decrypts from the bot's UDP packets.
  const greeting = await twin.discord.waitForVoiceStream({ channelId: voiceChannelId, userId: twin.discord.botUserId })
  expect(greeting.opusPackets.length).toBeGreaterThan(10)

  // Discord fires speaking start again after short pauses: the open subscription keeps its one decoder.
  const receiver = getVoiceConnection(twin.discord.guildId)!.receiver
  receiver.speaking.emit('start', TEST_USER_ID)
  const subscription = receiver.subscriptions.get(TEST_USER_ID)!
  receiver.speaking.emit('start', TEST_USER_ID)
  expect(subscription.listenerCount('data')).toBe(1)

  await twin.discord.channel(voiceChannelId).user(TEST_USER_ID).speak({ opusPackets: await opusPackets(), intervalMs: 0 })
  await waitForChat('You have one project.')
  expect(await twin.discord.channel(voiceChannelId).text()).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    -# ⬦ voice call started ⋅ gpt-realtime-2.1
    Hello tommy.
    » **tommy:** Which projects do I have?
    -# ┣ shell _kimaki project list_
    You have one project."
  `)
  expect(realtime.audioBytes()).toBeGreaterThan(0)
  const [listed] = realtime.toolOutputs
  expect(listed?.name).toBe('shell')
  expect(JSON.parse(listed!.output)).toMatchObject({ exitCode: 0 })
  expect(listed!.output).toContain(server.projectDirectory)
  // Instructions name the users and the projects, and pass every user to kimaki send.
  const instructions = realtime.instructions[0]!
  expect(instructions).toContain(`--user '${TEST_USER_ID}'`)
  expect(instructions).toContain(server.projectDirectory)

  await twin.discord.channel(voiceChannelId).user(TEST_USER_ID).leaveVoice()
  await waitForChat('voice call ended')
  await waitFor({ label: 'bot out of voice', check: async () => botVoiceChannel() === null })
  await waitFor({ label: 'realtime socket closed', check: async () => realtime.openSockets() === 0 })
})

test('chat messages reach the model, and end_call leaves while the user stays', async () => {
  const before = (await twin.discord.channel(voiceChannelId).getMessages()).length
  realtime.replies.push({ type: 'say', text: 'Hi again.' }, { type: 'say', text: 'Bye.', then: { name: 'end_call', args: {} } })
  await twin.discord.channel(voiceChannelId).user(TEST_USER_ID).joinVoice()
  await waitForChat('Hi again.')
  await twin.discord.channel(voiceChannelId).user(TEST_USER_ID).sendMessage({ content: 'please hang up' })
  await waitFor({ label: 'bot out of voice', check: async () => botVoiceChannel() === null })
  await waitForChat('voice call ended: the assistant hung up')
  expect(realtime.userTexts.at(-1)).toBe('tommy wrote in the chat: please hang up')
  const messages = (await twin.discord.channel(voiceChannelId).getMessages()).slice(before)
  expect(messages.map((message) => `${message.author.username}: ${message.content}`).join('\n')).toMatchInlineSnapshot(`
    "TestBot: -# ⬦ voice call started ⋅ gpt-realtime-2.1
    TestBot: Hi again.
    tommy: please hang up
    TestBot: Bye.
    TestBot: -# ⬦ voice call ended: the assistant hung up"
  `)
  await twin.discord.channel(voiceChannelId).user(TEST_USER_ID).leaveVoice()
})
