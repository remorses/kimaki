// Bot wiring. Order: lock port -> SQLite (migrate) -> OpenCode service and
// Discord login in parallel. Returns a handle so tests can drive the bot
// in-process and stop it cleanly.

import { Client, Events, GatewayIntentBits, Partials } from 'discord.js'

import { createActions, type Actions } from './actions.ts'
import { openDb, type OpenedDb } from './db.ts'
import { createEffectsRunner } from './effects.ts'
import { DiscordError } from './errors.ts'
import { createEventLoop } from './event-loop.ts'
import { createEventRecorder } from './session-events.ts'
import { registerSlashCommands } from './slash-commands.ts'
import { registerIngress } from './ingress.ts'
import { createLogger, setLogFile } from './logger.ts'
import { startLockServer, type LockServer } from './lock-server.ts'
import { watchOpencode, type OpencodeConnection, type OpencodeEndpoint } from './opencode-server.ts'
import { createBotStore, type BotStore } from './store.ts'

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

  const lock = await startLockServer({ port: options.lockPort })
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
  const actions = createActions({ discord, db: db.db, opencode, eventLoop })
  registerIngress({ discord, db: db.db, actions })

  const stop = async () => {
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
  registerSlashCommands({ discord, db: db.db, kimaki: options.kimakiCommand })
  logger.log(`bot ready as ${discord.user?.tag}`)
  return { discord, opencode, db, lock, store, actions, stop }
}
