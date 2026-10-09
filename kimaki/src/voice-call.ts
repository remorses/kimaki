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
  type AudioResource,
  type VoiceConnection,
} from '@discordjs/voice'
import { API } from '@discordjs/core/http-only'
import { gemini, openai, RealtimeSession, resample, xai, type Adapter, type AudioSink, type OutputAudio, type Tool } from '@kimaki/realtime'
import { Events, type Guild, type VoiceState } from 'discord.js'
import * as errore from 'errore'
import prism from 'prism-media'
import { z } from 'zod'

import { oc, type Author, type Bot } from './bot.ts'
import { DbError } from './errors.ts'
import type { RunEnded } from './event-loop.ts'
import { asSubtext, formatError, formatShellFinished, formatToolFailed, formatToolLine } from './format-parts.ts'
import { canUseKimaki } from './ingress.ts'
import { createLogger } from './logger.ts'
import { addVoiceChannel, listProjects } from './project.ts'
import { formatEcho } from './queue.ts'
import * as schema from './schema.ts'
import { catalogReady } from './sessions.ts'
import { voiceCallInstructions } from './system-prompt.ts'

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
const searchArgs = z.object({ query: z.string({ error: 'query must be a string' }).trim().min(1, { error: 'query must not be empty' }) })
const postArgs = z.object({ text: z.string({ error: 'text must be a string' }).trim().min(1, { error: 'text must not be empty' }) })
const toolInput = z.record(z.string(), z.json())
const toolError = z.object({ error: z.string() })
// One line of `kimaki send` output.
const sendResult = z.object({ threadId: z.string() })
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

const REALTIME_PROVIDERS = ['openai', 'xai', 'gemini'] as const
type RealtimeProvider = (typeof REALTIME_PROVIDERS)[number]

const PROVIDER_NAMES: Record<RealtimeProvider, string> = { openai: 'OpenAI', xai: 'xAI', gemini: 'Gemini' }

// Built-in voices of each realtime API. No name repeats across providers, so a voice picks its provider.
// OpenAI: the list in the error of session.update with an unknown voice (gpt-realtime-2.1, 2026-10).
// xAI: KnownVoiceId in https://github.com/xai-org/xai-sdk-ts/blob/main/src/generated/voice.ts
// Gemini: Live takes the TTS voices, https://ai.google.dev/gemini-api/docs/speech-generation#voices
export const REALTIME_VOICES: Record<RealtimeProvider, readonly string[]> = {
  openai: ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'],
  xai: [
    'eve', 'ara', 'rex', 'sal', 'leo', 'altair', 'atlas', 'aurora', 'carina', 'castor', 'celeste', 'cosmo', 'helios', 'helix',
    'iris', 'kepler', 'liora', 'lumen', 'luna', 'lux', 'naksh', 'orion', 'perseus', 'rigel', 'sirius', 'ursa', 'zagan', 'zenith',
  ],
  gemini: [
    'Puck', 'Zephyr', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel',
    'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima',
    'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
  ],
}

// Sent when no voice is saved: OpenAI's own default, xAI's documented default, Gemini's documented default.
export const DEFAULT_REALTIME_VOICES: Record<RealtimeProvider, string> = { openai: 'marin', xai: 'eve', gemini: 'Puck' }

export class UnknownVoiceError extends errore.createTaggedError({
  name: 'UnknownVoiceError',
  message: 'Unknown voice "$voice". Pass one of: $voices. Use --voice default to reset',
}) {}

// Case-insensitive; returns the canonical name of the voice and its provider.
export function parseRealtimeVoice(name: string): UnknownVoiceError | { provider: RealtimeProvider; voice: string } {
  const wanted = name.trim().toLowerCase()
  for (const provider of REALTIME_PROVIDERS) {
    const voice = REALTIME_VOICES[provider].find((candidate) => candidate.toLowerCase() === wanted)
    if (voice) return { provider, voice }
  }
  const voices = REALTIME_PROVIDERS.map((provider) => `${PROVIDER_NAMES[provider]} ${REALTIME_VOICES[provider].join(', ')}`).join('; ')
  return new UnknownVoiceError({ voice: name, voices })
}

// The --voice start flag: a voice saves it, "default" clears it.
export async function saveVoiceCallVoice({ db, appId, voice }: { db: Bot['db']; appId: string; voice: string | null }): Promise<DbError | void> {
  const saved = await db.insert(schema.bot_settings).values({ app_id: appId, voice_call_voice: voice })
    .onConflictDoUpdate({ target: schema.bot_settings.app_id, set: { voice_call_voice: voice } })
    .then(() => undefined)
    .catch((cause) => new DbError({ operation: 'write bot_settings', cause }))
  if (saved instanceof Error) return saved
}

// Same keys as voice transcription (bot_api_keys, then env), best first. OpenAI
// has the most reliable tool calls. Its realtime API only takes function and MCP
// tools, so web search is our web_search function (searchKey); xAI and Gemini search server-side.
// https://developers.openai.com/api/docs/guides/realtime-mcp
// A saved voice (kimaki --voice) moves its provider first when that key is set.
// voiceNotice says why the saved voice is not used.
export async function realtimeModel(bot: Pick<Bot, 'db' | 'token' | 'realtimeBaseUrls'>): Promise<
  DbError | NoRealtimeKeyError | { adapter: Adapter; voice: string; voiceNotice: string | null; builtinSearch: string; searchKey: string | null }
> {
  const row = await bot.db.query.bot_tokens
    .findFirst({ where: { token: bot.token }, with: { api_keys: true, settings: true } })
    .catch((cause) => new DbError({ operation: 'read realtime keys', cause }))
  if (row instanceof Error) return row
  const keys = row?.api_keys
  const available = [
    { provider: 'openai' as const, key: keys?.openai_api_key || process.env['OPENAI_API_KEY'] },
    { provider: 'xai' as const, key: keys?.xai_api_key || process.env['XAI_API_KEY'] },
    { provider: 'gemini' as const, key: keys?.gemini_api_key || process.env['GEMINI_API_KEY'] },
  ].flatMap(({ provider, key }) => (key ? [{ provider, key }] : []))
  const savedName = row?.settings?.voice_call_voice ?? null
  const parsed = savedName === null ? null : parseRealtimeVoice(savedName)
  const saved = parsed instanceof Error ? null : parsed
  const chosen = available.find((entry) => entry.provider === saved?.provider) ?? available[0]
  if (!chosen) return new NoRealtimeKeyError()
  const voice = saved?.provider === chosen.provider ? saved.voice : DEFAULT_REALTIME_VOICES[chosen.provider]
  const voiceNotice = (() => {
    if (parsed instanceof Error) return `saved voice ${savedName} is unknown, using ${voice}. Run kimaki --voice <name> to change it`
    if (!saved || saved.provider === chosen.provider) return null
    return `voice ${saved.voice} needs a ${PROVIDER_NAMES[saved.provider]} key, using ${voice}`
  })()
  const shared = { voice, voiceNotice }
  if (chosen.provider === 'openai') {
    return { ...shared, adapter: openai({ apiKey: chosen.key, baseUrl: bot.realtimeBaseUrls.openai }), builtinSearch: 'web_search', searchKey: chosen.key }
  }
  if (chosen.provider === 'xai') {
    const builtinTools = [{ type: 'web_search' }, { type: 'x_search' }]
    return { ...shared, adapter: xai({ apiKey: chosen.key, builtinTools, baseUrl: bot.realtimeBaseUrls.xai }), builtinSearch: 'web_search and x_search', searchKey: null }
  }
  return { ...shared, adapter: gemini({ apiKey: chosen.key, builtinTools: [{ googleSearch: {} }] }), builtinSearch: 'Google Search', searchKey: null }
}

const SEARCH_MODEL = 'gpt-5.5'

type ResponsesOutput = {
  output?: Array<{
    type?: string
    content?: Array<{ type?: string; text?: string; annotations?: Array<{ type?: string; url?: string }> }>
  }>
}

// OpenAI web search through the Responses API, for the web_search tool of OpenAI calls.
// Low reasoning keeps it to a few seconds. https://developers.openai.com/api/docs/guides/tools-web-search
async function searchWeb({ apiKey, baseUrl, query }: { apiKey: string; baseUrl: string; query: string }) {
  const response = await fetch(`${baseUrl}/responses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: SEARCH_MODEL,
      reasoning: { effort: 'low' },
      tools: [{ type: 'web_search' }],
      instructions: 'Answer in a few short sentences that will be read aloud. No markdown.',
      input: query,
    }),
    signal: AbortSignal.timeout(60_000),
  }).catch((cause) => new VoiceCallError({ operation: 'web search', cause }))
  if (response instanceof Error) return response
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    return new VoiceCallError({ operation: `web search (HTTP ${response.status}: ${body.slice(0, 300)})` })
  }
  const data = await (response.json() as Promise<ResponsesOutput>).catch((cause) => new VoiceCallError({ operation: 'web search', cause }))
  if (data instanceof Error) return data
  const parts = (data.output ?? []).filter((item) => item.type === 'message').flatMap((item) => item.content ?? [])
  // Inline citations like ([npmjs.com](https://...)) would be read aloud; the URLs are in sources.
  const answer = parts.map((part) => part.text ?? '').join('').replace(/\s*\(\[[^\]]*\]\([^)]*\)\)/g, '').trim()
  const sources = [...new Set(parts.flatMap((part) => part.annotations ?? []).flatMap((a) => (a.type === 'url_citation' && a.url ? [a.url] : [])))]
  return { answer, sources: sources.slice(0, 5) }
}

function parseJsonAs<T extends z.ZodType>(schema: T, text: string): z.output<T> | null {
  const parsed = errore.try(() => schema.safeParse(JSON.parse(text)))
  if (parsed instanceof Error || !parsed.success) return null
  return parsed.data
}

// Same tool line as in session threads, from the JSON arguments of the model.
function toolCallLine({ name, args }: { name: string; args: string }): string {
  return formatToolLine({ name, input: parseJsonAs(toolInput, args) ?? {} })
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
  const [content, skills] = await Promise.all([
    fs.promises
      .readFile(agentsPath, 'utf8')
      .catch((cause: NodeJS.ErrnoException) => (cause.code === 'ENOENT' ? null : new VoiceCallError({ operation: `read ${agentsPath}`, cause }))),
    globalSkills(bot, configDir),
  ])
  if (content instanceof Error) logger.warn(`global AGENTS.md`, content)
  if (skills instanceof Error) logger.warn(`global skills`, skills)
  return {
    agentsMd: typeof content === 'string' && content.trim() ? { path: agentsPath, content } : null,
    skills: skills instanceof Error ? [] : skills,
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
function createSpeaker(connection: VoiceConnection, { onError }: { onError: (error: Error) => void }) {
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 50 } })
  connection.subscribe(player)
  const playing: { current: { stream: PassThrough; resource: AudioResource } | null } = { current: null }
  player.on(AudioPlayerStatus.Idle, () => {
    playing.current = null
  })
  player.on('error', onError)
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
    player,
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
  // Threads that `kimaki send` started or prompted in this call.
  started: Set<string>
  // Threads whose transcript a background `kimaki send --wait` still waits for.
  waiting: Set<string>
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
      if (!(await canUseKimaki({ guild, userId: state.id }))) continue
      const user = await bot.discord.users.fetch(state.id).catch(() => null)
      users.set(state.id, { id: state.id, username: user?.username ?? state.id })
    }
    return users
  }

  // Posts finished transcripts and tool lines the chat does not show yet, in session order.
  function postTranscripts(bot: Bot, call: Call) {
    const messages = call.session.view().messages
    for (const [index, message] of messages.entries()) {
      if (call.posted.has(index)) continue
      if (message.kind === 'summary') {
        call.posted.add(index)
        continue
      }
      if (message.kind === 'tool') {
        call.posted.add(index)
        post(bot, { channelId: call.channelId, text: toolCallLine(message) })
        continue
      }
      // Text before a tool call is complete, and its line must come before the tool line.
      const finished = message.done || (message.kind === 'assistant' && messages.slice(index + 1).some((next) => next.kind === 'tool'))
      if (!finished) continue
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

  function tools(bot: Bot, { call, searchKey }: { call: () => Call; searchKey: string | null }): Record<string, Tool> {
    const webSearch: Record<string, Tool> = searchKey
      ? {
          web_search: {
            description: 'Search the web for current information. Returns a short answer and source URLs. Post the URLs with post_message if the users want them.',
            parameters: { type: 'object', properties: { query: { type: 'string', description: 'What to find out, as a full question' } }, required: ['query'] },
            async execute(args) {
              const parsed = searchArgs.safeParse(args)
              if (!parsed.success) return { error: parsed.error.issues.map((issue) => issue.message).join('; ') }
              const result = await searchWeb({ apiKey: searchKey, baseUrl: bot.transcriptionBaseUrls.openai ?? 'https://api.openai.com/v1', query: parsed.data.query })
              if (result instanceof Error) {
                logger.warn(`web search`, result)
                return { error: result.message }
              }
              return result
            },
          },
        }
      : {}
    return {
      ...webSearch,
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
        if (ended instanceof Error) report(bot, { channelId: call.channelId, label: 'end of speech', error: ended })
      }
      // pipeline() destroys the decoder (and frees its codec) when the receive stream closes.
      pipeline(opus, decoder, (error) => {
        if (error && !call.ending) report(bot, { channelId: call.channelId, label: `audio stream of ${user.username}`, error })
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
    const [projects, context] = await Promise.all([listProjects({ db: bot.db }), globalContext(bot, { configDir: opencodeConfigDir })])
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
      agentsMd: context.agentsMd,
      skills: context.skills,
    })
    const speaker = createSpeaker(connection, { onError: (error) => report(bot, { channelId, label: 'audio player', error }) })
    const holder: { call: Call | null } = { call: null }
    const session = new RealtimeSession({
      model: model.adapter,
      voice: model.voice,
      instructions,
      tools: tools(bot, { call: () => holder.call!, searchKey: model.searchKey }),
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
      started: new Set(),
      waiting: new Set(),
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
      if (event.type === 'response.done' || event.type === 'tool.call' || (event.type === 'input.text' && event.final)) postTranscripts(bot, call)
      if (event.type === 'error') report(bot, { channelId, label: `model error${event.code ? ` (${event.code})` : ''}`, error: event.message })
      if (event.type === 'tool.builtin') post(bot, { channelId, text: toolCallLine(event) })
      const failed = event.type === 'tool.result' ? toolFailedLine(event) : null
      if (failed) post(bot, { channelId, text: failed })
      // Subscribed after the first connect: every start is a reconnect.
      if (event.type === 'session.started') post(bot, { channelId, text: asSubtext('⬦ reconnected to the model') })
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
    connection.on('error', (error) => report(bot, { channelId, label: 'voice connection', error }))
    if (process.env['KIMAKI_VOICE_DEBUG']) {
      connection.on('debug', (message) => logger.info(`voice debug: ${message}`))
      connection.on('stateChange', (before, after) => logger.info(`voice connection ${before.status} -> ${after.status}`))
      connection.receiver.speaking.on('start', (userId) => logger.info(`speaking start ${userId}`))
      speaker.player.on('stateChange', (before, after) => logger.info(`player ${before.status} -> ${after.status}`))
      speaker.player.on('debug', (message) => logger.info(`player debug: ${message}`))
      session.subscribe((event) => {
        if (event.type !== 'output.audio') logger.info(`realtime ${JSON.stringify(event).slice(0, 300)}`)
      })
    }
    listen(bot, call)
    logger.info(`voice call started in ${channelId} with ${model.adapter.provider} ${model.adapter.model}, voice ${model.voice}`)
    post(bot, { channelId, text: `-# ⬦ voice call started ⋅ ${model.adapter.model} ⋅ ${model.voice}` })
    if (model.voiceNotice) post(bot, { channelId, text: asSubtext(`⬦ ${model.voiceNotice}`) })
    const greeted = sendHidden(call, '<system>The call started. Greet the users by name in one short sentence.</system>')
    if (greeted instanceof Error) report(bot, { channelId, label: 'greeting', error: greeted })
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
    const respond = call.started.has(threadId) && !call.waiting.has(threadId)
    const sent = call.session.sendText(notice, { respond })
    if (sent instanceof Error) return logger.warn(`thread finished notice`, sent)
    call.posted.add(call.session.view().messages.length - 1)
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
