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
import { describe, beforeAll, afterAll, beforeEach, afterEach, onTestFailed, test, expect } from 'vitest'
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
  getRuntime,
  disposeRuntime,
} from './session-handler/thread-session-runtime.js'
import { getThreadState, setRunController } from './session-handler/thread-runtime-state.js'
import {
  setBotToken,
  initDatabase,
  closeDatabase,
  setChannelDirectory,
  setChannelVerbosity,
  getChannelVerbosity,
  setSessionModel,
  type VerbosityLevel,
} from './database.js'
import { startHranaServer, stopHranaServer } from './hrana-server.js'
import { initializeOpencodeForDirectory } from './opencode.js'
import {
  cleanupOpencodeServers,
  cleanupTestSessions,
  waitForBotMessageContaining,
  waitForBotReplyAfterUserMessage,
  waitForThreadPhase,
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
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          },
        },
      ],
      // Keep run active for a while after emitting initial text so abort paths
      // can race against an in-flight stream.
      partDelaysMs: [0, 0, 0, 3_000, 0],
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

  // Emits text quickly then stalls for 100s before finish.
  // The interrupt plugin should abort this before finish arrives.
  // Uses latestUserTextIncludes (not rawPromptIncludes) so it only fires
  // when SLEEP_MARKER is the latest user message — after the interrupt
  // resumes, the latest user text is the follow-up, not the marker.
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
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2,
          },
        },
      ],
      // Text emits quickly, then 100s delay before finish keeps the run active
      // so the interrupt plugin has time to abort it.
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

const TEST_USER_ID = '200000000000000991'
const TEXT_CHANNEL_ID = '200000000000000992'

e2eTest('thread queue advanced (interrupt, abort, model-switch)', () => {
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
    const sessionEventsDir = path.join(
      directories.root,
      'opencode-session-events',
    )
    fs.mkdirSync(sessionEventsDir, { recursive: true })

    process.env['KIMAKI_LOCK_PORT'] = String(lockPort)
    // Shorten interrupt plugin timeout so the test doesn't wait 3s (default)
    process.env['KIMAKI_INTERRUPT_STEP_TIMEOUT_MS'] = '500'
    process.env['KIMAKI_LOG_OPENCODE_SESSION_EVENTS'] = '1'
    process.env['KIMAKI_OPENCODE_SESSION_EVENTS_DIR'] = sessionEventsDir
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
      smallModel: 'deterministic-v3',
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
    delete process.env['KIMAKI_INTERRUPT_STEP_TIMEOUT_MS']
    delete process.env['KIMAKI_LOG_OPENCODE_SESSION_EVENTS']
    delete process.env['KIMAKI_OPENCODE_SESSION_EVENTS_DIR']
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

  afterEach(async () => {
    const threadIds = [...store.getState().threads.keys()]
    for (const threadId of threadIds) {
      disposeRuntime(threadId)
    }
    await cleanupTestSessions({
      projectDirectory: directories.projectDirectory,
      testStartTime,
    })
  })

  test(
    'normal completion emits footer after bot reply',
    async () => {
      // Verifies that a simple user message → bot reply flow produces a
      // footer message (duration, model, context%). Catches regressions
      // where the footer-suppression heuristic fires on normal completions.
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: footer-check',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: footer-check'
        },
      })

      const th = discord.thread(thread.id)
      await th.waitForBotReply({ timeout: 4_000 })

      // Wait for footer to appear — it's the bot message starting with
      // "*" and containing "⋅" (the separator in "*project ⋅ duration").
      const deadline = Date.now() + 4_000
      let foundFooter = false
      while (Date.now() < deadline) {
        const msgs = await th.getMessages()
        foundFooter = msgs.some((m) => {
          return m.author.id === discord.botUserId
            && m.content.startsWith('*')
            && m.content.includes('⋅')
        })
        if (foundFooter) {
          break
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 100)
        })
      }
      expect(foundFooter).toBe(true)
    },
    8_000,
  )

  test(
    'footer appears after second message in same session',
    async () => {
      // Verifies footer still appears after a follow-up message in the
      // same session. The hasUnrepliedUserMessage heuristic could falsely
      // suppress the footer if re-emitted user message.updated events
      // have newer timestamps than the assistant message.
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: footer-multi-setup',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: footer-multi-setup'
        },
      })

      const th = discord.thread(thread.id)
      await th.waitForBotReply({ timeout: 4_000 })

      // Wait for first footer
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '⋅',
        timeout: 4_000,
      })

      // Send second message in same session
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: footer-multi-second',
      })

      await waitForBotReplyAfterUserMessage({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        userMessageIncludes: 'footer-multi-second',
        timeout: 4_000,
      })

      // Verify a second footer appears after the second reply
      const msgs = await th.getMessages()
      const footerCount = msgs.filter((m) => {
        return m.author.id === discord.botUserId
          && m.content.startsWith('*')
          && m.content.includes('⋅')
      }).length
      if (footerCount >= 2) {
        // Already appeared
        expect(footerCount).toBeGreaterThanOrEqual(2)
        return
      }

      // Poll for second footer
      const deadline = Date.now() + 4_000
      let found = false
      while (Date.now() < deadline) {
        await new Promise((resolve) => {
          setTimeout(resolve, 100)
        })
        const latestMsgs = await th.getMessages()
        const count = latestMsgs.filter((m) => {
          return m.author.id === discord.botUserId
            && m.content.startsWith('*')
            && m.content.includes('⋅')
        }).length
        if (count >= 2) {
          found = true
          break
        }
      }
      expect(found).toBe(true)
    },
    12_000,
  )

  test(
    'interrupted run has no footer, completed follow-up has footer',
    async () => {
      // Simulates: user sends message → assistant starts streaming slowly →
      // user sends follow-up → interrupt plugin aborts the slow run →
      // follow-up gets a normal reply. The interrupted run should NOT have
      // a footer, but the completed follow-up SHOULD have one.

      // 1. Establish session
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: interrupt-footer-setup',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: interrupt-footer-setup'
        },
      })

      const th = discord.thread(thread.id)
      await th.waitForBotReply({ timeout: 4_000 })

      // Wait for first footer (from setup reply)
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '⋅',
        timeout: 4_000,
      })

      const beforeInterruptMsgs = await th.getMessages()
      const baselineCount = beforeInterruptMsgs.length

      // 2. Send slow message that stalls before finish
      await th.user(TEST_USER_ID).sendMessage({
        content: 'PLUGIN_TIMEOUT_SLEEP_MARKER',
      })

      // Wait for the slow response text to appear
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'starting sleep 100',
        afterUserMessageIncludes: 'PLUGIN_TIMEOUT_SLEEP_MARKER',
        timeout: 4_000,
      })

      await waitForThreadPhase({
        threadId: thread.id,
        phase: 'running',
        timeout: 4_000,
      })

      // 3. Send follow-up while slow run is active — interrupt plugin aborts
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: interrupt-footer-followup',
      })

      // 4. Wait for the follow-up to get a reply
      const messages = await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'ok',
        afterUserMessageIncludes: 'interrupt-footer-followup',
        timeout: 12_000,
      })

      // 5. Assert: no footer appears between the interrupted run and the
      //    follow-up reply. The interrupted run should NOT emit a footer.
      const followupUserIdx = messages.findIndex((m, idx) => {
        return idx >= baselineCount
          && m.author.id === TEST_USER_ID
          && m.content.includes('interrupt-footer-followup')
      })
      const okReplyIdx = messages.findIndex((m, idx) => {
        if (idx <= followupUserIdx) {
          return false
        }
        return m.author.id === discord.botUserId && m.content.includes('ok')
      })
      expect(followupUserIdx).toBeGreaterThanOrEqual(0)
      expect(okReplyIdx).toBeGreaterThan(followupUserIdx)

      // Check no footer between the interrupted text and the follow-up reply
      const footerBetween = messages.some((m, idx) => {
        if (idx < baselineCount || idx >= okReplyIdx) {
          return false
        }
        return m.author.id === discord.botUserId
          && m.content.startsWith('*')
          && m.content.includes('⋅')
      })
      expect(footerBetween).toBe(false)
    },
    15_000,
  )

  test(
    'slow tool call (sleep) gets aborted by explicit abort, then queue continues',
    async () => {
      // Tests that long-running tool calls can be explicitly aborted, then
      // the next user message is processed normally.

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

      // 2. Start a slow run. Uses PLUGIN_TIMEOUT_SLEEP_MARKER so the matcher
      //    uses latestUserTextIncludes — after abort and re-prompt the slow
      //    matcher won't re-fire on the queued "papa" message.
      await th.user(TEST_USER_ID).sendMessage({
        content: 'PLUGIN_TIMEOUT_SLEEP_MARKER',
      })

      // 3. Wait until the slow run is active.
      await waitForThreadPhase({
        threadId: thread.id,
        phase: 'running',
        timeout: 4_000,
      })

      const runtime = getRuntime(thread.id)
      expect(runtime).toBeDefined()
      if (!runtime) {
        throw new Error('Expected runtime to exist for explicit-abort test')
      }

      // 4. Explicitly abort the active sleep run, then enqueue next message.
      runtime.abortActiveRun('test-explicit-abort')

      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: papa',
      })

      // 5. The explicit abort stops the sleep session, and the queue processes "papa".
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

      // Ensure the slow marker user message appeared before papa.
      const sleepToolIndex = after.findIndex((m) => {
        return (
          m.author.id === TEST_USER_ID &&
          m.content.includes('PLUGIN_TIMEOUT_SLEEP_MARKER')
        )
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

  test(
    'explicit abort emits MessageAbortedError and does not emit footer',
    async () => {
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: abort-no-footer-setup',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: abort-no-footer-setup'
        },
      })

      const th = discord.thread(thread.id)
      await th.waitForBotReply({ timeout: 4_000 })

      // Ensure setup footer is already present before starting abort scenario.
      // Without this, a late footer from setup can be miscounted as a new
      // post-abort footer and cause false failures.
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '⋅',
        timeout: 4_000,
      })

      await th.user(TEST_USER_ID).sendMessage({
        content: 'SLOW_ABORT_MARKER run long response',
      })

      await waitForThreadPhase({
        threadId: thread.id,
        phase: 'running',
        timeout: 4_000,
      })

      const runtime = getRuntime(thread.id)
      expect(runtime).toBeDefined()
      if (!runtime) {
        throw new Error('Expected runtime to exist for abort no-footer test')
      }

      const beforeAbortMessages = await th.getMessages()
      const baselineCount = beforeAbortMessages.length

      runtime.abortActiveRun('test-no-footer-on-abort')

      await waitForThreadPhase({
        threadId: thread.id,
        phase: 'idle',
        timeout: 4_000,
      })

      // Poll Discord messages and verify no NEW footer appears after abort.
      // Only check messages that arrived after the abort — earlier footers
      // (from the setup reply) are expected and should not cause failure.
      for (let i = 0; i < 10; i++) {
        await new Promise((resolve) => {
          setTimeout(resolve, 20)
        })
        const msgs = await th.getMessages()
        const newMsgs = msgs.slice(baselineCount)
        const hasFooter = newMsgs.some((m) => {
          return m.author.id === discord.botUserId
            && m.content.startsWith('*')
            && m.content.includes('⋅')
        })
        expect(hasFooter).toBe(false)
      }
    },
    10_000,
  )

  test(
    'plugin timeout interrupt aborts slow sleep and avoids intermediate footer',
    async () => {
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: plugin-timeout-setup',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: plugin-timeout-setup'
        },
      })

      const th = discord.thread(thread.id)
      await th.waitForBotReply({ timeout: 4_000 })
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '*project',
        timeout: 4_000,
      })

      await th.user(TEST_USER_ID).sendMessage({
        content: 'PLUGIN_TIMEOUT_SLEEP_MARKER',
      })

      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'starting sleep 100',
        afterUserMessageIncludes: 'PLUGIN_TIMEOUT_SLEEP_MARKER',
        timeout: 4_000,
      })

      await waitForThreadPhase({
        threadId: thread.id,
        phase: 'running',
        timeout: 4_000,
      })

      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: plugin-timeout-after',
      })

      const messages = await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'ok',
        afterUserMessageIncludes: 'plugin-timeout-after',
        timeout: 12_000,
      })

      const afterIndex = messages.findIndex((message) => {
        return (
          message.author.id === TEST_USER_ID
          && message.content.includes('plugin-timeout-after')
        )
      })
      expect(afterIndex).toBeGreaterThanOrEqual(0)

      const okReplyIndex = messages.findIndex((message, index) => {
        if (index <= afterIndex) {
          return false
        }
        return message.author.id === discord.botUserId && message.content.includes('ok')
      })
      expect(okReplyIndex).toBeGreaterThan(afterIndex)

      const footerBeforeReply = messages.some((message, index) => {
        if (index <= afterIndex || index >= okReplyIndex) {
          return false
        }
        if (message.author.id !== discord.botUserId) {
          return false
        }
        return message.content.startsWith('*') && message.content.includes('⋅')
      })
      expect(footerBeforeReply).toBe(false)
    },
    15_000,
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
      content: 'SLOW_ABORT_MARKER run long response',
    })

    await waitForThreadPhase({
      threadId: thread.id,
      phase: 'running',
      timeout: 4_000,
    })

    const runtime = getRuntime(thread.id)
    expect(runtime).toBeDefined()
    if (!runtime) {
      throw new Error('Expected runtime to exist for race abort scenario')
    }

    runtime.abortActiveRun('test-race-abort')

    // Send follow-up after explicit abort and ensure the thread recovers.
    await th.user(TEST_USER_ID).sendMessage({
      content: raceFinalPrompt,
    })

    await waitForBotReplyAfterUserMessage({
      discord,
      threadId: thread.id,
      userId: TEST_USER_ID,
      userMessageIncludes: raceFinalPrompt,
      timeout: 4_000,
    })
  }

  test.skip(
    'explicit abort stale-idle window: follow-up prompt still gets assistant text',
    async () => {
      await runInterruptRaceScenario(1)
    },
    8_000,
  )

  test(
    'model switch mid-session aborts and restarts from same session history',
    async () => {
      // Simulates the /model flow with simplified runtime behavior:
      // abort current run, then send empty user prompt to opencode.
      // The deterministic provider should still see the original marker
      // in raw prompt history and replay that same request context.

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

      // 2. Send a slow marker prompt so the run stays active.
      //    Uses PLUGIN_TIMEOUT_SLEEP_MARKER (latestUserTextIncludes) instead of
      //    SLOW_ABORT_MARKER (rawPromptIncludes) so that after the retry's empty
      //    prompt the slow matcher won't fire again — the latest user text will
      //    be empty, not the marker.
      await th.user(TEST_USER_ID).sendMessage({
        content: 'PLUGIN_TIMEOUT_SLEEP_MARKER',
      })

      // Wait for run active state, then switch model immediately.
      await waitForThreadPhase({
        threadId: thread.id,
        phase: 'running',
        timeout: 4_000,
      })

      const sessionId = getThreadState(thread.id)?.sessionId
      expect(sessionId).toBeDefined()
      if (!sessionId) {
        throw new Error('Expected active session id for model switch test')
      }

      // 3. Switch model and trigger mid-run restart.
      //    abortActiveRunInternal sets phase to idle immediately, so
      //    handleSessionIdle won't call finishRun (phase !== 'running' guard).
      //    No footer is emitted — correct behavior for retries.
      await setSessionModel({
        sessionId,
        modelId: 'deterministic-provider/deterministic-v3',
        variant: null,
      })

      const runtime = getRuntime(thread.id)
      expect(runtime).toBeDefined()
      if (!runtime) {
        throw new Error('Expected runtime to exist for model switch test')
      }
      const retried = await runtime.retryLastUserPrompt()
      expect(retried).toBe(true)

      // 4. Ensure the thread keeps making progress after model-switch retry.
      //    If retry deadlocks, this follow-up won't get a bot reply.
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: model-switch-followup',
      })

      await waitForBotReplyAfterUserMessage({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        userMessageIncludes: 'model-switch-followup',
        timeout: 4_000,
      })
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
        content: 'SLOW_ABORT_MARKER run long response',
      })

      await waitForThreadPhase({
        threadId: thread.id,
        phase: 'running',
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

      const settled = await waitForThreadPhase({
        threadId: thread.id,
        phase: 'idle',
        timeout: 4_000,
      })
      expect(settled.runState.phase).toBe('idle')
    },
    10_000,
  )

})
