// Gateway-proxy reconnection test.
//
// Parameterized: can test against local digital-twin OR a real production gateway.
//
// Local mode (default):
//   Starts a digital-twin + local gateway-proxy binary, kills and restarts the proxy.
//
// Production mode (env vars):
//   GATEWAY_TEST_URL        - production gateway WS+REST URL (e.g. wss://discord-gateway.kimaki.dev)
//   GATEWAY_TEST_TOKEN      - client token (clientId:secret)
//   GATEWAY_TEST_REDEPLOY   - if "1", runs `fly deploy` between kill/restart instead of local binary
//
// Usage:
//   # Local (needs gateway-proxy binary built):
//   pnpm test --run src/gateway-proxy-reconnect.e2e.test.ts
//
//   # Against production (just connect + kill WS + wait for reconnect):
//   GATEWAY_TEST_URL=wss://discord-gateway.kimaki.dev \
//   GATEWAY_TEST_TOKEN=myclientid:mysecret \
//   KIMAKI_TEST_LOGS=1 \
//   pnpm test --run src/gateway-proxy-reconnect.e2e.test.ts -t "production"

import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { describe, test, expect, afterAll, afterEach } from 'vitest'
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import { setGlobalDispatcher, Agent } from 'undici'

// Match production discord-bot.ts settings: increase connection pool and
// disable timeouts so REST calls don't hang during gateway redeploys.
setGlobalDispatcher(
  new Agent({ headersTimeout: 0, bodyTimeout: 0, connections: 500 }),
)

// --- Config from env ---

const PROD_GATEWAY_URL = process.env['GATEWAY_TEST_URL'] || ''
const PROD_TOKEN = process.env['GATEWAY_TEST_TOKEN'] || ''
const isProdTest = !!(PROD_GATEWAY_URL && PROD_TOKEN)

// --- Constants ---

const DEBUG_BINARY = path.resolve(
  process.cwd(),
  '..',
  'gateway-proxy',
  'target',
  'debug',
  'gateway-proxy',
)
const RELEASE_BINARY = path.resolve(
  process.cwd(),
  '..',
  'gateway-proxy',
  'target',
  'release',
  'gateway-proxy',
)
const BINARY_PATH = fs.existsSync(DEBUG_BINARY) ? DEBUG_BINARY : RELEASE_BINARY
const binaryExists = fs.existsSync(BINARY_PATH)

const GUILD_ID = '800000000000000001'
const CHANNEL_ID = '800000000000000010'
const USER_ID = '800000000000000099'

// --- Helpers ---

function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') {
        srv.close()
        reject(new Error('Failed to get port'))
        return
      }
      const port = addr.port
      srv.close(() => {
        resolve(port)
      })
    })
  })
}

async function waitForProxyReady({
  port,
  timeoutMs = 30_000,
}: {
  port: number
  timeoutMs?: number
}): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/shard-count`)
      if (res.ok) {
        return
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => {
      setTimeout(r, 200)
    })
  }
  throw new Error(`gateway-proxy not ready after ${timeoutMs}ms`)
}

interface ProxyConfig {
  configDir: string
  port: number
  twinPort: number
  botToken: string
  gatewayUrl: string
  clients?: Record<string, { secret: string; guilds: string[] }>
}

function startProxy({
  configDir,
  port,
  twinPort,
  botToken,
  gatewayUrl,
  clients,
}: ProxyConfig): ChildProcess {
  const config: Record<string, unknown> = {
    log_level: 'debug',
    token: botToken,
    intents: 32511,
    shards: 1,
    port,
    validate_token: !clients,
    gateway_url: gatewayUrl,
    twilight_http_proxy: `127.0.0.1:${twinPort}`,
    externally_accessible_url: `ws://127.0.0.1:${port}`,
    cache: {
      channels: true,
      presences: false,
      emojis: false,
      current_member: true,
      members: false,
      roles: true,
      scheduled_events: false,
      stage_instances: false,
      stickers: false,
      users: false,
      voice_states: false,
    },
  }
  if (clients) {
    config.clients = clients
  }

  const configPath = path.join(configDir, 'config.json')
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))

  const child = spawn(BINARY_PATH, [], {
    cwd: configDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RUST_LOG: 'debug' },
  })

  const showLogs = !!process.env['KIMAKI_TEST_LOGS']
  const logLines: string[] = []
  child.stdout?.on('data', (data: Buffer) => {
    const line = data.toString().trim()
    if (line) {
      logLines.push(`[proxy-stdout] ${line}`)
      if (showLogs) {
        console.log(`[proxy-stdout] ${line}`)
      }
    }
  })
  child.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim()
    if (line) {
      logLines.push(`[proxy-stderr] ${line}`)
      if (showLogs) {
        console.log(`[proxy-stderr] ${line}`)
      }
    }
  })

  ;(child as ChildProcess & { _logLines?: string[] })._logLines = logLines
  return child
}

function dumpProxyLogs(child: ChildProcess) {
  const logLines = (child as ChildProcess & { _logLines?: string[] })._logLines
  if (logLines?.length) {
    console.log('\n--- proxy logs ---')
    for (const line of logLines) {
      console.log(line)
    }
    console.log('--- end proxy logs ---\n')
  }
}

function killProxy(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.killed || child.exitCode !== null) {
      resolve()
      return
    }
    child.once('exit', () => {
      resolve()
    })
    child.kill('SIGTERM')
  })
}

function createDiscordJsClient({ restUrl }: { restUrl: string }) {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
    rest: { api: restUrl },
  })
}

/** Attach all shard event listeners and collect events into an array for diagnosis. */
function attachEventCollector({
  client,
  label,
}: {
  client: Client
  label: string
}): string[] {
  const events: string[] = []
  client.on(Events.ShardReady, (shardId) => {
    events.push(`ShardReady:${shardId}`)
    console.log(`[${label}] ShardReady shard=${shardId}`)
  })
  client.on(Events.ShardReconnecting, (shardId) => {
    events.push(`ShardReconnecting:${shardId}`)
    console.log(`[${label}] ShardReconnecting shard=${shardId}`)
  })
  client.on(Events.ShardResume, (shardId, replayed) => {
    events.push(`ShardResume:${shardId}:${replayed}`)
    console.log(`[${label}] ShardResume shard=${shardId} replayed=${replayed}`)
  })
  client.on(Events.ShardDisconnect, (event, shardId) => {
    events.push(`ShardDisconnect:${shardId}:${event.code}`)
    console.log(`[${label}] ShardDisconnect shard=${shardId} code=${event.code}`)
  })
  client.on(Events.ShardError, (error, shardId) => {
    events.push(`ShardError:${shardId}:${error.message}`)
    console.log(`[${label}] ShardError shard=${shardId} error=${error.message}`)
  })
  client.on(Events.Invalidated, () => {
    events.push('Invalidated')
    console.log(`[${label}] Session invalidated`)
  })
  client.on(Events.Error, (error) => {
    events.push(`Error:${error.message}`)
    console.log(`[${label}] Client error: ${error.message}`)
  })
  client.on(Events.Debug, (info) => {
    if (
      info.includes('close') ||
      info.includes('Close') ||
      info.includes('CLOSE') ||
      info.includes('destroy') ||
      info.includes('session') ||
      info.includes('Session') ||
      info.includes('IDENTIFY') ||
      info.includes('RESUME') ||
      info.includes('Identifying') ||
      info.includes('Resuming') ||
      info.includes('Invalid') ||
      info.includes('Zombie') ||
      info.includes('econnr') ||
      info.includes('fetch') ||
      info.includes('Fetch') ||
      info.includes('error') ||
      info.includes('Error') ||
      info.includes('Gateway Information') ||
      info.includes('fully ready')
    ) {
      events.push(`Debug:${info}`)
      console.log(`[${label}] Debug: ${info}`)
    }
  })
  return events
}

function waitForClientReady({
  client,
  token,
  timeoutMs = 30_000,
}: {
  client: Client
  token: string
  timeoutMs?: number
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Client did not become ready within ${timeoutMs}ms`))
    }, timeoutMs)
    client.once(Events.ClientReady, () => {
      clearTimeout(timeout)
      resolve()
    })
    client.login(token).catch(reject)
  })
}

function waitForReconnection({
  client,
  events,
  label,
  timeoutMs = 30_000,
}: {
  client: Client
  events: string[]
  label: string
  timeoutMs?: number
}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      console.log(`[${label}] TIMEOUT: client did not reconnect within ${timeoutMs}ms`)
      console.log(`[${label}] Events so far:`, events)
      resolve(false)
    }, timeoutMs)

    client.on(Events.ShardReady, () => {
      clearTimeout(timeout)
      resolve(true)
    })
    client.on(Events.ShardResume, () => {
      clearTimeout(timeout)
      resolve(true)
    })
  })
}

// ============================================================================
// Local tests (digital-twin + local binary)
// ============================================================================

const describeLocal = binaryExists ? describe : describe.skip

describeLocal('gateway-proxy reconnection (local binary)', () => {
  let discord: DigitalDiscord
  let proxyProcess: ChildProcess
  let client: Client
  let proxyPort: number
  let tmpDir: string

  afterAll(async () => {
    client?.destroy()
    if (proxyProcess && !proxyProcess.killed) {
      proxyProcess.kill('SIGTERM')
    }
    await discord?.stop().catch(() => {})
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  }, 5_000)

  test(
    'reconnects after local proxy restart (REST through proxy, clientId:secret)',
    async () => {
      tmpDir = fs.mkdtempSync(path.join(process.cwd(), 'tmp', 'gw-reconnect-'))
      proxyPort = await getAvailablePort()

      const CLIENT_ID = 'test-client'
      const CLIENT_SECRET = 'test-secret-12345'
      const CLIENT_TOKEN = `${CLIENT_ID}:${CLIENT_SECRET}`

      discord = new DigitalDiscord({
        guilds: [
          {
            id: GUILD_ID,
            name: 'Reconnect Test Guild',
            ownerId: USER_ID,
            channels: [{ id: CHANNEL_ID, name: 'general', type: ChannelType.GuildText }],
          },
        ],
        users: [{ id: USER_ID, username: 'reconnect-tester' }],
        gatewayUrlOverride: `ws://127.0.0.1:${proxyPort}`,
        dbUrl: `file:${path.join(tmpDir, 'twin.db')}`,
      })
      await discord.start()
      console.log(`[local] twin at port ${discord.port}, proxy will be at ${proxyPort}`)

      const proxyConfigDir = path.join(tmpDir, 'proxy-config')
      fs.mkdirSync(proxyConfigDir, { recursive: true })

      const proxyOpts: ProxyConfig = {
        configDir: proxyConfigDir,
        port: proxyPort,
        twinPort: discord.port,
        botToken: discord.botToken,
        gatewayUrl: discord.gatewayUrl,
        clients: { [CLIENT_ID]: { secret: CLIENT_SECRET, guilds: [GUILD_ID] } },
      }
      proxyProcess = startProxy(proxyOpts)
      await waitForProxyReady({ port: proxyPort })

      // REST through proxy (matches production gateway mode)
      client = createDiscordJsClient({ restUrl: `http://127.0.0.1:${proxyPort}/api` })
      const events = attachEventCollector({ client, label: 'local' })
      await waitForClientReady({ client, token: CLIENT_TOKEN })
      console.log('[local] Client ready')

      // Kill proxy
      const firstProxy = proxyProcess
      await killProxy(proxyProcess)
      await new Promise((r) => { setTimeout(r, 1000) })

      // Restart proxy on same port
      proxyProcess = startProxy(proxyOpts)
      await waitForProxyReady({ port: proxyPort })
      console.log('[local] Proxy restarted')

      const reconnected = await waitForReconnection({ client, events, label: 'local' })
      console.log('[local] All events:', events)
      if (!reconnected) {
        dumpProxyLogs(firstProxy)
        dumpProxyLogs(proxyProcess)
      }

      expect(reconnected).toBe(true)
      expect(client.isReady()).toBe(true)
    },
    90_000,
  )
})

// ============================================================================
// Production test (real gateway proxy on Fly.io)
// ============================================================================

const describeProd = isProdTest ? describe : describe.skip

describeProd('gateway-proxy reconnection (production)', () => {
  let client: Client

  afterEach(() => {
    client?.destroy()
  })

  test(
    'discord.js reconnects to production gateway after fly deploy',
    async () => {
      // Derive REST URL from gateway WS URL (wss://host → https://host/api)
      const parsedUrl = new URL(PROD_GATEWAY_URL)
      parsedUrl.protocol = parsedUrl.protocol === 'wss:' ? 'https:' : 'http:'
      const restUrl = `${parsedUrl.origin}/api`

      console.log(`[prod] Gateway URL: ${PROD_GATEWAY_URL}`)
      console.log(`[prod] REST URL: ${restUrl}`)
      console.log(`[prod] Token: ${PROD_TOKEN.slice(0, 8)}...`)

      client = createDiscordJsClient({ restUrl })
      const events = attachEventCollector({ client, label: 'prod' })

      // Connect to production gateway
      await waitForClientReady({ client, token: PROD_TOKEN, timeoutMs: 60_000 })
      console.log(`[prod] Client ready. Guilds: ${client.guilds.cache.size}`)
      expect(client.guilds.cache.size).toBeGreaterThanOrEqual(1)

      // Deploy the gateway (restarts the Fly machine).
      // Uses `pnpm run deploy` which cross-compiles Rust locally then deploys
      // via Dockerfile.fly. Never use `fly deploy` directly.
      console.log('[prod] Running pnpm run deploy to restart gateway...')
      const deployResult = await new Promise<{ code: number; output: string }>((resolve) => {
        const deployChild = spawn(
          'pnpm',
          ['run', 'deploy'],
          {
            cwd: path.resolve(process.cwd(), '..', 'gateway-proxy'),
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
        let output = ''
        deployChild.stdout?.on('data', (d: Buffer) => {
          const line = d.toString()
          output += line
          console.log(`[fly] ${line.trim()}`)
        })
        deployChild.stderr?.on('data', (d: Buffer) => {
          const line = d.toString()
          output += line
          console.log(`[fly-err] ${line.trim()}`)
        })
        deployChild.on('exit', (code) => {
          resolve({ code: code ?? 1, output })
        })
      })
      console.log(`[prod] Deploy exited with code ${deployResult.code}`)

      // Wait for reconnection (longer timeout for production)
      const reconnected = await waitForReconnection({
        client,
        events,
        label: 'prod',
        timeoutMs: 120_000,
      })

      console.log('[prod] All events:', events)

      expect(reconnected).toBe(true)
      expect(client.isReady()).toBe(true)
      expect(client.guilds.cache.size).toBeGreaterThanOrEqual(1)
    },
    300_000, // 5min timeout for deploy + reconnect
  )
})
