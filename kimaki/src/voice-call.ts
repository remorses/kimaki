// Voice calls in the Kimaki voice channel: one voice channel per machine and
// guild (addVoiceChannel in project.ts), mapped to the data dir. A permitted
// user joins it, the bot joins and opens a realtime speech-to-speech session
// (@kimaki/realtime). The call ends when the last permitted user leaves, or
// when the model calls end_call.
//
//   user opus ─▶ receiver (AfterSilence) ─▶ prism Decoder 48k stereo ─▶ session.appendAudio
//                                       stream end ─▶ session.endOfSpeech
//   model PCM 24k mono ─▶ 48k stereo ─▶ AudioResource(Raw) ─▶ AudioPlayer ─▶ Discord
//   model tool calls ─▶ shell (kimaki CLI, cwd dataDir) | post_message | end_call
//
// The text chat of the voice channel shows the call: transcripts, tool lines,
// messages from post_message and uploads (`kimaki upload-to-discord` defaults to
// KIMAKI_CHANNEL_ID in the call shell). Text typed there goes to the model.
// V1 reference: `git show v1:cli/src/voice-handler.ts`.

import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { PassThrough, pipeline } from 'node:stream'
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioResource,
  type VoiceConnection,
} from '@discordjs/voice'
import { API } from '@discordjs/core/http-only'
import { gemini, openai, RealtimeSession, resample, xai, type Adapter, type AudioSink, type OutputAudio, type Tool } from '@kimaki/realtime'
import { Events, type Guild, type VoiceState } from 'discord.js'
import * as errore from 'errore'
import prism from 'prism-media'
import { z } from 'zod'

import type { Author, Bot } from './bot.ts'
import { DbError } from './errors.ts'
import { formatError, formatToolLine } from './format-parts.ts'
import { canUseKimaki } from './ingress.ts'
import { createLogger } from './logger.ts'
import { addVoiceChannel, listProjects } from './project.ts'
import { formatEcho } from './queue.ts'
import { voiceCallInstructions } from './system-prompt.ts'

const logger = createLogger('VCALL')

// Shell output the model reads: the end of stdout and stderr.
const OUTPUT_LIMIT = 4_000
const SHELL_TIMEOUT_MS = 120_000
const BACKGROUND_TIMEOUT_MS = 30 * 60_000

const shellArgs = z.object({
  command: z.string({ error: 'command must be a string' }).trim().min(1, { error: 'command must not be empty' }),
  background: z.boolean().optional(),
  timeoutSeconds: z.number().positive().optional(),
})
const postArgs = z.object({ text: z.string({ error: 'text must be a string' }).trim().min(1, { error: 'text must not be empty' }) })
// A user's audio stream ends after this much silence (V1: 500).
const SPEECH_END_MS = 400

export class VoiceCallError extends errore.createTaggedError({
  name: 'VoiceCallError',
  message: 'Voice call $operation failed',
}) {}

export class NoRealtimeKeyError extends errore.createTaggedError({
  name: 'NoRealtimeKeyError',
  message: 'Voice calls need an OpenAI, xAI or Gemini API key. Run /transcription-key, or kimaki bot keys set --openai <key>',
}) {}

// Realtime WebSocket URLs; tests point OpenAI at a local fake.
export type RealtimeBaseUrls = { openai?: string; xai?: string }

// Same keys as voice transcription (bot_api_keys, then env), best first. OpenAI
// has the most reliable tool calls; it has no server-side search, xAI and Gemini do.
export async function realtimeModel(bot: Pick<Bot, 'db' | 'token' | 'realtimeBaseUrls'>): Promise<DbError | NoRealtimeKeyError | { adapter: Adapter; builtinSearch: string | null }> {
  const row = await bot.db.query.bot_tokens
    .findFirst({ where: { token: bot.token }, with: { api_keys: true } })
    .catch((cause) => new DbError({ operation: 'read realtime keys', cause }))
  if (row instanceof Error) return row
  const keys = row?.api_keys
  const openaiKey = keys?.openai_api_key || process.env['OPENAI_API_KEY']
  if (openaiKey) return { adapter: openai({ apiKey: openaiKey, baseUrl: bot.realtimeBaseUrls.openai }), builtinSearch: null }
  const xaiKey = keys?.xai_api_key || process.env['XAI_API_KEY']
  if (xaiKey) {
    const builtinTools = [{ type: 'web_search' }, { type: 'x_search' }]
    return { adapter: xai({ apiKey: xaiKey, builtinTools, baseUrl: bot.realtimeBaseUrls.xai }), builtinSearch: 'web_search and x_search' }
  }
  const geminiKey = keys?.gemini_api_key || process.env['GEMINI_API_KEY']
  if (geminiKey) return { adapter: gemini({ apiKey: geminiKey, builtinTools: [{ googleSearch: {} }] }), builtinSearch: 'Google Search' }
  return new NoRealtimeKeyError()
}

// Creates the voice channel of this machine in every guild with its project channels.
export async function ensureVoiceChannels(bot: Bot, { machine }: { machine: string }): Promise<Error | string[]> {
  const projects = await listProjects({ db: bot.db })
  if (projects instanceof Error) return projects
  const guildIds = [...new Set(projects.flatMap((project) => (project.guild_id ? [project.guild_id] : [])))]
  const api = new API(bot.discord.rest)
  const channelIds: string[] = []
  for (const guildId of guildIds) {
    const voice = await addVoiceChannel({ api, db: bot.db, guildId, dataDir: bot.dataDir, machine })
    if (voice instanceof Error) return voice
    if (voice.created) logger.info(`created voice channel ${voice.channelId} in guild ${guildId}`)
    channelIds.push(voice.channelId)
  }
  return channelIds
}

// --- audio

// Model audio (mono, any rate) to what Discord plays: 48 kHz stereo PCM16.
function toDiscordPcm({ pcm, rate }: { pcm: Int16Array; rate: number }): Buffer {
  const mono = resample(pcm, rate, 48_000)
  const stereo = new Int16Array(mono.length * 2)
  for (let i = 0; i < mono.length; i++) {
    stereo[i * 2] = mono[i]!
    stereo[i * 2 + 1] = mono[i]!
  }
  return Buffer.from(stereo.buffer)
}

// Plays model replies. One resource per reply: the player stops by itself
// after 1s without audio (maxMissedFrames), so the next reply starts a new one.
function createSpeaker(connection: VoiceConnection) {
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 50 } })
  connection.subscribe(player)
  const playing: { current: { stream: PassThrough; resource: AudioResource } | null } = { current: null }
  player.on(AudioPlayerStatus.Idle, () => {
    playing.current = null
  })
  player.on('error', (error) => logger.warn(`audio player`, error))
  const sink: AudioSink = {
    play(audio: OutputAudio) {
      if (!playing.current) {
        const stream = new PassThrough()
        playing.current = { stream, resource: createAudioResource(stream, { inputType: StreamType.Raw }) }
        player.play(playing.current.resource)
      }
      playing.current.stream.write(toDiscordPcm(audio))
    },
    // Barge-in: how much of the reply the users heard.
    stop() {
      const current = playing.current
      if (!current) return null
      playing.current = null
      current.stream.end()
      player.stop(true)
      return current.resource.playbackDuration
    },
  }
  return {
    sink,
    // Resolves when nothing plays, at most after `timeout` ms.
    quiet: async (timeout: number) => {
      if (player.state.status === AudioPlayerStatus.Idle) return
      await entersState(player, AudioPlayerStatus.Idle, timeout).catch(() => undefined)
    },
    stop: () => player.stop(true),
  }
}

function killGroup(child: ChildProcess) {
  // Not exitCode: /bin/sh can exit while a background child of its group still runs.
  if (child.pid === undefined) return
  const killed = errore.try(() => process.kill(-child.pid!, 'SIGTERM'))
  if (killed instanceof Error) child.kill('SIGTERM')
}

// --- calls

type Call = {
  guildId: string
  channelId: string
  connection: VoiceConnection
  session: RealtimeSession
  speaker: ReturnType<typeof createSpeaker>
  // Users allowed to talk to the model (canUseKimaki), by ID.
  permitted: Map<string, Author>
  // The user whose audio goes to the model now; others wait until the stream ends.
  floor: { userId: string | null; lastSpeaker: Author | null }
  // Indexes of session messages already posted in the text chat.
  posted: Set<number>
  background: Set<ChildProcess>
  ending: boolean
}

export type VoiceCalls = ReturnType<typeof createVoiceCalls>

export function createVoiceCalls() {
  // guildId -> call. One call per guild: a bot is in at most one voice channel there.
  const calls = new Map<string, Call>()
  // Voice state changes of one guild run in order, so a quick join and leave cannot race.
  const chains = new Map<string, Promise<void>>()

  function serialize(guildId: string, task: () => Promise<void>) {
    const next = (chains.get(guildId) ?? Promise.resolve()).then(() => task().catch((error: Error) => logger.error(`voice state`, error)))
    chains.set(guildId, next)
    return next
  }

  // Bot lines in the text chat of the voice channel, through the same FIFO as session output.
  function post(bot: Bot, { channelId, text, markdown = false }: { channelId: string; text: string; markdown?: boolean }) {
    bot.effects.run(channelId, [markdown ? { type: 'markdown', text, blankLineBefore: false } : { type: 'send', text }])
  }

  async function voiceChannelOf(bot: Bot, guildId: string) {
    return bot.db.query.channel_directories
      .findFirst({ where: { guild_id: guildId, channel_type: 'voice' } })
      .catch((cause) => new DbError({ operation: 'read voice channel', cause }))
  }

  async function permittedUsers(bot: Bot, { guild, channelId }: { guild: Guild; channelId: string }) {
    const states = guild.voiceStates.cache.filter((state) => state.channelId === channelId && state.id !== bot.discord.user?.id)
    const users = new Map<string, Author>()
    for (const state of states.values()) {
      if (!(await canUseKimaki({ guild, userId: state.id }))) continue
      const user = await bot.discord.users.fetch(state.id).catch(() => null)
      users.set(state.id, { id: state.id, username: user?.username ?? state.id })
    }
    return users
  }

  // Posts finished transcripts the chat does not show yet. Tool lines are posted by the tools.
  function postTranscripts(bot: Bot, call: Call) {
    const messages = call.session.view().messages
    for (const [index, message] of messages.entries()) {
      if (call.posted.has(index)) continue
      if (message.kind === 'tool' || message.kind === 'summary') {
        call.posted.add(index)
        continue
      }
      if (!message.done) continue
      call.posted.add(index)
      const text = message.text.trim()
      if (!text) continue
      if (message.kind === 'user') post(bot, { channelId: call.channelId, text: formatEcho({ username: call.floor.lastSpeaker?.username ?? 'voice', text }) })
      else post(bot, { channelId: call.channelId, text: message.interrupted ? `${text} *(interrupted)*` : text, markdown: true })
    }
  }

  // Text the model gets that the chat already shows (typed messages, command results).
  function sendHidden(call: Call, text: string) {
    const sent = call.session.sendText(text)
    if (sent instanceof Error) return sent
    call.posted.add(call.session.view().messages.length - 1)
  }

  // The instructions keep the users of the call start (prompt cache); changes come as context.
  // On Gemini every clientContent interrupts the current reply (https://ai.google.dev/api/live).
  function announceUsers(call: Call) {
    const users = [...call.permitted.values()]
    const list = users.map((user) => `${user.username} (${user.id})`).join(', ')
    const args = users.map((user) => `--user '${user.id}'`).join(' ')
    const sent = call.session.sendText(`<system>The users in the call are now: ${list}. Pass ${args} to kimaki send.</system>`, { respond: false })
    if (sent instanceof Error) return logger.warn(`announce users`, sent)
    call.posted.add(call.session.view().messages.length - 1)
  }

  function shellEnv(bot: Bot, call: Call) {
    const { OPENCODE_SESSION_ID: _session, KIMAKI_TOOL_CALL: _toolCall, ...env } = process.env
    return {
      ...env,
      PATH: `${path.join(bot.dataDir, 'bin')}${path.delimiter}${env['PATH'] ?? ''}`,
      KIMAKI_DATA_DIR: bot.dataDir,
      KIMAKI_LOCK_PORT: String(bot.lockPort),
      // Default target of `kimaki upload-to-discord` in the call.
      KIMAKI_CHANNEL_ID: call.channelId,
    }
  }

  // Runs a shell command; resolves with the exit code and the end of its output.
  function runShell(bot: Bot, { call, command, timeoutMs }: { call: Call; command: string; timeoutMs: number }) {
    return new Promise<{ exitCode: number | null; output: string }>((resolve) => {
      // Own process group: a timeout or hangup kills the pipeline, not only /bin/sh.
      const child = spawn('/bin/sh', ['-c', command], { cwd: bot.dataDir, env: shellEnv(bot, call), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
      call.background.add(child)
      const output = { text: '' }
      const append = (chunk: Buffer) => {
        output.text = (output.text + chunk.toString('utf8')).slice(-OUTPUT_LIMIT)
      }
      child.stdout.on('data', append)
      child.stderr.on('data', append)
      const timer = setTimeout(() => {
        append(Buffer.from(`\n[killed after ${Math.round(timeoutMs / 1000)}s]`))
        killGroup(child)
      }, timeoutMs)
      child.on('error', (error) => append(Buffer.from(`\n${error.message}`)))
      child.on('close', (code) => {
        clearTimeout(timer)
        call.background.delete(child)
        resolve({ exitCode: code, output: output.text })
      })
    })
  }

  function tools(bot: Bot, call: () => Call): Record<string, Tool> {
    return {
      shell: {
        description: 'Run a shell command with the kimaki CLI on PATH. Returns the exit code and the last 4000 characters of output.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The command, e.g. kimaki session list --all --active' },
            background: { type: 'boolean', description: 'Return at once; the output arrives later in a <background-command> message. Use it for slow commands like kimaki session wait.' },
            timeoutSeconds: { type: 'number', description: 'Default 120. Background commands default to 1800.' },
          },
          required: ['command'],
        },
        async execute(args) {
          const parsed = shellArgs.safeParse(args)
          if (!parsed.success) return { error: parsed.error.issues.map((issue) => issue.message).join('; ') }
          const input = parsed.data
          const current = call()
          post(bot, { channelId: current.channelId, text: formatToolLine({ name: 'shell', input: { command: input.command } }) })
          const background = input.background === true
          const timeoutMs = input.timeoutSeconds ? input.timeoutSeconds * 1000 : background ? BACKGROUND_TIMEOUT_MS : SHELL_TIMEOUT_MS
          const run = runShell(bot, { call: current, command: input.command, timeoutMs })
          if (!background) return run
          void run.then(({ exitCode, output }) => {
            if (current.ending) return
            const sent = sendHidden(current, `<background-command exit-code="${exitCode}">\n$ ${input.command}\n${output}\n</background-command>`)
            if (sent instanceof Error) logger.warn(`background result`, sent)
          })
          return { started: true }
        },
      },
      post_message: {
        description: 'Post markdown in the text chat of this voice channel: links, IDs, lists, code.',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        execute(args) {
          const parsed = postArgs.safeParse(args)
          if (!parsed.success) return { error: parsed.error.issues.map((issue) => issue.message).join('; ') }
          post(bot, { channelId: call().channelId, text: parsed.data.text, markdown: true })
          return { posted: true }
        },
      },
      end_call: {
        description: 'Leave the voice call. Say a short goodbye in the same reply, before calling it.',
        parameters: { type: 'object', properties: {} },
        async execute() {
          const current = call()
          // The goodbye came before this call in the same reply: let it play, then leave.
          // The session closes before the result is sent, so no further reply is requested.
          await current.speaker.quiet(15_000)
          await end(bot, { guildId: current.guildId, reason: 'the assistant hung up' })
          return { ok: true }
        },
      },
    }
  }

  function listen(bot: Bot, call: Call) {
    const receiver = call.connection.receiver
    receiver.speaking.on('start', (userId) => {
      const user = call.permitted.get(userId)
      if (!user || call.ending) return
      // One audio stream for the model: the latest speaker takes the floor (V1 policy).
      call.floor.userId = userId
      call.floor.lastSpeaker = user
      // start fires again after 100ms of silence while the subscription (400ms) is still open.
      if (receiver.subscriptions.has(userId)) return
      const opus = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: SPEECH_END_MS } })
      const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 })
      decoder.on('data', (pcm: Buffer) => {
        if (call.floor.userId !== userId) return
        // Copy: a Buffer slice can start at an odd byte offset.
        const sent = call.session.appendAudio(new Int16Array(Uint8Array.from(pcm).buffer), { rate: 48_000, channels: 2 })
        if (sent instanceof Error) logger.warn(`audio to model`, sent)
      })
      const release = () => {
        if (call.floor.userId !== userId) return
        call.floor.userId = null
        if (call.ending) return
        const ended = call.session.endOfSpeech()
        if (ended instanceof Error) logger.warn(`end of speech`, ended)
      }
      // pipeline() destroys the decoder (and frees its codec) when the receive stream closes.
      pipeline(opus, decoder, (error) => {
        if (error && !call.ending) logger.warn(`audio stream of ${userId}`, error)
        release()
      })
    })
  }

  async function start(bot: Bot, { guild, channelId, users }: { guild: Guild; channelId: string; users: Map<string, Author> }) {
    const model = await realtimeModel(bot)
    if (model instanceof Error) {
      logger.warn(`voice call not started`, model)
      post(bot, { channelId, text: formatError(model.message) })
      return
    }
    const connection = joinVoiceChannel({ guildId: guild.id, channelId, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: false })
    const ready = await entersState(connection, VoiceConnectionStatus.Ready, 20_000)
      .catch((cause) => new VoiceCallError({ operation: 'join', cause }))
    if (ready instanceof Error) {
      connection.destroy()
      logger.error(`voice call`, ready)
      post(bot, { channelId, text: formatError(ready.message) })
      return
    }
    const projects = await listProjects({ db: bot.db })
    if (projects instanceof Error) logger.warn(`voice call projects`, projects)
    const instructions = voiceCallInstructions({
      users: [...users.values()],
      projects: (projects instanceof Error ? [] : projects).map((project) => ({
        channelId: project.channel_id,
        channelName: guild.channels.cache.get(project.channel_id)?.name ?? project.channel_id,
        directory: project.directory,
      })),
      guildId: guild.id,
      voiceChannelId: channelId,
      dataDir: bot.dataDir,
      builtinSearch: model.builtinSearch,
    })
    const speaker = createSpeaker(connection)
    const holder: { call: Call | null } = { call: null }
    const session = new RealtimeSession({
      model: model.adapter,
      instructions,
      tools: tools(bot, () => holder.call!),
      output: speaker.sink,
      turns: { mode: 'server', silenceMs: 600 },
    })
    const call: Call = {
      guildId: guild.id,
      channelId,
      connection,
      session,
      speaker,
      permitted: users,
      floor: { userId: null, lastSpeaker: null },
      posted: new Set(),
      background: new Set(),
      ending: false,
    }
    holder.call = call
    calls.set(guild.id, call)
    const connected = await session.connect()
    if (connected instanceof Error) {
      logger.error(`voice call`, connected)
      post(bot, { channelId, text: formatError(connected.message) })
      await end(bot, { guildId: guild.id, reason: null })
      return
    }
    session.subscribe((event) => {
      if (event.type === 'response.done' || (event.type === 'input.text' && event.final)) postTranscripts(bot, call)
      // A closed socket that the session does not reopen (go away reconnects by itself).
      const lost = (event.type === 'session.closed' && event.reason !== 'go away') || (event.type === 'error' && event.code === 'reconnect_failed')
      if (lost && !call.ending) void end(bot, { guildId: guild.id, reason: 'the model connection closed' })
    })
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      // Discord moves or reconnects: wait shortly, else the call is over (V1 behavior).
      void Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]).catch(() => end(bot, { guildId: guild.id, reason: 'disconnected from Discord voice' }))
    })
    connection.on(VoiceConnectionStatus.Destroyed, () => void end(bot, { guildId: guild.id, reason: null }))
    connection.on('error', (error) => logger.warn(`voice connection`, error))
    listen(bot, call)
    logger.info(`voice call started in ${channelId} with ${model.adapter.provider} ${model.adapter.model}`)
    post(bot, { channelId, text: `-# ⬦ voice call started ⋅ ${model.adapter.model}` })
    const greeted = sendHidden(call, '<system>The call started. Greet the users by name in one short sentence.</system>')
    if (greeted instanceof Error) logger.warn(`greeting`, greeted)
  }

  async function end(bot: Bot, { guildId, reason }: { guildId: string; reason: string | null }) {
    const call = calls.get(guildId)
    if (!call || call.ending) return
    call.ending = true
    calls.delete(guildId)
    for (const child of call.background) killGroup(child)
    postTranscripts(bot, call)
    await call.session.close()
    call.speaker.stop()
    if (call.connection.state.status !== VoiceConnectionStatus.Destroyed) call.connection.destroy()
    logger.info(`voice call ended in ${call.channelId}${reason ? `: ${reason}` : ''}`)
    post(bot, { channelId: call.channelId, text: `-# ⬦ voice call ended${reason ? `: ${reason}` : ''}` })
  }

  async function onVoiceState(bot: Bot, { before, after }: { before: VoiceState; after: VoiceState }) {
    const guild = after.guild
    if (after.id === bot.discord.user?.id) {
      // Kicked or moved out by someone else.
      const call = calls.get(guild.id)
      if (call && after.channelId !== call.channelId) await end(bot, { guildId: guild.id, reason: 'the bot left the voice channel' })
      return
    }
    const voice = await voiceChannelOf(bot, guild.id)
    if (voice instanceof Error) return logger.warn(voice)
    if (!voice) return
    const joined = after.channelId === voice.channel_id && before.channelId !== voice.channel_id
    const left = before.channelId === voice.channel_id && after.channelId !== voice.channel_id
    if (!joined && !left) return
    const call = calls.get(guild.id)
    if (left) {
      if (!call?.permitted.delete(after.id)) return
      if (call.permitted.size === 0) return end(bot, { guildId: guild.id, reason: 'everyone left' })
      return announceUsers(call)
    }
    const users = await permittedUsers(bot, { guild, channelId: voice.channel_id })
    if (call) {
      if (!users.has(after.id) || call.permitted.has(after.id)) return
      call.permitted.set(after.id, users.get(after.id)!)
      return announceUsers(call)
    }
    if (users.size === 0) return
    await start(bot, { guild, channelId: voice.channel_id, users })
  }

  const listener: { current: ((before: VoiceState, after: VoiceState) => void) | null } = { current: null }

  return {
    register(bot: Bot) {
      listener.current = (before, after) => void serialize(after.guild.id, () => onVoiceState(bot, { before, after }))
      bot.discord.on(Events.VoiceStateUpdate, listener.current)
    },
    // A message in the text chat of a voice channel: to the model, if a call runs there.
    async text(bot: Bot, { guildId, channelId, author, content }: { guildId: string; channelId: string; author: Author; content: string }) {
      const call = calls.get(guildId)
      if (!call || call.channelId !== channelId || call.ending || !content.trim()) return
      const sent = sendHidden(call, `${author.username} wrote in the chat: ${content}`)
      if (sent instanceof Error) return new VoiceCallError({ operation: 'forward a chat message', cause: sent })
    },
    async stop(bot: Bot) {
      if (listener.current) bot.discord.off(Events.VoiceStateUpdate, listener.current)
      // A call may be starting: let queued voice state work finish first.
      await Promise.all(chains.values())
      await Promise.all([...calls.keys()].map((guildId) => end(bot, { guildId, reason: 'Kimaki stopped' })))
    },
  }
}
