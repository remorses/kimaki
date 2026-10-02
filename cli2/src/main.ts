// Bot wiring. Order: lock port -> SQLite (migrate) -> OpenCode service and
// Discord login in parallel. Returns a handle so tests can drive the bot
// in-process and stop it cleanly.

import { Client, Events, GatewayIntentBits, Partials } from 'discord.js'
import * as errore from 'errore'

import { createAgentUi } from './agent-ui.ts'
import type { Analytics } from './analytics.ts'
import type { Bot } from './bot.ts'
import { openDb } from './db.ts'
import { createEffectsRunner } from './effects.ts'
import { DiscordError } from './errors.ts'
import { createEventLoop } from './event-loop.ts'
import { registerIngress } from './ingress.ts'
import { runLockRoute } from './lock-routes.ts'
import { installShim, startLockServer, type LockServer } from './lock-server.ts'
import { createLogger, setLogFile } from './logger.ts'
import { installPluginShim, watchOpencode, type OpencodeEndpoint } from './opencode-server.ts'
import { countUserProjects } from './project.ts'
import { createScheduler, systemClock, type Clock } from './scheduler.ts'
import { createEventRecorder } from './session-events.ts'
import { createPluginWait, refreshCliContext } from './sessions.ts'
import { createInteractionRegistry, registerSlashCommands } from './slash-commands.ts'
import { createSleepLock } from './sleeps.ts'
import { createBotStore } from './store.ts'
import type { TranscriptionBaseUrls } from './voice.ts'

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

export type BotHandle = Bot & {
  lock: LockServer
  // Tests drive scheduling with a manual clock and call this themselves.
  scheduler: { runDueTasks: () => Promise<void> }
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

  // Each resource registers its cleanup when acquired; disposal runs in reverse
  // (commands and scheduler first, the db and the lock port last). A startup
  // failure disposes it on return; a started bot moves it into stop().
  await using cleanup = new errore.AsyncDisposableStack()

  const lock = await startLockServer({ port: options.lockPort, dataDir: options.dataDir })
  if (lock instanceof Error) return lock
  cleanup.defer(() => lock.close())

  const opened = await openDb({ dataDir: options.dataDir, migrate: true })
  if (opened instanceof Error) return opened
  cleanup.defer(() => opened.close())
  const db = opened.db

  const discord = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel, Partials.Message, Partials.User, Partials.ThreadMember],
    ...(options.discordRestUrl && { rest: { api: options.discordRestUrl, version: '10' } }),
  })
  cleanup.defer(() => discord.destroy())
  cleanup.defer(() => options.analytics.flush())
  const store = createBotStore()
  const recorder = createEventRecorder({ dataDir: options.dataDir })
  cleanup.defer(() => recorder.close())
  const effects = createEffectsRunner({ discord })
  cleanup.defer(() => effects.stop())
  const eventLoop = createEventLoop({ store, db, discord, effects, recorder, analytics: options.analytics })
  const loaded = await eventLoop.load()
  if (loaded instanceof Error) return loaded
  // Before the service is used, so a service started by ensure() loads it at once.
  const plugin = await installPluginShim({ configDir: options.opencodeConfigDir })
  if (plugin instanceof Error) return plugin
  const opencode = watchOpencode({
    serviceFile: options.opencodeServiceFile,
    ensure: options.ensureOpencode,
    onConnect: eventLoop.onConnect,
    onEvent: eventLoop.onEvent,
    onDisconnect: eventLoop.onDisconnect,
  })
  cleanup.defer(() => opencode.stop())
  const shim = await installShim({ dataDir: options.dataDir, command: options.kimakiCommand })
  if (shim instanceof Error) return shim
  // The features that non-interaction code reaches through bot.features.
  const agentUi = createAgentUi({ store, eventLoop, opencode })
  cleanup.defer(() => agentUi.stop())
  const bot: Bot = {
    discord,
    db,
    store,
    opencode,
    eventLoop,
    effects,
    analytics: options.analytics,
    clock: options.clock ?? systemClock,
    dataDir: options.dataDir,
    lockPort: lock.port,
    token: options.token,
    transcriptionBaseUrls: options.transcriptionBaseUrls ?? {},
    autoWorktrees: options.autoWorktrees ?? false,
    features: { withSleepLock: createSleepLock(), waitForPlugin: createPluginWait({ opencode }), agentUi },
  }
  const scheduler = createScheduler({
    bot,
    intervalMs: options.schedulerIntervalMs === undefined ? 5_000 : options.schedulerIntervalMs,
  })
  cleanup.defer(() => scheduler.stop())
  // The lock server only passes /kimaki/* paths.
  lock.handle((route, input, signal) => runLockRoute(bot, { route: route.slice('/kimaki/'.length), input, signal }))
  registerIngress(bot)

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
  if (failure) return failure
  const refreshed = await refreshCliContext(bot)
  if (refreshed instanceof Error) return refreshed
  const commands = registerSlashCommands(bot, createInteractionRegistry())
  cleanup.defer(() => commands.stop())
  // Awaited so the handle is only returned once every guild has its commands.
  await commands.registerAll()
  // After Discord and OpenCode are ready: a due task needs both.
  const scheduling = await scheduler.start()
  if (scheduling instanceof Error) return scheduling
  logger.log(`bot ready as ${discord.user?.tag}`)
  const projects = await countUserProjects({ db, dataDir: options.dataDir })
  if (projects instanceof Error) logger.warn(projects.message)
  options.analytics.track('bot_started', {
    guild_count: discord.guilds.cache.size,
    ...(!(projects instanceof Error) && { user_project_count: projects }),
  })
  const resources = cleanup.move()
  let stopping: Promise<void> | undefined
  return { ...bot, lock, scheduler: { runDueTasks: scheduler.runDueTasks }, stop: () => (stopping ??= resources.disposeAsync()) }
}
