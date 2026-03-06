// E2e tests for ThreadSessionRuntime lifecycle behaviors.
// Tests scenarios not covered by the queue/interrupt tests:
// 1. Sequential completions: listener stays alive across multiple full run cycles
// 2. Concurrent first messages: runtime serialization without threadMessageQueue
//
// Uses opencode-deterministic-provider (no real LLM calls).
// Poll timeouts: 4s max, 100ms interval.

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import url from 'node:url'
import { describe, beforeAll, afterAll, test, expect } from 'vitest'
import { ChannelType, Client, GatewayIntentBits, Partials } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import {
  buildDeterministicOpencodeConfig,
  type DeterministicMatcher,
} from 'opencode-deterministic-provider'
import { setDataDir } from './config.js'
import { store } from './store.js'
import { startDiscordBot } from './discord-bot.js'
import { getRuntime } from './session-handler/thread-session-runtime.js'
import {
  setBotToken,
  initDatabase,
  closeDatabase,
  setChannelDirectory,
  setChannelVerbosity,
  type VerbosityLevel,
} from './database.js'
import { startHranaServer, stopHranaServer } from './hrana-server.js'
import { initializeOpencodeForDirectory } from './opencode.js'
import {
  cleanupOpencodeServers,
  cleanupTestSessions,
  waitForBotMessageContaining,
  waitForBotReplyAfterUserMessage,
} from './test-utils.js'


const TEST_USER_ID = '200000000000000888'
const TEXT_CHANNEL_ID = '200000000000000889'

function createRunDirectories() {
  const root = path.resolve(process.cwd(), 'tmp', 'runtime-lifecycle-e2e')
  fs.mkdirSync(root, { recursive: true })
  const dataDir = fs.mkdtempSync(path.join(root, 'data-'))
  const projectDirectory = path.join(root, 'project')
  fs.mkdirSync(projectDirectory, { recursive: true })
  return { root, dataDir, projectDirectory }
}

function chooseLockPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Failed to resolve lock port'))
        return
      }
      const port = address.port
      server.close(() => {
        resolve(port)
      })
    })
  })
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

function createDeterministicMatchers(): DeterministicMatcher[] {
  // Simple reply matcher: model echoes back the requested text.
  // Uses 100ms delay on first text delta to keep streams async without adding
  // unnecessary latency. Tests verify ordering/serialization, not latency handling.
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

  return [userReplyMatcher]
}

describe('runtime lifecycle', () => {
  let directories: ReturnType<typeof createRunDirectories>
  let discord: DigitalDiscord
  let botClient: Client
  let previousDefaultVerbosity: VerbosityLevel | null = null
  let testStartTime = Date.now()

  beforeAll(async () => {
    testStartTime = Date.now()
    directories = createRunDirectories()
    const lockPort = await chooseLockPort()

    process.env['KIMAKI_LOCK_PORT'] = String(lockPort)
    setDataDir(directories.dataDir)
    previousDefaultVerbosity = store.getState().defaultVerbosity
    store.setState({ defaultVerbosity: 'tools-and-text' })

    const digitalDiscordDbPath = path.join(
      directories.dataDir,
      'digital-discord.db',
    )

    discord = new DigitalDiscord({
      guild: {
        name: 'Lifecycle E2E Guild',
        ownerId: TEST_USER_ID,
      },
      channels: [
        {
          id: TEXT_CHANNEL_ID,
          name: 'lifecycle-e2e',
          type: ChannelType.GuildText,
        },
      ],
      users: [
        {
          id: TEST_USER_ID,
          username: 'lifecycle-tester',
        },
      ],
      dbUrl: `file:${digitalDiscordDbPath}`,
    })

    await discord.start()

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
        matchers: createDeterministicMatchers(),
      },
    })
    fs.writeFileSync(
      path.join(directories.projectDirectory, 'opencode.json'),
      JSON.stringify(opencodeConfig, null, 2),
    )

    const dbPath = path.join(directories.dataDir, 'discord-sessions.db')
    const hranaResult = await startHranaServer({ dbPath })
    if (hranaResult instanceof Error) {
      throw hranaResult
    }
    process.env['KIMAKI_DB_URL'] = hranaResult
    await initDatabase()
    await setBotToken(discord.botUserId, discord.botToken)

    await setChannelDirectory({
      channelId: TEXT_CHANNEL_ID,
      directory: directories.projectDirectory,
      channelType: 'text',
    })
    await setChannelVerbosity(TEXT_CHANNEL_ID, 'tools-and-text')

    botClient = createDiscordJsClient({ restUrl: discord.restUrl })
    await startDiscordBot({
      token: discord.botToken,
      appId: discord.botUserId,
      discordClient: botClient,
    })

    // Pre-warm the opencode server
    const warmup = await initializeOpencodeForDirectory(
      directories.projectDirectory,
    )
    if (warmup instanceof Error) {
      throw warmup
    }
  }, 60_000)

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
    await cleanupOpencodeServers()
    await Promise.all([
      closeDatabase().catch(() => { return }),
      stopHranaServer().catch(() => { return }),
      discord?.stop().catch(() => { return }),
    ])
    delete process.env['KIMAKI_LOCK_PORT']
    delete process.env['KIMAKI_DB_URL']
    if (previousDefaultVerbosity) {
      store.setState({ defaultVerbosity: previousDefaultVerbosity })
    }
    if (directories) {
      fs.rmSync(directories.dataDir, { recursive: true, force: true })
    }
  }, 10_000)

  test(
    'three sequential completions reuse same runtime and listener',
    async () => {
      // Sends A, waits for full completion (footer), sends B, waits for
      // footer, sends C, waits for footer. Proves the listener stays alive
      // across full run cycles without any interrupt/queue involvement.
      // This is the "calm" path — no abort, no queue, just sequential use.

      // 1. Send first message → thread created, session established
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: seq-alpha',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: seq-alpha'
        },
      })

      const th = discord.thread(thread.id)

      // Wait for footer (italic project info line) — proves run A completed
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '*project',
        timeout: 4_000,
      })

      // Capture runtime identity — should not change across runs
      const runtimeAfterA = getRuntime(thread.id)
      expect(runtimeAfterA).toBeDefined()

      // 2. Send B after A fully completed
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: seq-beta',
      })

      await waitForBotReplyAfterUserMessage({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        userMessageIncludes: 'seq-beta',
        timeout: 4_000,
      })

      // Wait for B's footer
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '*project',
        afterUserMessageIncludes: 'seq-beta',
        timeout: 4_000,
      })

      // Same runtime instance — listener was not recreated
      const runtimeAfterB = getRuntime(thread.id)
      expect(runtimeAfterB).toBe(runtimeAfterA)

      // 3. Send C after B fully completed
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: seq-gamma',
      })

      await waitForBotReplyAfterUserMessage({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        userMessageIncludes: 'seq-gamma',
        timeout: 4_000,
      })

      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '*project',
        afterUserMessageIncludes: 'seq-gamma',
        timeout: 4_000,
      })

      // Still the same runtime — three full cycles, one runtime, one listener
      const runtimeAfterC = getRuntime(thread.id)
      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: assistant (TestBot)
        ⬥ ok
        --- from: assistant (TestBot)
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (lifecycle-tester)
        Reply with exactly: seq-beta
        --- from: assistant (TestBot)
        ⬥ ok
        --- from: assistant (TestBot)
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (lifecycle-tester)
        Reply with exactly: seq-gamma
        --- from: assistant (TestBot)
        ⬥ ok
        --- from: assistant (TestBot)
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
      expect(runtimeAfterC).toBe(runtimeAfterA)
    },
    15_000,
  )

  test(
    'footer includes context percentage and model id',
    async () => {
      const prompt = 'Reply with exactly: footer-check'
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: prompt,
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === prompt
        },
      })

      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'deterministic-v2',
        timeout: 4_000,
      })

      const messages = await discord.thread(thread.id).getMessages()

      const footerMessage = messages.find((message) => {
        if (message.author.id !== discord.botUserId) {
          return false
        }
        if (!message.content.startsWith('*')) {
          return false
        }
        return message.content.includes('deterministic-v2')
      })

      expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
        "--- from: assistant (TestBot)
        ⬥ ok
        --- from: assistant (TestBot)
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
      expect(footerMessage).toBeDefined()
      if (!footerMessage) {
        throw new Error('Expected footer message to be present')
      }
      expect(footerMessage.content).toContain('deterministic-v2')
      expect(footerMessage.content).toMatch(/\d+%/)
    },
    10_000,
  )

  test(
    'two near-simultaneous messages to same thread serialize correctly',
    async () => {
      // Sends A to create a thread, then fires B and C simultaneously into
      // the thread (no await between them). Without the old threadMessageQueue,
      // the runtime's dispatchAction must serialize these. Both should get
      // responses and the thread should not deadlock or create duplicate sessions.

      // 1. Establish thread + session
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: concurrent-setup',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: concurrent-setup'
        },
      })

      const th = discord.thread(thread.id)
      const setupReply = await th.waitForBotReply({ timeout: 4_000 })
      expect(setupReply.content.trim().length).toBeGreaterThan(0)

      // Wait for setup footer so the run is fully idle
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '*project',
        timeout: 4_000,
      })

      // Snapshot bot message count before sending concurrent messages
      const beforeMessages = await th.getMessages()
      const beforeBotCount = beforeMessages.filter((m) => {
        return m.author.id === discord.botUserId
      }).length

      // 2. Fire B and C simultaneously — no await between sends
      const sendB = th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: concurrent-bravo',
      })
      const sendC = th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: concurrent-charlie',
      })
      await Promise.all([sendB, sendC])

      // 3. Both should eventually get bot replies — the runtime serializes them
      await waitForBotReplyAfterUserMessage({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        userMessageIncludes: 'concurrent-bravo',
        timeout: 4_000,
      })

      await waitForBotReplyAfterUserMessage({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        userMessageIncludes: 'concurrent-charlie',
        timeout: 4_000,
      })

      // 4. Verify both user messages arrived and the thread didn't deadlock.
      //    With explicit abort flows, bravo can be aborted by charlie before
      //    producing a reply, so we can't assert +2 bot messages. What we
      //    CAN verify: both user messages exist, charlie (the last one) has
      //    a bot reply after it, and the replies are distinct messages.
      const messages = await th.getMessages()

      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: assistant (TestBot)
        ⬥ ok
        --- from: assistant (TestBot)
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (lifecycle-tester)
        Reply with exactly: concurrent-bravo
        --- from: user (lifecycle-tester)
        Reply with exactly: concurrent-charlie
        --- from: assistant (TestBot)
        ⬥ ok"
      `)
      const bravoIndex = messages.findIndex((m) => {
        return (
          m.author.id === TEST_USER_ID &&
          m.content.includes('concurrent-bravo')
        )
      })
      const charlieIndex = messages.findIndex((m) => {
        return (
          m.author.id === TEST_USER_ID &&
          m.content.includes('concurrent-charlie')
        )
      })
      expect(bravoIndex).toBeGreaterThan(-1)
      expect(charlieIndex).toBeGreaterThan(-1)
      expect(bravoIndex).toBeLessThan(charlieIndex)

      // Charlie (the last queued message) must have a bot reply after it.
      const charlieReplyIndex = messages.findIndex((m, i) => {
        return i > charlieIndex && m.author.id === discord.botUserId
      })
      expect(charlieReplyIndex).toBeGreaterThan(-1)

      // At least 1 new bot message appeared (charlie's reply). If bravo
      // wasn't aborted, there will be 2. Either way, no deadlock.
      const afterBotCount = messages.filter((m) => {
        return m.author.id === discord.botUserId
      }).length
      expect(afterBotCount).toBeGreaterThanOrEqual(beforeBotCount + 1)
    },
    15_000,
  )
})
