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
import { describe, beforeAll, afterAll, beforeEach, test, expect } from 'vitest'
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
import { initializeOpencodeForDirectory, getOpencodeClient, stopOpencodeServer } from './opencode.js'
import type { Part, Message } from '@opencode-ai/sdk/v2'
import {
  chooseLockPort,
  cleanupTestSessions,
  initTestGitRepo,
  waitForFooterMessage,
  waitForBotMessageContaining,
  waitForThreadState,
} from './test-utils.js'

import { getThreadState } from './session-handler/thread-runtime-state.js'

const e2eTest = describe

// ── Helpers ──────────────────────────────────────────────────────

function createRunDirectories() {
  const root = path.resolve(process.cwd(), 'tmp', 'voice-msg-e2e')
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

/** Set the deterministic transcription config in the store for the next voice message. */
function setDeterministicTranscription(config: DeterministicTranscriptionConfig | null) {
  store.setState({
    test: { deterministicTranscription: config },
  })
}

// ── OpenCode session assertion helpers ───────────────────────────
// These verify what actually happened in the OpenCode session (prompts
// sent, aborts, responses) beyond just Discord messages and thread state.

type SessionMessage = { info: Message; parts: Part[] }

function getOpencodeClientForTest(projectDirectory: string) {
  const client = getOpencodeClient(projectDirectory)
  if (!client) {
    throw new Error('OpenCode client not found for project directory')
  }
  return client
}

/** Extract text content from an array of parts (filters to TextPart only). */
function getTextFromParts(parts: Part[]): string[] {
  return parts.flatMap((part) => {
    if (part.type === 'text') {
      return [part.text]
    }
    return []
  })
}

/** Get all user-role messages' text parts joined. */
function getUserTexts(messages: SessionMessage[]): string[] {
  return messages
    .filter((m) => m.info.role === 'user')
    .flatMap((m) => getTextFromParts(m.parts))
}

/** Get all assistant-role messages' text parts joined. */
function getAssistantTexts(messages: SessionMessage[]): string[] {
  return messages
    .filter((m) => m.info.role === 'assistant')
    .flatMap((m) => getTextFromParts(m.parts))
}

/**
 * Poll session.messages() until predicate returns true.
 * Used to wait for async session updates (prompts dispatched, responses completed).
 */
async function waitForSessionMessages({
  projectDirectory,
  sessionID,
  timeout,
  predicate,
  description,
}: {
  projectDirectory: string
  sessionID: string
  timeout: number
  predicate: (messages: SessionMessage[]) => boolean
  description: string
}): Promise<SessionMessage[]> {
  const client = getOpencodeClientForTest(projectDirectory)
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const result = await client.session.messages({
      sessionID,
      directory: projectDirectory,
    })
    const messages = result.data ?? []
    if (predicate(messages)) {
      return messages
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100)
    })
  }
  // Final attempt for error reporting
  const finalResult = await client.session.messages({
    sessionID,
    directory: projectDirectory,
  })
  const finalMessages = finalResult.data ?? []
  const userTexts = getUserTexts(finalMessages)
  const assistantTexts = getAssistantTexts(finalMessages)
  throw new Error(
    `Timed out waiting for session messages (${description}). ` +
    `User texts: ${JSON.stringify(userTexts.map((t) => t.slice(0, 80)))}. ` +
    `Assistant texts: ${JSON.stringify(assistantTexts.map((t) => t.slice(0, 80)))}`,
  )
}

// ── Deterministic provider matchers ──────────────────────────────
// The opencode session uses these to produce canned responses.

function createDeterministicMatchers(): DeterministicMatcher[] {
  // Slow response: emits text-delta after 2s delay, giving voice messages
  // time to arrive while the session is still "running".
  // Uses latestUserTextIncludes (not rawPromptIncludes) so it only matches
  // the current user message, not previous messages in session history.
  const slowResponse: DeterministicMatcher = {
    id: 'slow-response',
    priority: 100,
    when: {
      latestUserTextIncludes: 'SLOW_RESPONSE_MARKER',
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
      latestUserTextIncludes: 'FAST_RESPONSE_MARKER',
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
    const lockPort = chooseLockPort({ key: TEXT_CHANNEL_ID })

    process.env['KIMAKI_LOCK_PORT'] = String(lockPort)
    setDataDir(directories.dataDir)
    previousDefaultVerbosity = store.getState().defaultVerbosity
    store.setState({ defaultVerbosity: 'tools_and_text' })

    const digitalDiscordDbPath = path.join(
      directories.dataDir,
      'digital-discord.db',
    )

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
    await setChannelVerbosity(TEXT_CHANNEL_ID, 'tools_and_text')

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
  }, 20_000)

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

    await stopOpencodeServer()
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
  }, 5_000)

  beforeEach(() => {
    // Reset deterministic transcription before each test to prevent leakage
    // from a failed test that set it but didn't clean up
    setDeterministicTranscription(null)
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

      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
      })

      // Assert thread state has a session and no queued messages after footer.
      const finalState = await waitForThreadState({
        threadId: thread.id,
        predicate: (state) => {
          return Boolean(state.sessionId) && state.queueItems.length === 0
        },
        timeout: 4_000,
        description: 'voice turn settled with empty queue',
      })

      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
      })

      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (voice-tester)
        [attachment: voice-message.ogg]
        --- from: assistant (TestBot)
        🎤 Transcribing voice message...
        📝 **Transcribed message:** Fix the login bug in auth.ts
        ⬥ session-reply
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
      expect(finalState.sessionId).toBeDefined()

      // Verify OpenCode session received the transcribed voice message as a prompt
      const messages = await waitForSessionMessages({
        projectDirectory: directories.projectDirectory,
        sessionID: finalState.sessionId!,
        timeout: 4_000,
        description: 'voice transcription prompt sent to session',
        predicate: (all) => {
          const userTexts = getUserTexts(all)
          return userTexts.some((text) => text.includes('Fix the login bug in auth.ts'))
        },
      })
      const userTexts = getUserTexts(messages)
      expect(userTexts.some((t) => t.includes('Fix the login bug in auth.ts'))).toBe(true)
      // Session should have at least one assistant response
      const assistantTexts = getAssistantTexts(messages)
      expect(assistantTexts.length).toBeGreaterThan(0)
    },
    8_000,
  )

  test(
    'voice attachment without content type still transcribes and avoids empty prompt dispatch',
    async () => {
      setDeterministicTranscription({
        transcription: 'Investigate the missing content type path',
        queueMessage: false,
      })

      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: '',
        attachments: [
          {
            id: 'voice-no-content-type',
            filename: 'voice-message.ogg',
            size: 1024,
            url: 'https://fake-cdn.discord.test/voice-no-content-type.ogg',
            proxy_url: 'https://fake-cdn.discord.test/voice-no-content-type.ogg',
          },
        ],
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name?.includes('Investigate the missing content type path') ?? false
        },
      })

      const th = discord.thread(thread.id)

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
        text: 'Investigate the missing content type path',
        timeout: 4_000,
      })

      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
      })

      const finalState = await waitForThreadState({
        threadId: thread.id,
        predicate: (state) => {
          return Boolean(state.sessionId) && state.queueItems.length === 0
        },
        timeout: 4_000,
        description: 'voice attachment without content type settled',
      })

      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (voice-tester)
        [attachment: voice-message.ogg]
        --- from: assistant (TestBot)
        🎤 Transcribing voice message...
        📝 **Transcribed message:** Investigate the missing content type path
        ⬥ session-reply
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)

      const messages = await waitForSessionMessages({
        projectDirectory: directories.projectDirectory,
        sessionID: finalState.sessionId!,
        timeout: 4_000,
        description: 'voice attachment without content type dispatched once',
        predicate: (all) => {
          const userTexts = getUserTexts(all)
          return userTexts.some((text) => {
            return text.includes('Investigate the missing content type path')
          })
        },
      })

      const userTexts = getUserTexts(messages)
      expect(userTexts).not.toContain('')
      expect(
        userTexts.some((text) => {
          return text.includes('Investigate the missing content type path')
        }),
      ).toBe(true)
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

      // Wait for the initial setup turn to fully complete before sending voice.
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'fast-response-done',
        timeout: 4_000,
      })
      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
      })

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

      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'session-reply',
        timeout: 4_000,
      })

      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'session-reply',
        afterAuthorId: discord.botUserId,
      })

      const finalState = getThreadState(thread.id)
      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (voice-tester)
        FAST_RESPONSE_MARKER initial setup
        --- from: assistant (TestBot)
        ⬥ fast-response-done
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (voice-tester)
        [attachment: voice-message.ogg]
        --- from: assistant (TestBot)
        🎤 Transcribing voice message...
        📝 **Transcribed message:** Add error handling to the parser
        ⬥ session-reply
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
      expect(finalState?.sessionId).toBeDefined()
      if (!finalState?.sessionId) {
        throw new Error('Expected final state with sessionId')
      }
      expect(finalState.queueItems.length).toBe(0)

      // Verify the same OpenCode session received both prompts:
      // the initial text message AND the voice transcription
      const messages = await waitForSessionMessages({
        projectDirectory: directories.projectDirectory,
        sessionID: finalState.sessionId,
        timeout: 4_000,
        description: 'idle session receives voice transcription prompt',
        predicate: (all) => {
          const userTexts = getUserTexts(all)
          return (
            userTexts.some((t) => t.includes('FAST_RESPONSE_MARKER initial setup')) &&
            userTexts.some((t) => t.includes('Add error handling to the parser'))
          )
        },
      })
      const userTexts = getUserTexts(messages)
      expect(userTexts.some((t) => t.includes('FAST_RESPONSE_MARKER initial setup'))).toBe(true)
      expect(userTexts.some((t) => t.includes('Add error handling to the parser'))).toBe(true)
      // Both prompts should have gotten assistant responses
      const assistantTexts = getAssistantTexts(messages)
      expect(assistantTexts.length).toBeGreaterThanOrEqual(2)
    },
    8_000,
  )

  // ── Test 3: Voice message queues behind running session (default) ──

  test.skip(
    'voice message with queueMessage=false queues behind running session',
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

      // 2. Send voice message while session is running (default: queue)
      setDeterministicTranscription({
        transcription: 'Stop and do this instead',
        queueMessage: false,
      })

      await th.user(TEST_USER_ID).sendVoiceMessage()

      // 3. Wait for transcription to appear first
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'Stop and do this instead',
        timeout: 4_000,
      })

      // queueMessage=false no longer interrupts by default, so we should NOT
      // receive the queued-position ack that queueMessage=true sends.
      const afterTranscription = await th.getMessages()
      const hasQueuedAck = afterTranscription.some((m) => {
        return (
          m.author.id === discord.botUserId &&
          m.content.includes('Queued at position')
        )
      })
      expect(hasQueuedAck).toBe(false)

      const midState = getThreadState(thread.id)
      expect(midState).toBeDefined()

      // 4. Wait for both runs to finish (slow prompt + queued transcription)
      const finalState = await waitForThreadState({
        threadId: thread.id,
        predicate: (s) => {
          return s.queueItems.length === 0
        },
        timeout: 8_000,
        description: 'queue empty (default queued voice behavior)',
      })
      expect(finalState.sessionId).toBeDefined()
      expect(finalState.queueItems.length).toBe(0)

      // Verify the OpenCode session processed both prompts sequentially.
      const messages = await waitForSessionMessages({
        projectDirectory: directories.projectDirectory,
        sessionID: finalState.sessionId!,
        timeout: 4_000,
        description: 'default queue: original prompt + voice prompt',
        predicate: (all) => {
          const userTexts = getUserTexts(all)
          const assistantTexts = getAssistantTexts(all)
          return (
            userTexts.some((t) => t.includes('SLOW_RESPONSE_MARKER start slow task')) &&
            userTexts.some((t) => t.includes('Stop and do this instead')) &&
            assistantTexts.some((t) => t.includes('slow-response-done')) &&
            assistantTexts.some((t) => t.includes('session-reply'))
          )
        },
      })
      const userTexts = getUserTexts(messages)
      // Both prompts were sent to the same session
      expect(userTexts.some((t) => t.includes('SLOW_RESPONSE_MARKER start slow task'))).toBe(true)
      expect(userTexts.some((t) => t.includes('Stop and do this instead'))).toBe(true)

      const assistantTexts = getAssistantTexts(messages)
      expect(assistantTexts.some((t) => t.includes('slow-response-done'))).toBe(true)
      expect(assistantTexts.some((t) => t.includes('session-reply'))).toBe(true)
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

      // 2. Send voice message with queueMessage=true (should NOT interrupt)
      setDeterministicTranscription({
        transcription: 'Queue this task for later',
        queueMessage: true,
      })

      await th.user(TEST_USER_ID).sendVoiceMessage()

      // 3. Transcription should appear, followed by queue notification
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'Queue this task for later',
        timeout: 4_000,
      })

      const messagesWithQueueAck = await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'Queued at position',
        timeout: 4_000,
      })
      const queueAckMessage = messagesWithQueueAck.find((message) => {
        return (
          message.author.id === discord.botUserId
          && message.content.includes('Queued at position')
        )
      })
      expect(queueAckMessage).toBeDefined()

      // 4. queueMessage=true should not interrupt the in-flight response.
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'slow-response-done',
        timeout: 4_000,
      })

      if (!queueAckMessage) {
        throw new Error('Expected queue ack message')
      }

      const dispatchPrefix = '» **voice-tester:** Voice message transcription from Discord user:'
      const messagesWithDispatch = await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        text: dispatchPrefix,
        afterMessageId: queueAckMessage.id,
        timeout: 8_000,
      })
      const dispatchMessage = messagesWithDispatch.find((message) => {
        return (
          message.author.id === discord.botUserId
          && message.content.includes(dispatchPrefix)
        )
      })
      expect(dispatchMessage).toBeDefined()

      if (!dispatchMessage) {
        throw new Error('Expected queued dispatch indicator message')
      }

      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        text: 'session-reply',
        afterMessageId: dispatchMessage.id,
        timeout: 8_000,
      })

      // 5. Wait for the slow session to finish AND the queue to drain.
      // Using waitForThreadState with a compound predicate avoids matching
      // the transient 'idle' state from run A before run B starts.
      const finalState = await waitForThreadState({
        threadId: thread.id,
        predicate: (s) => {
          return s.queueItems.length === 0
        },
        timeout: 8_000,
        description: 'queue empty (both runs completed)',
      })

      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'session-reply',
        afterAuthorId: discord.botUserId,
      })

      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (voice-tester)
        SLOW_RESPONSE_MARKER start queued task
        [attachment: voice-message.ogg]
        --- from: assistant (TestBot)
        🎤 Transcribing voice message...
        📝 **Transcribed message:** Queue this task for later
        Queued at position 1
        ⬥ slow-response-done
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        » **voice-tester:** Voice message transcription from Discord user:
        Queue this task for later
        ⬥ session-reply
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
      expect(finalState.queueItems.length).toBe(0)

      // Verify the OpenCode session processed BOTH prompts sequentially:
      // the slow initial prompt completed, then the queued voice prompt ran
      const messages = await waitForSessionMessages({
        projectDirectory: directories.projectDirectory,
        sessionID: finalState.sessionId!,
        timeout: 4_000,
        description: 'queue: both prompts processed with responses',
        predicate: (all) => {
          const userTexts = getUserTexts(all)
          const assistantTexts = getAssistantTexts(all)
          return (
            userTexts.some((t) => t.includes('SLOW_RESPONSE_MARKER start queued task')) &&
            userTexts.some((t) => t.includes('Queue this task for later')) &&
            assistantTexts.some((t) => t.includes('slow-response-done')) &&
            assistantTexts.some((t) => t.includes('session-reply'))
          )
        },
      })
      const userTexts = getUserTexts(messages)
      const assistantTexts = getAssistantTexts(messages)
      // Both prompts sent to the session
      expect(userTexts.some((t) => t.includes('SLOW_RESPONSE_MARKER start queued task'))).toBe(true)
      expect(userTexts.some((t) => t.includes('Queue this task for later'))).toBe(true)
      // Both got responses (slow response + default reply for queued message)
      expect(assistantTexts.some((t) => t.includes('slow-response-done'))).toBe(true)
      expect(assistantTexts.some((t) => t.includes('session-reply'))).toBe(true)
      // No abort errors — the queue preserved the first run
      const abortedAssistant = messages.find((m) => {
        return m.info.role === 'assistant' && m.info.error?.name === 'MessageAbortedError'
      })
      expect(abortedAssistant).toBeUndefined()
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

      // Wait for the first run to complete before sending voice.
      await th.waitForBotReply({ timeout: 4_000 })
      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
      })

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

      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'Delayed transcription result',
        afterAuthorId: discord.botUserId,
      })

      // 4. Session should process the delayed transcription and settle.
      const finalState = await waitForThreadState({
        threadId: thread.id,
        predicate: (state) => {
          return Boolean(state.sessionId) && state.queueItems.length === 0
        },
        timeout: 4_000,
        description: 'delayed transcription settled with empty queue',
      })

      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (voice-tester)
        FAST_RESPONSE_MARKER quick task
        --- from: assistant (TestBot)
        ⬥ fast-response-done
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (voice-tester)
        [attachment: voice-message.ogg]
        --- from: assistant (TestBot)
        🎤 Transcribing voice message...
        📝 **Transcribed message:** Delayed transcription result
        ⬥ session-reply
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
      expect(finalState.sessionId).toBeDefined()
      expect(finalState.queueItems.length).toBe(0)

      // 5. Verify the OpenCode session processed both prompts on the same session:
      // the fast text message completed first, then the delayed voice transcription
      const sessionMessages = await waitForSessionMessages({
        projectDirectory: directories.projectDirectory,
        sessionID: finalState.sessionId!,
        timeout: 4_000,
        description: 'race: both prompts processed with responses on same session',
        predicate: (all) => {
          const userTexts = getUserTexts(all)
          const aTexts = getAssistantTexts(all)
          return (
            userTexts.some((t) => t.includes('FAST_RESPONSE_MARKER quick task')) &&
            userTexts.some((t) => t.includes('Delayed transcription result')) &&
            aTexts.length >= 2
          )
        },
      })
      const userTexts = getUserTexts(sessionMessages)
      expect(userTexts.some((t) => t.includes('FAST_RESPONSE_MARKER quick task'))).toBe(true)
      expect(userTexts.some((t) => t.includes('Delayed transcription result'))).toBe(true)
      // Both prompts got assistant responses (no aborts — second arrived after first finished)
      const assistantTexts = getAssistantTexts(sessionMessages)
      expect(assistantTexts.length).toBeGreaterThanOrEqual(2)
      const abortedAssistant = sessionMessages.find((m) => {
        return m.info.role === 'assistant' && m.info.error?.name === 'MessageAbortedError'
      })
      expect(abortedAssistant).toBeUndefined()
    },
    8_000,
  )

  // ── Test 6: Slow transcription with queueMessage=true arriving after idle queue drain ──

  test(
    'slow queued transcription completing after session idle is dispatched',
    async () => {
      // Reproduces the bug where a voice message with queueMessage=true has
      // slow transcription that completes after the session is already idle.
      // The message gets inserted into the local queue but was never drained
      // because handleSessionIdle() didn't call tryDrainQueue().
      //
      // 1. Send a fast text message → session starts and finishes quickly
      // 2. Send a voice message with queueMessage=true and slow transcription
      // 3. Fast session finishes → handleSessionIdle fires
      // 4. Transcription completes → enqueueViaLocalQueue adds item
      // 5. tryDrainQueue in handleSessionIdle should pick it up

      // 1. Start a session with a fast response
      setDeterministicTranscription(null)
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'FAST_RESPONSE_MARKER fast before queued voice',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name?.includes('fast before queued voice') ?? false
        },
      })

      const th = discord.thread(thread.id)

      // Wait for the first run to fully complete before sending the queued voice message.
      await th.waitForBotReply({ timeout: 4_000 })
      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
      })

      // 2. Send voice message with queueMessage=true AND slow transcription.
      // Session is already idle when this arrives. The transcription delay
      // means the message enters the local queue after idle has fired.
      setDeterministicTranscription({
        transcription: 'Queued voice after idle',
        queueMessage: true,
        delayMs: 500,
      })

      await th.user(TEST_USER_ID).sendVoiceMessage()

      // 3. The transcription should complete, and even though queueMessage=true
      // routes through the local queue, the item should be drained immediately
      // because the session is idle. No dispatch indicator (» prefix) appears
      // because the message is dispatched immediately by enqueueViaLocalQueue's
      // tryDrainQueue (showIndicator=false for first drain).
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'Queued voice after idle',
        timeout: 4_000,
      })

      // Wait for the queued message response and footer
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        text: 'session-reply',
        timeout: 4_000,
      })

      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'session-reply',
        afterAuthorId: discord.botUserId,
      })

      // 4. Final state: queue should be empty
      const finalState = await waitForThreadState({
        threadId: thread.id,
        predicate: (state) => {
          return Boolean(state.sessionId) && state.queueItems.length === 0
        },
        timeout: 4_000,
        description: 'queued voice after idle settled with empty queue',
      })

      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (voice-tester)
        FAST_RESPONSE_MARKER fast before queued voice
        --- from: assistant (TestBot)
        ⬥ fast-response-done
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (voice-tester)
        [attachment: voice-message.ogg]
        --- from: assistant (TestBot)
        🎤 Transcribing voice message...
        📝 **Transcribed message:** Queued voice after idle
        ⬥ session-reply
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
      expect(finalState.sessionId).toBeDefined()
      expect(finalState.queueItems.length).toBe(0)

      // 5. Verify the OpenCode session processed both prompts
      const sessionMessages = await waitForSessionMessages({
        projectDirectory: directories.projectDirectory,
        sessionID: finalState.sessionId!,
        timeout: 4_000,
        description: 'queued-voice-idle: both prompts processed',
        predicate: (all) => {
          const userTexts = getUserTexts(all)
          const aTexts = getAssistantTexts(all)
          return (
            userTexts.some((t) => t.includes('FAST_RESPONSE_MARKER fast before queued voice')) &&
            userTexts.some((t) => t.includes('Queued voice after idle')) &&
            aTexts.length >= 2
          )
        },
      })
      const userTexts = getUserTexts(sessionMessages)
      expect(userTexts.some((t) => t.includes('FAST_RESPONSE_MARKER fast before queued voice'))).toBe(true)
      expect(userTexts.some((t) => t.includes('Queued voice after idle'))).toBe(true)
      const assistantTexts = getAssistantTexts(sessionMessages)
      expect(assistantTexts.length).toBeGreaterThanOrEqual(2)
    },
    10_000,
  )
})
