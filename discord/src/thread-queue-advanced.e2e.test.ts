// E2e tests for advanced interrupt, abort, and retry scenarios.
// Split from thread-message-queue.e2e.test.ts so vitest can parallelize
// across files. See that file for basic ordering tests.
//
// Uses opencode-deterministic-provider which returns canned responses instantly
// (no real LLM calls), so poll timeouts can be aggressive (4s). The only real
// latency is OpenCode server startup (beforeAll) and intentional partDelaysMs
// in matchers (100ms for user-reply, 500ms for race-final-reply).

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { describe, beforeAll, afterAll, beforeEach, onTestFailed, test, expect } from 'vitest'
import { ChannelType, Client, GatewayIntentBits, Partials } from 'discord.js'
import type { APIMessage } from 'discord.js'
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
  disposeRuntime,
  getRuntime,
} from './session-handler/thread-session-runtime.js'
import { setRunController } from './session-handler/thread-runtime-state.js'
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
  waitForBotMessageContaining,
} from './test-utils.js'
import { getLogEntryCount, getLogEntriesSince } from './logger.js'

const e2eTest = describe

function createRunDirectories() {
  const root = path.resolve(process.cwd(), 'tmp', 'thread-queue-advanced-e2e')
  fs.mkdirSync(root, { recursive: true })

  const dataDir = fs.mkdtempSync(path.join(root, 'data-'))
  const projectDirectory = path.join(root, 'project')
  fs.mkdirSync(projectDirectory, { recursive: true })

  return { root, dataDir, projectDirectory }
}

function chooseLockPort() {
  return 51_000 + (Date.now() % 2_000)
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

const TEST_USER_ID = '200000000000000991'
const TEXT_CHANNEL_ID = '200000000000000992'

e2eTest('thread queue advanced (interrupt, abort, retry)', () => {
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
        name: 'Queue Advanced E2E Guild',
        ownerId: TEST_USER_ID,
      },
      channels: [
        {
          id: TEXT_CHANNEL_ID,
          name: 'queue-advanced-e2e',
          type: ChannelType.GuildText,
        },
      ],
      users: [
        {
          id: TEST_USER_ID,
          username: 'queue-advanced-tester',
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
    'slow tool call (sleep) gets aborted when new message queues',
    async () => {
      // Tests that long-running tool calls get properly aborted when a new
      // message queues behind them. During tool execution no step-finish events
      // arrive, but interrupt should still abort immediately so the queue can
      // process the next message normally.

      // 1. Fast setup: establish session
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: oscar',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: oscar'
        },
      })

      const th = discord.thread(thread.id)
      const firstReply = await th.waitForBotReply({ timeout: 4_000 })
      expect(firstReply.content.trim().length).toBeGreaterThan(0)

      const before = await th.getMessages()
      const beforeBotCount = before.filter((m) => {
        return m.author.id === discord.botUserId
      }).length

      // 2. Ask the model to run a long sleep command
      await th.user(TEST_USER_ID).sendMessage({
        content:
          'MANDATORY INSTRUCTION: call the bash tool immediately and run exactly this command: `sleep 500`. No explanation. No normal text. Do not skip the tool call.',
      })

      // 3. Wait until we see the bash tool message for sleep, proving the tool
      //    call actually started before the interrupt message is sent.
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'sleep 500',
        afterUserMessageIncludes: 'sleep 500',
        timeout: 4_000,
      })

      // 4. Send interrupt message while sleep is still running
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: papa',
      })

      // 5. The interrupt aborts the sleep session, and the queue processes "papa".
      const after = await waitForBotReplyAfterUserMessage({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        userMessageIncludes: 'papa',
        timeout: 4_000,
      })

      const afterBotMessages = after.filter((m) => {
        return m.author.id === discord.botUserId
      })
      expect(afterBotMessages.length).toBeGreaterThanOrEqual(beforeBotCount + 1)

      // Ensure sleep tool output appeared before the interrupt message.
      const sleepToolIndex = after.findIndex((m) => {
        return m.author.id === discord.botUserId && m.content.includes('sleep 500')
      })
      expect(sleepToolIndex).toBeGreaterThan(-1)

      // "papa" user message appears before the last bot response
      const userPapaIndex = after.findIndex((m) => {
        return m.author.id === TEST_USER_ID && m.content.includes('papa')
      })
      expect(userPapaIndex).toBeGreaterThan(-1)
      expect(sleepToolIndex).toBeLessThan(userPapaIndex)
      const lastBotIndex = after.findLastIndex((m) => {
        return m.author.id === discord.botUserId
      })
      expect(userPapaIndex).toBeLessThan(lastBotIndex)
    },
    8_000,
  )

  async function runInterruptRaceScenario(runIndex: number) {
    // Reproduces the stale-idle timing window reported in production:
    // 1) an active stream is interrupted by a new message,
    // 2) late events from the interrupted stream arrive,
    // 3) the new prompt must still produce assistant text.
    const setupPrompt = `Reply with exactly: race-setup-${runIndex}`
    const raceFinalPrompt = `Reply with exactly: race-final-${runIndex}`

    await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
      content: setupPrompt,
    })

    const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
      timeout: 4_000,
      predicate: (t) => {
        return t.name === setupPrompt
      },
    })

    const th = discord.thread(thread.id)
    const setupReply = await th.waitForBotReply({ timeout: 4_000 })
    expect(setupReply.content.trim().length).toBeGreaterThan(0)

    await th.user(TEST_USER_ID).sendMessage({
      content:
        'MANDATORY INSTRUCTION: call the bash tool immediately and run exactly this command: `sleep 500`. No explanation. No normal text. Do not skip the tool call.',
    })

    await waitForBotMessageContaining({
      discord,
      threadId: thread.id,
      userId: TEST_USER_ID,
      text: 'sleep 500',
      afterUserMessageIncludes: 'sleep 500',
      timeout: 4_000,
    })

    await th.user(TEST_USER_ID).sendMessage({
      content: raceFinalPrompt,
    })

    await waitForBotMessageContaining({
      discord,
      threadId: thread.id,
      userId: TEST_USER_ID,
      text: 'race-final',
      afterUserMessageIncludes: raceFinalPrompt,
      timeout: 4_000,
    })
  }

  test(
    'interrupt race: queued message still gets assistant text after stale idle window',
    async () => {
      await runInterruptRaceScenario(1)
    },
    8_000,
  )

  test(
    'retryLastUserPrompt aborts active run and re-dispatches same prompt',
    async () => {
      // Simulates the /model flow: user sends a message, model is changed
      // mid-run, retryLastUserPrompt() aborts and re-dispatches the same prompt.

      // 1. Establish session
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: retry-setup',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: retry-setup'
        },
      })

      const th = discord.thread(thread.id)
      const firstReply = await th.waitForBotReply({ timeout: 4_000 })
      expect(firstReply.content.trim().length).toBeGreaterThan(0)

      // 2. Send a slow prompt (sleep tool) so the run stays active
      await th.user(TEST_USER_ID).sendMessage({
        content:
          'MANDATORY INSTRUCTION: call the bash tool immediately and run exactly this command: `sleep 500`. No explanation. No normal text. Do not skip the tool call.',
      })

      // Wait for the tool call to start — proves run is active
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'sleep 500',
        afterUserMessageIncludes: 'sleep 500',
        timeout: 4_000,
      })

      // 3. Call retryLastUserPrompt() — this simulates what /model does
      const runtime = getRuntime(thread.id)
      expect(runtime).toBeDefined()
      if (!runtime) {
        throw new Error('Expected runtime to exist for retry test')
      }
      const retried = await runtime.retryLastUserPrompt()
      expect(retried).toBe(true)

      // 4. The retry re-fetches the last user message (the sleep prompt)
      //    and re-dispatches it. The deterministic provider will match the
      //    sleep tool call again. We verify a new tool call message appears
      //    AFTER the retry point.
      //
      //    Since the retry aborts the active run and re-enqueues, we should
      //    eventually see a second batch of sleep-related output or a
      //    follow-up bot message. The key assertion: the runtime didn't get
      //    stuck — it produced new output after retry.
      const before = await th.getMessages()
      const beforeBotCount = before.filter((m) => {
        return m.author.id === discord.botUserId
      }).length

      // Wait for at least one new bot message after the retry
      const after = await waitForBotMessageCount({
        discord,
        threadId: thread.id,
        count: beforeBotCount + 1,
        timeout: 4_000,
      })

      const afterBotMessages = after.filter((m) => {
        return m.author.id === discord.botUserId
      })
      expect(afterBotMessages.length).toBeGreaterThan(beforeBotCount)
    },
    10_000,
  )

  test(
    'abortActiveRun falls back to API abort when run controller is missing',
    async () => {
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: force-abort-setup',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: force-abort-setup'
        },
      })

      const th = discord.thread(thread.id)
      const setupReply = await th.waitForBotReply({ timeout: 4_000 })
      expect(setupReply.content.trim().length).toBeGreaterThan(0)

      await th.user(TEST_USER_ID).sendMessage({
        content:
          'MANDATORY INSTRUCTION: call the bash tool immediately and run exactly this command: `sleep 500`. No explanation. No normal text. Do not skip the tool call.',
      })

      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'sleep 500',
        afterUserMessageIncludes: 'sleep 500',
        timeout: 4_000,
      })

      const runtime = getRuntime(thread.id)
      expect(runtime).toBeDefined()
      if (!runtime) {
        throw new Error('Expected runtime to exist for forced-abort test')
      }

      // Simulate the edge case found in review: runtime exists but
      // runController was already cleared before /abort runs.
      setRunController(thread.id, undefined)

      runtime.abortActiveRun('force-abort-test')

      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '*project',
        afterUserMessageIncludes: 'sleep 500',
        timeout: 4_000,
      })
    },
    10_000,
  )

  test(
    'retryLastUserPrompt returns false when runtime is disposed mid-retry',
    async () => {
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: retry-dispose-setup',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: retry-dispose-setup'
        },
      })

      const th = discord.thread(thread.id)
      const setupReply = await th.waitForBotReply({ timeout: 4_000 })
      expect(setupReply.content.trim().length).toBeGreaterThan(0)

      await th.user(TEST_USER_ID).sendMessage({
        content:
          'MANDATORY INSTRUCTION: call the bash tool immediately and run exactly this command: `sleep 500`. No explanation. No normal text. Do not skip the tool call.',
      })

      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'sleep 500',
        afterUserMessageIncludes: 'sleep 500',
        timeout: 4_000,
      })

      const runtime = getRuntime(thread.id)
      expect(runtime).toBeDefined()
      if (!runtime) {
        throw new Error('Expected runtime to exist for dispose-retry test')
      }

      const retryPromise = runtime.retryLastUserPrompt()
      disposeRuntime(thread.id)

      const retried = await retryPromise
      expect(retried).toBe(false)
    },
    10_000,
  )
})
