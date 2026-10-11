// E2E harness (spec 28.2.1). Each test file gets its own OpenCode service in a
// temp root with private XDG dirs and SQLite DB, started with the same
// `serve --service` command the user's service uses, so the bot connects
// through Service.discover() exactly like production. The bot runs in-process
// against discord-digital-twin.

import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'
import { createClient } from '@libsql/client'
import { OpenCode, type OpenCodeClient } from '@opencode/client'
import { Service } from '@opencode/client/service'
import { ChannelType, ComponentType, type APIMessage } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import {
  buildDeterministicOpencode2Config,
  type DeterministicMatcher,
} from 'opencode-deterministic-provider'

import { disabledAnalytics, type Analytics } from '../analytics.ts'
import { GATEWAY_APP_ID, saveCredentials, type Credentials } from '../credentials.ts'
import { openDb, verbosityToV1, type Verbosity } from '../db.ts'
import type { ToolInput } from '../format-parts.ts'
import * as schema from '../schema.ts'
import { startLockServer } from '../lock-server.ts'
import { startBot, type BotHandle } from '../main.ts'
import type { LockRouteInput, LockRouteName } from '../lock-routes.ts'
import { listTasks, type Clock } from '../scheduler.ts'
import type { RealtimeBaseUrls } from '../voice-call.ts'

export const TEST_MODEL = 'deterministic-v2'

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address !== 'object') {
        reject(new Error('no port'))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

// The real native binary. node_modules/.bin/opencode is a sh wrapper that
// survives SIGTERM and orphans the server.
export function opencodeBinary(): string {
  const require = createRequire(import.meta.url)
  const packageJsonPath = require.resolve('@opencode/cli/package.json')
  return path.join(path.dirname(packageJsonPath), 'bin/opencode.exe')
}

export type OpencodeTestServer = {
  root: string
  serviceFile: string
  // Global OpenCode config dir of this server (XDG_CONFIG_HOME/opencode).
  configDir: string
  // OpenCode's SQLite file of this server (XDG_DATA_HOME/opencode/opencode.db).
  dbFile: string
  projectDirectory: string
  // User skill folder (~/.agents/skills of the test HOME). It exists at start, so OpenCode watches it.
  skillsDirectory: string
  client: () => Promise<OpenCodeClient>
  kill: () => Promise<void>
  start: () => Promise<void>
  stop: () => Promise<void>
}

export async function startOpencodeTestServer({
  matchers = [],
  permissions = [],
  commands = {},
  models = {},
  agents = {},
  mcp,
  plugins = [],
}: {
  matchers?: DeterministicMatcher[]
  // OpenCode commands (`/name args` in Discord), e.g. { review: { template: 'Review: $ARGUMENTS' } }.
  commands?: Record<string, { template: string; description?: string }>
  // Appended after the allow-all rules: the last matching rule wins.
  permissions?: Array<{ action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }>
  // More deterministic models next to TEST_MODEL, e.g. with thinking variants.
  models?: Record<string, { name: string; variants?: Array<{ id: string }> }>
  // Agent overrides and custom agents (config `agents`).
  agents?: Record<string, { description?: string; mode?: 'primary' | 'subagent' | 'all'; hidden?: boolean; model?: string }>
  // MCP servers (config `mcp.servers`).
  mcp?: { servers: Record<string, { type: 'local'; command: string[] }> }
  plugins?: string[]
} = {}): Promise<OpencodeTestServer> {
  // realpath: macOS tmpdir is /var/... but OpenCode resolves /private/var/...
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-e2e-')))
  const projectDirectory = path.join(root, 'project')
  fs.mkdirSync(projectDirectory, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: projectDirectory })
  const serviceFile = path.join(root, 'state', 'opencode', 'service.json')
  const config = buildDeterministicOpencode2Config({
    model: TEST_MODEL,
    settings: { strict: false, matchers },
    permissions: [
      { action: 'shell', resource: '*', effect: 'allow' },
      { action: 'edit', resource: '*', effect: 'allow' },
      ...permissions,
    ],
  })
  // No provider keys: the model catalog must not depend on the developer's env.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('OPENCODE_') && !key.endsWith('_API_KEY')),
  )
  const env = {
    ...inherited,
    HOME: path.join(root, 'home'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    OPENCODE_TEST_HOME: path.join(root, 'home'),
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...config,
      providers: Object.fromEntries(
        Object.entries(config.providers).map(([id, provider]) => [id, { ...provider, models: { ...provider.models, ...models } }]),
      ),
      commands,
      agents,
      // The Kimaki plugin is not listed: the bot writes plugins/kimaki/ into
      // configDir on start, the same path as production.
      plugins: plugins.map((plugin) => pathToFileURL(plugin).href),
      ...(mcp && { mcp }),
    }),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
  } satisfies NodeJS.ProcessEnv
  for (const key of ['HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'] as const) {
    fs.mkdirSync(env[key], { recursive: true })
  }
  const skillsDirectory = path.join(env.HOME, '.agents', 'skills')
  fs.mkdirSync(skillsDirectory, { recursive: true })

  const current: { child: ChildProcess | null } = { child: null }

  async function start() {
    // A fresh port per start, like a restarted or upgraded user service.
    const port = await freePort()
    current.child = spawn(
      opencodeBinary(),
      ['serve', '--service', '--port', String(port), '--hostname', '127.0.0.1'],
      { env, stdio: 'ignore' },
    )
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const endpoint = await Service.discover({ file: serviceFile }).catch(() => undefined)
      if (endpoint?.url.endsWith(`:${port}`)) return
      await sleep(100)
    }
    throw new Error(`OpenCode test server did not register in ${serviceFile}`)
  }

  async function kill() {
    const child = current.child
    current.child = null
    if (!child || child.exitCode !== null) return
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGTERM')
    await Promise.race([exited, sleep(5_000).then(() => child.kill('SIGKILL'))])
  }

  async function client() {
    const endpoint = await Service.discover({ file: serviceFile })
    if (!endpoint) throw new Error('OpenCode test server is not running')
    return OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
  }

  await start()
  return {
    root,
    serviceFile,
    configDir: path.join(env.XDG_CONFIG_HOME, 'opencode'),
    dbFile: path.join(env.XDG_DATA_HOME, 'opencode', 'opencode.db'),
    projectDirectory,
    skillsDirectory,
    client,
    kill,
    start,
    stop: async () => {
      await kill()
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

// One throwaway turn so the first real test does not pay OpenCode cold start
// (config, agents, provider load) inside Discord waits.
export async function warmUp({ server }: { server: OpencodeTestServer }): Promise<void> {
  const client = await server.client()
  const session = await client.session.create({ location: { directory: server.projectDirectory } })
  await client.session.prompt({ sessionID: session.id, text: 'warm up' })
  await client.session.wait({ sessionID: session.id })
  await client.session.remove({ sessionID: session.id })
}

export const TEST_USER_ID = '200000000000000001'
export const OTHER_USER_ID = '200000000000000002'

export type TestTwin = {
  discord: DigitalDiscord
  stop: () => Promise<void>
  channelId: string
  // A second project channel, for per-channel settings like verbosity.
  quietChannelId: string
  unregisteredChannelId: string
}

// One scripted backend response: text, a tool call, or text that ends with a tool call.
export type FakeLiveReply =
  | { type: 'say'; text: string; then?: { name: string; args: ToolInput } }
  | { type: 'call'; name: string; args: ToolInput }

export type FakeLive = {
  // startTestBot({ realtimeBaseUrls }).
  baseUrls: RealtimeBaseUrls
  // Backend answers in order, one per Responses request.
  replies: FakeLiveReply[]
  // What the user "said" in each utterance, in order.
  transcripts: string[]
  // The first speakable append of a call is Kimaki's greeting request; the fake model answers it with this.
  greeting: string
  // GPT-Live instructions of each call, and backend instructions of each Responses request.
  liveInstructions: string[]
  backendInstructions: string[]
  // Text of each new user message the backend got, function outputs, and every context append.
  backendInputs: string[]
  toolOutputs: Array<{ name: string; output: string }>
  appends: Array<{ channel: string; text: string; delegation: boolean }>
  voicedFrames: () => number
  openCalls: () => number
  stop: () => Promise<void>
}

// GPT-Live and its backend, deterministic, over real WebRTC on loopback:
// - POST /calls answers the SDP offer with a werift peer and hears the bot's Opus.
//   Speech then 300ms of silence ends an utterance: a user turn and a delegation
//   with the next transcript.
// - The sideband speaks every speakable append verbatim: an assistant turn plus tone RTP.
// - POST /responses streams the next scripted reply as Responses SSE.
export async function startFakeLive(): Promise<FakeLive> {
  const [{ WebSocketServer }, werift, { default: OpusScript }] = await Promise.all([import('ws'), import('werift'), import('opusscript')])
  const port = await freePort()
  const counter = { id: 0, voiced: 0 }
  const nextId = (prefix: string) => `${prefix}_${++counter.id}`
  // 20 ms frames of a 440 Hz tone, 48 kHz stereo, for the model's voice.
  const encoder = new OpusScript(48_000, 2, OpusScript.Application.VOIP)
  const tone = Array.from({ length: 15 }, (_, frame) => {
    const pcm = Buffer.alloc(960 * 4)
    for (let i = 0; i < 960; i++) {
      const sample = Math.round(Math.sin((2 * Math.PI * 440 * (frame * 960 + i)) / 48_000) * 8000)
      pcm.writeInt16LE(sample, i * 4)
      pcm.writeInt16LE(sample, i * 4 + 2)
    }
    return Buffer.from(encoder.encode(pcm, 960))
  })
  encoder.delete()
  type FakeCall = { peer: InstanceType<typeof werift.RTCPeerConnection>; socket: import('ws').WebSocket | null; spoken: number; rtp: { sequence: number; timestamp: number } }
  const calls = new Map<string, FakeCall>()
  const seenOutputs = new Set<string>()

  const fake: FakeLive = {
    baseUrls: {
      calls: `http://127.0.0.1:${port}/backend-api/codex/realtime/calls`,
      sideband: `ws://127.0.0.1:${port}/v1/live`,
      responses: `http://127.0.0.1:${port}/backend-api/codex/responses`,
    },
    replies: [],
    transcripts: [],
    greeting: 'Hello.',
    liveInstructions: [],
    backendInstructions: [],
    backendInputs: [],
    toolOutputs: [],
    appends: [],
    voicedFrames: () => counter.voiced,
    openCalls: () => [...calls.values()].filter((call) => call.socket !== null).length,
    stop: async () => {
      await Promise.all([...calls.values()].map((call) => call.peer.close()))
      sockets.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }

  const send = (call: FakeCall, event: ToolInput) => call.socket?.send(JSON.stringify(event))
  const speak = (call: FakeCall, text: string) => {
    send(call, { type: 'turn.done', turn: { id: nextId('turn'), role: 'assistant', transcript: text } })
    const [transceiver] = call.peer.getTransceivers()
    for (const opus of tone) {
      const header = new werift.RtpHeader({ payloadType: 111, sequenceNumber: call.rtp.sequence, timestamp: call.rtp.timestamp, marker: false })
      call.rtp.sequence = (call.rtp.sequence + 1) & 0xffff
      call.rtp.timestamp = (call.rtp.timestamp + 960) >>> 0
      void transceiver?.sender.sendRtp(new werift.RtpPacket(header, opus))
    }
  }

  async function createCall(body: { sdp: string; session: { instructions?: string } }) {
    fake.liveInstructions.push(body.session.instructions ?? '')
    const peer = new werift.RTCPeerConnection({ codecs: { audio: [werift.useOPUS({ payloadType: 111 })], video: [] } })
    const callId = nextId('rtc')
    const call: FakeCall = { peer, socket: null, spoken: 0, rtp: { sequence: 1, timestamp: 0 } }
    calls.set(callId, call)
    await peer.setRemoteDescription({ type: 'offer', sdp: body.sdp })
    const decoder = new OpusScript(48_000, 2)
    const speech = { active: false, silentFrames: 0 }
    peer.getTransceivers()[0]!.receiver.track.onReceiveRtp.subscribe((rtp) => {
      const pcm = Buffer.from(decoder.decode(rtp.payload))
      const loud = Array.from({ length: pcm.length / 2 }, (_, i) => Math.abs(pcm.readInt16LE(i * 2))).some((sample) => sample > 500)
      if (loud) {
        counter.voiced++
        speech.active = true
        speech.silentFrames = 0
        return
      }
      if (!speech.active || ++speech.silentFrames < 15) return
      speech.active = false
      const text = fake.transcripts.shift() ?? ''
      send(call, { type: 'turn.done', turn: { id: nextId('turn'), role: 'user', transcript: text } })
      send(call, { type: 'delegation.created', item: { id: nextId('item'), type: 'delegation', target: 'client', content: [{ type: 'input_text', text }] } })
    })
    await peer.setLocalDescription(await peer.createAnswer())
    return { callId, sdp: peer.localDescription!.sdp }
  }

  // Responses SSE for one request: the next scripted reply, as finished output items.
  function respond(body: { instructions?: string; input?: Array<{ type?: string; role?: string; call_id?: string; output?: string; name?: string; content?: Array<{ text?: string }> }> }) {
    fake.backendInstructions.push(body.instructions ?? '')
    const input = body.input ?? []
    const names = new Map(input.flatMap((item) => (item.type === 'function_call' && item.call_id ? [[item.call_id, item.name ?? '']] : [])))
    for (const item of input) {
      if (item.type !== 'function_call_output' || !item.call_id || seenOutputs.has(item.call_id)) continue
      seenOutputs.add(item.call_id)
      fake.toolOutputs.push({ name: names.get(item.call_id) ?? '', output: item.output ?? '' })
    }
    const last = input.at(-1)
    if (last?.type === 'message' && last.role === 'user') fake.backendInputs.push(last.content?.[0]?.text ?? '')
    const reply = fake.replies.shift()
    const items: ToolInput[] = []
    if (reply?.type === 'say') items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply.text }] })
    const call = reply?.type === 'call' ? reply : reply?.then
    if (call) items.push({ type: 'function_call', call_id: nextId('call'), name: call.name, arguments: JSON.stringify(call.args) })
    const events = [...items.map((item) => ({ type: 'response.output_item.done', item })), { type: 'response.completed', response: {} }]
    return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
  }

  const readBody = async (request: http.IncomingMessage) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString('utf8')
  }

  const server = http.createServer((request, response) => {
    void (async () => {
      const body = await readBody(request)
      if (request.url?.startsWith('/backend-api/codex/realtime/calls')) {
        const created = await createCall(JSON.parse(body) as Parameters<typeof createCall>[0])
        response.writeHead(201, { location: `/v1/realtime/calls/${created.callId}`, 'content-type': 'application/sdp' })
        response.end(created.sdp)
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(respond(JSON.parse(body) as Parameters<typeof respond>[0]))
    })()
  })
  const sockets = new WebSocketServer({ server })
  sockets.on('connection', (socket, request) => {
    const call = calls.get(request.url?.split('/').at(-1) ?? '')
    if (!call) return socket.close(4004)
    call.socket = socket
    socket.on('close', () => {
      call.socket = null
      void call.peer.close()
    })
    socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString()) as { type: string; channel?: string; delegation_item_id?: string; content?: Array<{ text?: string }> }
      if (event.type === 'session.close') {
        send(call, { type: 'session.closed', reason: 'client_request' })
        socket.close(1000)
        return
      }
      if (!event.type.endsWith('context.append')) return
      const text = event.content?.map((part) => part.text ?? '').join('') ?? ''
      fake.appends.push({ channel: event.channel ?? 'speakable', text, delegation: Boolean(event.delegation_item_id) })
      if (event.channel !== 'speakable') return
      speak(call, call.spoken++ === 0 ? fake.greeting : text)
    })
    // Like GPT-Live: the session starts once the media connection is up.
    const started = () => socket.send(JSON.stringify({ type: 'session.started', session: { id: 'rtc_fake' } }))
    if (call.peer.connectionState === 'connected') return started()
    const subscription = call.peer.connectionStateChange.subscribe((state) => {
      if (state !== 'connected') return
      subscription.unSubscribe()
      started()
    })
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  return fake
}

// gateway: the twin plays gateway-proxy (REST scope rules of rest_proxy.rs)
// and accepts a clientId:secret token. KIMAKI_TEST_GATEWAY=1 runs every e2e
// file in gateway mode, to find REST calls the proxy would reject.
export async function startTwin({
  gateway = process.env['KIMAKI_TEST_GATEWAY'] === '1',
  voice = false,
}: {
  gateway?: boolean
  // Discord voice server (wss + UDP) for voice call tests; trusts its certificate in this process.
  voice?: boolean
} = {}): Promise<TestTwin> {
  const channelId = '200000000000000100'
  const unregisteredChannelId = '200000000000000101'
  const quietChannelId = '200000000000000102'
  // A file DB per twin: the default shared in-memory DB outlives stop() and
  // collides with the next twin when vitest reuses a worker process.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-twin-'))
  const discord = new DigitalDiscord({
    dbUrl: `file:${path.join(root, 'twin.db')}`,
    voice,
    ...(gateway && { gatewayProxy: true, botToken: `${crypto.randomUUID()}:${crypto.randomBytes(32).toString('hex')}` }),
    guild: { name: 'Kimaki Test', ownerId: TEST_USER_ID },
    channels: [
      { id: channelId, name: 'project', type: ChannelType.GuildText },
      { id: unregisteredChannelId, name: 'random', type: ChannelType.GuildText },
      { id: quietChannelId, name: 'quiet', type: ChannelType.GuildText },
    ],
    users: [
      { id: TEST_USER_ID, username: 'tommy' },
      { id: OTHER_USER_ID, username: 'stranger' },
    ],
  })
  await discord.start()
  if (voice) discord.trustVoiceCertificate()
  return {
    discord,
    channelId,
    quietChannelId,
    unregisteredChannelId,
    stop: async () => {
      await discord.stop()
      await discord.prisma.$disconnect()
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

// Onboarding is phase 10: tests insert the channel mapping directly.
export async function seedProjectChannel({
  dataDir,
  channelId,
  guildId,
  directory,
  verbosity,
}: {
  dataDir: string
  channelId: string
  guildId: string
  directory: string
  verbosity?: Verbosity
}): Promise<void> {
  const opened = await openDb({ dataDir, migrate: true })
  if (opened instanceof Error) throw opened
  await opened.db
    .insert(schema.channel_directories)
    .values({ channel_id: channelId, directory, channel_type: 'text', guild_id: guildId })
  if (verbosity) {
    await opened.db
      .insert(schema.channel_verbosity)
      .values({ channel_id: channelId, verbosity: verbosityToV1(verbosity) })
  }
  opened.close()
}

export async function startTestBot({
  dataDir,
  twin,
  server,
  geminiBaseUrl,
  openaiBaseUrl,
  chatgptBaseUrl,
  opencodeDbFile = server.dbFile,
  realtimeBaseUrls,
  lockPort,
  saveTwinCredentials = true,
  analytics,
  clock,
  schedulerIntervalMs,
}: {
  dataDir: string
  twin: TestTwin
  server: OpencodeTestServer
  // Voice transcription against startFakeGemini() / startFakeOpenAI().
  geminiBaseUrl?: string
  openaiBaseUrl?: string
  // ChatGPT subscription transcription against startFakeChatGPT(), with the credential in opencodeDbFile.
  chatgptBaseUrl?: string
  opencodeDbFile?: string
  // Voice calls against startFakeLive().
  realtimeBaseUrls?: RealtimeBaseUrls
  lockPort?: number
  // false: the data dir is used as is (a V1 database the bot start must import).
  saveTwinCredentials?: boolean
  // Default: off. Tests pass createAnalytics() with a local OTLP endpoint.
  analytics?: Analytics
  // Scheduling tests pass manualClock() and null, then call bot.scheduler.runDueTasks().
  clock?: Clock
  schedulerIntervalMs?: number | null
}): Promise<BotHandle> {
  // What credential resolution saves in production; `kimaki project add` reads it.
  const credentials: Credentials = twin.discord.botToken.includes(':')
    ? { mode: 'gateway', appId: GATEWAY_APP_ID, token: twin.discord.botToken, baseUrl: new URL('/', twin.discord.restUrl).toString() }
    : { mode: 'self_hosted', appId: twin.discord.botUserId, token: twin.discord.botToken, baseUrl: null }
  if (saveTwinCredentials) {
    const opened = await openDb({ dataDir, migrate: true })
    if (opened instanceof Error) throw opened
    const saved = await saveCredentials({ db: opened.db, credentials })
    opened.close()
    if (saved instanceof Error) throw saved
  }
  const lock = await startLockServer({ port: lockPort ?? await freePort(), dataDir })
  if (lock instanceof Error) throw lock
  const bot = await startBot({
    dataDir,
    kimakiCommand: `'${process.execPath}' --import '${createRequire(import.meta.url).resolve('tsx')}' '${path.resolve('src/cli.ts')}'`,
    token: credentials.token,
    appId: credentials.appId,
    lock,
    discordRestUrl: twin.discord.restUrl,
    opencodeServiceFile: server.serviceFile,
    opencodeConfigDir: server.configDir,
    opencodeDbFile,
    ensureOpencode: false,
    analytics: analytics ?? disabledAnalytics,
    ...(clock && { clock }),
    ...(schedulerIntervalMs !== undefined && { schedulerIntervalMs }),
    ...(realtimeBaseUrls && { realtimeBaseUrls }),
    transcriptionBaseUrls: {
      ...(geminiBaseUrl && { gemini: geminiBaseUrl }),
      ...(openaiBaseUrl && { openai: openaiBaseUrl }),
      ...(chatgptBaseUrl && { chatgpt: chatgptBaseUrl }),
    },
  })
  if (bot instanceof Error) throw bot
  return bot
}

// Time as a test input (spec 30, Phase 8): never vi.useFakeTimers(), it would
// also freeze discord.js, the twin and HTTP timeouts in this process.
export function manualClock(start: number): Clock & { set: (ms: number) => void; advance: (ms: number) => void } {
  const state = { now: start }
  return {
    now: () => state.now,
    set: (ms) => { state.now = ms },
    advance: (ms) => { state.now += ms },
  }
}

// Scheduling e2e helpers. `request` is the lock-server call the CLI makes,
// without paying a CLI process start; `cli` runs the real command.
export function schedulingKit({ suite, dataDir, clock }: {
  suite: () => { bot: BotHandle; twin: TestTwin; server: OpencodeTestServer }
  dataDir: string
  clock: ReturnType<typeof manualClock>
}) {
  async function request<N extends LockRouteName>(route: N, input: LockRouteInput<N>): Promise<unknown> {
    const { bot } = suite()
    const token = fs.readFileSync(path.join(dataDir, 'lock-token'), 'utf8')
    const response = await fetch(`http://127.0.0.1:${bot.lock.port}/kimaki/${route}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(input) })
    const body: unknown = await response.json()
    if (!response.ok) throw new Error(`${route} failed: ${JSON.stringify(body)}`)
    return body
  }
  async function threadIds(): Promise<Set<string>> {
    const { twin } = suite()
    return new Set((await twin.discord.channel(twin.channelId).getThreads()).map((thread) => thread.id))
  }
  return {
    request,
    threadIds,
    async cli(args: string[]): Promise<string> {
      const { bot, server } = suite()
      const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), ...args, '--data-dir', dataDir], {
        env: { ...process.env, KIMAKI_LOCK_PORT: String(bot.lock.port), KIMAKI_OPENCODE_SERVICE_FILE: server.serviceFile },
      })
      return result.stdout
    },
    // `kimaki send --channel <project> --send-at …`
    async schedule(input: Omit<LockRouteInput<'send'>, 'channelId'>) {
      return (await request('send', { channelId: suite().twin.channelId, ...input })) as { routineId: number; nextRunAt: string }
    },
    async listTasks() {
      const opened = await openDb({ dataDir, migrate: false })
      if (opened instanceof Error) throw opened
      const tasks = await listTasks({ db: opened.db })
      opened.close()
      if (tasks instanceof Error) throw tasks
      return tasks
    },
    // Moves the clock, runs the due tasks once, and returns the threads they created.
    async tick(iso: string): Promise<string[]> {
      const before = await threadIds()
      clock.set(Date.parse(iso))
      await suite().bot.scheduler.runDueTasks()
      return [...(await threadIds())].filter((id) => !before.has(id))
    },
  }
}

export type FakeTranscription = { transcription: string; route?: string; agent?: string }

// A voice message whose audio bytes are the transcription the fake returns.
export function voiceUrl(result: FakeTranscription): string {
  return `data:audio/ogg;base64,${Buffer.from(JSON.stringify(result)).toString('base64')}`
}

export type FakeGemini = {
  baseUrl: string
  // Route enum offered by each transcription request (tool schema), and the audio media type.
  requests: Array<{ routes: unknown; mimeType: string }>
  stop: () => Promise<void>
}

// Gemini generateContent over HTTP, deterministic: the "audio" is JSON of
// the transcription tool call to return (see voiceUrl()). Exercises the real
// request, schema and response parsing of voice.ts.
export async function startFakeGemini(): Promise<FakeGemini> {
  const requests: FakeGemini['requests'] = []
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        contents: Array<{ parts: Array<{ inlineData?: { data: string; mimeType: string } }> }>
        tools: Array<{ functionDeclarations: Array<{ name: string; parameters: { properties: { route?: { enum?: unknown } } } }> }>
      }
      const declaration = body.tools[0]!.functionDeclarations[0]!
      const audio = body.contents[0]!.parts.find((part) => part.inlineData)!.inlineData!
      requests.push({ routes: declaration.parameters.properties.route?.enum ?? null, mimeType: audio.mimeType })
      const args = JSON.parse(Buffer.from(audio.data, 'base64').toString('utf8')) as FakeTranscription
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: declaration.name, args } }] } }],
        }),
      )
    })
  })
  const port = await freePort()
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

export type FakeOpenAI = {
  baseUrl: string
  // Audio of each request, as OpenAI received it.
  requests: Array<{ model: string; format: string; audio: Buffer; routes: unknown }>
  // Reply status; tests set 401 to check the fallback to the next transcriber.
  status: number
  stop: () => Promise<void>
}

// OpenAI chat completions over HTTP, deterministic: every request gets the
// same transcription tool call. Real Opus audio goes through the OGG -> WAV
// conversion first, so the audio cannot carry the answer like voiceUrl().
export async function startFakeOpenAI({ result }: { result: FakeTranscription }): Promise<FakeOpenAI> {
  const fake: Omit<FakeOpenAI, 'baseUrl' | 'stop'> = { requests: [], status: 200 }
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        model: string
        tools: Array<{ function: { name: string; parameters: { properties: { route?: { enum?: unknown } } } } }>
        messages: Array<{ content: Array<{ type: string; input_audio?: { data: string; format: string } }> }>
      }
      const tool = body.tools[0]!.function
      const audio = body.messages[0]!.content.find((part) => part.input_audio)!.input_audio!
      fake.requests.push({
        model: body.model,
        format: audio.format,
        audio: Buffer.from(audio.data, 'base64'),
        routes: tool.parameters.properties.route?.enum ?? null,
      })
      response.setHeader('content-type', 'application/json')
      if (fake.status !== 200) {
        response.statusCode = fake.status
        response.end(JSON.stringify({ error: { message: 'unauthorized' } }))
        return
      }
      response.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: { role: 'assistant', content: null, tool_calls: [{ type: 'function', function: { name: tool.name, arguments: JSON.stringify(result) } }] },
            },
          ],
        }),
      )
    })
  })
  const port = await freePort()
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  return Object.assign(fake, {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  })
}

export type FakeChatGPT = {
  baseUrl: string
  // Each POST /transcribe, as ChatGPT received it.
  requests: Array<{ authorization: string | null; accountId: string | null; filename: string; type: string; audio: Buffer }>
  // Reply status; tests set 401 to check the API key fallback.
  status: number
  stop: () => Promise<void>
}

// chatgpt.com/backend-api/transcribe: multipart `file` in, `{ text }` out.
export async function startFakeChatGPT({ text }: { text: string }): Promise<FakeChatGPT> {
  const fake: Omit<FakeChatGPT, 'baseUrl' | 'stop'> = { requests: [], status: 200 }
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', async () => {
      const headers = new Headers(Object.entries(request.headers).flatMap(([key, value]) => (typeof value === 'string' ? [[key, value]] : [])))
      const form = await new Request('http://fake/transcribe', { method: 'POST', headers, body: Buffer.concat(chunks) }).formData()
      const file = form.get('file')
      if (!(file instanceof File)) throw new Error('fake ChatGPT: no file field')
      fake.requests.push({
        authorization: headers.get('authorization'),
        accountId: headers.get('chatgpt-account-id'),
        filename: file.name,
        type: file.type,
        audio: Buffer.from(await file.arrayBuffer()),
      })
      response.statusCode = fake.status
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(fake.status === 200 ? { text } : { detail: 'unauthorized' }))
    })
  })
  const port = await freePort()
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  return Object.assign(fake, {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  })
}

// An OpenCode database with only the credential table and one ChatGPT OAuth row.
export async function writeOpencodeCredential({ file, access, expires }: { file: string; access: string; expires: number }) {
  const client = createClient({ url: `file:${file}` })
  await client.execute('CREATE TABLE credential (id text PRIMARY KEY, integration_id text, label text NOT NULL, value text NOT NULL, connector_id text, method_id text, active integer, time_created integer NOT NULL, time_updated integer NOT NULL)')
  await client.execute({
    sql: `INSERT INTO credential (id, integration_id, label, value, time_created, time_updated) VALUES ('cred_test', 'openai', 'OAuth', ?, 0, 0)`,
    args: [JSON.stringify({ type: 'oauth', methodID: 'chatgpt-browser', access, refresh: 'refresh-test', expires })],
  })
  client.close()
}

export function tempDataDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-data-')))
}

export async function waitFor<T>({
  label,
  timeout = 4_000,
  check,
}: {
  label: string
  timeout?: number
  check: () => Promise<T | null | undefined | false>
}): Promise<T> {
  // Clamped to 8..10s: the first turn on a fresh server pays session create,
  // config load and provider load.
  const deadline = Date.now() + Math.min(10_000, Math.max(8_000, timeout))
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await sleep(100)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

export function isFooter(message: APIMessage): boolean {
  const content = message.content
  return content.startsWith('-# *') && content.includes('⋅') && !content.startsWith('-# *using ')
}

// Waits until the thread has `count` footers from the bot.
export async function waitForFooter({
  discord,
  threadId,
  count = 1,
}: {
  discord: DigitalDiscord
  threadId: string
  count?: number
}): Promise<APIMessage> {
  return waitFor({
    label: `footer #${count} in thread ${threadId}`,
    check: async () => {
      const footers = (await discord.thread(threadId).getMessages()).filter(
        (message) => message.author.id === discord.botUserId && isFooter(message),
      )
      return footers.length >= count ? footers[count - 1] : null
    },
  })
}

export async function waitForBotMessageContaining({
  discord,
  threadId,
  text,
}: {
  discord: DigitalDiscord
  threadId: string
  text: string
}): Promise<APIMessage> {
  return waitFor({
    label: `bot message containing ${JSON.stringify(text)}`,
    check: async () => {
      const messages = await discord.thread(threadId).getMessages()
      return messages.find((message) => message.author.id === discord.botUserId && message.content.includes(text))
    },
  })
}

function selectOf(message: APIMessage) {
  for (const row of message.components ?? []) {
    if (row.type !== ComponentType.ActionRow) continue
    for (const component of row.components) {
      if (component.type === ComponentType.StringSelect) return component
    }
  }
  return null
}

// The newest bot message with a select menu whose custom ID starts with `prefix`.
export async function waitForSelectMenu({
  discord,
  channelId,
  prefix,
}: {
  discord: DigitalDiscord
  channelId: string
  prefix: string
}) {
  return waitFor({
    label: `select menu ${prefix}`,
    check: async () => {
      const messages = await discord.channel(channelId).getMessages()
      for (const message of [...messages].reverse()) {
        const select = selectOf(message)
        if (select?.custom_id.startsWith(prefix)) return { message, select }
      }
      return null
    },
  })
}

// Deterministic provider responses for scripted turns.
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }

export function textParts(text: string): DeterministicMatcher['then']['parts'] {
  return [
    { type: 'text-start', id: 'text' },
    { type: 'text-delta', id: 'text', delta: text },
    { type: 'text-end', id: 'text' },
    { type: 'finish', finishReason: 'stop', usage },
  ]
}

// A reply that streams `text` only after `delayMs`, so tests can act while
// the run is busy. Lowest priority: the marker stays in the thread name,
// which is part of every later prompt's per-turn context.
export function slowTextMatcher({
  marker,
  text,
  delayMs,
}: {
  marker: string
  text: string
  delayMs: number
}): DeterministicMatcher {
  return {
    id: marker,
    priority: 1,
    when: { latestUserTextIncludes: marker },
    then: { parts: textParts(text), partDelaysMs: [0, delayMs, 0, 0] },
  }
}

export function toolParts({
  toolCallId,
  toolName,
  input,
}: {
  toolCallId: string
  toolName: string
  input: ToolInput
}): DeterministicMatcher['then']['parts'] {
  return [
    { type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) },
    { type: 'finish', finishReason: 'tool-calls', usage },
  ]
}

// Each step of a scripted turn matches on the tool call id of the previous
// step, which is in the raw prompt only after that tool ran.
export function scriptedTurn({
  marker,
  steps,
  finalText,
}: {
  marker: string
  steps: Array<{ id: string; tool: string; input: ToolInput }>
  finalText: string
}): DeterministicMatcher[] {
  const toolMatchers = steps.map((step, index): DeterministicMatcher => {
    const previous = steps[index - 1]
    return {
      id: `${marker}-${step.id}`,
      priority: 100 + index,
      when: { latestUserTextIncludes: marker, ...(previous && { rawPromptIncludes: previous.id }) },
      then: { parts: toolParts({ toolCallId: step.id, toolName: step.tool, input: step.input }) },
    }
  })
  const last = steps[steps.length - 1]
  return [
    ...toolMatchers,
    {
      id: `${marker}-final`,
      priority: 100 + steps.length,
      when: { latestUserTextIncludes: marker, ...(last && { rawPromptIncludes: last.id }) },
      then: { parts: textParts(finalText) },
    },
  ]
}
