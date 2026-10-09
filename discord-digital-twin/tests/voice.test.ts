// Voice: discord.js + @discordjs/voice join a twin voice channel, play an Ogg
// Opus file, and the twin records the decrypted opus frames. The fixture is a
// short TTS clip (egaki speech, Cartesia sonic-3, converted with ffmpeg).

import fs from 'node:fs'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { ChannelType, Client, GatewayIntentBits } from 'discord.js'
import {
  EndBehaviorType,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice'
import prism from 'prism-media'
import { DigitalDiscord } from '../src/index.js'

const GUILD = '400000000000000001'
const VOICE_CHANNEL = '400000000000000011'
const USER = '400000000000000021'
const FIXTURE = new URL('./fixtures/voice-hello.ogg', import.meta.url)
// @discordjs/voice ends every stream with opus silence frames.
const SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe])

let discord: DigitalDiscord
let client: Client

async function readOpusPackets(file: URL): Promise<Buffer[]> {
  const packets: Buffer[] = []
  for await (const packet of fs.createReadStream(file).pipe(new prism.opus.OggDemuxer())) packets.push(packet)
  return packets
}

beforeAll(async () => {
  discord = new DigitalDiscord({
    voice: true,
    users: [{ id: USER, username: 'tommy' }],
    guild: { id: GUILD, name: 'Voice', channels: [{ id: VOICE_CHANNEL, name: 'talk', type: ChannelType.GuildVoice }] },
  })
  await discord.start()
  discord.trustVoiceCertificate()
  client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    rest: { api: discord.restUrl, version: '10' },
  })
  const ready = new Promise<void>((resolve) => client.once('clientReady', () => resolve()))
  await client.login(discord.botToken)
  await ready
})

afterAll(async () => {
  await client?.destroy()
  await discord?.stop()
})

test('bot joins a voice channel and the twin records the audio it sends', async () => {
  const guild = client.guilds.cache.get(GUILD)
  if (!guild) throw new Error('guild missing')
  const connection = joinVoiceChannel({
    guildId: GUILD,
    channelId: VOICE_CHANNEL,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    daveEncryption: false,
  })
  await entersState(connection, VoiceConnectionStatus.Ready, 8_000)
  expect(guild.members.me?.voice.channelId).toBe(VOICE_CHANNEL)

  const player = createAudioPlayer()
  connection.subscribe(player)
  player.play(createAudioResource(fs.createReadStream(FIXTURE), { inputType: StreamType.OggOpus }))

  const stream = await discord.waitForVoiceStream({ channelId: VOICE_CHANNEL, userId: discord.botUserId })
  const expected = await readOpusPackets(FIXTURE)
  expect(stream.opusPackets.slice(0, expected.length)).toEqual(expected)
  // Then only silence frames. @discordjs/voice 0.19 sends 4 of its 5.
  const tail = stream.opusPackets.slice(expected.length)
  expect(tail.length).toBeGreaterThan(0)
  expect(tail.every((packet) => packet.equals(SILENCE_FRAME))).toBe(true)

  connection.destroy()
  await expect.poll(() => guild.members.me?.voice.channelId ?? null, { timeout: 4_000, interval: 50 }).toBe(null)
})

test('a user speaking reaches the bot receiver as the same opus frames', async () => {
  const guild = client.guilds.cache.get(GUILD)
  if (!guild) throw new Error('guild missing')
  const connection = joinVoiceChannel({ guildId: GUILD, channelId: VOICE_CHANNEL, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false })
  await entersState(connection, VoiceConnectionStatus.Ready, 8_000)
  const speaker = new Promise<string>((resolve) => connection.receiver.speaking.once('start', resolve))
  const received: Buffer[] = []
  const ended = new Promise<void>((resolve) => {
    connection.receiver.speaking.once('start', (userId) => {
      const stream = connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 100 } })
      stream.on('data', (packet: Buffer) => received.push(packet))
      stream.once('end', () => resolve())
    })
  })
  const expected = await readOpusPackets(FIXTURE)
  await discord.channel(VOICE_CHANNEL).user(USER).joinVoice()
  await discord.channel(VOICE_CHANNEL).user(USER).speak({ opusPackets: expected, intervalMs: 0 })
  expect(await speaker).toBe(USER)
  await ended
  // The speaking event fires before the frame is routed, so the subscription gets every frame.
  expect(received).toEqual(expected)
  await discord.channel(VOICE_CHANNEL).user(USER).leaveVoice()
  connection.destroy()
  await expect.poll(() => guild.members.me?.voice.channelId ?? null, { timeout: 4_000, interval: 50 }).toBe(null)
})

test('a user joining voice reaches the bot as voiceStateUpdate', async () => {
  const seen: Array<string | null> = []
  client.on('voiceStateUpdate', (_old, state) => {
    if (state.id === USER) seen.push(state.channelId)
  })
  await discord.channel(VOICE_CHANNEL).user(USER).joinVoice()
  await discord.channel(VOICE_CHANNEL).user(USER).leaveVoice()
  await expect.poll(() => seen, { timeout: 4_000, interval: 50 }).toEqual([VOICE_CHANNEL, null])
})
