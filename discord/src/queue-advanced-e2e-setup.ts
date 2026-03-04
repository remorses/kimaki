// Shared setup for queue-advanced e2e test files.
// Extracted so vitest can parallelize the split test files across workers.

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { beforeAll, afterAll, afterEach, expect } from 'vitest'
import { ChannelType, Client, GatewayIntentBits, Partials } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import {
  buildDeterministicOpencodeConfig,
  type DeterministicMatcher,
} from 'opencode-deterministic-provider'
import { setDataDir } from './config.js'
import { store } from './store.js'
import { startDiscordBot } from './discord-bot.js'
import { disposeRuntime } from './session-handler/thread-session-runtime.js'
import {
  setBotToken,
  initDatabase,
  closeDatabase,
  setChannelDirectory,
  setChannelVerbosity,
  getChannelVerbosity,
  type VerbosityLevel,
} from './database.js'
import { startHranaServer, stopHranaServer } from './hrana-server.js'
import { initializeOpencodeForDirectory } from './opencode.js'
import {
  cleanupOpencodeServers,
  cleanupTestSessions,
} from './test-utils.js'


export function createRunDirectories({ name }: { name: string }) {
  const root = path.resolve(process.cwd(), 'tmp', name)
  fs.mkdirSync(root, { recursive: true })

  const dataDir = fs.mkdtempSync(path.join(root, 'data-'))
  const projectDirectory = path.join(root, 'project')
  fs.mkdirSync(projectDirectory, { recursive: true })

  return { root, dataDir, projectDirectory }
}

export function chooseLockPort() {
  return 51_000 + (Date.now() % 2_000)
}

export function createDiscordJsClient({ restUrl }: { restUrl: string }) {
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

export function createDeterministicMatchers(): DeterministicMatcher[] {
  const raceFinalReplyMatcher: DeterministicMatcher = {
    id: 'race-final-reply',
    priority: 110,
    when: {
      latestUserTextIncludes: 'Reply with exactly: race-final',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'race-final' },
        { type: 'text-delta', id: 'race-final', delta: 'race-final' },
        { type: 'text-end', id: 'race-final' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
      partDelaysMs: [0, 500, 0, 0, 0],
    },
  }

  const slowAbortMatcher: DeterministicMatcher = {
    id: 'slow-abort-marker',
    priority: 100,
    when: {
      latestUserTextIncludes: 'SLOW_ABORT_MARKER run long response',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'slow-start' },
        { type: 'text-delta', id: 'slow-start', delta: 'slow-response-started' },
        { type: 'text-end', id: 'slow-start' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
      partDelaysMs: [0, 0, 0, 3_000, 0],
    },
  }

  const toolFollowupMatcher: DeterministicMatcher = {
    id: 'tool-followup',
    priority: 50,
    when: { lastMessageRole: 'tool' },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'tool-followup' },
        { type: 'text-delta', id: 'tool-followup', delta: 'tool done' },
        { type: 'text-end', id: 'tool-followup' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
    },
  }

  const userReplyMatcher: DeterministicMatcher = {
    id: 'user-reply',
    priority: 10,
    when: {
      lastMessageRole: 'user',
      rawPromptIncludes: 'Reply with exactly:',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'default-reply' },
        { type: 'text-delta', id: 'default-reply', delta: 'ok' },
        { type: 'text-end', id: 'default-reply' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
      partDelaysMs: [0, 100, 0, 0, 0],
    },
  }

  const pluginTimeoutSleepMatcher: DeterministicMatcher = {
    id: 'plugin-timeout-sleep',
    priority: 100,
    when: {
      latestUserTextIncludes: 'PLUGIN_TIMEOUT_SLEEP_MARKER',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'sleep-text' },
        { type: 'text-delta', id: 'sleep-text', delta: 'starting sleep 100' },
        { type: 'text-end', id: 'sleep-text' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
      partDelaysMs: [0, 0, 0, 0, 100_000],
    },
  }

  return [
    slowAbortMatcher,
    pluginTimeoutSleepMatcher,
    raceFinalReplyMatcher,
    toolFollowupMatcher,
    userReplyMatcher,
  ]
}

export type QueueAdvancedContext = {
  directories: ReturnType<typeof createRunDirectories>
  discord: DigitalDiscord
  botClient: Client
  testStartTime: number
}

export const TEST_USER_ID = '200000000000000991'

/**
 * Sets up a full queue-advanced e2e environment: digital-twin Discord server,
 * opencode deterministic provider, database, bot client.
 * Each caller should use a unique channelId and dirName to avoid collisions
 * when vitest runs files in parallel.
 */
export function setupQueueAdvancedSuite({
  channelId,
  channelName,
  dirName,
  username,
}: {
  channelId: string
  channelName: string
  dirName: string
  username: string
}): QueueAdvancedContext {
  const ctx: QueueAdvancedContext = {
    directories: undefined as unknown as ReturnType<typeof createRunDirectories>,
    discord: undefined as unknown as DigitalDiscord,
    botClient: undefined as unknown as Client,
    testStartTime: Date.now(),
  }

  let previousDefaultVerbosity: VerbosityLevel | null = null

  beforeAll(async () => {
    ctx.testStartTime = Date.now()
    ctx.directories = createRunDirectories({ name: dirName })
    const lockPort = chooseLockPort()
    const sessionEventsDir = path.join(ctx.directories.root, 'opencode-session-events')
    fs.mkdirSync(sessionEventsDir, { recursive: true })

    process.env['KIMAKI_LOCK_PORT'] = String(lockPort)
    process.env['KIMAKI_INTERRUPT_STEP_TIMEOUT_MS'] = '500'
    process.env['KIMAKI_LOG_OPENCODE_SESSION_EVENTS'] = '1'
    process.env['KIMAKI_OPENCODE_SESSION_EVENTS_DIR'] = sessionEventsDir
    setDataDir(ctx.directories.dataDir)
    previousDefaultVerbosity = store.getState().defaultVerbosity
    store.setState({ defaultVerbosity: 'tools-and-text' })

    ctx.discord = new DigitalDiscord({
      guild: { name: `${dirName} Guild`, ownerId: TEST_USER_ID },
      channels: [
        { id: channelId, name: channelName, type: ChannelType.GuildText },
      ],
      users: [{ id: TEST_USER_ID, username }],
    })

    await ctx.discord.start()

    const providerNpm = url
      .pathToFileURL(
        path.resolve(process.cwd(), '..', 'opencode-deterministic-provider', 'src', 'index.ts'),
      )
      .toString()

    const opencodeConfig = buildDeterministicOpencodeConfig({
      providerName: 'deterministic-provider',
      providerNpm,
      model: 'deterministic-v2',
      smallModel: 'deterministic-v3',
      settings: { strict: false, matchers: createDeterministicMatchers() },
    })
    fs.writeFileSync(
      path.join(ctx.directories.projectDirectory, 'opencode.json'),
      JSON.stringify(opencodeConfig, null, 2),
    )

    const dbPath = path.join(ctx.directories.dataDir, 'discord-sessions.db')
    const hranaResult = await startHranaServer({ dbPath })
    if (hranaResult instanceof Error) {
      throw hranaResult
    }
    process.env['KIMAKI_DB_URL'] = hranaResult
    await initDatabase()
    await setBotToken(ctx.discord.botUserId, ctx.discord.botToken)

    await setChannelDirectory({
      channelId,
      directory: ctx.directories.projectDirectory,
      channelType: 'text',
      appId: ctx.discord.botUserId,
    })
    await setChannelVerbosity(channelId, 'tools-and-text')
    const channelVerbosity = await getChannelVerbosity(channelId)
    expect(channelVerbosity).toBe('tools-and-text')

    ctx.botClient = createDiscordJsClient({ restUrl: ctx.discord.restUrl })
    await startDiscordBot({
      token: ctx.discord.botToken,
      appId: ctx.discord.botUserId,
      discordClient: ctx.botClient,
    })

    const warmup = await initializeOpencodeForDirectory(ctx.directories.projectDirectory)
    if (warmup instanceof Error) {
      throw warmup
    }
  }, 60_000)

  afterAll(async () => {
    if (ctx.directories) {
      await cleanupTestSessions({
        projectDirectory: ctx.directories.projectDirectory,
        testStartTime: ctx.testStartTime,
      })
    }

    if (ctx.botClient) {
      ctx.botClient.destroy()
    }

    await cleanupOpencodeServers()
    await Promise.all([
      closeDatabase().catch(() => {}),
      stopHranaServer().catch(() => {}),
      ctx.discord?.stop().catch(() => {}),
    ])

    delete process.env['KIMAKI_LOCK_PORT']
    delete process.env['KIMAKI_DB_URL']
    delete process.env['KIMAKI_INTERRUPT_STEP_TIMEOUT_MS']
    delete process.env['KIMAKI_LOG_OPENCODE_SESSION_EVENTS']
    delete process.env['KIMAKI_OPENCODE_SESSION_EVENTS_DIR']
    if (previousDefaultVerbosity) {
      store.setState({ defaultVerbosity: previousDefaultVerbosity })
    }
    if (ctx.directories) {
      fs.rmSync(ctx.directories.dataDir, { recursive: true, force: true })
    }
  }, 10_000)

  afterEach(async () => {
    const threadIds = [...store.getState().threads.keys()]
    for (const threadId of threadIds) {
      disposeRuntime(threadId)
    }
    await cleanupTestSessions({
      projectDirectory: ctx.directories.projectDirectory,
      testStartTime: ctx.testStartTime,
    })
  })

  return ctx
}
