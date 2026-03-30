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
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  Routes,
} from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
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
import { setDataDir } from './config.js'
import type { VerbosityLevel } from './database.js'
import { startDiscordBot } from './discord-bot.js'
import {
  chooseLockPort,
  cleanupTestSessions,
  initTestGitRepo,
  waitForFooterMessage,
} from './test-utils.js'
import { stopOpencodeServer } from './opencode.js'
import { createDiscordRest } from './discord-urls.js'
import { store } from './store.js'

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
  initTestGitRepo(projectDirectory)
  return { root, dataDir, projectDirectory }
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

function hasStringId(value: unknown): value is { id: string } {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  if (!('id' in value)) {
    return false
  }
  return typeof value.id === 'string'
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

  const showLogs = !!process.env['KIMAKI_TEST_LOGS']
  child.stdout?.on('data', (data: Buffer) => {
    const line = data.toString().trim()
    if (line && showLogs) {
      console.log(`[gateway-proxy] ${line}`)
    }
  })
  child.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim()
    if (line && showLogs) {
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
  let testStartTime = Date.now()

  beforeAll(async () => {
    testStartTime = Date.now()
    const lockPort = chooseLockPort({ key: CHANNEL_1_ID })
    directories = createRunDirectories()
    process.env['KIMAKI_LOCK_PORT'] = String(lockPort)
    process.env['KIMAKI_VITEST'] = '1'
    setDataDir(directories.dataDir)
    previousDefaultVerbosity = store.getState().defaultVerbosity
    store.setState({ defaultVerbosity: 'text_only' })

    const digitalDiscordDbPath = path.join(
      directories.dataDir,
      'digital-discord.db',
    )

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
      dbUrl: `file:${digitalDiscordDbPath}`,
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
    if (directories) {
      await cleanupTestSessions({
        projectDirectory: directories.projectDirectory,
        testStartTime,
      })
    }

    if (botClient) {
      botClient.destroy()
    }
    if (proxyProcess && !proxyProcess.killed) {
      proxyProcess.kill('SIGTERM')
    }

    await stopOpencodeServer()
    await Promise.all([
      closeDatabase().catch(() => {}),
      stopHranaServer().catch(() => {}),
      discord?.stop().catch(() => {}),
    ])

    delete process.env['KIMAKI_LOCK_PORT']
    delete process.env['KIMAKI_DB_URL']
    delete process.env['KIMAKI_VITEST']
    if (previousDefaultVerbosity) {
      store.setState({ defaultVerbosity: previousDefaultVerbosity })
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

      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 15_000,
      })

      expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
        "--- from: user (proxy-tester)
        hello from gateway proxy test
        --- from: assistant (TestBot)
        ⬥ gateway-proxy-reply
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
      expect(reply).toBeDefined()
      expect(reply.content.trim().length).toBeGreaterThan(0)
    },
    15_000,
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

      await waitForFooterMessage({
        discord,
        threadId: firstThreadId,
        timeout: 4_000,
        afterMessageIncludes: 'follow up through proxy',
        afterAuthorId: TEST_USER_ID,
      })

      expect(await discord.thread(firstThreadId).text()).toMatchInlineSnapshot(`
        "--- from: user (proxy-tester)
        hello from gateway proxy test
        --- from: assistant (TestBot)
        ⬥ gateway-proxy-reply
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (proxy-tester)
        follow up through proxy
        --- from: assistant (TestBot)
        ⬥ gateway-proxy-reply
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
      expect(reply).toBeDefined()
      expect(reply.content.trim().length).toBeGreaterThan(0)
    },
    15_000,
  )

  // Reconnect test lives in gateway-proxy-reconnect.e2e.test.ts.
  // It was here before but kills the proxy mid-suite, breaking shared
  // state (bot/proxy connection) for all subsequent tests.

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
      expect(await discord.thread(firstThreadId).text()).toMatchInlineSnapshot(`
        "--- from: user (proxy-tester)
        hello from gateway proxy test
        --- from: assistant (TestBot)
        ⬥ gateway-proxy-reply
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (proxy-tester)
        follow up through proxy
        --- from: assistant (TestBot)
        ⬥ gateway-proxy-reply
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (proxy-tester)
        !echo proxy-shell-test
        --- from: assistant (TestBot)
        \`echo proxy-shell-test\` exited with 0
        \`\`\`
        proxy-shell-test
        \`\`\`"
      `)
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
      expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
        "--- from: user (proxy-tester)
        second message through proxy
        --- from: assistant (TestBot)
        ⬥ gateway-proxy-reply"
      `)
      expect(reply).toBeDefined()
      expect(reply.content.trim().length).toBeGreaterThan(0)
    },
    15_000,
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

  test(
    'REST client operations work through proxy and enforce guild scope',
    async () => {
      const previousBaseUrl = store.getState().discordBaseUrl
      store.setState({ discordBaseUrl: `http://127.0.0.1:${proxyPort}` })

      try {
        const botRest = createDiscordRest(discord.botToken)
        const clientRest = createDiscordRest('client-a:secret-a')

        const posted = await botRest.post(Routes.channelMessages(CHANNEL_1_ID), {
          body: { content: 'rest-proxy-test-message' },
        })
        expect(hasStringId(posted)).toBe(true)
        if (!hasStringId(posted)) {
          throw new Error('Expected REST message create response to include id')
        }

        const thread = await botRest.post(
          Routes.threads(CHANNEL_1_ID, posted.id),
          {
            body: { name: 'rest-proxy-thread' },
          },
        )
        expect(hasStringId(thread)).toBe(true)

        const channel = await botRest.get(Routes.channel(CHANNEL_1_ID))
        expect(hasStringId(channel)).toBe(true)

        const guildChannels = await clientRest.get(
          Routes.guildChannels(GUILD_1_ID),
        )
        expect(Array.isArray(guildChannels)).toBe(true)

        const forbiddenGuildResponse = await fetch(
          `http://127.0.0.1:${proxyPort}/api/v10${Routes.guildChannels(GUILD_2_ID)}`,
          {
            method: 'GET',
            headers: {
              Authorization: 'Bot client-a:secret-a',
            },
          },
        )
        expect(forbiddenGuildResponse.status).toBe(403)

        const gatewayInfo = await clientRest.get(Routes.gatewayBot())
        expect(typeof gatewayInfo).toBe('object')

        const me = await clientRest.get(Routes.user('@me'))
        expect(hasStringId(me)).toBe(true)
      } finally {
        store.setState({ discordBaseUrl: previousBaseUrl })
      }
    },
    15_000,
  )
})
