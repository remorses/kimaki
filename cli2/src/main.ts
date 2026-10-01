// Bot wiring. Order: lock port -> SQLite (migrate) -> OpenCode service and
// Discord login in parallel. Returns a handle so tests can drive the bot
// in-process and stop it cleanly.

import { Client, Events, GatewayIntentBits, Partials } from 'discord.js'

import { createActions, parseSendInput, type Actions } from './actions.ts'
import { createAgentUi } from './agent-ui.ts'
import { openDb, type OpenedDb } from './db.ts'
import { createEffectsRunner } from './effects.ts'
import { ConfigError, DiscordError } from './errors.ts'
import { createEventLoop } from './event-loop.ts'
import { createEventRecorder } from './session-events.ts'
import { registerSlashCommands } from './slash-commands.ts'
import { registerIngress } from './ingress.ts'
import { createLogger, setLogFile } from './logger.ts'
import { installShim, startLockServer, type LockServer } from './lock-server.ts'
import { watchOpencode, type OpencodeConnection, type OpencodeEndpoint } from './opencode-server.ts'
import { createBotStore, type BotStore } from './store.ts'
import { createTranscriber, type TranscriptionBaseUrls } from './voice.ts'

const logger = createLogger('MAIN')

export type StartBotOptions = {
  dataDir: string
  token: string
  lockPort: number
  // discord.js REST `api` URL: gateway-proxy in gateway mode, the digital twin
  // in tests. The WebSocket URL comes from GET /gateway/bot on that host.
  discordRestUrl?: string | null
  // Registration file of the OpenCode service. Defaults to the XDG state dir.
  opencodeServiceFile?: string
  // Start the service with Service.ensure() when none is running.
  ensureOpencode: boolean
  // Shell command that runs this Kimaki install (shown by /session-id and
  // given to agents), from kimakiShellCommand().
  kimakiCommand: string
  // Voice transcription API base URLs; tests point Gemini at a local fake.
  transcriptionBaseUrls?: TranscriptionBaseUrls
}

export type BotHandle = {
  discord: Client
  opencode: OpencodeConnection
  db: OpenedDb
  lock: LockServer
  store: BotStore
  actions: Actions
  stop: () => Promise<void>
}

async function loginDiscord({ discord, token }: { discord: Client; token: string }): Promise<DiscordError | void> {
  const ready = new Promise<void>((resolve) => discord.once(Events.ClientReady, () => resolve()))
  const login = await discord.login(token).catch((e) => new DiscordError({ operation: 'login', cause: e }))
  if (login instanceof Error) return login
  await ready
}

export async function startBot(options: StartBotOptions): Promise<Error | BotHandle> {
  const logFile = setLogFile({ dataDir: options.dataDir })
  if (logFile instanceof Error) return logFile

  const lock = await startLockServer({ port: options.lockPort, dataDir: options.dataDir })
  if (lock instanceof Error) return lock

  const db = await openDb({ dataDir: options.dataDir, migrate: true })
  if (db instanceof Error) {
    await lock.close()
    return db
  }

  const discord = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel, Partials.Message, Partials.User, Partials.ThreadMember],
    ...(options.discordRestUrl && { rest: { api: options.discordRestUrl, version: '10' } }),
  })
  const store = createBotStore()
  const effects = createEffectsRunner({ discord })
  const recorder = createEventRecorder({ dataDir: options.dataDir })
  const eventLoop = createEventLoop({ store, db: db.db, discord, effects, recorder })
  const loaded = await eventLoop.load()
  if (loaded instanceof Error) {
    db.close()
    await lock.close()
    return loaded
  }
  const opencode = watchOpencode({
    serviceFile: options.opencodeServiceFile,
    ensure: options.ensureOpencode,
    onConnect: eventLoop.onConnect,
    onEvent: eventLoop.onEvent,
    onDisconnect: eventLoop.onDisconnect,
  })
  const shim = await installShim({ dataDir: options.dataDir, command: options.kimakiCommand })
  if (shim instanceof Error) {
    opencode.stop()
    db.close()
    await lock.close()
    return shim
  }
  const actions = createActions({ discord, db: db.db, opencode, eventLoop, store, cliContext: { dataDir: options.dataDir, lockPort: lock.port } })
  const agentUi = createAgentUi({ store, eventLoop, actions, directoryFor: async (sessionId) => {
    const client = opencode.endpoint?.client
    if (!client) return new ConfigError({ reason: 'OpenCode is disconnected' })
    const info = await client.session.get({ sessionID: sessionId }).catch((cause) => new ConfigError({ reason: 'Cannot find upload session', cause }))
    return info instanceof Error ? info : info.location.directory
  } })
  lock.handle(async (route, input, signal) => {
    if (route === '/kimaki/upload') {
      if (!input || typeof input !== 'object' || !('id' in input) || typeof input.id !== 'string' || !input.id || !('files' in input) || !Array.isArray(input.files)) return new ConfigError({ reason: 'Upload needs a session and files' })
      const files: Array<{ path: string; name: string }> = []
      for (const file of input.files) {
        if (!file || typeof file !== 'object' || typeof file.path !== 'string' || typeof file.name !== 'string') return new ConfigError({ reason: 'Invalid upload file' })
        files.push({ path: file.path, name: file.name })
      }
      const result = await actions.upload({ id: input.id, files })
      return result instanceof Error ? result : { data: result }
    }
    if (route.startsWith('/kimaki/action/')) return actions.runCli(route.slice('/kimaki/action/'.length), input)
    if (route === '/kimaki/buttons' || route === '/kimaki/upload-request') return agentUi.request(route, input, signal)
    if (route === '/kimaki/login' || route === '/kimaki/credential') {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return new ConfigError({ reason: 'Expected login object' })
      const fields = new Map(Object.entries(input))
      if (route === '/kimaki/login') {
        const provider = fields.get('provider')
        const key = fields.get('key')
        if (typeof provider !== 'string' || !provider) return new ConfigError({ reason: 'Provider is required' })
        const method = fields.get('method'), attempt = fields.get('attempt'), code = fields.get('code'), operation = fields.get('operation')
        if ([key, method, attempt, code, operation].some((value) => value !== undefined && (typeof value !== 'string' || !value))) return new ConfigError({ reason: 'Login fields must be non-empty strings' })
        return actions.loginCli({ provider, ...(typeof key === 'string' && { key }), ...(typeof method === 'string' && { method }), ...(typeof attempt === 'string' && { attempt }), ...(typeof code === 'string' && { code }), ...(typeof operation === 'string' && { operation }) })
      }
      const id = fields.get('id')
      const operation = fields.get('operation')
      const label = fields.get('label')
      if (typeof id !== 'string' || !id || (operation !== 'activate' && operation !== 'remove' && operation !== 'label') || (label !== undefined && typeof label !== 'string')) return new ConfigError({ reason: 'Invalid credential action' })
      const result = await actions.credential({ id, operation, label })
      return result instanceof Error ? result : { data: result }
    }
    if (route !== '/kimaki/send') return new ConfigError({ reason: 'Unknown bot action' })
    const parsed = parseSendInput(input)
    if (parsed instanceof Error) return parsed
    const result = await actions.send(parsed)
    return result instanceof Error ? result : { data: result }
  })
  const transcriber = createTranscriber({ db: db.db, token: options.token, baseUrls: options.transcriptionBaseUrls })
  registerIngress({ discord, db: db.db, store, actions, transcriber, dataDir: options.dataDir })

  const stop = async () => {
    agentUi.stop()
    opencode.stop()
    effects.stop()
    await recorder.close()
    await discord.destroy()
    db.close()
    await lock.close()
  }

  // Resolves with the first fatal error, or null when both sides are ready.
  // Not Promise.all: a failed side must not wait for the other (Discord login
  // or OpenCode retries can take long), and the other side's "stopped" error
  // would hide the real cause.
  const failure = await new Promise<Error | null>((resolve) => {
    const pending = { count: 2 }
    const settle = (result: Error | OpencodeEndpoint | void) => {
      if (result instanceof Error) {
        resolve(result)
        return
      }
      pending.count--
      if (pending.count === 0) resolve(null)
    }
    void opencode.ready.then(settle)
    void loginDiscord({ discord, token: options.token }).then(settle)
  })
  if (failure) {
    await stop()
    return failure
  }
  const refreshed = await actions.refreshCliContext()
  if (refreshed instanceof Error) { await stop(); return refreshed }
  const commands = registerSlashCommands({ discord, db: db.db, kimaki: options.kimakiCommand, store, actions, opencode, agentUi })
  // Awaited so the handle is only returned once every guild has its commands.
  await commands.registerAll()
  logger.log(`bot ready as ${discord.user?.tag}`)
  return { discord, opencode, db, lock, store, actions, stop }
}
