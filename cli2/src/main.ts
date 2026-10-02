// Bot wiring. Order: lock port -> SQLite (migrate) -> OpenCode service and
// Discord login in parallel. Returns a handle so tests can drive the bot
// in-process and stop it cleanly.

import { Client, Events, GatewayIntentBits, Partials } from 'discord.js'

import { createActions, parseSendInput, type Actions } from './actions.ts'
import type { Analytics } from './analytics.ts'
import { countUserProjects } from './project.ts'
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
import {
  installPluginShim,
  watchOpencode,
  type OpencodeConnection,
  type OpencodeEndpoint,
} from './opencode-server.ts'
import { createScheduler, parseScheduleOptions, parseTaskEdit, systemClock, type Clock, type Scheduler } from './scheduler.ts'
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
  // Global OpenCode config dir that gets plugins/kimaki/ (opencodeConfigDir()).
  // Required, so no caller writes into the user's real config by accident.
  opencodeConfigDir: string
  // Shell command that runs this Kimaki install (given to agents), from kimakiShellCommand().
  kimakiCommand: string
  // Product analytics sink (createAnalytics or disabledAnalytics).
  analytics: Analytics
  // Voice transcription API base URLs; tests point Gemini at a local fake.
  transcriptionBaseUrls?: TranscriptionBaseUrls
  // The scheduler's only source of time. Tests pass a manual clock.
  clock?: Clock
  // How often due tasks and wakes run; null: never (tests call scheduler.runDueTasks).
  schedulerIntervalMs?: number | null
  autoWorktrees?: boolean
}

export type BotHandle = {
  discord: Client
  opencode: OpencodeConnection
  db: OpenedDb
  lock: LockServer
  store: BotStore
  actions: Actions
  analytics: Analytics
  scheduler: Pick<Scheduler, 'runDueTasks'>
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
  const eventLoop = createEventLoop({ store, db: db.db, discord, effects, recorder, analytics: options.analytics })
  const loaded = await eventLoop.load()
  if (loaded instanceof Error) {
    db.close()
    await lock.close()
    return loaded
  }
  // Before the service is used, so a service started by ensure() loads it at once.
  const plugin = await installPluginShim({ configDir: options.opencodeConfigDir })
  if (plugin instanceof Error) {
    db.close()
    await lock.close()
    return plugin
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
  const actions = createActions({ discord, db: db.db, opencode, eventLoop, store, analytics: options.analytics, cliContext: { dataDir: options.dataDir, lockPort: lock.port }, autoWorktrees: options.autoWorktrees })
  const scheduler = createScheduler({
    clock: options.clock ?? systemClock,
    discord,
    db: db.db,
    actions,
    store,
    opencode,
    intervalMs: options.schedulerIntervalMs === undefined ? 5_000 : options.schedulerIntervalMs,
  })
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
    if (route === '/kimaki/status') {
      return {
        data: {
          pid: process.pid,
          uptimeSec: Math.round(process.uptime()),
          dataDir: options.dataDir,
          mode: options.token.includes(':') ? 'gateway' : 'self_hosted',
          analytics: options.analytics.enabled,
          opencode: { connected: opencode.connected, url: opencode.endpoint?.url ?? null, version: opencode.endpoint?.version ?? null },
          guilds: [...discord.guilds.cache.values()].map((guild) => ({ id: guild.id, name: guild.name })),
        },
      }
    }
    if (route === '/kimaki/sleep') {
      if (!input || typeof input !== 'object' || Array.isArray(input)) return new ConfigError({ reason: 'Expected a sleep object' })
      const fields = new Map(Object.entries(input))
      const [sessionId, duration, until, reason] = ['sessionId', 'duration', 'until', 'reason'].map((key) => fields.get(key))
      if (typeof sessionId !== 'string' || !sessionId) return new ConfigError({ reason: 'Use --session or run kimaki sleep inside an OpenCode session' })
      if ([duration, until, reason].some((value) => value !== undefined && typeof value !== 'string')) return new ConfigError({ reason: 'Sleep fields must be strings' })
      const result = await scheduler.createSleep({ sessionId, duration: typeof duration === 'string' ? duration : undefined, until: typeof until === 'string' ? until : undefined, reason: typeof reason === 'string' ? reason : undefined })
      return result instanceof Error ? result : { data: result }
    }
    if (route === '/kimaki/task/edit') {
      const edit = parseTaskEdit(input)
      if (edit instanceof Error) return edit
      const result = await scheduler.editTask(edit)
      return result instanceof Error ? result : { data: result }
    }
    if (route === '/kimaki/task/delete' || route === '/kimaki/task/run') {
      const id = input && typeof input === 'object' ? new Map(Object.entries(input)).get('id') : undefined
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) return new ConfigError({ reason: 'Task ID must be a positive integer' })
      const result = route === '/kimaki/task/delete' ? await scheduler.deleteTask(id) : await scheduler.runTaskNow(id)
      return result instanceof Error ? result : { data: result }
    }
    if (route !== '/kimaki/send') return new ConfigError({ reason: 'Unknown bot action' })
    const parsed = parseSendInput(input)
    if (parsed instanceof Error) return parsed
    const schedule = parseScheduleOptions(input)
    if (schedule instanceof Error) return schedule
    const result = schedule ? await scheduler.createTask({ send: parsed, options: schedule }) : await actions.send(parsed)
    return result instanceof Error ? result : { data: result }
  })
  const transcriber = createTranscriber({ db: db.db, token: options.token, baseUrls: options.transcriptionBaseUrls })
  registerIngress({ discord, db: db.db, store, actions, transcriber, dataDir: options.dataDir })

  const shutdown = async () => {
    await scheduler.stop()
    agentUi.stop()
    opencode.stop()
    effects.stop()
    await recorder.close()
    await options.analytics.flush()
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
    await shutdown()
    return failure
  }
  const refreshed = await actions.refreshCliContext()
  if (refreshed instanceof Error) { await shutdown(); return refreshed }
  const commands = registerSlashCommands({ discord, db: db.db, store, actions, opencode, agentUi, scheduler })
  const stop = async () => {
    await commands.stop()
    await shutdown()
  }
  // Awaited so the handle is only returned once every guild has its commands.
  await commands.registerAll()
  // After Discord and OpenCode are ready: a due task needs both.
  const scheduling = await scheduler.start()
  if (scheduling instanceof Error) { await stop(); return scheduling }
  logger.log(`bot ready as ${discord.user?.tag}`)
  const projects = await countUserProjects({ db: db.db, dataDir: options.dataDir })
  if (projects instanceof Error) logger.warn(projects.message)
  options.analytics.track('bot_started', {
    guild_count: discord.guilds.cache.size,
    ...(!(projects instanceof Error) && { user_project_count: projects }),
  })
  return { discord, opencode, db, lock, store, actions, analytics: options.analytics, scheduler, stop }
}
