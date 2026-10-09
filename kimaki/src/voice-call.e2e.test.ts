// Voice calls: the twin plays Discord voice (wss + UDP), a local OpenAI
// Realtime fake plays the model. A user joins the Kimaki voice channel, the bot
// joins and greets, the user speaks, the model runs `kimaki project list` with
// the shell tool and answers. Leaving ends the call; so does end_call.

import fs from 'node:fs'
import path from 'node:path'
import { getVoiceConnection } from '@discordjs/voice'
import type { DeterministicMatcher } from 'opencode-deterministic-provider'
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
  textParts,
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
  const matchers: DeterministicMatcher[] = ['call-thread-marker', 'other-thread-marker'].map((marker) => ({
    id: marker,
    priority: 50,
    when: { latestUserTextIncludes: marker },
    then: { parts: textParts(`${marker} done`) },
  }))
  ;[server, twin, realtime] = await Promise.all([startOpencodeTestServer({ matchers }), startTwin({ voice: true }), startFakeRealtime()])
  await seedProjectChannel({ dataDir, channelId: twin.channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  // The user's global AGENTS.md and a global skill go into the call instructions.
  fs.writeFileSync(path.join(server.configDir, 'AGENTS.md'), 'Always answer like a pirate.\n')
  fs.mkdirSync(path.join(server.configDir, 'skills', 'deploy-docs'), { recursive: true })
  fs.writeFileSync(path.join(server.configDir, 'skills', 'deploy-docs', 'SKILL.md'), '---\nname: deploy-docs\ndescription: Deploy the docs <site> & check it.\n---\n\nRun pnpm deploy.\n')
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

test('the voice channel is created once per machine, with no category', async () => {
  const first = await ensureVoiceChannels(bot, { machine: 'test-machine' })
  if (first instanceof Error) throw first
  const second = await ensureVoiceChannels(bot, { machine: 'test-machine' })
  expect(second).toEqual(first)
  voiceChannelId = first[0]!
  const channel = await twin.discord.prisma.channel.findUniqueOrThrow({ where: { id: voiceChannelId } })
  expect({ name: channel.name, type: channel.type, parentId: channel.parentId }).toMatchInlineSnapshot(`
    {
      "name": "Kimaki voice test-machine",
      "parentId": null,
      "type": 2,
    }
  `)
})

test('a user joins, speaks, the model runs a kimaki command and answers; leaving ends the call', async () => {
  realtime.replies.push(
    { type: 'say', text: 'Hello tommy.' },
    // seq makes the output longer than the 4000 character limit.
    { type: 'call', name: 'shell', args: { command: 'seq 1 2000; kimaki project list' } },
    { type: 'call', name: 'shell', args: { command: `kimaki send --channel ${twin.channelId} --prompt 'Voice call note' --notify-only` } },
    // An empty post fails validation: the chat shows a failed tool line.
    { type: 'call', name: 'post_message', args: { text: ' ' } },
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
  // Thread IDs are snowflakes: replace them for a stable snapshot.
  expect((await twin.discord.channel(voiceChannelId).text()).replace(/<#\d+>/g, '<#thread>')).toMatchInlineSnapshot(`
    "--- from: assistant (TestBot)
    -# ⬦ voice call started ⋅ gpt-realtime-2.1
    Hello tommy.
    » **tommy:** Which projects do I have?
    -# ┣ shell _seq 1 2000; kimaki project list_
    -# ┣ shell _kimaki send --channel 200000000000000100 --prompt 'Voice call note' --notify-on…_
    -# ⬦ session started in <#thread>
    -# ┣ post\\_message (text:)
    -#  ⨯  post\\_message _text must not be empty_
    You have one project."
  `)
  expect(realtime.audioBytes()).toBeGreaterThan(0)
  const [listed] = realtime.toolOutputs
  expect(listed?.name).toBe('shell')
  expect(JSON.parse(listed!.output)).toMatchObject({ exitCode: 0 })
  expect(listed!.output).toContain(server.projectDirectory)
  // The truncated output names a file with the full output.
  const { output } = JSON.parse(listed!.output) as { output: string }
  const file = /full output in (\S+?),/.exec(output)?.[1]
  expect(output.split('\n')[0]).toMatch(/^\[output truncated: first \d+ characters omitted; full output in \S+, use grep or sed on it\]$/)
  expect(fs.readFileSync(file!, 'utf8').startsWith('1\n2\n3\n')).toBe(true)
  fs.rmSync(file!)
  // Instructions name the users and the projects, and pass every user to kimaki send.
  const instructions = realtime.instructions[0]!
  expect(instructions).toContain(`--user '${TEST_USER_ID}'`)
  expect(instructions).toContain(server.projectDirectory)
  expect(instructions.slice(instructions.indexOf('## user instructions')).replaceAll(server.configDir, '<config>')).toMatchInlineSnapshot(`
    "## user instructions

    The global AGENTS.md of the user. Follow it where it applies to this call.

    <user-agents-md path="<config>/AGENTS.md">
    Always answer like a pirate.
    </user-agents-md>

    ## skills

    Skills are instruction files for specific tasks. Before you use a skill, read its SKILL.md with the shell tool (cat <path>) and follow it.

    <available-skills>
      <skill name="deploy-docs" path="<config>/skills/deploy-docs/SKILL.md">Deploy the docs &lt;site> &amp; check it.</skill>
    </available-skills>"
  `)

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
    TestBot: -# ┣ end\\_call
    TestBot: -# ⬦ voice call ended: the assistant hung up"
  `)
  await twin.discord.channel(voiceChannelId).user(TEST_USER_ID).leaveVoice()
})

test('finished threads of any project are announced in the call; the model answers only for its own', async () => {
  await waitFor({ label: 'bot out of voice', check: async () => botVoiceChannel() === null })
  const before = (await twin.discord.channel(voiceChannelId).getMessages()).length
  realtime.replies.push(
    { type: 'say', text: 'Hi.' },
    { type: 'call', name: 'shell', args: { command: `kimaki send --channel ${twin.channelId} --prompt 'call-thread-marker' --user '${TEST_USER_ID}'` } },
    { type: 'say', text: 'Started.' },
    // The answer to the finished notice of the thread the call started.
    { type: 'say', text: 'Your thread finished.' },
  )
  await twin.discord.channel(voiceChannelId).user(TEST_USER_ID).joinVoice()
  await waitForChat('Hi.')
  await twin.discord.channel(voiceChannelId).user(TEST_USER_ID).sendMessage({ content: 'start a thread' })
  await waitForChat('Your thread finished.')

  // A thread started from Discord, not from the call: context only, no answer.
  realtime.replies.push({ type: 'say', text: 'Should stay quiet.' })
  await twin.discord.channel(twin.channelId).user(TEST_USER_ID).sendMessage({ content: 'other-thread-marker' })
  await waitFor({
    label: 'second finished notice',
    check: async () => (await twin.discord.channel(voiceChannelId).getMessages()).filter((message) => message.content.includes('thread finished')).length === 2,
  })
  for (let i = 0; i < 10; i++) {
    expect(realtime.replies.length).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  realtime.replies.length = 0

  const messages = (await twin.discord.channel(voiceChannelId).getMessages()).slice(before)
  const text = messages
    .map((message) => `${message.author.username}: ${message.content}`)
    .join('\n')
    .replace(/\d{17,20}/g, '<id>')
    .replace(/ses_\w+/g, '<ses>')
  expect(text).toMatchInlineSnapshot(`
    "TestBot: -# ⬦ voice call started ⋅ gpt-realtime-2.1
    TestBot: Hi.
    tommy: start a thread
    TestBot: -# ┣ shell _kimaki send --channel <id> --prompt 'call-thread-marker' --user '…_
    TestBot: -# ⬦ session started in <#<id>>
    TestBot: Started.
    TestBot: -# ⬦ thread finished: call-thread-marker ⋅ https://discord.com/channels/<id>/<id> ⋅ <ses>
    TestBot: Your thread finished.
    TestBot: -# ⬦ thread finished: other-thread-marker ⋅ https://discord.com/channels/<id>/<id> ⋅ <ses>"
  `)
  const notices = realtime.userTexts.filter((userText) => userText.startsWith('<system>Thread finished'))
  expect(notices.map((notice) => notice.replace(/\d{17,20}/g, '<id>').replace(/ses_\w+/g, '<ses>'))).toMatchInlineSnapshot(`
    [
      "<system>Thread finished: "call-thread-marker". Thread ID <id>, session ID <ses>, URL https://discord.com/channels/<id>/<id>.</system>",
      "<system>Thread finished: "other-thread-marker". Thread ID <id>, session ID <ses>, URL https://discord.com/channels/<id>/<id>.</system>",
    ]
  `)
  await twin.discord.channel(voiceChannelId).user(TEST_USER_ID).leaveVoice()
})
