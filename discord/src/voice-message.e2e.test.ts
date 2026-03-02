// E2e tests for voice message handling (audio attachment transcription).
// Uses deterministic transcription (store.test.deterministicTranscription) to
// bypass real AI model calls and control transcription output, timing, and
// queueMessage flag. Combined with opencode-deterministic-provider for session
// responses. Tests validate the full flow: attachment detection → transcription
// → session dispatch, including interrupt, queue, and race condition scenarios.
//
// Tests assert on both Discord messages (via digital twin) and session state
// transitions (via getThreadState from the zustand store).

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
import { setDataDir } from './config.js'
import { store, type DeterministicTranscriptionConfig } from './store.js'
import { startDiscordBot } from './discord-bot.js'
import {
  setBotToken,
  initDatabase,
  closeDatabase,
  setChannelDirectory,
  setChannelVerbosity,
} from './database.js'
import { startHranaServer, stopHranaServer } from './hrana-server.js'
import { initializeOpencodeForDirectory } from './opencode.js'
import {
  cleanupOpencodeServers,
  cleanupTestSessions,
  waitForBotMessageContaining,
  waitForThreadPhase,
  waitForThreadQueueLength,
  waitForThreadState,
} from './test-utils.js'
import { getLogEntryCount, getLogEntriesSince } from './logger.js'
import { getThreadState } from './session-handler/thread-runtime-state.js'

const e2eTest = describe

// ── Helpers ──────────────────────────────────────────────────────

function createRunDirectories() {
  const root = path.resolve(process.cwd(), 'tmp', 'voice-msg-e2e')
  fs.mkdirSync(root, { recursive: true })

  const dataDir = fs.mkdtempSync(path.join(root, 'data-'))
  const projectDirectory = path.join(root, 'project')
  fs.mkdirSync(projectDirectory, { recursive: true })

  return { root, dataDir, projectDirectory }
}

function chooseLockPort() {
  return 53_000 + (Date.now() % 2_000)
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

/** Set the deterministic transcription config in the store for the next voice message. */
function setDeterministicTranscription(config: DeterministicTranscriptionConfig | null) {
  store.setState({
    test: { deterministicTranscription: config },
  })
}

// ── Deterministic provider matchers ──────────────────────────────
// The opencode session uses these to produce canned responses.

function createDeterministicMatchers(): DeterministicMatcher[] {
  // Slow response: emits text-delta after 2s delay, giving voice messages
  // time to arrive while the session is still "running".
  const slowResponse: DeterministicMatcher = {
    id: 'slow-response',
    priority: 100,
    when: {
      rawPromptIncludes: 'SLOW_RESPONSE_MARKER',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'slow' },
        { type: 'text-delta', id: 'slow', delta: 'slow-response-done' },
        { type: 'text-end', id: 'slow' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
      // 2s delay on the first text delta — keeps the session in "running" state
      partDelaysMs: [0, 0, 2000, 0, 0],
    },
  }

  // Fast response: completes almost immediately (~100ms)
  const fastResponse: DeterministicMatcher = {
    id: 'fast-response',
    priority: 90,
    when: {
      rawPromptIncludes: 'FAST_RESPONSE_MARKER',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'fast' },
        { type: 'text-delta', id: 'fast', delta: 'fast-response-done' },
        { type: 'text-end', id: 'fast' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
      partDelaysMs: [0, 100, 0, 0, 0],
    },
  }

  // Default: matches any user message (fallback)
  const defaultReply: DeterministicMatcher = {
    id: 'default-reply',
    priority: 1,
    when: {
      lastMessageRole: 'user',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'default' },
        { type: 'text-delta', id: 'default', delta: 'session-reply' },
        { type: 'text-end', id: 'default' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
      partDelaysMs: [0, 100, 0, 0, 0],
    },
  }

  // Tool followup: when the last message is a tool result
  const toolFollowup: DeterministicMatcher = {
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
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
    },
  }

  return [slowResponse, fastResponse, toolFollowup, defaultReply]
}

// ── Test constants ───────────────────────────────────────────────

const TEST_USER_ID = '300000000000000777'
const TEXT_CHANNEL_ID = '300000000000000778'

// ── Test suite ───────────────────────────────────────────────────

e2eTest('voice message handling', () => {
  let directories: ReturnType<typeof createRunDirectories>
  let discord: DigitalDiscord
  let botClient: Client
  let previousDefaultVerbosity = store.getState().defaultVerbosity
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
        name: 'Voice E2E Guild',
        ownerId: TEST_USER_ID,
      },
      channels: [
        {
          id: TEXT_CHANNEL_ID,
          name: 'voice-e2e',
          type: ChannelType.GuildText,
        },
      ],
      users: [
        {
          id: TEST_USER_ID,
          username: 'voice-tester',
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
    // Reset deterministic transcription
    setDeterministicTranscription(null)

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
    store.setState({ defaultVerbosity: previousDefaultVerbosity })
    if (directories) {
      fs.rmSync(directories.dataDir, { recursive: true, force: true })
    }
  }, 10_000)

  let logStartIndex = 0
  beforeEach(() => {
    // Reset deterministic transcription before each test to prevent leakage
    // from a failed test that set it but didn't clean up
    setDeterministicTranscription(null)
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

  // ── Test 1: Voice message in a channel creates thread + session ──

  test(
    'voice message in channel creates thread and starts session',
    async () => {
      setDeterministicTranscription({
        transcription: 'Fix the login bug in auth.ts',
        queueMessage: false,
      })

      // Send voice message in the text channel
      await discord
        .channel(TEXT_CHANNEL_ID)
        .user(TEST_USER_ID)
        .sendVoiceMessage()

      // Thread should be created and renamed to the transcription text
      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name?.includes('Fix the login bug') ?? false
        },
      })
      expect(thread).toBeDefined()

      const th = discord.thread(thread.id)

      // Bot should post "Transcribing..." then "Transcribed message: ..."
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'Transcribing voice message',
        timeout: 4_000,
      })

      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'Fix the login bug in auth.ts',
        timeout: 4_000,
      })

      // Session should get the transcribed prompt and respond
      const sessionReply = await th.waitForBotReply({ timeout: 4_000 })
      expect(sessionReply).toBeDefined()

      // Assert thread state reaches finished (session completed)
      const finalState = await waitForThreadPhase({
        threadId: thread.id,
        phase: 'finished',
        timeout: 4_000,
      })
      expect(finalState.sessionId).toBeDefined()
    },
    8_000,
  )

  // ── Test 2: Voice message in thread with idle session ──

  test(
    'voice message in thread with idle session starts new request',
    async () => {
      // 1. Create a session with a text message first
      setDeterministicTranscription(null) // text message, no transcription
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'FAST_RESPONSE_MARKER initial setup',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name?.includes('FAST_RESPONSE_MARKER') ?? false
        },
      })

      const th = discord.thread(thread.id)

      // Wait for the session to complete (reach finished state)
      await waitForThreadPhase({
        threadId: thread.id,
        phase: 'finished',
        timeout: 4_000,
      })

      // Confirm session is idle
      const idleState = getThreadState(thread.id)
      expect(idleState?.runState.phase).toBe('finished')

      // 2. Now send a voice message to the idle session
      setDeterministicTranscription({
        transcription: 'Add error handling to the parser',
        queueMessage: false,
      })

      await th.user(TEST_USER_ID).sendVoiceMessage()

      // Bot should post transcription messages
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'Transcribing voice message',
        timeout: 4_000,
      })

      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'Add error handling to the parser',
        timeout: 4_000,
      })

      // Session should process the transcribed message and finish
      const finalState = await waitForThreadPhase({
        threadId: thread.id,
        phase: 'finished',
        timeout: 4_000,
      })
      expect(finalState.sessionId).toBeDefined()
      expect(finalState.queueItems.length).toBe(0)
    },
    8_000,
  )

  // ── Test 3: Voice message interrupts running session ──

  test(
    'voice message interrupts running session when queueMessage is false',
    async () => {
      // 1. Start a session with a slow response
      setDeterministicTranscription(null)
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'SLOW_RESPONSE_MARKER start slow task',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name?.includes('SLOW_RESPONSE_MARKER') ?? false
        },
      })

      const th = discord.thread(thread.id)

      // Wait for the session to start running (dispatching phase)
      await waitForThreadPhase({
        threadId: thread.id,
        phase: ['collecting-baseline', 'dispatching', 'prompt-resolved'],
        timeout: 4_000,
      })

      // 2. Send voice message while session is running (should interrupt)
      setDeterministicTranscription({
        transcription: 'Stop and do this instead',
        queueMessage: false,
      })

      await th.user(TEST_USER_ID).sendVoiceMessage()

      // 3. The running session should be aborted, then new request processed.
      // Wait for the transcription to appear first
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'Stop and do this instead',
        timeout: 4_000,
      })

      // Session should eventually reach finished with the new prompt processed
      const finalState = await waitForThreadPhase({
        threadId: thread.id,
        phase: 'finished',
        timeout: 6_000,
      })
      expect(finalState.sessionId).toBeDefined()
      expect(finalState.queueItems.length).toBe(0)
    },
    10_000,
  )

  // ── Test 4: Voice message with queueMessage=true queues instead of interrupting ──

  test(
    'voice message with queueMessage=true queues behind running session',
    async () => {
      // 1. Start a session with a slow response
      setDeterministicTranscription(null)
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'SLOW_RESPONSE_MARKER start queued task',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name?.includes('start queued task') ?? false
        },
      })

      const th = discord.thread(thread.id)

      // Wait for session to start running
      await waitForThreadPhase({
        threadId: thread.id,
        phase: ['collecting-baseline', 'dispatching', 'prompt-resolved'],
        timeout: 4_000,
      })

      // 2. Send voice message with queueMessage=true (should NOT interrupt)
      setDeterministicTranscription({
        transcription: 'Queue this task for later',
        queueMessage: true,
      })

      await th.user(TEST_USER_ID).sendVoiceMessage()

      // 3. Transcription should appear
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'Queue this task for later',
        timeout: 4_000,
      })

      // 4. The message should be queued (interruptActive: false means it goes to queue)
      // The slow session should still be running, not aborted
      const midState = await waitForThreadQueueLength({
        threadId: thread.id,
        count: 1,
        timeout: 4_000,
      })
      // Session should still be in an active phase (not aborted)
      expect(['collecting-baseline', 'dispatching', 'prompt-resolved']).toContain(
        midState.runState.phase,
      )

      // 5. Wait for the slow session to finish AND the queue to drain.
      // Using waitForThreadState with a compound predicate avoids matching
      // the transient 'finished' state from run A before run B starts.
      const finalState = await waitForThreadState({
        threadId: thread.id,
        predicate: (s) => {
          return s.runState.phase === 'finished' && s.queueItems.length === 0
        },
        timeout: 8_000,
        description: 'phase=finished AND queue empty (both runs completed)',
      })
      expect(finalState.runState.phase).toBe('finished')
      expect(finalState.queueItems.length).toBe(0)
    },
    12_000,
  )

  // ── Test 5: Slow transcription finishes after session becomes idle (race condition) ──

  test(
    'slow transcription completing after session finishes is handled correctly',
    async () => {
      // This tests the race condition where:
      // 1. Session starts with a fast response (~100ms)
      // 2. Voice message is sent simultaneously with slow transcription (500ms)
      // 3. The fast session finishes BEFORE transcription completes
      // 4. When transcription completes, the session is idle → should start new request

      // 1. Start a session with a fast response
      setDeterministicTranscription(null)
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'FAST_RESPONSE_MARKER quick task',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name?.includes('quick task') ?? false
        },
      })

      const th = discord.thread(thread.id)

      // Wait for the first bot reply (session established)
      await th.waitForBotReply({ timeout: 4_000 })

      // 2. Now send voice message with slow transcription
      // The fast response completes in ~100ms, but transcription takes 500ms.
      // By the time transcription returns, the session is already idle.
      setDeterministicTranscription({
        transcription: 'Delayed transcription result',
        queueMessage: false,
        delayMs: 500,
      })

      await th.user(TEST_USER_ID).sendVoiceMessage()

      // 3. The transcription should complete after the session finishes
      // and the transcribed message should be processed as a new request
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'Delayed transcription result',
        timeout: 4_000,
      })

      // 4. Session should process the delayed transcription and reach finished
      const finalState = await waitForThreadPhase({
        threadId: thread.id,
        phase: 'finished',
        timeout: 4_000,
      })
      expect(finalState.sessionId).toBeDefined()
      expect(finalState.queueItems.length).toBe(0)

      // 5. Verify the bot sent a session reply after the transcription
      // (there should be at least 2 session replies: one for the fast text, one for the voice)
      const messages = await th.getMessages()
      const botMessages = messages.filter((m) => {
        return m.author.id === discord.botUserId
      })
      // At minimum: transcribing msg + transcribed msg + session reply for text + session reply for voice
      expect(botMessages.length).toBeGreaterThanOrEqual(4)
    },
    8_000,
  )
})
