// E2e tests for basic per-thread message queue ordering.
// Advanced interrupt/abort/retry tests are in thread-queue-advanced.e2e.test.ts.
//
// Uses opencode-deterministic-provider which returns canned responses instantly
// (no real LLM calls), so poll timeouts can be aggressive (4s). The only real
// latency is OpenCode server startup (beforeAll) and intentional partDelaysMs
// in matchers (100ms for user-reply).
//
// Tests within a single file run sequentially (shared in-memory log buffer
// for failure diagnostics). If total duration of a file exceeds ~10s, split
// into a new test file so vitest can parallelize across files.

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { describe, beforeAll, afterAll, beforeEach, onTestFailed, test, expect } from 'vitest'
import { ChannelType, Client, GatewayIntentBits, Partials } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import {
  buildDeterministicOpencodeConfig,
  type DeterministicMatcher,
} from 'opencode-deterministic-provider'
import {
  setDataDir,
} from './config.js'
import { store } from './store.js'
import { startDiscordBot } from './discord-bot.js'
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
  waitForBotMessageCount,
  waitForBotReplyAfterUserMessage,
} from './test-utils.js'
import { getLogEntryCount, getLogEntriesSince } from './logger.js'

const e2eTest = describe

function createRunDirectories() {
  const root = path.resolve(process.cwd(), 'tmp', 'thread-queue-e2e')
  fs.mkdirSync(root, { recursive: true })

  const dataDir = fs.mkdtempSync(path.join(root, 'data-'))
  const projectDirectory = path.join(root, 'project')
  fs.mkdirSync(projectDirectory, { recursive: true })

  return { root, dataDir, projectDirectory }
}

function chooseLockPort() {
  return 47_000 + (Date.now() % 2_000)
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

function createDeterministicMatchers() {
  const raceFinalReplyMatcher: DeterministicMatcher = {
    id: 'race-final-reply',
    priority: 110,
    when: {
      rawPromptIncludes: 'Reply with exactly: race-final',
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
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          },
        },
      ],
      // Delay first output to widen the stale-idle window. The race happens
      // in <1ms; 500ms is plenty to keep the window reliably open.
      partDelaysMs: [0, 500, 0, 0, 0],
    },
  }

  const sleepMatcher: DeterministicMatcher = {
    id: 'sleep-tool-call',
    priority: 100,
    when: {
      rawPromptIncludes:
        'MANDATORY INSTRUCTION: call the bash tool immediately and run exactly this command: `sleep 500`',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'sleep-start' },
        { type: 'text-delta', id: 'sleep-start', delta: 'running sleep 500' },
        { type: 'text-end', id: 'sleep-start' },
        {
          type: 'tool-call',
          toolCallId: 'sleep-call-1',
          toolName: 'bash',
          input: JSON.stringify({
            command: 'sleep 500',
            description: 'Deterministic sleep for interrupt e2e',
            hasSideEffect: true,
          }),
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          },
        },
      ],
    },
  }

  const toolFollowupMatcher: DeterministicMatcher = {
    id: 'tool-followup',
    priority: 50,
    when: {
      lastMessageRole: 'tool',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'tool-followup' },
        { type: 'text-delta', id: 'tool-followup', delta: 'tool done' },
        { type: 'text-end', id: 'tool-followup' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          },
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
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          },
        },
      ],
      partDelaysMs: [0, 100, 0, 0, 0],
    },
  }

  return [
    sleepMatcher,
    raceFinalReplyMatcher,
    toolFollowupMatcher,
    userReplyMatcher,
  ]
}

const TEST_USER_ID = '200000000000000777'
const TEXT_CHANNEL_ID = '200000000000000778'

e2eTest('thread message queue ordering', () => {
  let directories: ReturnType<typeof createRunDirectories>
  let discord: DigitalDiscord
  let botClient: Client
  let previousDefaultVerbosity: VerbosityLevel | null =
    null
  let testStartTime = Date.now()

  beforeAll(async () => {
    testStartTime = Date.now()
    directories = createRunDirectories()
    const lockPort = chooseLockPort()

    process.env['KIMAKI_LOCK_PORT'] = String(lockPort)
    setDataDir(directories.dataDir)
    previousDefaultVerbosity = store.getState().defaultVerbosity
    store.setState({ defaultVerbosity: 'tools-and-text' })

    discord = new DigitalDiscord({
      guild: {
        name: 'Queue E2E Guild',
        ownerId: TEST_USER_ID,
      },
      channels: [
        {
          id: TEXT_CHANNEL_ID,
          name: 'queue-e2e',
          type: ChannelType.GuildText,
        },
      ],
      users: [
        {
          id: TEST_USER_ID,
          username: 'queue-tester',
        },
      ],
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
      appId: discord.botUserId,
    })
    await setChannelVerbosity(TEXT_CHANNEL_ID, 'tools-and-text')
    const channelVerbosity = await getChannelVerbosity(TEXT_CHANNEL_ID)
    expect(channelVerbosity).toBe('tools-and-text')

    botClient = createDiscordJsClient({ restUrl: discord.restUrl })
    await startDiscordBot({
      token: discord.botToken,
      appId: discord.botUserId,
      discordClient: botClient,
    })

    // Pre-warm the opencode server so the first test doesn't include
    // server startup time (~3-4s) inside its 4s poll timeouts.
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
      closeDatabase().catch(() => {
        return
      }),
      stopHranaServer().catch(() => {
        return
      }),
      discord?.stop().catch(() => {
        return
      }),
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

  // Capture log buffer position before each test. On failure, dump only the
  // log lines produced during that test so failures are easy to diagnose.
  let logStartIndex = 0

  beforeEach(() => {
    logStartIndex = getLogEntryCount()
    onTestFailed(() => {
      const logs = getLogEntriesSince(logStartIndex)
      if (logs.length > 0) {
        console.error(`\n--- kimaki logs (${logs.length} lines) ---`)
        console.error(logs.join(''))
        console.error(`--- end ---\n`)
      }
    })
  })

  test(
    'text message during active session gets processed',
    async () => {
      // 1. Send initial message to text channel → thread created + session established
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: alpha',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: alpha'
        },
      })

      const th = discord.thread(thread.id)

      // Wait for the first bot reply so session is fully established in DB
      const firstReply = await th.waitForBotReply({
        timeout: 4_000,
      })
      expect(firstReply.content.trim().length).toBeGreaterThan(0)

      // Snapshot bot message count before sending follow-up
      const before = await th.getMessages()
      const beforeBotCount = before.filter((m) => {
        return m.author.id === discord.botUserId
      }).length

      // 2. Send follow-up message B into the thread — serialized by runtime's enqueueIncoming
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: beta',
      })

      // 3. Wait for exactly 1 new bot message (the response to B)
      const after = await waitForBotMessageCount({
        discord,
        threadId: thread.id,
        count: beforeBotCount + 1,
        timeout: 4_000,
      })

      // 4. Verify at least 1 new bot message appeared for the follow-up.
      //    The bot may send additional messages per session (error reactions,
      //    session notifications) so we check >= not exact equality.
      const afterBotMessages = after.filter((m) => {
        return m.author.id === discord.botUserId
      })
      expect(afterBotMessages.length).toBeGreaterThanOrEqual(beforeBotCount + 1)

      // User B's message must appear before the new bot response
      const userBIndex = after.findIndex((m) => {
        return (
          m.author.id === TEST_USER_ID &&
          m.content.includes('beta')
        )
      })
      const lastBotIndex = after.findLastIndex((m) => {
        return m.author.id === discord.botUserId
      })

      expect(userBIndex).toBeGreaterThan(-1)
      expect(lastBotIndex).toBeGreaterThan(-1)
      expect(userBIndex).toBeLessThan(lastBotIndex)

      // New bot response has non-empty content
      const newBotReply = afterBotMessages[afterBotMessages.length - 1]!
      expect(newBotReply.content.trim().length).toBeGreaterThan(0)
    },
    8_000,
  )

  test(
    'two rapid text messages in thread — both processed in order',
    async () => {
      // 1. Send initial message to text channel → thread + session established
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: one',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: one'
        },
      })

      const th = discord.thread(thread.id)

      // Wait for the first bot reply so session is established
      const firstReply = await th.waitForBotReply({
        timeout: 4_000,
      })
      expect(firstReply.content.trim().length).toBeGreaterThan(0)

      // Snapshot bot message count before sending follow-ups
      const before = await th.getMessages()
      const beforeBotCount = before.filter((m) => {
        return m.author.id === discord.botUserId
      }).length

      // 2. Rapidly send messages B and C — both serialized by runtime's enqueueIncoming
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: two',
      })
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: three',
      })

      // 3. Wait for exactly 2 new bot messages (one per follow-up)
      const after = await waitForBotMessageCount({
        discord,
        threadId: thread.id,
        count: beforeBotCount + 2,
        timeout: 4_000,
      })

      // 4. Verify at least 2 new bot messages appeared (one per follow-up).
      //    The bot may send additional messages per session (error reactions,
      //    session notifications) so we check >= not exact equality.
      const afterBotMessages = after.filter((m) => {
        return m.author.id === discord.botUserId
      })
      expect(afterBotMessages.length).toBeGreaterThanOrEqual(beforeBotCount + 2)

      // Each new bot message has non-empty content
      const newBotReplies = afterBotMessages.slice(beforeBotCount)
      for (const reply of newBotReplies) {
        expect(reply.content.trim().length).toBeGreaterThan(0)
      }

      // 5. Verify per-follow-up causality: user B appears before 2nd bot
      //    message, user C appears before 3rd bot message
      const botIndices = after.reduce<number[]>((acc, m, i) => {
        if (m.author.id === discord.botUserId) {
          acc.push(i)
        }
        return acc
      }, [])

      const userTwoIndex = after.findIndex((m) => {
        return (
          m.author.id === TEST_USER_ID &&
          m.content.includes('two')
        )
      })
      const userThreeIndex = after.findIndex((m) => {
        return (
          m.author.id === TEST_USER_ID &&
          m.content.includes('three')
        )
      })

      expect(userTwoIndex).toBeGreaterThan(-1)
      expect(userThreeIndex).toBeGreaterThan(-1)

      // Bot responses for B and C are the last 2 bot messages
      const botForB = botIndices[botIndices.length - 2]!
      const botForC = botIndices[botIndices.length - 1]!

      // Each user message appears before its corresponding bot response
      expect(userTwoIndex).toBeLessThan(botForB)
      expect(userThreeIndex).toBeLessThan(botForC)

      // Bot response for B appears before bot response for C (queue order)
      expect(botForB).toBeLessThan(botForC)
    },
    8_000,
  )

  test(
    'queued message aborts running session immediately',
    async () => {
      // When a new message arrives while a session is running,
      // runtime.enqueueIncoming with interruptActive aborts the in-flight
      // run immediately, then the runtime processes the next message.
      //
      // 1. Fast setup: establish session
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: delta',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: delta'
        },
      })

      const th = discord.thread(thread.id)
      const firstReply = await th.waitForBotReply({ timeout: 4_000 })
      expect(firstReply.content.trim().length).toBeGreaterThan(0)

      const before = await th.getMessages()
      const beforeBotCount = before.filter((m) => {
        return m.author.id === discord.botUserId
      }).length

      // 2. Send B, then quickly send C to trigger the interrupt.
      //    200ms gap gives B time to enter the queue and start processing.
      //    runtime's abortActiveRun aborts B immediately so C can run.
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: echo',
      })
      await new Promise((r) => {
        setTimeout(r, 200)
      })
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: foxtrot',
      })

      // 3. Poll until foxtrot's user message has a bot reply after it.
      //    waitForBotMessageCount alone isn't enough — error messages from the
      //    interrupted session can satisfy the count before foxtrot gets its reply.
      const after = await waitForBotReplyAfterUserMessage({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        userMessageIncludes: 'foxtrot',
        timeout: 4_000,
      })

      // 4. Foxtrot got a bot response. Echo may or may not produce one —
      //    the abort error is silently suppressed, so no error message appears.
      const afterBotMessages = after.filter((m) => {
        return m.author.id === discord.botUserId
      })
      expect(afterBotMessages.length).toBeGreaterThanOrEqual(beforeBotCount + 1)

      const userEchoIndex = after.findIndex((m) => {
        return m.author.id === TEST_USER_ID && m.content.includes('echo')
      })
      const userFoxtrotIndex = after.findIndex((m) => {
        return m.author.id === TEST_USER_ID && m.content.includes('foxtrot')
      })
      expect(userEchoIndex).toBeGreaterThan(-1)
      expect(userFoxtrotIndex).toBeGreaterThan(-1)

      // Foxtrot's bot reply appears after the foxtrot user message
      const botAfterFoxtrot = after.findIndex((m, i) => {
        return i > userFoxtrotIndex && m.author.id === discord.botUserId
      })
      expect(botAfterFoxtrot).toBeGreaterThan(userFoxtrotIndex)
    },
    8_000,
  )

  test(
    'slow stream still gets interrupted when no step-finish arrives',
    async () => {
      // With immediate abort, a queued message interrupts even while the previous
      // request is mid-stream and has not reached a step-finish event.

      // 1. Fast setup: establish session
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: golf',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: golf'
        },
      })

      const th = discord.thread(thread.id)
      const firstReply = await th.waitForBotReply({ timeout: 4_000 })
      expect(firstReply.content.trim().length).toBeGreaterThan(0)

      const before = await th.getMessages()
      const beforeBotCount = before.filter((m) => {
        return m.author.id === discord.botUserId
      }).length

      // 2. Start request B, then send C while B is still in progress.
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: hotel',
      })

      // 3. Wait briefly for B to start, then send C to trigger immediate abort
      await new Promise((r) => {
        setTimeout(r, 200)
      })
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: india',
      })

      // 4. B is aborted and C gets processed.
      //    Poll until india's user message has a bot reply after it.
      const after = await waitForBotReplyAfterUserMessage({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        userMessageIncludes: 'india',
        timeout: 4_000,
      })

      // C's user message appears before its bot response.
      // The interrupted hotel session may or may not produce a visible bot message
      // (depends on timing), so we only assert on india's reply existence.
      const userIndiaIndex = after.findIndex((m) => {
        return m.author.id === TEST_USER_ID && m.content.includes('india')
      })
      expect(userIndiaIndex).toBeGreaterThan(-1)
      const botAfterIndia = after.findIndex((m, i) => {
        return i > userIndiaIndex && m.author.id === discord.botUserId
      })
      expect(botAfterIndia).toBeGreaterThan(userIndiaIndex)
    },
    8_000,
  )

  test(
    'queue drains correctly after interrupted session',
    async () => {
      // Verifies the queue doesn't get stuck after multiple interrupts.
      // Rapidly sends B, C, D — each interrupts the previous. Then after all
      // complete, sends E to prove the queue is clean and accepting new work.

      // 1. Fast setup: establish session
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: juliet',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: juliet'
        },
      })

      const th = discord.thread(thread.id)
      const firstReply = await th.waitForBotReply({ timeout: 4_000 })
      expect(firstReply.content.trim().length).toBeGreaterThan(0)

      const before = await th.getMessages()
      const beforeBotCount = before.filter((m) => {
        return m.author.id === discord.botUserId
      }).length

      // 2. Rapidly send B, C, D — each queues behind the previous and triggers interrupt
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: kilo',
      })
      await new Promise((r) => {
        setTimeout(r, 300)
      })
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: lima',
      })
      await new Promise((r) => {
        setTimeout(r, 300)
      })
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: mike',
      })

      // 3. Wait until the last burst message (mike) has a bot reply after it.
      const afterBurst = await waitForBotReplyAfterUserMessage({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        userMessageIncludes: 'mike',
        timeout: 4_000,
      })

      const burstBotMessages = afterBurst.filter((m) => {
        return m.author.id === discord.botUserId
      })
      expect(burstBotMessages.length).toBeGreaterThanOrEqual(beforeBotCount + 1)

      // 4. Queue should be clean — send E and verify it also gets processed
      const burstBotCount = burstBotMessages.length

      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: november',
      })

      const afterE = await waitForBotReplyAfterUserMessage({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        userMessageIncludes: 'november',
        timeout: 4_000,
      })

      const finalBotMessages = afterE.filter((m) => {
        return m.author.id === discord.botUserId
      })
      expect(finalBotMessages.length).toBeGreaterThanOrEqual(burstBotCount)

      // E's user message appears before the final bot response
      const userNovemberIndex = afterE.findIndex((m) => {
        return m.author.id === TEST_USER_ID && m.content.includes('november')
      })
      expect(userNovemberIndex).toBeGreaterThan(-1)
      const lastBotIndex = afterE.findLastIndex((m) => {
        return m.author.id === discord.botUserId
      })
      expect(userNovemberIndex).toBeLessThan(lastBotIndex)
    },
    8_000,
  )

})

