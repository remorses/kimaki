// Voice calls: the twin plays Discord voice (wss + UDP), startFakeLive() plays
// GPT-Live over real WebRTC plus the backend model. A user joins the Kimaki voice
// channel, the bot joins and greets, the user speaks, the model delegates, the
// backend runs `kimaki project list` with the shell tool and the model says the
// answer. Leaving ends the call; so does end_call.

import fs from 'node:fs'
import path from 'node:path'
import { getVoiceConnection } from '@discordjs/voice'
import type { DeterministicMatcher } from 'opencode-deterministic-provider'
import prism from 'prism-media'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { BotHandle } from './main.ts'
import { ensureVoiceChannels, saveVoiceCallVoice, voiceCallSettings } from './voice-call.ts'
import {
  TEST_USER_ID,
  seedProjectChannel,
  startFakeLive,
  startOpencodeTestServer,
  startTestBot,
  startTwin,
  tempDataDir,
  textParts,
  waitFor,
  writeOpencodeCredential,
  type FakeLive,
  type OpencodeTestServer,
  type TestTwin,
} from './test/harness.ts'

let server: OpencodeTestServer
let twin: TestTwin
let bot: BotHandle
let live: FakeLive
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

async function chatSince(before: number) {
  const messages = (await twin.discord.channel(voiceChannelId).getMessages()).slice(before)
  return messages
    .map((message) => `${message.author.username}: ${message.content}`)
    .join('\n')
    .replace(/\d{17,20}/g, '<id>')
    .replace(/ses_\w+/g, '<ses>')
}

beforeAll(async () => {
  dataDir = tempDataDir()
  const matchers: DeterministicMatcher[] = ['call-thread-marker', 'other-thread-marker'].map((marker) => ({
    id: marker,
    priority: 50,
    when: { latestUserTextIncludes: marker },
    then: { parts: textParts(`${marker} done`) },
  }))
  ;[server, twin, live] = await Promise.all([startOpencodeTestServer({ matchers }), startTwin({ voice: true }), startFakeLive()])
  await seedProjectChannel({ dataDir, channelId: twin.channelId, guildId: twin.discord.guildId, directory: server.projectDirectory })
  // The user's global AGENTS.md and a global skill go into the backend instructions.
  fs.writeFileSync(path.join(server.configDir, 'AGENTS.md'), 'Always answer like a pirate.\n')
  fs.mkdirSync(path.join(server.configDir, 'skills', 'deploy-docs'), { recursive: true })
  fs.writeFileSync(path.join(server.configDir, 'skills', 'deploy-docs', 'SKILL.md'), '---\nname: deploy-docs\ndescription: Deploy the docs <site> & check it.\n---\n\nRun pnpm deploy.\n')
  // The ChatGPT subscription signed in to OpenCode pays for the calls.
  const opencodeDbFile = path.join(dataDir, 'opencode-chatgpt.db')
  await writeOpencodeCredential({ file: opencodeDbFile, access: 'chatgpt-access-token', expires: Date.now() + 3_600_000 })
  bot = await startTestBot({ dataDir, twin, server, opencodeDbFile, realtimeBaseUrls: live.baseUrls })
  live.greeting = 'Hello tommy.'
})

afterAll(async () => {
  await bot?.stop()
  await twin?.stop()
  await server?.stop()
  await live?.stop()
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

test('a user joins and speaks, the backend runs kimaki commands and the model says the answer; leaving ends the call', async () => {
  live.replies.push(
    // seq makes the output longer than the 4000 character limit.
    { type: 'call', name: 'shell', args: { command: 'seq 1 2000; kimaki project list' } },
    { type: 'call', name: 'shell', args: { command: `kimaki send --channel ${twin.channelId} --prompt 'Voice call note' --notify-only` } },
    // An empty post fails validation: the chat shows a failed tool line.
    { type: 'call', name: 'post_message', args: { text: ' ' } },
    { type: 'say', text: 'You have one project.' },
  )
  live.transcripts.push('Which projects do I have?')
  await twin.discord.channel(voiceChannelId).user(TEST_USER_ID).joinVoice()
  await waitFor({ label: 'bot in the voice channel', check: async () => botVoiceChannel() === voiceChannelId })
  // The greeting is real audio: model RTP passed to Discord, decrypted by the twin from the bot's UDP packets.
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
    -# ⬦ voice call started ⋅ gpt-live ⋅ cove
    Hello tommy.
    » **tommy:** Which projects do I have?
    -# ┣ shell _seq 1 2000; kimaki project list_
    -# ┣ shell _kimaki send --channel 200000000000000100 --prompt 'Voice call note' --notify-on…_
    -# ⬦ session started in <#thread>
    -#  ⨯  post\\_message _text must not be empty_
    You have one project."
  `)
  expect(live.voicedFrames()).toBeGreaterThan(0)
  expect(live.backendInputs).toMatchInlineSnapshot(`
    [
      "Which projects do I have?",
    ]
  `)
  const [listed] = live.toolOutputs
  expect(listed?.name).toBe('shell')
  expect(JSON.parse(listed!.output)).toMatchObject({ exitCode: 0 })
  expect(listed!.output).toContain(server.projectDirectory)
  // The truncated output names a file with the full output.
  const { output } = JSON.parse(listed!.output) as { output: string }
  const file = /full output in (\S+?),/.exec(output)?.[1]
  expect(output.split('\n')[0]).toMatch(/^\[output truncated: first \d+ characters omitted; full output in \S+, use grep or sed on it\]$/)
  expect(fs.readFileSync(file!, 'utf8').startsWith('1\n2\n3\n')).toBe(true)
  fs.rmSync(file!)
  // The model's instructions name the users; the backend's name the projects and pass every user to kimaki send.
  expect(live.liveInstructions[0]).toContain('with tommy')
  const instructions = live.backendInstructions[0]!
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
  await waitFor({ label: 'model call closed', check: async () => live.openCalls() === 0 })
})

test('chat messages reach the backend, and end_call leaves after the goodbye while the user stays', async () => {
  const before = (await twin.discord.channel(voiceChannelId).getMessages()).length
  const botPackets = () => twin.discord.getVoiceStreams({ channelId: voiceChannelId, userId: twin.discord.botUserId }).reduce((total, stream) => total + stream.opusPackets.length, 0)
  const packetsBefore = botPackets()
  live.greeting = 'Hi again.'
  live.replies.push({ type: 'call', name: 'end_call', args: {} }, { type: 'say', text: 'Bye.' })
  await twin.discord.channel(voiceChannelId).user(TEST_USER_ID).joinVoice()
  await waitForChat('Hi again.')
  await twin.discord.channel(voiceChannelId).user(TEST_USER_ID).sendMessage({ content: 'please hang up' })
  await waitFor({ label: 'bot out of voice', check: async () => botVoiceChannel() === null })
  await waitForChat('voice call ended: the assistant hung up')
  // The greeting and the goodbye (15 packets each in the fake) were both played before the bot left.
  expect(botPackets() - packetsBefore).toBeGreaterThanOrEqual(30)
  expect(live.backendInputs.at(-1)).toBe(`<chat-message from="tommy" user-id="${TEST_USER_ID}">\nplease hang up\n</chat-message>`)
  expect(await chatSince(before)).toMatchInlineSnapshot(`
    "TestBot: -# ⬦ voice call started ⋅ gpt-live ⋅ cove
    TestBot: Hi again.
    tommy: please hang up
    TestBot: -# ┣ end\\_call
    TestBot: Bye.
    TestBot: -# ⬦ voice call ended: the assistant hung up"
  `)
  await twin.discord.channel(voiceChannelId).user(TEST_USER_ID).leaveVoice()
})

test('finished threads of any project are announced in the call; the model answers only for its own', async () => {
  await waitFor({ label: 'bot out of voice', check: async () => botVoiceChannel() === null })
  const before = (await twin.discord.channel(voiceChannelId).getMessages()).length
  live.replies.push(
    { type: 'call', name: 'shell', args: { command: `kimaki send --channel ${twin.channelId} --prompt 'call-thread-marker' --user '${TEST_USER_ID}'` } },
    { type: 'say', text: 'Started.' },
    // The answer to the finished notice of the thread the call started.
    { type: 'say', text: 'Your thread finished.' },
  )
  live.greeting = 'Hi.'
  await twin.discord.channel(voiceChannelId).user(TEST_USER_ID).joinVoice()
  await waitForChat('Hi.')
  await twin.discord.channel(voiceChannelId).user(TEST_USER_ID).sendMessage({ content: 'start a thread' })
  await waitForChat('Your thread finished.')

  // A thread started from Discord, not from the call: silent context for both models, no backend run.
  live.replies.push({ type: 'say', text: 'Should stay quiet.' })
  await twin.discord.channel(twin.channelId).user(TEST_USER_ID).sendMessage({ content: 'other-thread-marker' })
  await waitFor({
    label: 'second finished notice',
    check: async () => (await twin.discord.channel(voiceChannelId).getMessages()).filter((message) => message.content.includes('thread finished')).length === 2,
  })
  for (let i = 0; i < 10; i++) {
    expect(live.replies.length).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  live.replies.length = 0

  expect(await chatSince(before)).toMatchInlineSnapshot(`
    "TestBot: -# ⬦ voice call started ⋅ gpt-live ⋅ cove
    TestBot: Hi.
    tommy: start a thread
    TestBot: -# ┣ shell _kimaki send --channel <id> --prompt 'call-thread-marker' --user '…_
    TestBot: -# ⬦ session started in <#<id>>
    TestBot: Started.
    TestBot: -# ⬦ thread finished: call-thread-marker ⋅ https://discord.com/channels/<id>/<id> ⋅ <ses>
    TestBot: Your thread finished.
    TestBot: -# ⬦ thread finished: other-thread-marker ⋅ https://discord.com/channels/<id>/<id> ⋅ <ses>"
  `)
  const notices = live.appends.filter((append) => append.text.startsWith('<system>Thread finished'))
  expect(notices.map((notice) => ({ ...notice, text: notice.text.replace(/\d{17,20}/g, '<id>').replace(/ses_\w+/g, '<ses>') }))).toMatchInlineSnapshot(`
    [
      {
        "channel": "commentary",
        "delegation": false,
        "text": "<system>Thread finished: "other-thread-marker". Thread ID <id>, session ID <ses>, URL https://discord.com/channels/<id>/<id>.</system>",
      },
    ]
  `)
  await twin.discord.channel(voiceChannelId).user(TEST_USER_ID).leaveVoice()
})

test('a saved voice is used when gpt-live knows it; no ChatGPT sign-in means no call', async () => {
  const appId = (await bot.db.query.bot_tokens.findFirst({ where: { token: bot.token } }))!.app_id
  const pick = async (voice: string | null) => {
    const saved = await saveVoiceCallVoice({ db: bot.db, appId, voice })
    if (saved instanceof Error) throw saved
    const settings = await voiceCallSettings(bot)
    if (settings instanceof Error) throw settings
    return `${voice}: ${settings.voice}${settings.voiceNotice ? ` (${settings.voiceNotice})` : ''}`
  }
  const lines: string[] = []
  for (const voice of [null, 'JUNIPER', 'marin']) lines.push(await pick(voice))
  const reset = await saveVoiceCallVoice({ db: bot.db, appId, voice: null })
  if (reset instanceof Error) throw reset
  const signedOut = await voiceCallSettings({ ...bot, opencodeDbFile: path.join(dataDir, 'missing.db') })
  lines.push(signedOut instanceof Error ? signedOut.message : 'signed in')
  expect(lines).toMatchInlineSnapshot(`
    [
      "null: cove",
      "JUNIPER: juniper",
      "marin: cove (saved voice marin is unknown, using cove. Run kimaki --voice <name> to change it)",
      "Voice calls need a ChatGPT subscription signed in to OpenCode. Run kimaki login openai, then join the voice channel again",
    ]
  `)
})
