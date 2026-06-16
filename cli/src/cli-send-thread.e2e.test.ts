// E2e test for `kimaki send --channel` flow.
// Reproduces the race condition where the bot's MessageCreate GuildText handler
// tries to call startThread() on the same message that the CLI already created
// a thread for via REST, causing DiscordAPIError[160004].
//
// The test simulates the exact flow: bot posts a starter message with a
// `start: true` embed marker, then creates a thread on that message via REST.
// The ThreadCreate handler should pick it up and start a session. The
// MessageCreate handler must NOT try to startThread() on the same message.
//
// Uses opencode-deterministic-provider (no real LLM calls).
// Poll timeouts: 4s max, 100ms interval.

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { describe, beforeAll, afterAll, test, expect } from 'vitest'
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  Routes,
} from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import {
  buildDeterministicOpencodeConfig,
  type DeterministicMatcher,
} from 'opencode-deterministic-provider'
import { setDataDir } from './config.js'
import { store } from './store.js'
import { startDiscordBot } from './discord-bot.js'
import {
  setBotToken,
  initDatabase,
  closeDatabase,
  setChannelDirectory,
  setChannelMentionMode,
  setChannelVerbosity,
  type VerbosityLevel,
} from './database.js'
import { startHranaServer, stopHranaServer } from './hrana-server.js'
import {
  initializeOpencodeForDirectory,
  stopOpencodeServer,
} from './opencode.js'
import {
  chooseAvailableLockPort,
  cleanupTestSessions,
  initTestGitRepo,
  waitForBotMessageContaining,
  waitForFooterMessage,
} from './test-utils.js'
import YAML from 'yaml'
import type { ThreadStartMarker } from './system-message.js'

const TEST_USER_ID = '200000000000000830'
const TEXT_CHANNEL_ID = '200000000000000831'
const BOT_USER_ID = '200000000000000832'
const EMPTY_CONTENT_CHANNEL_ID = '200000000000000833'
const MENTION_MODE_EMPTY_CONTENT_CHANNEL_ID = '200000000000000834'
const THREAD_EMPTY_CONTENT_CHANNEL_ID = '200000000000000835'

function createRunDirectories() {
  const root = path.resolve(process.cwd(), 'tmp', 'cli-send-thread-e2e')
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

function createDeterministicMatchers(): DeterministicMatcher[] {
  const userReplyMatcher: DeterministicMatcher = {
    id: 'user-reply',
    priority: 10,
    when: {
      lastMessageRole: 'user',
      latestUserTextIncludes: 'Reply with exactly:',
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

  // Catch-all: any user message gets a reply
  const catchAll: DeterministicMatcher = {
    id: 'catch-all',
    priority: 0,
    when: { lastMessageRole: 'user' },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'catch' },
        { type: 'text-delta', id: 'catch', delta: 'caught-by-model' },
        { type: 'text-end', id: 'catch' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
    },
  }

  return [userReplyMatcher, catchAll]
}

describe('kimaki send --channel thread creation', () => {
  let directories: ReturnType<typeof createRunDirectories>
  let discord: DigitalDiscord
  let botClient: Client
  let previousDefaultVerbosity: VerbosityLevel | null = null
  let testStartTime = Date.now()

  beforeAll(async () => {
    testStartTime = Date.now()
    directories = createRunDirectories()
    const lockPort = await chooseAvailableLockPort({ key: 'cli-send-thread-e2e' })

    process.env['KIMAKI_LOCK_PORT'] = String(lockPort)
    setDataDir(directories.dataDir)
    previousDefaultVerbosity = store.getState().defaultVerbosity
    store.setState({ defaultVerbosity: 'tools_and_text' })

    const digitalDiscordDbPath = path.join(
      directories.dataDir,
      'digital-discord.db',
    )

    discord = new DigitalDiscord({
      botUser: { id: BOT_USER_ID },
      guild: {
        name: 'CLI Send E2E Guild',
        ownerId: TEST_USER_ID,
      },
      channels: [
        {
          id: TEXT_CHANNEL_ID,
          name: 'cli-send-e2e',
          type: ChannelType.GuildText,
        },
        {
          id: EMPTY_CONTENT_CHANNEL_ID,
          name: 'empty-content-e2e',
          type: ChannelType.GuildText,
        },
        {
          id: MENTION_MODE_EMPTY_CONTENT_CHANNEL_ID,
          name: 'mention-mode-empty-content-e2e',
          type: ChannelType.GuildText,
        },
        {
          id: THREAD_EMPTY_CONTENT_CHANNEL_ID,
          name: 'thread-empty-content-e2e',
          type: ChannelType.GuildText,
        },
      ],
      users: [
        {
          id: TEST_USER_ID,
          username: 'cli-send-tester',
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
    await setChannelDirectory({
      channelId: EMPTY_CONTENT_CHANNEL_ID,
      directory: directories.projectDirectory,
      channelType: 'text',
    })
    await setChannelDirectory({
      channelId: MENTION_MODE_EMPTY_CONTENT_CHANNEL_ID,
      directory: directories.projectDirectory,
      channelType: 'text',
    })
    await setChannelDirectory({
      channelId: THREAD_EMPTY_CONTENT_CHANNEL_ID,
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
    if (directories) {
      await cleanupTestSessions({
        projectDirectory: directories.projectDirectory,
        testStartTime,
      })
    }
    if (botClient) {
      void botClient.destroy()
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
  }, 5_000)

  test(
    'empty project-channel message asks user to mention the bot instead of creating a thread',
    async () => {
      await discord
        .channel(EMPTY_CONTENT_CHANNEL_ID)
        .user(TEST_USER_ID)
        .sendMessage({
          content: '',
        })

      await waitForBotMessageContaining({
        discord,
        threadId: EMPTY_CONTENT_CHANNEL_ID,
        userId: discord.botUserId,
        text: 'Mention me and send it again',
        timeout: 4_000,
      })

      expect(
        await discord.channel(EMPTY_CONTENT_CHANNEL_ID).text(),
      ).toMatchInlineSnapshot(`
        "--- from: user (cli-send-tester)
        --- from: assistant (TestBot)
        I can see you sent a message, but Discord did not include its text.
        Mention me and send it again, like \`@Kimaki fix the failing test\`, so I can read it.
        To avoid this reminder, start Kimaki with \`--mention-mode\` so it only reacts to mentioned messages."
      `)

      const threads = await discord.channel(EMPTY_CONTENT_CHANNEL_ID).getThreads()
      expect(threads).toHaveLength(0)
    },
    8_000,
  )

  test(
    'mention mode silently ignores empty project-channel messages without warning',
    async () => {
      await setChannelMentionMode(MENTION_MODE_EMPTY_CONTENT_CHANNEL_ID, true)
      await discord
        .channel(MENTION_MODE_EMPTY_CONTENT_CHANNEL_ID)
        .user(TEST_USER_ID)
        .sendMessage({
          content: '',
        })

      await new Promise((resolve) => {
        setTimeout(resolve, 300)
      })

      expect(
        await discord.channel(MENTION_MODE_EMPTY_CONTENT_CHANNEL_ID).text(),
      ).toMatchInlineSnapshot(`"--- from: user (cli-send-tester)"`)

      const threads = await discord
        .channel(MENTION_MODE_EMPTY_CONTENT_CHANNEL_ID)
        .getThreads()
      expect(threads).toHaveLength(0)
    },
    8_000,
  )

  test(
    'empty existing-thread message asks user to mention the bot instead of enqueueing a prompt',
    async () => {
      await discord
        .channel(THREAD_EMPTY_CONTENT_CHANNEL_ID)
        .user(TEST_USER_ID)
        .sendMessage({
          content: 'thread empty content seed',
        })

      const thread = await discord
        .channel(THREAD_EMPTY_CONTENT_CHANNEL_ID)
        .waitForThread({
          timeout: 4_000,
          predicate: (t) => {
            return t.name === 'thread empty content seed'
          },
        })

      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'caught-by-model',
        afterAuthorId: discord.botUserId,
      })

      await discord.thread(thread.id).user(TEST_USER_ID).sendMessage({
        content: '',
      })

      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: discord.botUserId,
        text: 'Mention me and send it again',
        timeout: 4_000,
      })

      expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
        "--- from: user (cli-send-tester)
        thread empty content seed
        --- from: assistant (TestBot)
        *using deterministic-provider/deterministic-v2*
        ⬥ caught-by-model
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (cli-send-tester)
        --- from: assistant (TestBot)
        I can see you sent a message, but Discord did not include its text.
        Mention me and send it again, like \`@Kimaki fix the failing test\`, so I can read it.
        To avoid this reminder, start Kimaki with \`--mention-mode\` so it only reacts to mentioned messages."
      `)
    },
    12_000,
  )

  test(
    'kimaki send --prompt "/hello-test-cmd" falls through as text when registeredUserCommands is empty (repro #97)',
    async () => {
      // Reproduce GitHub #97: when registeredUserCommands is empty (gateway mode
      // startup race, or backgroundInit not complete), the prompt "/hello-test-cmd"
      // is NOT detected as a command and is sent to the model as plain text.

      const prevCommands = store.getState().registeredUserCommands
      // Ensure store is empty — this is the bug condition
      store.setState({ registeredUserCommands: [] })

      try {
        const prompt = '/hello-test-cmd'
        const embedMarker: ThreadStartMarker = {
          start: true,
          username: 'cli-send-tester',
          userId: TEST_USER_ID,
        }

        const starterMessage = (await botClient.rest.post(
          Routes.channelMessages(TEXT_CHANNEL_ID),
          {
            body: {
              content: prompt,
              embeds: [
                { color: 0x2b2d31, footer: { text: YAML.stringify(embedMarker) } },
              ],
            },
          },
        )) as { id: string }

        await new Promise((resolve) => {
          setTimeout(resolve, 200)
        })

        const threadData = (await botClient.rest.post(
          Routes.threads(TEXT_CHANNEL_ID, starterMessage.id),
          {
            body: { name: 'cmd-detection-test', auto_archive_duration: 1440 },
          },
        )) as { id: string }

        await botClient.rest.put(
          Routes.threadMembers(threadData.id, TEST_USER_ID),
        )

        // Wait for the command detection result AFTER the starter message.
        // New-session model banners are also bot replies, so waiting for any
        // message can return before the command result is visible.
        await waitForBotMessageContaining({
          discord,
          threadId: threadData.id,
          userId: discord.botUserId,
          text: 'Command not found: "hello-test"',
          afterMessageId: starterMessage.id,
          timeout: 4_000,
        })

        const messages = await discord.thread(threadData.id).getMessages()
        const botReplies = messages.filter((m) => {
          return m.author.id === discord.botUserId && m.id !== starterMessage.id
        })

        const allContent = botReplies.map((m) => {
          return m.content
        })
        expect(
          allContent.some((content) => {
            return content.includes('Command not found: "hello-test"')
          }),
        ).toBe(true)
      } finally {
        store.setState({ registeredUserCommands: prevCommands })
      }
    },
    15_000,
  )

  test(
    'bot-posted starter message with start marker creates thread without DiscordAPIError[160004]',
    async () => {
      // Simulate what `kimaki send --channel` does:
      // 1. Bot posts a starter message with `start: true` embed marker
      // 2. Bot creates a thread on that message via REST
      // The ThreadCreate handler should pick it up. The MessageCreate GuildText
      // handler must NOT try to startThread() on the same message (race).

      const prompt = 'Reply with exactly: cli-send-test'
      const embedMarker: ThreadStartMarker = {
        start: true,
        username: 'cli-send-tester',
        userId: TEST_USER_ID,
      }

      // Step 1: Bot posts the starter message (same as CLI's sendDiscordMessageWithOptionalAttachment)
      const starterMessage = (await botClient.rest.post(
        Routes.channelMessages(TEXT_CHANNEL_ID),
        {
          body: {
            content: prompt,
            embeds: [
              { color: 0x2b2d31, footer: { text: YAML.stringify(embedMarker) } },
            ],
          },
        },
      )) as { id: string }

      // Give the bot's MessageCreate handler time to process the starter
      // message. Without the fix, the handler enters the GuildText path and
      // tries to startThread() on this message, which races the CLI's thread
      // creation below. The digital twin enforces Discord's 160004 uniqueness
      // constraint, so the second startThread call fails.
      await new Promise((resolve) => {
        setTimeout(resolve, 200)
      })

      // Verify the MessageCreate handler did NOT create a thread on this
      // message. If the handler ignored the start marker (correct behavior),
      // no thread exists yet and the REST call below succeeds.
      const threadsBeforeCliCreate = await discord
        .channel(TEXT_CHANNEL_ID)
        .getThreads()
      const preExistingThread = threadsBeforeCliCreate.find((t) => {
        return t.name?.includes('cli-send-test')
      })
      // This is the core regression assertion: without the fix in discord-bot.ts
      // (skipping start markers in the GuildText handler), the MessageCreate
      // handler would create a thread here, and the CLI's REST call below would
      // fail with 160004.
      expect(preExistingThread).toBeUndefined()

      // Step 2: Bot creates a thread on the starter message (same as CLI's Routes.threads call)
      const threadData = (await botClient.rest.post(
        Routes.threads(TEXT_CHANNEL_ID, starterMessage.id),
        {
          body: {
            name: 'cli-send-test',
            auto_archive_duration: 1440,
          },
        },
      )) as { id: string; name: string }

      // Add test user to thread
      await botClient.rest.put(
        Routes.threadMembers(threadData.id, TEST_USER_ID),
      )

      // Wait for the bot to reply with the ⬥ prefix (proves ThreadCreate
      // handler picked up the starter message and started a session)
      await waitForBotMessageContaining({
        discord,
        threadId: threadData.id,
        userId: discord.botUserId,
        text: '⬥',
        timeout: 4_000,
      })

      // Wait for footer message (proves session completed successfully)
      await waitForFooterMessage({
        discord,
        threadId: threadData.id,
        timeout: 4_000,
        afterMessageIncludes: '⬥',
        afterAuthorId: discord.botUserId,
      })

      // Verify no DiscordAPIError[160004] or other errors in the thread.
      // Before the fix, the MessageCreate GuildText handler would race the
      // CLI's thread creation and produce an error message here.
      const messages = await discord.thread(threadData.id).getMessages()
      const errorMessages = messages.filter((m) => {
        return m.content.includes('Error:') || m.content.includes('160004')
      })
      expect(errorMessages).toHaveLength(0)

      // Verify at least one ⬥ reply exists (session produced output)
      const botReplies = messages.filter((m) => {
        return (
          m.author.id === discord.botUserId && m.content.startsWith('⬥')
        )
      })
      expect(botReplies.length).toBeGreaterThanOrEqual(1)
    },
    15_000,
  )
})
