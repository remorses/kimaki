// E2e tests for per-thread message queue ordering.
// Uses opencode-deterministic-provider which returns canned responses instantly
// (no real LLM calls), so poll timeouts can be aggressive (4s). The only real
// latency is OpenCode server startup (beforeAll) and intentional partDelaysMs
// in matchers (700ms for user-reply, 2500ms for race-final-reply).
//
// Tests within a single file run sequentially (shared in-memory log buffer
// for failure diagnostics). If total duration of a file exceeds ~10s, split
// into a new test file so vitest can parallelize across files.

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
import { getOpencodeServers, initializeOpencodeForDirectory } from './opencode.js'
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

async function cleanupOpencodeServers() {
  const servers = getOpencodeServers()
  for (const [, server] of servers) {
    if (!server.process.killed) {
      server.process.kill('SIGTERM')
    }
  }
  servers.clear()
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
      // Delay first output to widen the window where a stale idle could end
      // this new request before it emits any assistant text.
      partDelaysMs: [0, 2500, 0, 0, 0],
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
      partDelaysMs: [0, 700, 0, 0, 0],
    },
  }

  return [
    sleepMatcher,
    raceFinalReplyMatcher,
    toolFollowupMatcher,
    userReplyMatcher,
  ]
}

/** Poll getMessages until we see at least `count` bot messages. */
async function waitForBotMessageCount({
  discord,
  threadId,
  count,
  timeout,
}: {
  discord: DigitalDiscord
  threadId: string
  count: number
  timeout: number
}) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const messages = await discord.thread(threadId).getMessages()
    const botMessages = messages.filter((m) => {
      return m.author.id === discord.botUserId
    })
    if (botMessages.length >= count) {
      return messages
    }
    await new Promise((r) => {
      setTimeout(r, 100)
    })
  }
  throw new Error(
    `Timed out waiting for ${count} bot messages in thread ${threadId}`,
  )
}

async function waitForBotReplyAfterUserMessage({
  discord,
  threadId,
  userMessageIncludes,
  timeout,
}: {
  discord: DigitalDiscord
  threadId: string
  userMessageIncludes: string
  timeout: number
}) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const messages = await discord.thread(threadId).getMessages()
    const userMessageIndex = messages.findIndex((message) => {
      return (
        message.author.id === TEST_USER_ID &&
        message.content.includes(userMessageIncludes)
      )
    })
    const botReplyIndex = messages.findIndex((message, index) => {
      return index > userMessageIndex && message.author.id === discord.botUserId
    })
    if (userMessageIndex >= 0 && botReplyIndex >= 0) {
      return messages
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100)
    })
  }
  throw new Error(
    `Timed out waiting for bot reply after user message containing "${userMessageIncludes}" in thread ${threadId}`,
  )
}

async function waitForBotMessageContaining({
  discord,
  threadId,
  text,
  afterUserMessageIncludes,
  timeout,
}: {
  discord: DigitalDiscord
  threadId: string
  text: string
  afterUserMessageIncludes?: string
  timeout: number
}) {
  const start = Date.now()
  let lastMessages: APIMessage[] = []
  while (Date.now() - start < timeout) {
    const messages = await discord.thread(threadId).getMessages()
    lastMessages = messages
    const afterIndex = afterUserMessageIncludes
      ? messages.findIndex((message) => {
          return (
            message.author.id === TEST_USER_ID &&
            message.content.includes(afterUserMessageIncludes)
          )
        })
      : -1
    const match = messages.find((message, index) => {
      if (afterUserMessageIncludes && afterIndex >= 0 && index <= afterIndex) {
        return false
      }
      return (
        message.author.id === discord.botUserId &&
        message.content.includes(text)
      )
    })
    if (match) {
      return messages
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100)
    })
  }
  const recent = lastMessages
    .slice(-12)
    .map((message) => {
      const role = message.author.id === discord.botUserId ? 'bot' : 'user'
      return `${role}: ${message.content.slice(0, 120)}`
    })
    .join('\n')
  throw new Error(
    `Timed out waiting for bot message containing "${text}" in thread ${threadId}. Recent messages:\n${recent}`,
  )
}

const TEST_USER_ID = '200000000000000777'
const TEXT_CHANNEL_ID = '200000000000000778'

e2eTest('thread message queue ordering', () => {
  let directories: ReturnType<typeof createRunDirectories>
  let discord: DigitalDiscord
  let botClient: Client
  let previousDefaultVerbosity: VerbosityLevel | null =
    null

  beforeAll(async () => {
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
  }, 60_000)

  afterAll(async () => {
    // Clean up opencode sessions created during tests
    if (directories) {
      const getClient = await initializeOpencodeForDirectory(
        directories.projectDirectory,
      )
      if (!(getClient instanceof Error)) {
        const client = getClient()
        const listResult = await client.session.list({
          directory: directories.projectDirectory,
        }).catch(() => {
          return null
        })
        const sessions = listResult?.data ?? []
        await Promise.all(
          sessions.map((s) => {
            return client.session.delete({
              sessionID: s.id,
              directory: directories.projectDirectory,
            }).catch(() => {
              return
            })
          }),
        )
      }
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

      // 2. Send follow-up message B into the thread — goes through threadMessageQueue
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

      // 2. Rapidly send messages B and C — both go through threadMessageQueue
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
      // When a new message queues behind a running session,
      // signalThreadInterrupt aborts the in-flight session immediately,
      // then the queue processes the next message.
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
      //    signalThreadInterrupt aborts B immediately so C can run.
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
        setTimeout(r, 500)
      })
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: india',
      })

      // 4. B is aborted and C gets processed.
      //    Poll until india's user message has a bot reply after it.
      const after = await waitForBotReplyAfterUserMessage({
        discord,
        threadId: thread.id,
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
    'abortActiveRun forces API abort when run controller is missing',
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

      runtime.abortActiveRun('force-abort-test', {
        forceApiAbortWithoutRunController: true,
      })

      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
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
