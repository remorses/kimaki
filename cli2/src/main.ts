// Bot wiring. Order: lock port -> SQLite (migrate) -> OpenCode service and
// Discord login in parallel. Returns a handle so tests can drive the bot
// in-process and stop it cleanly.

import { Client, Events, GatewayIntentBits, Partials } from 'discord.js'

import { openDb, type OpenedDb } from './db.ts'
import { DiscordError } from './errors.ts'
import { createLogger, setLogFile } from './logger.ts'
import { startLockServer, type LockServer } from './lock-server.ts'
import { watchOpencode, type OpencodeConnection } from './opencode-server.ts'

const logger = createLogger('MAIN')

export type StartBotOptions = {
  dataDir: string
  token: string
  lockPort: number
  // Test only: digital twin REST base URL. The gateway URL comes from /gateway/bot.
  discordRestUrl?: string
  // Registration file of the OpenCode service. Defaults to the XDG state dir.
  opencodeServiceFile?: string
  // Start the service with Service.ensure() when none is running.
  ensureOpencode: boolean
}

export type BotHandle = {
  discord: Client
  opencode: OpencodeConnection
  db: OpenedDb
  lock: LockServer
  stop: () => Promise<void>
}

function createDiscordClient({ restUrl }: { restUrl?: string }): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Channel, Partials.Message, Partials.User, Partials.ThreadMember],
    ...(restUrl && { rest: { api: restUrl, version: '10' } }),
  })
}

async function loginDiscord({ discord, token }: { discord: Client; token: string }): Promise<DiscordError | void> {
  const ready = new Promise<void>((resolve) => discord.once(Events.ClientReady, () => resolve()))
  const login = await discord.login(token).catch((e) => new DiscordError({ operation: 'login', cause: e }))
  if (login instanceof Error) return login
  await ready
}

export async function startBot(options: StartBotOptions): Promise<Error | BotHandle> {
  setLogFile({ dataDir: options.dataDir })

  const lock = await startLockServer({ port: options.lockPort })
  if (lock instanceof Error) return lock

  const db = await openDb({ dataDir: options.dataDir, migrate: true })
  if (db instanceof Error) {
    await lock.close()
    return db
  }

  const discord = createDiscordClient({ restUrl: options.discordRestUrl })
  const opencode = watchOpencode({
    serviceFile: options.opencodeServiceFile,
    ensure: options.ensureOpencode,
    onConnect: async () => {},
    onEvent: () => {},
    onDisconnect: () => {},
  })

  const stop = async () => {
    opencode.stop()
    await discord.destroy()
    db.close()
    await lock.close()
  }

  const [opencodeReady, discordReady] = await Promise.all([
    opencode.ready,
    loginDiscord({ discord, token: options.token }),
  ])
  if (opencodeReady instanceof Error) {
    await stop()
    return opencodeReady
  }
  if (discordReady instanceof Error) {
    await stop()
    return discordReady
  }
  logger.log(`bot ready as ${discord.user?.tag}`)
  return { discord, opencode, db, lock, stop }
}
