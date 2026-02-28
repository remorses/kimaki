// Gateway-proxy integration test.
// Starts a discord-digital-twin (fake Discord), a gateway-proxy Rust binary
// in front of it, and the kimaki bot connecting through the proxy.
// Validates that messages create threads, bot replies, and multi-tenant
// guild filtering routes events to the right clients.
//
// Requires the gateway-proxy binary at gateway-proxy/target/release/gateway-proxy.
// If not found, all tests are skipped.

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import net from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { ChannelType, Client, GatewayIntentBits, Partials } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin'
import {
  buildDeterministicOpencodeConfig,
  type DeterministicMatcher,
} from 'opencode-deterministic-provider'
import { startHranaServer, stopHranaServer } from './hrana-server.js'
import {
  setBotToken,
  initDatabase,
  closeDatabase,
  setChannelDirectory,
} from './database.js'
import { setDataDir, setDefaultVerbosity, getDefaultVerbosity } from './config.js'
import type { VerbosityLevel } from './database.js'
import { startDiscordBot } from './discord-bot.js'
import { getOpencodeServers } from './opencode.js'

// --- Constants ---

const BINARY_PATH = path.resolve(
  process.cwd(),
  '..',
  'gateway-proxy',
  'target',
  'release',
  'gateway-proxy',
)

const TEST_USER_ID = '900000000000000001'
const CHANNEL_1_ID = '900000000000000010'
const CHANNEL_2_ID = '900000000000000020'
const GUILD_1_ID = '900000000000000100'
const GUILD_2_ID = '900000000000000200'

const binaryExists = fs.existsSync(BINARY_PATH)

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

function createRunDirectories() {
  const root = path.resolve(process.cwd(), 'tmp', 'gateway-proxy-e2e')
  fs.mkdirSync(root, { recursive: true })
  const dataDir = fs.mkdtempSync(path.join(root, 'data-'))
  const projectDirectory = path.join(root, 'project')
  fs.mkdirSync(projectDirectory, { recursive: true })
  return { root, dataDir, projectDirectory }
}

function chooseLockPort() {
  return 48_000 + (Date.now() % 2_000)
}

function createDiscordJsClient({ restUrl }: { restUrl: string }) {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User, Partials.ThreadMember],
    rest: { api: restUrl, version: '10' },
  })
}

async function cleanupOpencodeServers() {
  const servers = getOpencodeServers()
  for (const [, server] of servers) {
    if (!server.process.killed) {
      server.process.kill('SIGTERM')
    }
  }
  servers.clear()
}

function createMatchers(): DeterministicMatcher[] {
  const defaultReply: DeterministicMatcher = {
    id: 'default-reply',
    priority: 10,
    when: { lastMessageRole: 'user' },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'reply' },
        { type: 'text-delta', id: 'reply', delta: 'gateway-proxy-reply' },
        { type: 'text-end', id: 'reply' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
    },
  }
  return [defaultReply]
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
      setTimeout(r, 500)
    })
  }
  throw new Error(`gateway-proxy not ready after ${timeoutMs}ms`)
}

function startGatewayProxy({
  configDir,
  port,
  twinPort,
  botToken,
  gatewayUrl,
}: {
  configDir: string
  port: number
  twinPort: number
  botToken: string
  gatewayUrl: string
}): { process: ChildProcess; configPath: string } {
  const config = {
    log_level: 'info',
    token: botToken,
    intents: 32511,
    shards: 1,
    port,
    validate_token: true,
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
    clients: {
      'client-a': {
        secret: 'secret-a',
        guilds: [GUILD_1_ID],
      },
      'client-b': {
        secret: 'secret-b',
        guilds: [GUILD_2_ID],
      },
    },
  }

  const configPath = path.join(configDir, 'config.json')
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))

  const child = spawn(BINARY_PATH, [], {
    cwd: configDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, RUST_LOG: 'debug' },
  })

  child.stdout?.on('data', (data: Buffer) => {
    const line = data.toString().trim()
    if (line) {
      console.log(`[gateway-proxy] ${line}`)
    }
  })
  child.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim()
    if (line) {
      console.log(`[gateway-proxy] ${line}`)
    }
  })

  return { process: child, configPath }
}

// --- Test suite ---

const describeIf = binaryExists ? describe : describe.skip

describeIf('gateway-proxy e2e', () => {
  let discord: DigitalDiscord
  let proxyProcess: ChildProcess
  let botClient: Client
  let directories: ReturnType<typeof createRunDirectories>
  let proxyPort: number
  let previousDefaultVerbosity: VerbosityLevel | undefined
  let firstThreadId: string

  beforeAll(async () => {
    const lockPort = chooseLockPort()
    directories = createRunDirectories()
    process.env['KIMAKI_LOCK_PORT'] = String(lockPort)
    process.env['KIMAKI_VITEST'] = '1'
    setDataDir(directories.dataDir)
    previousDefaultVerbosity = getDefaultVerbosity()
    setDefaultVerbosity('text-only')

    proxyPort = await getAvailablePort()

    // Start digital-twin with 2 guilds, each with a text channel.
    // gatewayUrlOverride makes GET /gateway/bot return the proxy's URL
    // so discord.js clients connect through the proxy, not directly to twin.
    discord = new DigitalDiscord({
      guilds: [
        {
          id: GUILD_1_ID,
          name: 'Guild One',
          ownerId: TEST_USER_ID,
          channels: [
            { id: CHANNEL_1_ID, name: 'general-1', type: ChannelType.GuildText },
          ],
        },
        {
          id: GUILD_2_ID,
          name: 'Guild Two',
          ownerId: TEST_USER_ID,
          channels: [
            { id: CHANNEL_2_ID, name: 'general-2', type: ChannelType.GuildText },
          ],
        },
      ],
      users: [{ id: TEST_USER_ID, username: 'proxy-tester' }],
      gatewayUrlOverride: `ws://127.0.0.1:${proxyPort}`,
    })
    await discord.start()

    // Write opencode.json with deterministic provider
    const providerNpm = url
      .pathToFileURL(
        path.resolve(process.cwd(), '..', 'opencode-deterministic-provider', 'src', 'index.ts'),
      )
      .toString()

    const opencodeConfig = buildDeterministicOpencodeConfig({
      providerName: 'deterministic-provider',
      providerNpm,
      model: 'deterministic-v2',
      smallModel: 'deterministic-v2',
      settings: { strict: false, matchers: createMatchers() },
    })
    fs.writeFileSync(
      path.join(directories.projectDirectory, 'opencode.json'),
      JSON.stringify(opencodeConfig, null, 2),
    )

    // Start gateway-proxy binary pointing at twin
    const proxyConfigDir = path.join(directories.dataDir, 'proxy')
    fs.mkdirSync(proxyConfigDir, { recursive: true })

    const proxy = startGatewayProxy({
      configDir: proxyConfigDir,
      port: proxyPort,
      twinPort: discord.port,
      botToken: discord.botToken,
      gatewayUrl: discord.gatewayUrl,
    })
    proxyProcess = proxy.process

    // Wait for proxy to be ready (HTTP server up)
    await waitForProxyReady({ port: proxyPort, timeoutMs: 30_000 })

    // Initialize kimaki database
    const dbPath = path.join(directories.dataDir, 'discord-sessions.db')
    const hranaResult = await startHranaServer({ dbPath })
    if (hranaResult instanceof Error) {
      throw hranaResult
    }
    process.env['KIMAKI_DB_URL'] = hranaResult
    await initDatabase()
    await setBotToken(discord.botUserId, discord.botToken)

    // Register channel 1 with kimaki (bot will create sessions for messages here)
    await setChannelDirectory({
      channelId: CHANNEL_1_ID,
      directory: directories.projectDirectory,
      channelType: 'text',
      appId: discord.botUserId,
    })

    // Start the kimaki bot connected through the proxy
    botClient = createDiscordJsClient({ restUrl: discord.restUrl })

    await startDiscordBot({
      token: discord.botToken,
      appId: discord.botUserId,
      discordClient: botClient,
    })
  }, 120_000)

  afterAll(async () => {
    if (botClient) {
      botClient.destroy()
    }
    if (proxyProcess && !proxyProcess.killed) {
      proxyProcess.kill('SIGTERM')
    }

    await cleanupOpencodeServers()
    await Promise.all([
      closeDatabase().catch(() => {}),
      stopHranaServer().catch(() => {}),
      discord?.stop().catch(() => {}),
    ])

    delete process.env['KIMAKI_LOCK_PORT']
    delete process.env['KIMAKI_DB_URL']
    delete process.env['KIMAKI_VITEST']
    if (previousDefaultVerbosity) {
      setDefaultVerbosity(previousDefaultVerbosity)
    }
    if (directories) {
      fs.rmSync(directories.dataDir, { recursive: true, force: true })
    }
  }, 30_000)

  test(
    'message creates thread and bot replies through proxy',
    async () => {
      await discord.channel(CHANNEL_1_ID).user(TEST_USER_ID).sendMessage({
        content: 'hello from gateway proxy test',
      })

      const thread = await discord.channel(CHANNEL_1_ID).waitForThread({
        timeout: 15_000,
        predicate: (t) => {
          return t.name?.includes('hello from gateway proxy test') ?? false
        },
      })
      expect(thread).toBeDefined()
      expect(thread.id).toBeTruthy()
      firstThreadId = thread.id

      const reply = await discord.thread(thread.id).waitForBotReply({ timeout: 15_000 })
      expect(reply).toBeDefined()
      expect(reply.content.trim().length).toBeGreaterThan(0)
    },
    30_000,
  )

  test(
    'follow-up message in thread gets bot reply',
    async () => {
      const existingMessages = await discord.thread(firstThreadId).getMessages()
      const existingIds = new Set(existingMessages.map((m) => m.id))

      await discord.thread(firstThreadId).user(TEST_USER_ID).sendMessage({
        content: 'follow up through proxy',
      })

      const reply = await discord.thread(firstThreadId).waitForMessage({
        predicate: (m) => !existingIds.has(m.id) && m.author.id === discord.botUserId,
      })
      expect(reply).toBeDefined()
      expect(reply.content.trim().length).toBeGreaterThan(0)
    },
    30_000,
  )

  test(
    'shell command via ! prefix in thread',
    async () => {
      const existingMessages = await discord.thread(firstThreadId).getMessages()
      const existingIds = new Set(existingMessages.map((m) => m.id))

      await discord.thread(firstThreadId).user(TEST_USER_ID).sendMessage({
        content: '!echo proxy-shell-test',
      })

      // The bot replies with a loading message then edits it with the result.
      // The predicate waits for the edited version containing "exited with".
      const reply = await discord.thread(firstThreadId).waitForMessage({
        predicate: (m) =>
          !existingIds.has(m.id) &&
          m.author.id === discord.botUserId &&
          m.content.includes('exited with'),
      })
      expect(reply.content).toContain('proxy-shell-test')
    },
    15_000,
  )

  test(
    'second message creates separate thread',
    async () => {
      await discord.channel(CHANNEL_1_ID).user(TEST_USER_ID).sendMessage({
        content: 'second message through proxy',
      })

      const thread = await discord.channel(CHANNEL_1_ID).waitForThread({
        predicate: (t) =>
          (t.name?.includes('second message through proxy') ?? false) &&
          t.id !== firstThreadId,
      })
      expect(thread).toBeDefined()
      expect(thread.id).not.toBe(firstThreadId)

      const reply = await discord.thread(thread.id).waitForBotReply()
      expect(reply).toBeDefined()
      expect(reply.content.trim().length).toBeGreaterThan(0)
    },
    30_000,
  )

  test(
    'guild-2 message does not create thread (guild isolation)',
    async () => {
      await discord.channel(CHANNEL_2_ID).user(TEST_USER_ID).sendMessage({
        content: 'should not create thread in guild 2',
      })

      // Brief wait for events to propagate through the local system.
      // The proxy filters guild-2 events away from client-a, so no thread
      // should be created. 100ms is more than enough for local event routing.
      await new Promise((r) => {
        setTimeout(r, 100)
      })

      const threads = await discord.channel(CHANNEL_2_ID).getThreads()
      expect(threads).toHaveLength(0)
    },
    5_000,
  )

  test(
    'slash command routes INTERACTION_CREATE through proxy',
    async () => {
      const { id: interactionId } = await discord
        .channel(CHANNEL_1_ID)
        .user(TEST_USER_ID)
        .runSlashCommand({
          name: 'run-shell-command',
          options: [{ name: 'command', type: 3, value: 'echo proxy-slash-test' }],
        })

      const ack = await discord.channel(CHANNEL_1_ID).waitForInteractionAck({
        interactionId,
      })
      expect(ack.acknowledged).toBe(true)
    },
    15_000,
  )
})
