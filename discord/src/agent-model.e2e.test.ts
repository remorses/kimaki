// E2e test for agent model resolution in new threads.
// Reproduces a bug where /agent channel preference is ignored by the
// promptAsync path: submitViaOpencodeQueue only passes input.agent/input.model
// (undefined for normal Discord messages) instead of resolving channel agent
// preferences from DB like dispatchPrompt does.
//
// The test sets a channel agent with a custom model, sends a message,
// and verifies the footer contains the agent's model — not the default.
//
// Uses opencode-deterministic-provider (no real LLM calls).
// Poll timeouts: 4s max, 100ms interval.

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import url from 'node:url'
import {
  describe,
  beforeAll,
  afterAll,
  test,
  expect,
} from 'vitest'
import { ChannelType, Client, GatewayIntentBits, Partials } from 'discord.js'
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
  setChannelVerbosity,
  setChannelAgent,
  setChannelModel,
  type VerbosityLevel,
} from './database.js'
import { getPrisma } from './db.js'
import { startHranaServer, stopHranaServer } from './hrana-server.js'
import { initializeOpencodeForDirectory } from './opencode.js'
import {
  cleanupOpencodeServers,
  cleanupTestSessions,
  waitForBotMessageContaining,
  waitForFooterMessage,
} from './test-utils.js'


const TEST_USER_ID = '200000000000000920'
const TEXT_CHANNEL_ID = '200000000000000921'
const AGENT_MODEL = 'agent-model-v2'
const CHANNEL_MODEL = 'channel-model-v2'
const DEFAULT_MODEL = 'deterministic-v2'
const PROVIDER_NAME = 'deterministic-provider'

function createRunDirectories() {
  const root = path.resolve(process.cwd(), 'tmp', 'agent-model-e2e')
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
  const systemContextMatcher: DeterministicMatcher = {
    id: 'system-context-check',
    priority: 20,
    when: {
      lastMessageRole: 'user',
      latestUserTextIncludes: 'Reply with exactly: system-context-check',
      rawPromptIncludes: `Current Discord user ID is: ${TEST_USER_ID}`,
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'system-context-reply' },
        {
          type: 'text-delta',
          id: 'system-context-reply',
          delta: 'system-context-ok',
        },
        { type: 'text-end', id: 'system-context-reply' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
      partDelaysMs: [0, 100, 0, 0, 0],
    },
  }

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

  return [systemContextMatcher, userReplyMatcher]
}

/**
 * Create an opencode agent .md file that uses a specific model.
 * OpenCode discovers agents from .opencode/agent/*.md files.
 */
function createAgentFile({
  projectDirectory,
  agentName,
  model,
}: {
  projectDirectory: string
  agentName: string
  model: string
}) {
  const agentDir = path.join(projectDirectory, '.opencode', 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  const content = [
    '---',
    `model: ${model}`,
    'mode: primary',
    `description: Test agent with custom model`,
    '---',
    '',
    'You are a test agent. Reply concisely.',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(agentDir, `${agentName}.md`), content)
}

describe('agent model resolution', () => {
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
        name: 'Agent Model E2E Guild',
        ownerId: TEST_USER_ID,
      },
      channels: [
        {
          id: TEXT_CHANNEL_ID,
          name: 'agent-model-e2e',
          type: ChannelType.GuildText,
        },
      ],
      users: [
        {
          id: TEST_USER_ID,
          username: 'agent-model-tester',
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

    // Build base config with default model
    const opencodeConfig = buildDeterministicOpencodeConfig({
      providerName: PROVIDER_NAME,
      providerNpm,
      model: DEFAULT_MODEL,
      smallModel: DEFAULT_MODEL,
      settings: {
        strict: false,
        matchers: createDeterministicMatchers(),
      },
    })

    // Add extra models to the provider so opencode accepts them
    const providerConfig = opencodeConfig.provider[PROVIDER_NAME] as {
      models: Record<string, { name: string }>
    }
    providerConfig.models[AGENT_MODEL] = { name: AGENT_MODEL }
    providerConfig.models[CHANNEL_MODEL] = { name: CHANNEL_MODEL }

    fs.writeFileSync(
      path.join(directories.projectDirectory, 'opencode.json'),
      JSON.stringify(opencodeConfig, null, 2),
    )

    // Create the agent .md file with custom model
    createAgentFile({
      projectDirectory: directories.projectDirectory,
      agentName: 'test-agent',
      model: `${PROVIDER_NAME}/${AGENT_MODEL}`,
    })

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

    // Pre-warm the opencode server so agent discovery happens
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

  test(
    'new thread uses agent model when channel agent is set',
    async () => {
      // Set channel agent preference — this simulates /agent selecting test-agent
      await setChannelAgent(TEXT_CHANNEL_ID, 'test-agent')

      // Send a message to create a new thread
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: agent-model-check',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: agent-model-check'
        },
      })

      // Wait for the footer (starts with *project) — proves run completed.
      // Then assert which model ID appears in it.
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '*project',
        timeout: 4_000,
      })

      const messages = await discord.thread(thread.id).getMessages()

      // Find the footer message (starts with * italic)
      const footerMessage = messages.find((message) => {
        return (
          message.author.id === discord.botUserId &&
          message.content.startsWith('*')
        )
      })

      expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
        "--- from: assistant (TestBot)
        ⬥ ok
        --- from: assistant (TestBot)
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ agent-model-v2 ⋅ **test-agent***"
      `)
      expect(footerMessage).toBeDefined()
      if (!footerMessage) {
        throw new Error(
          `Expected footer message but none found. Bot messages: ${messages
            .filter((m) => m.author.id === discord.botUserId)
            .map((m) => m.content.slice(0, 150))
            .join(' | ')}`,
        )
      }

      // The footer should contain the agent's model, not the default
      expect(footerMessage.content).toContain(AGENT_MODEL)
      expect(footerMessage.content).not.toContain(DEFAULT_MODEL)
    },
    15_000,
  )

  test(
    'promptAsync path includes rich system context',
    async () => {
      await setChannelAgent(TEXT_CHANNEL_ID, 'test-agent')

      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: system-context-check',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: system-context-check'
        },
      })

      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'system-context-ok',
        timeout: 4_000,
      })

      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'system-context-ok',
        afterAuthorId: discord.botUserId,
      })

      expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
        "--- from: assistant (TestBot)
        ⬥ system-context-ok
        --- from: assistant (TestBot)
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ agent-model-v2 ⋅ **test-agent***"
      `)
    },
    15_000,
  )

  test(
    'new thread uses channel model when channel model preference is set',
    async () => {
      // Clear channel agent so model resolution falls through to channel model
      const prisma = await getPrisma()
      await prisma.channel_agents.deleteMany({
        where: { channel_id: TEXT_CHANNEL_ID },
      })

      // Set channel model preference — simulates /model selecting a model at channel scope
      await setChannelModel({
        channelId: TEXT_CHANNEL_ID,
        modelId: `${PROVIDER_NAME}/${CHANNEL_MODEL}`,
      })

      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: channel-model-check',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: channel-model-check'
        },
      })

      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '*project',
        timeout: 4_000,
      })

      const messages = await discord.thread(thread.id).getMessages()
      const footerMessage = messages.find((message) => {
        return (
          message.author.id === discord.botUserId &&
          message.content.startsWith('*')
        )
      })

      expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
        "--- from: assistant (TestBot)
        ⬥ ok
        --- from: assistant (TestBot)
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ channel-model-v2*"
      `)
      expect(footerMessage).toBeDefined()
      if (!footerMessage) {
        throw new Error(
          `Expected footer message but none found. Bot messages: ${messages
            .filter((m) => m.author.id === discord.botUserId)
            .map((m) => m.content.slice(0, 150))
            .join(' | ')}`,
        )
      }

      // Footer should contain the channel model, not the default
      expect(footerMessage.content).toContain(CHANNEL_MODEL)
      expect(footerMessage.content).not.toContain(DEFAULT_MODEL)
    },
    15_000,
  )

  test(
    'channel model with variant preference completes without error',
    async () => {
      // Clear channel agent so model resolution falls through to channel model
      const prisma = await getPrisma()
      await prisma.channel_agents.deleteMany({
        where: { channel_id: TEXT_CHANNEL_ID },
      })

      // Set channel model with a variant (thinking level)
      // The deterministic provider doesn't support thinking, so the variant
      // is resolved but silently dropped (no matching thinking values).
      // This test verifies the variant cascade code path runs without crashing
      // and the correct model still appears in the footer.
      await setChannelModel({
        channelId: TEXT_CHANNEL_ID,
        modelId: `${PROVIDER_NAME}/${CHANNEL_MODEL}`,
        variant: 'high',
      })

      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: variant-check',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: variant-check'
        },
      })

      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '*project',
        timeout: 4_000,
      })

      const messages = await discord.thread(thread.id).getMessages()
      const footerMessage = messages.find((message) => {
        return (
          message.author.id === discord.botUserId &&
          message.content.startsWith('*')
        )
      })

      expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
        "--- from: assistant (TestBot)
        ⬥ ok
        --- from: assistant (TestBot)
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ channel-model-v2*"
      `)
      expect(footerMessage).toBeDefined()
      if (!footerMessage) {
        throw new Error(
          `Expected footer message but none found. Bot messages: ${messages
            .filter((m) => m.author.id === discord.botUserId)
            .map((m) => m.content.slice(0, 150))
            .join(' | ')}`,
        )
      }

      // Footer should still contain the channel model (variant doesn't crash)
      expect(footerMessage.content).toContain(CHANNEL_MODEL)
      expect(footerMessage.content).not.toContain(DEFAULT_MODEL)
    },
    15_000,
  )
})
