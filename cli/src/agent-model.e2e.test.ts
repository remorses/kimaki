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

import path from 'node:path'
import url from 'node:url'
import {
  describe,
  beforeAll,
  afterAll,
  test,
  expect,
} from 'vitest'
import { ChannelType, Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder } from 'discord.js'
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
import { initializeOpencodeForDirectory, stopOpencodeServer } from './opencode.js'
import {
  chooseLockPort,
  cleanupTestSessions,
  initTestGitRepo,
  waitForBotMessageContaining,
  waitForFooterMessage,
} from './test-utils.js'
import { buildQuickAgentCommandDescription } from './commands/agent.js'


const TEST_USER_ID = '200000000000000920'
const TEXT_CHANNEL_ID = '200000000000000921'
const AGENT_MODEL = 'agent-model-v2'
const PLAN_AGENT_MODEL = 'plan-model-v2'
const CHANNEL_MODEL = 'channel-model-v2'
const DEFAULT_MODEL = 'deterministic-v2'
const PROVIDER_NAME = 'deterministic-provider'

function createRunDirectories() {
  const root = path.resolve(process.cwd(), 'tmp', 'agent-model-e2e')
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
  const systemContextMatcher: DeterministicMatcher = {
    id: 'system-context-check',
    priority: 20,
    when: {
      lastMessageRole: 'user',
      latestUserTextIncludes: 'Reply with exactly: system-context-check',
      promptTextIncludes: `<discord-user name="agent-model-tester" user-id="${TEST_USER_ID}"`,
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

  const replyContextMatcher: DeterministicMatcher = {
    id: 'reply-context-check',
    priority: 15,
    when: {
      lastMessageRole: 'user',
      latestUserTextIncludes: 'Reply with exactly: reply-context-check',
      rawPromptIncludes:
        'This message was a reply to message\n\n<replied-message author="agent-model-tester">\nfirst message in thread\n</replied-message>',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'reply-context-reply' },
        {
          type: 'text-delta',
          id: 'reply-context-reply',
          delta: 'reply-context-ok',
        },
        { type: 'text-end', id: 'reply-context-reply' },
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

  return [systemContextMatcher, replyContextMatcher, userReplyMatcher]
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
    providerConfig.models[PLAN_AGENT_MODEL] = { name: PLAN_AGENT_MODEL }
    providerConfig.models[CHANNEL_MODEL] = { name: CHANNEL_MODEL }

    fs.writeFileSync(
      path.join(directories.projectDirectory, 'opencode.json'),
      JSON.stringify(opencodeConfig, null, 2),
    )

    // Create agent .md files with custom models
    createAgentFile({
      projectDirectory: directories.projectDirectory,
      agentName: 'test-agent',
      model: `${PROVIDER_NAME}/${AGENT_MODEL}`,
    })
    createAgentFile({
      projectDirectory: directories.projectDirectory,
      agentName: 'plan',
      model: `${PROVIDER_NAME}/${PLAN_AGENT_MODEL}`,
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
    })
    await setChannelVerbosity(TEXT_CHANNEL_ID, 'tools_and_text')

    botClient = createDiscordJsClient({ restUrl: discord.restUrl })
    await startDiscordBot({
      token: discord.botToken,
      appId: discord.botUserId,
      discordClient: botClient,
    })

    // Register quick agent slash commands so /plan-agent and /test-agent-agent
    // are resolvable by handleQuickAgentCommand via guild.commands.fetch().
    const agentCommands = ['test-agent', 'plan'].map((agentName) => {
      return new SlashCommandBuilder()
        .setName(`${agentName}-agent`)
        .setDescription(
          buildQuickAgentCommandDescription({
            agentName,
            description: `Switch to ${agentName} agent`,
          }),
        )
        .setDMPermission(false)
        .toJSON()
    })
    const rest = new REST({ version: '10', api: discord.restUrl }).setToken(
      discord.botToken,
    )
    await rest.put(
      Routes.applicationGuildCommands(discord.botUserId, discord.guildId),
      { body: agentCommands },
    )

    // Pre-warm the opencode server so agent discovery happens
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
  }, 5_000)

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
        "--- from: user (agent-model-tester)
        Reply with exactly: agent-model-check
        --- from: assistant (TestBot)
        ⬥ ok
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
        "--- from: user (agent-model-tester)
        Reply with exactly: system-context-check
        --- from: assistant (TestBot)
        ⬥ system-context-ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ agent-model-v2 ⋅ **test-agent***"
      `)
    },
    15_000,
  )

  test(
    'reply message injects replied-message context',
    async () => {
      const prisma = await getPrisma()
      await prisma.channel_agents.deleteMany({
        where: { channel_id: TEXT_CHANNEL_ID },
      })
      await prisma.channel_models.deleteMany({
        where: { channel_id: TEXT_CHANNEL_ID },
      })

      const existingThreadIds = new Set(
        (await discord.channel(TEXT_CHANNEL_ID).getThreads()).map((thread) => {
          return thread.id
        }),
      )

      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'first message in thread',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 6_000,
        predicate: (t) => {
          return !existingThreadIds.has(t.id)
        },
      })

      const threadMessagesBeforeReply = await discord.thread(thread.id).getMessages()
      const firstUserMessage = threadMessagesBeforeReply.find((message) => {
        return (
          message.author.id === TEST_USER_ID
          && message.content === 'first message in thread'
        )
      })
      expect(firstUserMessage).toBeDefined()
      if (!firstUserMessage) {
        throw new Error('Expected first user message in thread')
      }

      await discord.thread(thread.id).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: reply-context-check',
        messageReference: {
          message_id: firstUserMessage.id,
          channel_id: thread.id,
          guild_id: discord.guildId,
        },
      })

      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'ok',
        timeout: 6_000,
      })

      const threadText = await discord.thread(thread.id).text()
      expect(threadText).toContain('first message in thread')
      expect(threadText).toContain('Reply with exactly: reply-context-check')
      expect(threadText).toContain('⬥ ok')
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
        "--- from: user (agent-model-tester)
        Reply with exactly: channel-model-check
        --- from: assistant (TestBot)
        ⬥ ok
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
        "--- from: user (agent-model-tester)
        Reply with exactly: variant-check
        --- from: assistant (TestBot)
        ⬥ ok
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

  test(
    'changing channel agent via /plan-agent does not affect existing thread model',
    async () => {
      // 1. Set channel agent to test-agent (uses AGENT_MODEL)
      await setChannelAgent(TEXT_CHANNEL_ID, 'test-agent')

      // 2. Send a message to create a thread
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: first-thread-msg',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: first-thread-msg'
        },
      })

      // Wait for footer — proves first run completed with test-agent's model
      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'ok',
        afterAuthorId: discord.botUserId,
      })

      const firstMessages = await discord.thread(thread.id).getMessages()
      const firstFooter = firstMessages.find((m) => {
        return (
          m.author.id === discord.botUserId && m.content.startsWith('*')
        )
      })
      expect(firstFooter).toBeDefined()
      // Verify the first run used test-agent's model
      expect(firstFooter!.content).toContain(AGENT_MODEL)

      // 3. Switch channel agent to plan via /plan-agent in the CHANNEL
      const { id: interactionId } = await discord
        .channel(TEXT_CHANNEL_ID)
        .user(TEST_USER_ID)
        .runSlashCommand({ name: 'plan-agent' })

      await discord
        .channel(TEXT_CHANNEL_ID)
        .waitForInteractionAck({ interactionId, timeout: 4_000 })

      // 4. Send a second message in the EXISTING thread
      const th = discord.thread(thread.id)
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: second-thread-msg',
      })

      // Wait for second footer (anchor on the user message, not bot reply)
      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'second-thread-msg',
        afterAuthorId: TEST_USER_ID,
      })

      expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
        "--- from: user (agent-model-tester)
        Reply with exactly: first-thread-msg
        --- from: assistant (TestBot)
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ agent-model-v2 ⋅ **test-agent***
        --- from: user (agent-model-tester)
        Reply with exactly: second-thread-msg
        --- from: assistant (TestBot)
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ agent-model-v2 ⋅ **test-agent***"
      `)

      const secondMessages = await discord.thread(thread.id).getMessages()
      const secondFooter = [...secondMessages]
        .reverse()
        .find((m) => {
          return (
            m.author.id === discord.botUserId && m.content.startsWith('*')
          )
        })
      expect(secondFooter).toBeDefined()

      // The existing thread should still use test-agent's model (AGENT_MODEL),
      // NOT plan agent's model (PLAN_AGENT_MODEL)
      expect(secondFooter!.content).toContain(AGENT_MODEL)
      expect(secondFooter!.content).not.toContain(PLAN_AGENT_MODEL)
    },
    20_000,
  )

  test(
    'thread created with no agent keeps default model after channel agent is set',
    async () => {
      // Clear any channel agent — thread starts with default (no agent)
      const prisma = await getPrisma()
      await prisma.channel_agents.deleteMany({
        where: { channel_id: TEXT_CHANNEL_ID },
      })
      // Also clear channel model so we get the pure default
      await prisma.channel_models.deleteMany({
        where: { channel_id: TEXT_CHANNEL_ID },
      })

      // 1. Send a message to create a thread (no channel agent set)
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: default-thread-msg',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: default-thread-msg'
        },
      })

      // Wait for footer — should show the default model
      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'ok',
        afterAuthorId: discord.botUserId,
      })

      const firstMessages = await discord.thread(thread.id).getMessages()
      const firstFooter = firstMessages.find((m) => {
        return (
          m.author.id === discord.botUserId && m.content.startsWith('*')
        )
      })
      expect(firstFooter).toBeDefined()
      // First run uses the default model (no agent set)
      expect(firstFooter!.content).toContain(DEFAULT_MODEL)
      expect(firstFooter!.content).not.toContain(AGENT_MODEL)

      // 2. Set channel agent to test-agent via /test-agent-agent in the CHANNEL
      const { id: interactionId } = await discord
        .channel(TEXT_CHANNEL_ID)
        .user(TEST_USER_ID)
        .runSlashCommand({ name: 'test-agent-agent' })

      await discord
        .channel(TEXT_CHANNEL_ID)
        .waitForInteractionAck({ interactionId, timeout: 4_000 })

      // 3. Send a second message in the EXISTING thread
      await discord
        .thread(thread.id)
        .user(TEST_USER_ID)
        .sendMessage({
          content: 'Reply with exactly: default-second-msg',
        })

      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'default-second-msg',
        afterAuthorId: TEST_USER_ID,
      })

      expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
        "--- from: user (agent-model-tester)
        Reply with exactly: default-thread-msg
        --- from: assistant (TestBot)
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (agent-model-tester)
        Reply with exactly: default-second-msg
        --- from: assistant (TestBot)
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)

      const secondMessages = await discord.thread(thread.id).getMessages()
      const secondFooter = [...secondMessages]
        .reverse()
        .find((m) => {
          return (
            m.author.id === discord.botUserId && m.content.startsWith('*')
          )
        })
      expect(secondFooter).toBeDefined()

      // The existing thread should still use the DEFAULT model,
      // NOT the test-agent's model (AGENT_MODEL)
      expect(secondFooter!.content).toContain(DEFAULT_MODEL)
      expect(secondFooter!.content).not.toContain(AGENT_MODEL)
    },
    20_000,
  )

  test(
    '/plan-agent inside a thread switches the model for that thread',
    async () => {
      // 1. Start with test-agent on the channel
      await setChannelAgent(TEXT_CHANNEL_ID, 'test-agent')

      // 2. Create a thread — first run uses test-agent's model
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: switch-in-thread-msg',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: switch-in-thread-msg'
        },
      })

      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'ok',
        afterAuthorId: discord.botUserId,
      })

      const firstFooter = (await discord.thread(thread.id).getMessages()).find(
        (m) => {
          return (
            m.author.id === discord.botUserId && m.content.startsWith('*')
          )
        },
      )
      expect(firstFooter).toBeDefined()
      expect(firstFooter!.content).toContain(AGENT_MODEL)

      // 3. Run /plan-agent INSIDE the thread
      const th = discord.thread(thread.id)
      const { id: interactionId } = await th
        .user(TEST_USER_ID)
        .runSlashCommand({ name: 'plan-agent' })

      await th.waitForInteractionAck({ interactionId, timeout: 4_000 })

      // 4. Send a second message in the same thread
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: after-switch-msg',
      })

      await waitForFooterMessage({
        discord,
        threadId: thread.id,
        timeout: 4_000,
        afterMessageIncludes: 'after-switch-msg',
        afterAuthorId: TEST_USER_ID,
      })

      expect(await discord.thread(thread.id).text()).toMatchInlineSnapshot(`
        "--- from: user (agent-model-tester)
        Reply with exactly: switch-in-thread-msg
        --- from: assistant (TestBot)
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ agent-model-v2 ⋅ **test-agent***
        Switched to **plan** agent for this session (was **test-agent**)
        Model: *deterministic-provider/plan-model-v2*
        The agent will change on the next message.
        --- from: user (agent-model-tester)
        Reply with exactly: after-switch-msg
        --- from: assistant (TestBot)
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ plan-model-v2 ⋅ **plan***"
      `)

      const secondFooter = [...(await discord.thread(thread.id).getMessages())]
        .reverse()
        .find((m) => {
          return (
            m.author.id === discord.botUserId && m.content.startsWith('*')
          )
        })
      expect(secondFooter).toBeDefined()

      // After /plan-agent in the thread, model should switch to plan's model
      expect(secondFooter!.content).toContain(PLAN_AGENT_MODEL)
      expect(secondFooter!.content).not.toContain(AGENT_MODEL)
    },
    20_000,
  )
})
