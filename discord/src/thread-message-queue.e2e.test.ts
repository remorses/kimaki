// E2e tests for basic per-thread message queue ordering.
// Advanced interrupt/abort/retry tests are in thread-queue-advanced.e2e.test.ts.
//
// Uses opencode-deterministic-provider which returns canned responses instantly
// (no real LLM calls), so poll timeouts can be aggressive (4s). The only real
// latency is OpenCode server startup (beforeAll) and intentional partDelaysMs
// in matchers (100ms for user-reply).
//
// If total duration of a file exceeds ~10s, split into a new test file
// so vitest can parallelize across files.

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
import { initializeOpencodeForDirectory, stopOpencodeServer } from './opencode.js'
import {
  cleanupTestSessions,
  waitForFooterMessage,
  waitForBotMessageContaining,
  waitForMessageById,
  waitForBotMessageCount,
  waitForBotReplyAfterUserMessage,
  waitForThreadState,
} from './test-utils.js'


const e2eTest = describe

function createRunDirectories() {
  const root = path.resolve(process.cwd(), 'tmp', 'thread-queue-e2e')
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

function createDeterministicMatchers() {
  const bashCreateFileMatcher: DeterministicMatcher = {
    id: 'bash-create-file',
    priority: 130,
    when: {
      lastMessageRole: 'user',
      rawPromptIncludes: 'BASH_TOOL_FILE_MARKER',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'bash-create-file' },
        {
          type: 'text-delta',
          id: 'bash-create-file',
          delta: 'running create file',
        },
        { type: 'text-end', id: 'bash-create-file' },
        {
          type: 'tool-call',
          toolCallId: 'bash-create-file-call',
          toolName: 'bash',
          input: JSON.stringify({
            command: 'mkdir -p tmp && printf "created" > tmp/bash-tool-executed.txt',
            description: 'Create marker file for e2e test',
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

  const bashCreateFileFollowupMatcher: DeterministicMatcher = {
    id: 'bash-create-file-followup',
    priority: 120,
    when: {
      lastMessageRole: 'tool',
      rawPromptIncludes: 'BASH_TOOL_FILE_MARKER',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'bash-create-file-followup' },
        {
          type: 'text-delta',
          id: 'bash-create-file-followup',
          delta: 'file created',
        },
        { type: 'text-end', id: 'bash-create-file-followup' },
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

  // Slow matcher for "hotel" so the 200ms sleep in the queueing test
  // guarantees "india" arrives while hotel is still streaming.
  const hotelSlowMatcher: DeterministicMatcher = {
    id: 'hotel-slow-reply',
    priority: 20,
    when: {
      latestUserTextIncludes: 'Reply with exactly: hotel',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'hotel-reply' },
        { type: 'text-delta', id: 'hotel-reply', delta: 'ok' },
        { type: 'text-end', id: 'hotel-reply' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
      partDelaysMs: [0, 100, 300, 0, 0],
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
    bashCreateFileMatcher,
    bashCreateFileFollowupMatcher,
    raceFinalReplyMatcher,
    hotelSlowMatcher,
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
    const lockPort = await chooseLockPort()

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
    const channelVerbosity = await getChannelVerbosity(TEXT_CHANNEL_ID)
    expect(channelVerbosity).toBe('tools_and_text')

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
    if (previousDefaultVerbosity) {
      store.setState({ defaultVerbosity: previousDefaultVerbosity })
    }
    if (directories) {
      fs.rmSync(directories.dataDir, { recursive: true, force: true })
    }
  }, 10_000)

  test(
    'first prompt after cold opencode server start still streams text parts',
    async () => {
      // Reproduce cold-start path: clear in-memory server/client registry so
      // runtime startEventListener() runs once before initialize and exits with
      // "No OpenCode client". The first prompt must still show text parts.
      await stopOpencodeServer()

      const prompt = 'Reply with exactly: cold-start-stream'

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
        text: '⬥ ok',
        timeout: 10_000,
      })

      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
      })

      expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
        "--- from: user (queue-tester)
        Reply with exactly: cold-start-stream
        --- from: assistant (TestBot)
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
    },
    12_000,
  )

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

      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'beta',
        afterAuthorId: TEST_USER_ID,
      })

      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (queue-tester)
        Reply with exactly: alpha
        --- from: assistant (TestBot)
        ⬥ ok
        --- from: user (queue-tester)
        Reply with exactly: beta
        --- from: assistant (TestBot)
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
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

      // 2. Rapidly send messages B and C. With opencode queue mode,
      // both messages are serialized by opencode's per-session loop.
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: two',
      })
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: three',
      })

      // 3. Wait for a bot reply after message C.
      const after = await waitForBotReplyAfterUserMessage({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        userMessageIncludes: 'three',
        timeout: 4_000,
      })

      // 4. Verify the latest user message got a bot reply.
      const afterBotMessages = after.filter((m) => {
        return m.author.id === discord.botUserId
      })
      expect(afterBotMessages.length).toBeGreaterThanOrEqual(beforeBotCount + 1)

      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'three',
        afterAuthorId: TEST_USER_ID,
      })

      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (queue-tester)
        Reply with exactly: one
        --- from: assistant (TestBot)
        ⬥ ok
        --- from: user (queue-tester)
        Reply with exactly: two
        Reply with exactly: three
        --- from: assistant (TestBot)
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
      const userThreeIndex = after.findIndex((message) => {
        return (
          message.author.id === TEST_USER_ID &&
          message.content.includes('three')
        )
      })
      expect(userThreeIndex).toBeGreaterThan(-1)

      const botAfterThreeIndex = after.findIndex((message, index) => {
        return index > userThreeIndex && message.author.id === discord.botUserId
      })
      expect(botAfterThreeIndex).toBeGreaterThan(userThreeIndex)

      const newBotReplies = afterBotMessages.slice(beforeBotCount)
      expect(newBotReplies.some((reply) => {
        return reply.content.trim().length > 0
      })).toBe(true)

      const finalState = await waitForThreadState({
        threadId: thread.id,
        predicate: (state) => {
          return state.queueItems.length === 0
        },
        timeout: 4_000,
        description: 'queue empty after rapid interrupts',
      })
      expect(finalState.queueItems.length).toBe(0)
    },
    8_000,
  )

  test(
    'normal messages bypass local queue and still show assistant text parts',
    async () => {
      const setupPrompt = 'Reply with exactly: opencode-queue-setup'
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: setupPrompt,
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: opencode-queue-setup'
        },
      })

      const th = discord.thread(thread.id)
      const firstReply = await th.waitForBotReply({ timeout: 4_000 })
      expect(firstReply.content.trim().length).toBeGreaterThan(0)

      // Anchor follow-up on an already-completed first run so footer ordering
      // is deterministic before we assert on the second prompt.
      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
      })

      const followupPrompt =
        'Prompt from test: respond with short text for opencode queue mode.'

      const followupUserMessage = await th.user(TEST_USER_ID).sendMessage({
        content: followupPrompt,
      })

      // Assert assistant text parts are visible in Discord.
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '⬥ ok',
        afterMessageId: followupUserMessage.id,
        timeout: 4_000,
      })

      const messagesWithFollowupFooter = await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: followupPrompt,
        afterAuthorId: TEST_USER_ID,
      })

      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (queue-tester)
        Reply with exactly: opencode-queue-setup
        --- from: assistant (TestBot)
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (queue-tester)
        Prompt from test: respond with short text for opencode queue mode.
        --- from: assistant (TestBot)
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
      const followupUserIndex = messagesWithFollowupFooter.findIndex((message) => {
        return message.id === followupUserMessage.id
      })
      const textPartAfterFollowupIndex = messagesWithFollowupFooter.findIndex((message, index) => {
        return (
          index > followupUserIndex &&
          message.author.id === discord.botUserId &&
          message.content.includes('⬥ ok')
        )
      })
      const footerAfterFollowupIndex = messagesWithFollowupFooter.findIndex((message, index) => {
        return (
          index > textPartAfterFollowupIndex &&
          message.author.id === discord.botUserId &&
          message.content.startsWith('*') &&
          message.content.includes('⋅')
        )
      })
      expect(followupUserIndex).toBeGreaterThan(-1)
      expect(textPartAfterFollowupIndex).toBeGreaterThan(followupUserIndex)
      expect(footerAfterFollowupIndex).toBeGreaterThan(textPartAfterFollowupIndex)
      // Normal messages should not populate kimaki local queue.
      const noLocalQueueState = await waitForThreadState({
        threadId: thread.id,
        predicate: (state) => {
          return state.queueItems.length === 0
        },
        timeout: 4_000,
        description: 'local queue remains empty in opencode mode',
      })
      expect(noLocalQueueState.queueItems.length).toBe(0)
    },
    8_000,
  )

  test(
    'bash tool-call actually executes and creates file in project directory',
    async () => {
      const markerRelativePath = path.join('tmp', 'bash-tool-executed.txt')
      const markerPath = path.join(directories.projectDirectory, markerRelativePath)
      fs.rmSync(markerPath, { force: true })

      const prompt = 'Reply with exactly: BASH_TOOL_FILE_MARKER'
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
        text: 'running create file',
        timeout: 4_000,
      })

      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
      })

      const deadline = Date.now() + 4_000
      while (!fs.existsSync(markerPath) && Date.now() < deadline) {
        await new Promise((resolve) => {
          setTimeout(resolve, 100)
        })
      }

      expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
        "--- from: user (queue-tester)
        Reply with exactly: BASH_TOOL_FILE_MARKER
        --- from: assistant (TestBot)
        ⬥ running create file
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        ⬥ ok"
      `)
      expect(fs.existsSync(markerPath)).toBe(true)
      const markerContents = fs.readFileSync(markerPath, 'utf8')
      expect(markerContents).toBe('created')
    },
    8_000,
  )

  test(
    '/queue shows queued status first, then dispatch indicator when dequeued',
    async () => {
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: queue-slash-setup',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: queue-slash-setup'
        },
      })

      const th = discord.thread(thread.id)
      const firstReply = await th.waitForBotReply({ timeout: 4_000 })
      expect(firstReply.content.trim().length).toBeGreaterThan(0)

      // Ensure the setup run is fully settled before slash-queue checks.
      // Otherwise the first /queue call can race with a still-busy run window.
      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
      })

      // Start a non-interrupting queued slash message while idle so it
      // dispatches immediately and keeps the runtime active.
      const { id: firstQueueInteractionId } = await th.user(TEST_USER_ID)
        .runSlashCommand({
          name: 'queue',
          options: [{ name: 'message', type: 3, value: 'Reply with exactly: race-final' }],
        })

      const firstQueueAck = await th.waitForInteractionAck({
        interactionId: firstQueueInteractionId,
        timeout: 4_000,
      })
      if (!firstQueueAck.messageId) {
        throw new Error('Expected first /queue response message id')
      }

      const firstQueueAckMessage = await waitForMessageById({
        discord,
        threadId: thread.id,
        messageId: firstQueueAck.messageId,
        timeout: 4_000,
      })
      expect(firstQueueAckMessage.content).toContain('» **queue-tester:** Reply with exactly: race-final')

      const queuedPrompt = 'Reply with exactly: queued-from-slash'
      const { id: interactionId } = await th.user(TEST_USER_ID).runSlashCommand({
        name: 'queue',
        options: [{ name: 'message', type: 3, value: queuedPrompt }],
      })

      const queuedAck = await th.waitForInteractionAck({ interactionId, timeout: 4_000 })
      if (!queuedAck.messageId) {
        throw new Error('Expected queued /queue response message id')
      }

      const queuedStatusMessage = await waitForMessageById({
        discord,
        threadId: thread.id,
        messageId: queuedAck.messageId,
        timeout: 4_000,
      })
      expect(queuedStatusMessage.content.startsWith('Queued message')).toBe(true)

      const expectedDispatchIndicator = `» **queue-tester:** ${queuedPrompt}`
      const messagesWithDispatch = await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: expectedDispatchIndicator,
        afterMessageId: queuedStatusMessage.id,
        timeout: 8_000,
      })

      const queuedStatusIndex = messagesWithDispatch.findIndex((message) => {
        return message.id === queuedStatusMessage.id
      })
      const dispatchIndicatorIndex = messagesWithDispatch.findIndex((message) => {
        return (
          message.author.id === discord.botUserId &&
          message.content.includes(expectedDispatchIndicator)
        )
      })
      expect(queuedStatusIndex).toBeGreaterThan(-1)
      expect(dispatchIndicatorIndex).toBeGreaterThan(queuedStatusIndex)

      const dispatchIndicatorMessage = messagesWithDispatch[dispatchIndicatorIndex]
      if (!dispatchIndicatorMessage) {
        throw new Error('Expected dispatch indicator message')
      }

      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        text: '⬥ ok',
        afterMessageId: dispatchIndicatorMessage.id,
        timeout: 8_000,
      })

      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 8_000,
        afterMessageIncludes: '⬥ ok',
        afterAuthorId: discord.botUserId,
      })

      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (queue-tester)
        Reply with exactly: queue-slash-setup
        --- from: assistant (TestBot)
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        » **queue-tester:** Reply with exactly: race-final
        Queued message (position 1)
        ⬥ race-final
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        » **queue-tester:** Reply with exactly: queued-from-slash
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
    },
    12_000,
  )

  test(
    'queued message waits for running session and then processes next',
    async () => {
      // When a new message arrives while a session is running, it queues and
      // runs after the in-flight request completes.
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

      // 2. Send B, then quickly send C to enqueue behind B.
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

      // 4. Foxtrot got a bot response after B/C were processed.
      const afterBotMessages = after.filter((m) => {
        return m.author.id === discord.botUserId
      })
      expect(afterBotMessages.length).toBeGreaterThanOrEqual(beforeBotCount + 1)

      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'foxtrot',
        afterAuthorId: TEST_USER_ID,
      })

      const userEchoIndex = after.findIndex((m) => {
        return m.author.id === TEST_USER_ID && m.content.includes('echo')
      })
      const userFoxtrotIndex = after.findIndex((m) => {
        return m.author.id === TEST_USER_ID && m.content.includes('foxtrot')
      })
      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (queue-tester)
        Reply with exactly: delta
        --- from: assistant (TestBot)
        ⬥ ok
        --- from: user (queue-tester)
        Reply with exactly: echo
        --- from: assistant (TestBot)
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (queue-tester)
        Reply with exactly: foxtrot
        --- from: assistant (TestBot)
        ⬥ ok
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
      expect(userEchoIndex).toBeGreaterThan(-1)
      expect(userFoxtrotIndex).toBeGreaterThan(-1)

      // Foxtrot's bot reply appears after the foxtrot user message
      const botAfterFoxtrot = after.findIndex((m, i) => {
        return i > userFoxtrotIndex && m.author.id === discord.botUserId
      })
      expect(botAfterFoxtrot).toBeGreaterThan(userFoxtrotIndex)

      // With queued-by-default behavior, dispatch indicator may appear.
    },
    8_000,
  )

  test(
    'slow stream still processes queued next message after completion',
    async () => {
      // A message sent mid-stream queues and runs after the in-flight request
      // completes (no auto-interrupt).

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

      // Wait for golf's footer so the golf→hotel transition is deterministic
      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'ok',
        afterAuthorId: discord.botUserId,
      })

      const before = await th.getMessages()
      const beforeBotCount = before.filter((m) => {
        return m.author.id === discord.botUserId
      }).length

      // 2. Start request B (hotel, slow matcher ~400ms), then send C while B
      //    is still in progress.
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: hotel',
      })

      // 3. Wait briefly for B to start, then send C to queue behind it
      await new Promise((r) => {
        setTimeout(r, 200)
      })
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: india',
      })

      // 4. B completes, then C gets processed.
      //    Poll until india's user message has a bot reply after it.
      const after = await waitForBotReplyAfterUserMessage({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        userMessageIncludes: 'india',
        timeout: 4_000,
      })

      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'india',
        afterAuthorId: TEST_USER_ID,
      })

      // C's user message appears before its bot response.
      // We assert on india's reply existence.
      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (queue-tester)
        Reply with exactly: golf
        --- from: assistant (TestBot)
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (queue-tester)
        Reply with exactly: hotel
        Reply with exactly: india
        --- from: assistant (TestBot)
        ⬥ ok
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
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
    'queue drains correctly after bursty queued messages',
    async () => {
      // Verifies the queue doesn't get stuck after multiple rapid messages.

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

      // 2. Rapidly send B, C, D back-to-back to avoid timing windows where
      // one run can finish between sends and reorder transcript lines.
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: kilo',
      })
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: lima',
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

      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'november',
        afterAuthorId: TEST_USER_ID,
      })

      expect(await th.text()).toMatchInlineSnapshot(`
        "--- from: user (queue-tester)
        Reply with exactly: juliet
        --- from: assistant (TestBot)
        ⬥ ok
        --- from: user (queue-tester)
        Reply with exactly: kilo
        Reply with exactly: lima
        Reply with exactly: mike
        --- from: assistant (TestBot)
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (queue-tester)
        Reply with exactly: november
        --- from: assistant (TestBot)
        ⬥ ok
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
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
