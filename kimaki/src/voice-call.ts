// Voice calls in the Kimaki voice channel: one voice channel per machine and
// guild (addVoiceChannel in project.ts), mapped to the data dir. A permitted
// user joins it, the bot joins and opens a GPT-Live call on the ChatGPT
// subscription (live-call.ts). The call ends when the last permitted user
// leaves, or when the backend calls end_call.
//
//   users' opus ─▶ prism Decoder 48k stereo ─▶ mixer ─▶ live-call (WebRTC) ─▶ GPT-Live
//   GPT-Live voice (Opus packets) ─▶ AudioResource(Opus) ─▶ AudioPlayer ─▶ Discord
//   GPT-Live delegation ─▶ voice-agent.ts (gpt-6-luna tool loop) ─▶ shell | post_message | end_call
//                       ◀─ final text, said by GPT-Live in its own words
//
// The text chat of the voice channel shows the call: transcripts, tool lines,
// messages from post_message and uploads (`kimaki upload-to-discord` defaults to
// KIMAKI_CHANNEL_ID in the call shell). Text typed there goes to the backend.
// V1 reference: `git show v1:cli/src/voice-handler.ts`.

import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
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
  type VoiceConnection,
} from '@discordjs/voice'
import { API } from '@discordjs/core/http-only'
import { Events, type Guild, type VoiceState } from 'discord.js'
import * as errore from 'errore'
import prism from 'prism-media'
import { z } from 'zod'

import { oc, type Author, type Bot } from './bot.ts'
import { DbError } from './errors.ts'
import type { RunEnded } from './event-loop.ts'
import { asSubtext, formatError, formatShellFinished, formatToolFailed, formatToolLine } from './format-parts.ts'
import { canUseKimaki } from './ingress.ts'
import { DEFAULT_LIVE_URLS, DEFAULT_LIVE_VOICE, FRAME_BYTES, LIVE_VOICES, startLiveCall, type LiveCall, type LiveEvent } from './live-call.ts'
import { createLogger } from './logger.ts'
import { addVoiceChannel, listProjects } from './project.ts'
import { formatEcho } from './queue.ts'
import * as schema from './schema.ts'
import { catalogReady, primaryAgents } from './sessions.ts'
import { liveCallInstructions, voiceCallInstructions, type VoiceCallContext } from './system-prompt.ts'
import { createVoiceAgent, type AgentTool } from './voice-agent.ts'
import { chatGPTCredential } from './voice.ts'

const logger = createLogger('VCALL')

// Shell output the model reads: the end of stdout and stderr.
const OUTPUT_LIMIT = 4_000
// Bytes of a truncated output kept on disk: a runaway command must not fill the drive.
const OUTPUT_FILE_LIMIT = 10 * 1024 * 1024
const SHELL_TIMEOUT_MS = 120_000
const BACKGROUND_TIMEOUT_MS = 30 * 60_000

const shellArgs = z.object({
  command: z.string({ error: 'command must be a string' }).trim().min(1, { error: 'command must not be empty' }),
  background: z.boolean().optional(),
  timeoutSeconds: z.number().positive().optional(),
})
const postArgs = z.object({ text: z.string({ error: 'text must be a string' }).trim().min(1, { error: 'text must not be empty' }) })
const toolInput = z.record(z.string(), z.json())
const toolError = z.object({ error: z.string() })
// One line of `kimaki send` output.
const sendResult = z.object({ threadId: z.string() })
// A user's audio stream ends after this much silence (V1: 500).
const SPEECH_END_MS = 400
// Microphone audio queued per user, in 20 ms frames: a stalled clock must not add delay.
const MAX_QUEUED_FRAMES = 50

export class VoiceCallError extends errore.createTaggedError({
  name: 'VoiceCallError',
  message: 'Voice call $operation failed',
}) {}

export class NoChatGPTError extends errore.createTaggedError({
  name: 'NoChatGPTError',
  message: 'Voice calls need a ChatGPT subscription signed in to OpenCode. Run kimaki login openai, then join the voice channel again',
}) {}

// Endpoints of the call; tests point them at local fakes.
export type RealtimeBaseUrls = { calls?: string; sideband?: string; responses?: string }

export class UnknownVoiceError extends errore.createTaggedError({
  name: 'UnknownVoiceError',
  message: 'Unknown voice "$voice". Pass one of: $voices. Use --voice default to reset',
}) {}

// Case-insensitive; returns the canonical name of the voice.
export function parseRealtimeVoice(name: string): UnknownVoiceError | { voice: string } {
  const voice = LIVE_VOICES.find((candidate) => candidate === name.trim().toLowerCase())
  if (!voice) return new UnknownVoiceError({ voice: name, voices: LIVE_VOICES.join(', ') })
  return { voice }
}

// The --voice start flag: a voice saves it, "default" clears it.
export async function saveVoiceCallVoice({ db, appId, voice }: { db: Bot['db']; appId: string; voice: string | null }): Promise<DbError | void> {
  const saved = await db.insert(schema.bot_settings).values({ app_id: appId, voice_call_voice: voice })
    .onConflictDoUpdate({ target: schema.bot_settings.app_id, set: { voice_call_voice: voice } })
    .then(() => undefined)
    .catch((cause) => new DbError({ operation: 'write bot_settings', cause }))
  if (saved instanceof Error) return saved
}

// The ChatGPT token stored by OpenCode pays for the voice and the backend. Kimaki never
// refreshes it (refresh tokens rotate); an expired token counts as signed out.
// voiceNotice says why the saved voice is not used.
export async function voiceCallSettings(bot: Pick<Bot, 'db' | 'token' | 'opencodeDbFile'>) {
  const [row, credential] = await Promise.all([
    bot.db.query.bot_tokens
      .findFirst({ where: { token: bot.token }, with: { settings: true } })
      .catch((cause) => new DbError({ operation: 'read voice call settings', cause })),
    chatGPTCredential({ dbFile: bot.opencodeDbFile }),
  ])
  if (row instanceof Error) return row
  if (credential instanceof Error) return credential
  if (!credential) return new NoChatGPTError()
  const saved = row?.settings?.voice_call_voice ?? null
  const parsed = saved === null ? null : parseRealtimeVoice(saved)
  if (parsed instanceof Error) {
    const voiceNotice = `saved voice ${saved} is unknown, using ${DEFAULT_LIVE_VOICE}. Run kimaki --voice <name> to change it`
    return { auth: credential, voice: DEFAULT_LIVE_VOICE, voiceNotice }
  }
  return { auth: credential, voice: parsed?.voice ?? DEFAULT_LIVE_VOICE, voiceNotice: null }
}

function parseJsonAs<T extends z.ZodType>(schema: T, text: string): z.output<T> | null {
  const parsed = errore.try(() => schema.safeParse(JSON.parse(text)))
  if (parsed instanceof Error || !parsed.success) return null
  return parsed.data
}

// Tools fail by returning { error }; null for any other result.
function toolFailedLine({ name, output }: { name: string; output: string }): string | null {
  const result = parseJsonAs(toolError, output)
  return result ? formatToolFailed({ name, message: result.error }) : null
}

// Skills of OpenCode's global config dir as a location: it has no project, so
// the list has only global skills (same rule as the global slash command catalog).
async function globalSkills(bot: Bot, directory: string) {
  const ready = await catalogReady(bot, directory)
  if (ready instanceof Error) return ready
  const listed = await oc(bot, 'skill.list', (client) => client.skill.list({ location: { directory } }))
  if (listed instanceof Error) return listed
  // Built-in skills have virtual paths like /builtin/report.md that the shell cannot read.
  const onDisk = await Promise.all(listed.data.map((skill) => fs.promises.stat(skill.path).then((stat) => stat.isFile(), () => false)))
  return listed.data.filter((_, index) => onDisk[index]).map((skill) => ({ id: skill.id, path: skill.path, description: skill.description ?? '' }))
}

// The user's global AGENTS.md and skills, read once per call so the instructions stay fixed.
// OpenCode reads the global AGENTS.md from its config dir (core/src/config/plugin/instruction.ts).
async function globalContext(bot: Bot, { configDir }: { configDir: string }) {
  const agentsPath = path.join(configDir, 'AGENTS.md')
  const [content, skills, agents] = await Promise.all([
    fs.promises
      .readFile(agentsPath, 'utf8')
      .catch((cause: NodeJS.ErrnoException) => (cause.code === 'ENOENT' ? null : new VoiceCallError({ operation: `read ${agentsPath}`, cause }))),
    globalSkills(bot, configDir),
    primaryAgents(bot, configDir),
  ])
  if (content instanceof Error) logger.warn(`global AGENTS.md`, content)
  if (skills instanceof Error) logger.warn(`global skills`, skills)
  if (agents instanceof Error) logger.warn(`global agents`, agents)
  return {
    agentsMd: typeof content === 'string' && content.trim() ? { path: agentsPath, content } : null,
    skills: skills instanceof Error ? [] : skills,
    // Same list as session threads get: the IDs kimaki send --agent takes.
    agents: agents instanceof Error ? [] : agents.map((agent) => ({ name: agent.id, description: agent.description ?? '' })),
  }
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

// Sums the 20 ms frames of all speaking users into the one stream the model hears.
// GPT-Live is full duplex, so everyone is heard at once and can interrupt it.
function createMixer() {
  const queues = new Map<string, Buffer[]>()
  return {
    push(userId: string, frame: Buffer) {
      if (frame.length !== FRAME_BYTES) return
      const queue = queues.get(userId) ?? []
      queues.set(userId, queue)
      queue.push(frame)
      if (queue.length > MAX_QUEUED_FRAMES) queue.shift()
    },
    read(): Buffer | null {
      const frames = [...queues.values()].flatMap((queue) => queue.splice(0, 1))
      if (frames.length <= 1) return frames[0] ?? null
      const mixed = Buffer.alloc(FRAME_BYTES)
      for (let offset = 0; offset < FRAME_BYTES; offset += 2) {
        const sum = frames.reduce((total, frame) => total + frame.readInt16LE(offset), 0)
        mixed.writeInt16LE(Math.max(-32_768, Math.min(32_767, sum)), offset)
      }
      return mixed
    },
  }
}

// Opus silence and DTX frames of the model are 1-3 bytes; each is still 20 ms of the timeline.
const MAX_SILENT_PAYLOAD = 3
// Packets queued before playback starts. The player reads one packet every 20 ms and plays
// silence when none is there, so without this margin network jitter becomes audible gaps.
const PREBUFFER_MS = 120
// A reply ends after this much silence; its resource then ends and the player goes idle.
const TRAILING_SILENCE_MS = 1_000

// Plays the model's Opus packets. Each reply is one resource: it starts with the first
// voiced packet, keeps the silence packets inside the reply, and ends after trailing silence.
// Barge-in needs nothing here: GPT-Live stops sending voiced packets.
function createSpeaker(connection: VoiceConnection, { onError }: { onError: (error: Error) => void }) {
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 50 } })
  connection.subscribe(player)
  player.on('error', onError)
  const reply: { stream: PassThrough | null; start: NodeJS.Timeout | null; retire: NodeJS.Timeout | null } = { stream: null, start: null, retire: null }
  // Resolved by the next voiced packet.
  const waiters: Array<() => void> = []
  const retire = () => {
    if (reply.start) clearTimeout(reply.start)
    if (reply.retire) clearTimeout(reply.retire)
    reply.stream?.end()
    reply.stream = null
    reply.start = null
    reply.retire = null
  }
  return {
    player,
    play(packet: Buffer) {
      const silent = packet.length <= MAX_SILENT_PAYLOAD
      if (!reply.stream && silent) return
      if (!reply.stream) {
        // Object mode: each write must stay one Opus packet.
        const stream = new PassThrough({ objectMode: true })
        reply.stream = stream
        reply.start = setTimeout(() => player.play(createAudioResource(stream, { inputType: StreamType.Opus })), PREBUFFER_MS)
      }
      reply.stream.write(packet)
      if (silent) return
      for (const resolve of waiters.splice(0)) resolve()
      if (reply.retire) clearTimeout(reply.retire)
      reply.retire = setTimeout(retire, TRAILING_SILENCE_MS)
    },
    // Resolves when speech that arrives after this call has played, at most after 20s.
    async played() {
      await new Promise<void>((resolve) => {
        waiters.push(resolve)
        setTimeout(resolve, 5_000)
      })
      // Playback starts PREBUFFER_MS after the first packet of a reply.
      await entersState(player, AudioPlayerStatus.Playing, 1_000).catch(() => undefined)
      await entersState(player, AudioPlayerStatus.Idle, 15_000).catch(() => undefined)
    },
    stop() {
      retire()
      player.stop(true)
    },
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
  live: LiveCall
  agent: ReturnType<typeof createVoiceAgent>
  speaker: ReturnType<typeof createSpeaker>
  mixer: ReturnType<typeof createMixer>
  // Users allowed to talk to the model (canUseKimaki), by ID.
  permitted: Map<string, Author>
  // Who spoke last, for the user transcript lines.
  lastSpeaker: Author | null
  background: Set<ChildProcess>
  // Threads that `kimaki send` started or prompted in this call.
  started: Set<string>
  // Threads whose transcript a background `kimaki send --wait` still waits for.
  waiting: Set<string>
  // end_call ran: the call ends after the final reply is spoken.
  hangup: boolean
  ending: boolean
}

export type VoiceCalls = ReturnType<typeof createVoiceCalls>

// opencodeConfigDir: OpenCode's global config dir, source of the user's AGENTS.md and skills.
export function createVoiceCalls({ opencodeConfigDir }: { opencodeConfigDir: string }) {
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

  // Errors during a call go to the log and to the text chat of the voice channel.
  function report(bot: Bot, { channelId, label, error }: { channelId: string; label: string; error: Error | string }) {
    logger.warn(label, error)
    post(bot, { channelId, text: formatError(`${label}: ${error instanceof Error ? error.message : error}`) })
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
      if (!(await canUseKimaki(bot, { guild, userId: state.id }))) continue
      const user = await bot.discord.users.fetch(state.id).catch(() => null)
      users.set(state.id, { id: state.id, username: user?.username ?? state.id })
    }
    return users
  }

  // Runs the backend on a request and has GPT-Live say the result. With a delegation ID
  // the result answers that delegation; without one (chat messages, notices) it is new speech.
  async function respond(bot: Bot, { call, text, delegationId }: { call: Call; text: string; delegationId?: string }) {
    const reply = await call.agent.run(text)
    if (call.ending) return
    if (reply instanceof Error) {
      report(bot, { channelId: call.channelId, label: 'voice backend', error: reply })
      call.live.append({ text: 'The task failed. Tell the users it did not complete.', channel: 'speakable', delegationId })
      return
    }
    // Web search citations like ([npmjs.com](https://...)) must not be read aloud.
    const spoken = reply.replace(/\s*\(\[[^\]]*\]\([^)]*\)\)/g, '').trim()
    if (spoken) call.live.append({ text: spoken, channel: 'speakable', delegationId })
    if (!call.hangup) return
    await call.speaker.played()
    // The users may have left meanwhile; a new call in the guild must not end.
    if (call.ending) return
    await end(bot, { guildId: call.guildId, reason: 'the assistant hung up' })
  }

  // Context both models keep without answering now.
  function inform(call: Call, text: string) {
    call.agent.note(text)
    call.live.append({ text, channel: 'commentary' })
  }

  // The instructions keep the users of the call start (prompt cache); changes come as context.
  function announceUsers(call: Call) {
    const users = [...call.permitted.values()]
    const list = users.map((user) => `${user.username} (${user.id})`).join(', ')
    const args = users.map((user) => `--user '${user.id}'`).join(' ')
    inform(call, `<system>The users in the call are now: ${list}. Pass ${args} to kimaki send.</system>`)
  }

  function onLive(bot: Bot, { call, event }: { call: Call; event: LiveEvent }) {
    if (call.ending) return
    if (event.type === 'delegation') {
      logger.info(`delegation ${event.id}: ${event.text.slice(0, 300)}`)
      // The delegation can come without text; the transcripts in the backend history have the request.
      const text = event.text || '<system>The voice model handed you the latest user request. Do it, using the transcript.</system>'
      return void respond(bot, { call, text, delegationId: event.id })
    }
    if (event.type === 'error') return report(bot, { channelId: call.channelId, label: 'model error', error: event.message })
    if (event.type === 'closed') return void end(bot, { guildId: call.guildId, reason: `the model connection closed (${event.reason})` })
    if (!event.text) return
    const speaker = event.role === 'user' ? (call.lastSpeaker?.username ?? 'voice') : 'voice assistant'
    // The backend sees the conversation, so a later "yes, do that" has its context.
    call.agent.note(`<transcript speaker="${speaker}">${event.text}</transcript>`)
    if (event.role === 'user') post(bot, { channelId: call.channelId, text: formatEcho({ username: speaker, text: event.text }) })
    else post(bot, { channelId: call.channelId, text: event.text, markdown: true })
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
  // The full output is streamed to a temp file, kept only when the output was truncated.
  // onLine gets each stdout line as it arrives, before the command ends.
  function runShell(bot: Bot, { call, command, timeoutMs, onLine }: { call: Call; command: string; timeoutMs: number; onLine?: (line: string) => void }) {
    const file = path.join(os.tmpdir(), `kimaki-voice-shell-${crypto.randomBytes(6).toString('hex')}.txt`)
    const full = fs.createWriteStream(file)
    full.on('error', (error) => logger.warn(`shell output file ${file}`, error))
    return new Promise<{ exitCode: number | null; output: string }>((resolve) => {
      // Own process group: a timeout or hangup kills the pipeline, not only /bin/sh.
      const child = spawn('/bin/sh', ['-c', command], { cwd: bot.dataDir, env: shellEnv(bot, call), stdio: ['ignore', 'pipe', 'pipe'], detached: true })
      call.background.add(child)
      const output = { text: '', total: 0, fileBytes: 0 }
      const append = (chunk: Buffer) => {
        const room = OUTPUT_FILE_LIMIT - output.fileBytes
        if (room > 0) full.write(chunk.subarray(0, room))
        output.fileBytes += Math.min(chunk.length, Math.max(room, 0))
        const text = chunk.toString('utf8')
        output.total += text.length
        output.text = (output.text + text).slice(-OUTPUT_LIMIT)
      }
      const lines = { pending: '' }
      child.stdout.on('data', (chunk: Buffer) => {
        append(chunk)
        if (!onLine) return
        const parts = (lines.pending + chunk.toString('utf8')).split('\n')
        lines.pending = parts.pop() ?? ''
        for (const line of parts) onLine(line)
      })
      child.stderr.on('data', append)
      const timer = setTimeout(() => {
        append(Buffer.from(`\n[killed after ${Math.round(timeoutMs / 1000)}s]`))
        killGroup(child)
      }, timeoutMs)
      child.on('error', (error) => append(Buffer.from(`\n${error.message}`)))
      child.on('close', (code) => {
        clearTimeout(timer)
        call.background.delete(child)
        if (onLine && lines.pending) onLine(lines.pending)
        const truncated = output.total - output.text.length
        full.end(() => {
          if (truncated === 0) {
            fs.promises.rm(file, { force: true }).catch((error: Error) => logger.warn(`remove ${file}`, error))
            resolve({ exitCode: code, output: output.text })
            return
          }
          // Say what was truncated and where the rest is, so the model greps it instead of trusting a partial answer.
          const saved = output.fileBytes === OUTPUT_FILE_LIMIT ? `the first 10 MB of the output in ${file}` : `full output in ${file}`
          resolve({ exitCode: code, output: `[output truncated: first ${truncated} characters omitted; ${saved}, use grep or sed on it]\n${output.text}` })
        })
      })
    })
  }

  function tools(bot: Bot, { call }: { call: () => Call }): Record<string, AgentTool> {
    return {
      shell: {
        description: 'Run a shell command with the kimaki CLI on PATH. Returns the exit code and the last 4000 characters of output.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The command, e.g. kimaki session list --all --active' },
            background: { type: 'boolean', description: 'Return at once; the output arrives later in a <background-command> message. Use it for slow commands like kimaki send --wait and kimaki session wait.' },
            timeoutSeconds: { type: 'number', description: 'Default 120. Background commands default to 1800.' },
          },
          required: ['command'],
        },
        async execute(args) {
          const parsed = shellArgs.safeParse(args)
          if (!parsed.success) return { error: parsed.error.issues.map((issue) => issue.message).join('; ') }
          const input = parsed.data
          const current = call()
          const background = input.background === true
          const timeoutMs = input.timeoutSeconds ? input.timeoutSeconds * 1000 : background ? BACKGROUND_TIMEOUT_MS : SHELL_TIMEOUT_MS
          const started = /\s--(thread|session)\b/.test(input.command) ? 'prompt sent to' : 'session started in'
          const waits = /\s--wait\b/.test(input.command)
          const sent: string[] = []
          // Streamed, so `kimaki send --wait` in the background shows its thread before the session ends.
          const onLine = /\bkimaki\s+send\b/.test(input.command)
            ? (line: string) => {
                // `kimaki send` prints one JSON line per send.
                const threadId = parseJsonAs(sendResult, line)?.threadId
                if (!threadId || current.ending) return
                sent.push(threadId)
                current.started.add(threadId)
                if (waits) current.waiting.add(threadId)
                post(bot, { channelId: current.channelId, text: asSubtext(`⬦ ${started} <#${threadId}>`) })
              }
            : undefined
          const run = runShell(bot, { call: current, command: input.command, timeoutMs, onLine }).then((result) => {
            for (const threadId of sent) current.waiting.delete(threadId)
            return result
          })
          if (!background) return run
          void run.then(({ exitCode, output }) => {
            if (current.ending) return
            // A null exit code means a signal killed it (timeout or hangup).
            const finished = formatShellFinished({ description: input.command, state: exitCode === null ? 'killed' : null, exit: exitCode })
            post(bot, { channelId: current.channelId, text: finished })
            void respond(bot, { call: current, text: `<background-command exit-code="${exitCode}">\n$ ${input.command}\n${output}\n</background-command>` })
          })
          return { started: true }
        },
      },
      post_message: {
        description: 'Post markdown in the text chat of this voice channel: links, IDs, lists, code. The users see the text as is, so write only the content, with no intro like "Here is the link".',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string', description: 'Only the content, e.g. "[Signup fix thread](https://discord.com/channels/...)" or a short list' } },
          required: ['text'],
        },
        execute(args) {
          const parsed = postArgs.safeParse(args)
          if (!parsed.success) return { error: parsed.error.issues.map((issue) => issue.message).join('; ') }
          post(bot, { channelId: call().channelId, text: parsed.data.text, markdown: true })
          return { posted: true }
        },
      },
      end_call: {
        description: 'Leave the voice call after your final reply is spoken. Make that reply a short goodbye.',
        parameters: { type: 'object', properties: {} },
        execute() {
          call().hangup = true
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
      call.lastSpeaker = user
      // start fires again after 100ms of silence while the subscription (400ms) is still open.
      if (receiver.subscriptions.has(userId)) return
      const opus = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: SPEECH_END_MS } })
      const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 })
      decoder.on('data', (pcm: Buffer) => call.mixer.push(userId, pcm))
      // pipeline() destroys the decoder (and frees its codec) when the receive stream closes.
      pipeline(opus, decoder, (error) => {
        if (error && !call.ending) report(bot, { channelId: call.channelId, label: `audio stream of ${user.username}`, error })
      })
    })
  }

  async function start(bot: Bot, { guild, channelId, users }: { guild: Guild; channelId: string; users: Map<string, Author> }) {
    const settings = await voiceCallSettings(bot)
    if (settings instanceof Error) {
      logger.warn(`voice call not started`, settings)
      post(bot, { channelId, text: formatError(settings.message) })
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
    const [projects, context] = await Promise.all([listProjects({ db: bot.db }), globalContext(bot, { configDir: opencodeConfigDir })])
    if (projects instanceof Error) logger.warn(`voice call projects`, projects)
    const callContext: VoiceCallContext = {
      users: [...users.values()],
      projects: (projects instanceof Error ? [] : projects).map((project) => ({
        channelId: project.channel_id,
        channelName: guild.channels.cache.get(project.channel_id)?.name ?? project.channel_id,
        directory: project.directory,
      })),
      guildId: guild.id,
      voiceChannelId: channelId,
      dataDir: bot.dataDir,
      agentsMd: context.agentsMd,
      skills: context.skills,
      agents: context.agents,
    }
    const holder: { call: Call | null } = { call: null }
    const speaker = createSpeaker(connection, { onError: (error) => report(bot, { channelId, label: 'audio player', error }) })
    const mixer = createMixer()
    const agent = createVoiceAgent({
      auth: settings.auth,
      url: bot.realtimeBaseUrls.responses,
      instructions: voiceCallInstructions(callContext),
      tools: tools(bot, { call: () => holder.call! }),
      // Same tool line as in session threads. A posted message shows itself; a failed post still gets its failure line.
      onToolCall: ({ name, args }) => {
        if (name !== 'post_message') post(bot, { channelId, text: formatToolLine({ name, input: parseJsonAs(toolInput, args) ?? {} }) })
      },
      onToolResult: (result) => {
        const failed = toolFailedLine(result)
        if (failed) post(bot, { channelId, text: failed })
      },
    })
    const live = await startLiveCall({
      auth: settings.auth,
      voice: settings.voice,
      instructions: liveCallInstructions(callContext),
      urls: { calls: bot.realtimeBaseUrls.calls ?? DEFAULT_LIVE_URLS.calls, sideband: bot.realtimeBaseUrls.sideband ?? DEFAULT_LIVE_URLS.sideband },
      readFrame: mixer.read,
      onOpus: speaker.play,
      onEvent: (event) => {
        if (holder.call) onLive(bot, { call: holder.call, event })
      },
    })
    if (live instanceof Error) {
      logger.error(`voice call`, live)
      post(bot, { channelId, text: formatError(live.message) })
      speaker.stop()
      connection.destroy()
      return
    }
    const call: Call = {
      guildId: guild.id,
      channelId,
      connection,
      live,
      agent,
      speaker,
      mixer,
      permitted: users,
      lastSpeaker: null,
      background: new Set(),
      started: new Set(),
      waiting: new Set(),
      hangup: false,
      ending: false,
    }
    holder.call = call
    calls.set(guild.id, call)
    connection.on(VoiceConnectionStatus.Disconnected, () => {
      // Discord moves or reconnects: wait shortly, else the call is over (V1 behavior).
      void Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]).catch(() => end(bot, { guildId: guild.id, reason: 'disconnected from Discord voice' }))
    })
    connection.on(VoiceConnectionStatus.Destroyed, () => void end(bot, { guildId: guild.id, reason: null }))
    connection.on('error', (error) => report(bot, { channelId, label: 'voice connection', error }))
    if (process.env['KIMAKI_VOICE_DEBUG']) {
      connection.on('debug', (message) => logger.info(`voice debug: ${message}`))
      connection.on('stateChange', (before, after) => logger.info(`voice connection ${before.status} -> ${after.status}`))
      connection.receiver.speaking.on('start', (userId) => logger.info(`speaking start ${userId}`))
      speaker.player.on('stateChange', (before, after) => logger.info(`player ${before.status} -> ${after.status}`))
    }
    listen(bot, call)
    logger.info(`voice call started in ${channelId}, voice ${settings.voice}`)
    post(bot, { channelId, text: `-# ⬦ voice call started ⋅ gpt-live ⋅ ${settings.voice}` })
    if (settings.voiceNotice) post(bot, { channelId, text: asSubtext(`⬦ ${settings.voiceNotice}`) })
    live.append({ text: 'The call started. Greet the users by name in one short sentence.', channel: 'speakable' })
  }

  async function end(bot: Bot, { guildId, reason }: { guildId: string; reason: string | null }) {
    const call = calls.get(guildId)
    if (!call || call.ending) return
    call.ending = true
    calls.delete(guildId)
    call.agent.stop()
    for (const child of call.background) killGroup(child)
    await call.live.close()
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

  // A thread of any project finished: tell the call of its guild, so nobody polls.
  async function notifyRunEnded(bot: Bot, { threadId, sessionId, error }: RunEnded) {
    if (calls.size === 0) return
    const thread = await bot.discord.channels.fetch(threadId).catch((cause) => new VoiceCallError({ operation: `fetch thread ${threadId}`, cause }))
    if (thread instanceof Error) return logger.warn(`thread finished notice`, thread)
    if (!thread?.isThread()) return
    const call = calls.get(thread.guildId)
    if (!call || call.ending) return
    const url = `https://discord.com/channels/${thread.guildId}/${threadId}`
    const state = error === null ? 'finished' : 'failed'
    post(bot, { channelId: call.channelId, text: asSubtext(`⬦ thread ${state}: ${thread.name} ⋅ ${url} ⋅ ${sessionId}`) })
    const failure = error === null ? '' : ` Error: ${error}`
    const notice = `<system>Thread ${state}: "${thread.name}". Thread ID ${threadId}, session ID ${sessionId}, URL ${url}.${failure}</system>`
    // Answer only for threads started in this call. A pending kimaki send --wait brings the transcript next.
    if (call.started.has(threadId) && !call.waiting.has(threadId)) return void respond(bot, { call, text: notice })
    inform(call, notice)
  }

  const listener: { current: ((before: VoiceState, after: VoiceState) => void) | null } = { current: null }
  // Set by register(); runs end before it only while no call exists.
  const registered: { bot: Bot | null } = { bot: null }

  return {
    register(bot: Bot) {
      registered.bot = bot
      listener.current = (before, after) => void serialize(after.guild.id, () => onVoiceState(bot, { before, after }))
      bot.discord.on(Events.VoiceStateUpdate, listener.current)
    },
    runEnded(run: RunEnded) {
      if (registered.bot) void notifyRunEnded(registered.bot, run)
    },
    // A message in the text chat of a voice channel: to the backend, if a call runs there.
    text(bot: Bot, { guildId, channelId, author, content }: { guildId: string; channelId: string; author: Author; content: string }) {
      const call = calls.get(guildId)
      if (!call || call.channelId !== channelId || call.ending || !content.trim()) return
      void respond(bot, { call, text: `<chat-message from="${author.username}" user-id="${author.id}">\n${content}\n</chat-message>` })
    },
    async stop(bot: Bot) {
      if (listener.current) bot.discord.off(Events.VoiceStateUpdate, listener.current)
      // A call may be starting: let queued voice state work finish first.
      await Promise.all(chains.values())
      await Promise.all([...calls.keys()].map((guildId) => end(bot, { guildId, reason: 'Kimaki stopped' })))
    },
  }
}
