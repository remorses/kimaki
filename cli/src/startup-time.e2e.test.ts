// Measures time-to-ready for the kimaki Discord bot startup.
// Used as a baseline to track startup performance and guide optimizations
// for scale-to-zero deployments where cold start time is critical.
//
// Measures each phase independently:
//   1. Hrana server start (DB + lock port)
//   2. Database init (Prisma connect via HTTP)
//   3. Discord.js client creation + login (Gateway READY)
//   4. startDiscordBot (event handlers + markDiscordGatewayReady)
//   5. OpenCode server startup (spawn + health poll)
//   6. Total wall-clock time from zero to "bot ready"
//
// Uses discord-digital-twin so Gateway READY is instant (no real Discord).
// OpenCode startup uses deterministic provider (no real LLM).

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { describe, test, expect, afterAll } from 'vitest'
import { ChannelType, Client, GatewayIntentBits, Partials } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import {
  buildDeterministicOpencodeConfig,
  type DeterministicMatcher,
} from 'opencode-deterministic-provider'
import { setDataDir } from './config.js'
import { startDiscordBot } from './discord-bot.js'
import {
  setBotToken,
  initDatabase,
  closeDatabase,
  setChannelDirectory,
} from './database.js'
import { startHranaServer, stopHranaServer } from './hrana-server.js'
import { initializeOpencodeForDirectory, stopOpencodeServer } from './opencode.js'
import { chooseLockPort, cleanupTestSessions, initTestGitRepo } from './test-utils.js'

interface PhaseTimings {
  hranaServerMs: number
  databaseInitMs: number
  discordLoginMs: number
  startDiscordBotMs: number
  opencodeServerMs: number
  totalMs: number
}

function createRunDirectories() {
  const root = path.resolve(process.cwd(), 'tmp', 'startup-time-e2e')
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
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [
      Partials.Channel,
      Partials.Message,
      Partials.User,
      Partials.ThreadMember,
    ],
    rest: {
      api: restUrl,
      version: '10',
    },
  })
}

function createMinimalMatchers(): DeterministicMatcher[] {
  return [
    {
      id: 'startup-test-reply',
      priority: 10,
      when: {
        lastMessageRole: 'user',
        rawPromptIncludes: 'startup-test',
      },
      then: {
        parts: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'startup-reply' },
          { type: 'text-delta', id: 'startup-reply', delta: 'ok' },
          { type: 'text-end', id: 'startup-reply' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ],
      },
    },
  ]
}

const TEST_USER_ID = '900000000000000777'
const TEXT_CHANNEL_ID = '900000000000000778'

describe('startup time measurement', () => {
  let directories: ReturnType<typeof createRunDirectories>
  let discord: DigitalDiscord
  let botClient: Client | null = null
  const testStartTime = Date.now()

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

    await Promise.all([
      stopOpencodeServer().catch(() => {}),
      closeDatabase().catch(() => {}),
      stopHranaServer().catch(() => {}),
      discord?.stop().catch(() => {}),
    ])

    delete process.env['KIMAKI_LOCK_PORT']
    delete process.env['KIMAKI_DB_URL']

    if (directories) {
      fs.rmSync(directories.dataDir, { recursive: true, force: true })
    }
  }, 5_000)

  test('measures per-phase startup timings', async () => {
    directories = createRunDirectories()
    const lockPort = chooseLockPort({ key: 'startup-time-e2e' })

    process.env['KIMAKI_LOCK_PORT'] = String(lockPort)
    setDataDir(directories.dataDir)

    const digitalDiscordDbPath = path.join(
      directories.dataDir,
      'digital-discord.db',
    )

    discord = new DigitalDiscord({
      guild: {
        name: 'Startup Time Guild',
        ownerId: TEST_USER_ID,
      },
      channels: [
        {
          id: TEXT_CHANNEL_ID,
          name: 'startup-time',
          type: ChannelType.GuildText,
        },
      ],
      users: [
        {
          id: TEST_USER_ID,
          username: 'startup-tester',
        },
      ],
      dbUrl: `file:${digitalDiscordDbPath}`,
    })

    await discord.start()

    // Write deterministic opencode config
    const providerNpm = url
      .pathToFileURL(
        path.resolve(
          process.cwd(),
          '..',
          'opencode-deterministic-provider',
          'src',
          'index.ts',
        ),
      )
      .toString()

    const opencodeConfig = buildDeterministicOpencodeConfig({
      providerName: 'deterministic-provider',
      providerNpm,
      model: 'deterministic-v2',
      smallModel: 'deterministic-v2',
      settings: {
        strict: false,
        matchers: createMinimalMatchers(),
      },
    })
    fs.writeFileSync(
      path.join(directories.projectDirectory, 'opencode.json'),
      JSON.stringify(opencodeConfig, null, 2),
    )

    // ── Phase timings ──
    const totalStart = performance.now()

    // Phase 1: Hrana server
    const hranaStart = performance.now()
    const dbPath = path.join(directories.dataDir, 'discord-sessions.db')
    const hranaResult = await startHranaServer({ dbPath })
    if (hranaResult instanceof Error) {
      throw hranaResult
    }
    process.env['KIMAKI_DB_URL'] = hranaResult
    const hranaMs = performance.now() - hranaStart

    // Phase 2: Database init
    const dbStart = performance.now()
    await initDatabase()
    await setBotToken(discord.botUserId, discord.botToken)
    await setChannelDirectory({
      channelId: TEXT_CHANNEL_ID,
      directory: directories.projectDirectory,
      channelType: 'text',
    })
    const dbMs = performance.now() - dbStart

    // Phase 3+4: Discord.js login + startDiscordBot
    // In the real cli.ts flow, login happens first (line 2077), then
    // startDiscordBot is called with the already-logged-in client (line 2130).
    // startDiscordBot calls login() again internally (line 1069) which is
    // a no-op on already-connected clients. We measure them together since
    // that's the real critical path.
    const loginStart = performance.now()
    botClient = createDiscordJsClient({ restUrl: discord.restUrl })
    // Don't pre-login — let startDiscordBot handle login internally.
    // This avoids the double-login overhead that inflates measurements.
    const loginMs = Math.round(performance.now() - loginStart)

    const botStart = performance.now()
    await startDiscordBot({
      token: discord.botToken,
      appId: discord.botUserId,
      discordClient: botClient,
    })
    const botMs = performance.now() - botStart

    // Phase 5: OpenCode server startup (biggest bottleneck)
    const opencodeStart = performance.now()
    const opencodeResult = await initializeOpencodeForDirectory(
      directories.projectDirectory,
    )
    if (opencodeResult instanceof Error) {
      throw opencodeResult
    }
    const opencodeMs = performance.now() - opencodeStart

    const totalMs = performance.now() - totalStart

    const timings: PhaseTimings = {
      hranaServerMs: Math.round(hranaMs),
      databaseInitMs: Math.round(dbMs),
      discordLoginMs: Math.round(loginMs),
      startDiscordBotMs: Math.round(botMs),
      opencodeServerMs: Math.round(opencodeMs),
      totalMs: Math.round(totalMs),
    }

    // Print timings for CI/local visibility
    console.log('\n┌─────────────────────────────────────────────┐')
    console.log('│         Kimaki Startup Time Breakdown       │')
    console.log('├─────────────────────────────────────────────┤')
    console.log(`│  Hrana server:       ${String(timings.hranaServerMs).padStart(6)} ms             │`)
    console.log(`│  Database init:      ${String(timings.databaseInitMs).padStart(6)} ms             │`)
    console.log(`│  Discord.js login:   ${String(timings.discordLoginMs).padStart(6)} ms             │`)
    console.log(`│  startDiscordBot:    ${String(timings.startDiscordBotMs).padStart(6)} ms             │`)
    console.log(`│  OpenCode server:    ${String(timings.opencodeServerMs).padStart(6)} ms             │`)
    console.log('├─────────────────────────────────────────────┤')
    console.log(`│  TOTAL:              ${String(timings.totalMs).padStart(6)} ms             │`)
    console.log('└─────────────────────────────────────────────┘\n')

    // Sanity assertions — these are baselines, not targets yet.
    // Each phase should complete (no infinite hang).
    expect(timings.hranaServerMs).toBeLessThan(5_000)
    expect(timings.databaseInitMs).toBeLessThan(5_000)
    expect(timings.discordLoginMs).toBeLessThan(10_000)
    expect(timings.startDiscordBotMs).toBeLessThan(5_000)
    expect(timings.opencodeServerMs).toBeLessThan(30_000)
    expect(timings.totalMs).toBeLessThan(60_000)

    // Verify the bot is actually functional by sending a message
    // and getting a response (validates the full pipeline works)
    await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
      content: 'startup-test ping',
    })

    const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 10_000,
    })

    const reply = await discord.thread(thread.id).waitForBotReply({
      timeout: 30_000,
    })

    expect(reply.content.length).toBeGreaterThan(0)
    expect(thread.id.length).toBeGreaterThan(0)
  }, 120_000)

  test('measures parallel startup (discord + opencode simultaneously)', async () => {
    // This test reuses the infrastructure from test 1 (hrana, db already up)
    // to measure what happens when we run Discord login + OpenCode in parallel.
    // In a fresh cold start, hrana+db init would add ~50ms on top.

    // Stop opencode server from test 1 so we get a fresh measurement
    await stopOpencodeServer().catch(() => {})

    // Destroy and recreate bot client for a clean login measurement
    if (botClient) {
      botClient.destroy()
      botClient = null
    }

    // ── Parallel phase: Discord login + OpenCode server simultaneously ──
    const parallelStart = performance.now()

    const [discordResult, opencodeResult] = await Promise.all([
      // Discord path: create client, login, start bot
      (async () => {
        const loginStart = performance.now()
        const client = createDiscordJsClient({ restUrl: discord.restUrl })
        await startDiscordBot({
          token: discord.botToken,
          appId: discord.botUserId,
          discordClient: client,
        })
        return {
          client,
          totalMs: Math.round(performance.now() - loginStart),
        }
      })(),
      // OpenCode path: spawn server + wait for health
      (async () => {
        const start = performance.now()
        const result = await initializeOpencodeForDirectory(
          directories.projectDirectory,
        )
        if (result instanceof Error) {
          throw result
        }
        return { ms: Math.round(performance.now() - start) }
      })(),
    ])

    const parallelMs = Math.round(performance.now() - parallelStart)
    botClient = discordResult.client

    console.log('\n┌─────────────────────────────────────────────┐')
    console.log('│      Parallel Startup Time Breakdown        │')
    console.log('├─────────────────────────────────────────────┤')
    console.log(`│  Discord login+bot:  ${String(discordResult.totalMs).padStart(6)} ms             │`)
    console.log(`│  OpenCode server:    ${String(opencodeResult.ms).padStart(6)} ms             │`)
    console.log('├─────────────────────────────────────────────┤')
    console.log(`│  PARALLEL TOTAL:     ${String(parallelMs).padStart(6)} ms             │`)
    console.log(`│  (vs sequential:     ${String(discordResult.totalMs + opencodeResult.ms).padStart(6)} ms)            │`)
    console.log('└─────────────────────────────────────────────┘\n')

    // Parallel total should be dominated by the slower path,
    // not the sum of both.
    const maxSingle = Math.max(discordResult.totalMs, opencodeResult.ms)
    expect(parallelMs).toBeLessThan(maxSingle + 500)
  }, 120_000)
})
