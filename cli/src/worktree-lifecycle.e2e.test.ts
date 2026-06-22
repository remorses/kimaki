// E2e test for worktree lifecycle: /new-worktree inside an existing thread
// creates a separate worktree thread that reuses session context. Each thread
// stays bound to one directory for its whole lifetime.
//
// Uses opencode-deterministic-provider (no real LLM calls).
// Poll timeouts: 4s max, 100ms interval (except worktree creation which
// involves real git operations — 10s timeout there).

import fs from 'node:fs'

import path from 'node:path'
import url from 'node:url'
import { describe, beforeAll, afterAll, test, expect } from 'vitest'
import { ChannelType, Client, GatewayIntentBits, Partials } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import {
  buildDeterministicOpencodeConfig,
  type DeterministicMatcher,
} from 'opencode-deterministic-provider'
import { setDataDir } from './config.js'
import { store } from './store.js'
import { startDiscordBot } from './discord-bot.js'
import { getRuntime } from './session-handler/thread-session-runtime.js'
import {
  setBotToken,
  initDatabase,
  closeDatabase,
  setChannelDirectory,
  setChannelVerbosity,
  setChannelWorktreesEnabled,
  getThreadSession,
  getThreadWorktree,
  type VerbosityLevel,
} from './database.js'
import { startHranaServer, stopHranaServer } from './hrana-server.js'
import {
  initializeOpencodeForDirectory,
  stopOpencodeServer,
} from './opencode.js'
import {
  chooseLockPort,
  cleanupTestSessions,
  waitForBotMessageContaining,
} from './test-utils.js'
import { execAsync } from './worktrees.js'

const TEST_USER_ID = '200000000000000901'
const TEXT_CHANNEL_ID = '200000000000000902'
const NON_GIT_CHANNEL_ID = '200000000000000903'
const AUTO_WORKTREE_CHANNEL_ID = '200000000000000904'
// Unique worktree name per run to avoid collisions with leftover worktrees
const WORKTREE_SUFFIX = Date.now().toString(36).slice(-6)
const WORKTREE_NAME = `wt-e2e-${WORKTREE_SUFFIX}`
const CHANNEL_WORKTREE_NAME = `wt-chan-${WORKTREE_SUFFIX}`
const AUTO_WORKTREE_SUFFIX = `wt-auto-${WORKTREE_SUFFIX}`

function normalizeWorktreeLifecycleText(text: string): string {
  return text
    .replaceAll(CHANNEL_WORKTREE_NAME, 'CHANNEL_WORKTREE_NAME')
    .replaceAll(AUTO_WORKTREE_SUFFIX, 'AUTO_WORKTREE_NAME')
    .replaceAll(WORKTREE_NAME, 'WORKTREE_NAME')
    .replace(/ses_[a-zA-Z0-9]+/g, 'ses_TEST')
    .replace(/<#\d+>/g, '<#THREAD_ID>')
    .replace(/`[^`\n]*\/worktrees\/[^`\n]*`/g, '`/tmp/worktrees/WORKTREE_NAME`')
}

function createRunDirectories() {
  const root = path.resolve(process.cwd(), 'tmp', 'worktree-lifecycle-e2e')
  fs.mkdirSync(root, { recursive: true })
  const dataDir = fs.mkdtempSync(path.join(root, 'data-'))
  const projectDirectory = path.join(root, 'project')
  const nonGitDirectory = path.join(root, 'non-git-project')
  fs.mkdirSync(projectDirectory, { recursive: true })
  fs.mkdirSync(nonGitDirectory, { recursive: true })
  return { root, dataDir, projectDirectory, nonGitDirectory }
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

/** Initialize a git repo with an initial commit so worktrees can be created. */
async function initGitRepo(directory: string): Promise<void> {
  // Check if already a git repo (directory may persist across runs)
  const isRepo = fs.existsSync(path.join(directory, '.git'))
  if (isRepo) {
    // Commit any new/changed files (opencode.json may have been rewritten)
    await execAsync('git add -A && git diff --cached --quiet || git commit -m "update"', {
      cwd: directory,
    }).catch(() => { return })
    return
  }
  await execAsync('git init -b main', { cwd: directory })
  await execAsync('git config user.email "test@test.com"', { cwd: directory })
  await execAsync('git config user.name "Test"', { cwd: directory })
  await execAsync('git add -A && git commit -m "initial"', { cwd: directory })
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

  return [userReplyMatcher]
}

describe('worktree lifecycle', () => {
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
        name: 'Worktree E2E Guild',
        ownerId: TEST_USER_ID,
      },
      channels: [
        {
          id: TEXT_CHANNEL_ID,
          name: 'worktree-e2e',
          type: ChannelType.GuildText,
        },
        {
          id: NON_GIT_CHANNEL_ID,
          name: 'non-git-worktree-e2e',
          type: ChannelType.GuildText,
        },
        {
          id: AUTO_WORKTREE_CHANNEL_ID,
          name: 'auto-worktree-e2e',
          type: ChannelType.GuildText,
        },
      ],
      users: [
        {
          id: TEST_USER_ID,
          username: 'worktree-tester',
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
    fs.writeFileSync(
      path.join(directories.nonGitDirectory, 'opencode.json'),
      JSON.stringify(opencodeConfig, null, 2),
    )

    // Initialize git repo after writing opencode.json so the initial commit
    // includes it. Worktrees require at least one commit.
    await initGitRepo(directories.projectDirectory)

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
      channelId: NON_GIT_CHANNEL_ID,
      directory: directories.nonGitDirectory,
      channelType: 'text',
    })
    await setChannelDirectory({
      channelId: AUTO_WORKTREE_CHANNEL_ID,
      directory: directories.projectDirectory,
      channelType: 'text',
    })
    await setChannelVerbosity(TEXT_CHANNEL_ID, 'tools_and_text')
    await setChannelVerbosity(NON_GIT_CHANNEL_ID, 'tools_and_text')
    await setChannelVerbosity(AUTO_WORKTREE_CHANNEL_ID, 'tools_and_text')
    await setChannelWorktreesEnabled(NON_GIT_CHANNEL_ID, true)
    await setChannelWorktreesEnabled(AUTO_WORKTREE_CHANNEL_ID, true)

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
      closeDatabase().catch(() => { return }),
      stopHranaServer().catch(() => { return }),
      discord?.stop().catch(() => { return }),
    ])
    delete process.env['KIMAKI_LOCK_PORT']
    delete process.env['KIMAKI_DB_URL']
    if (previousDefaultVerbosity) {
      store.setState({ defaultVerbosity: previousDefaultVerbosity })
    }
    // Clean up the git worktrees created during the tests
    if (directories) {
      const branchesToClean = [
        `opencode/kimaki-${WORKTREE_NAME}`,
        `opencode/kimaki-${CHANNEL_WORKTREE_NAME}`,
      ]
      await execAsync(
        `git worktree list --porcelain`,
        { cwd: directories.projectDirectory },
      ).then(async ({ stdout }) => {
        const lines = stdout.split('\n')
        let currentPath = ''
        for (const line of lines) {
          if (line.startsWith('worktree ')) {
            currentPath = line.slice('worktree '.length)
          }
          if (line.startsWith('branch ') && currentPath) {
            for (const branch of branchesToClean) {
              if (line.includes(branch)) {
                await execAsync(
                  `git worktree remove --force ${JSON.stringify(currentPath)}`,
                  { cwd: directories.projectDirectory },
                ).catch(() => { return })
              }
            }
          }
        }
      }).catch(() => { return })
      // Also clean up auto-worktree branches (pattern: opencode/kimaki-<suffix>)
      await execAsync(
        'git worktree prune',
        { cwd: directories.projectDirectory },
      ).catch(() => { return })
      for (const branch of branchesToClean) {
        await execAsync(
          `git branch -D ${JSON.stringify(branch)}`,
          { cwd: directories.projectDirectory },
        ).catch(() => { return })
      }
      // Clean auto-worktree branches (auto-derived names contain the suffix)
      await execAsync(
        `git branch --list 'opencode/kimaki-*${WORKTREE_SUFFIX}*'`,
        { cwd: directories.projectDirectory },
      ).then(async ({ stdout }) => {
        for (const branch of stdout.trim().split('\n').filter(Boolean)) {
          await execAsync(
            `git branch -D ${JSON.stringify(branch.trim())}`,
            { cwd: directories.projectDirectory },
          ).catch(() => { return })
        }
      }).catch(() => { return })
      fs.rmSync(directories.dataDir, {
        recursive: true,
        force: true,
        maxRetries: 3,
      })
    }
  }, 5_000)

  test(
    '/new-worktree in a session thread forks into a new worktree thread',
    async () => {
      // 1. Send a message to create a thread and establish a session
      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: before-worktree',
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return t.name === 'Reply with exactly: before-worktree'
        },
      })

      const th = discord.thread(thread.id)

      // Wait for the first run to produce visible assistant output before
      // running /new-worktree in the same thread.
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '⬥ ok',
        afterUserMessageIncludes: 'before-worktree',
        timeout: 10_000,
      })

      // Capture source runtime — it should stay bound to the base checkout.
      const runtimeBefore = getRuntime(thread.id)
      expect(runtimeBefore).toBeDefined()
      expect(runtimeBefore!.sdkDirectory).toBe(directories.projectDirectory)
      const sessionBefore = await getThreadSession(thread.id)
      expect(sessionBefore).toBeTruthy()

      // 2. Run /new-worktree inside the source thread.
      // This should create a new worktree thread instead of switching this one.
      const { id: interactionId } = await th
        .user(TEST_USER_ID)
        .runSlashCommand({
          name: 'new-worktree',
          options: [{ name: 'name', type: 3, value: WORKTREE_NAME }],
        })

      // Wait for the slash command ack
      await discord
        .channel(thread.id)
        .waitForInteractionAck({ interactionId, timeout: 4_000 })

      const worktreeThread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          if (!t.name) {
            return false
          }
          return t.id !== thread.id
            && t.name.startsWith('⬦ worktree: opencode/kimaki-')
            && t.name.includes(WORKTREE_NAME)
        },
      })
      const worktreeTh = discord.thread(worktreeThread.id)

      // 3. Wait for worktree to become ready in the new thread — the
      // background creation edits the starter message to include the branch.
      // Git worktree creation involves real git operations, so allow more time.
      await waitForBotMessageContaining({
        discord,
        threadId: worktreeThread.id,
        userId: TEST_USER_ID,
        text: 'Branch:',
        timeout: 10_000,
      })

      await waitForBotMessageContaining({
        discord,
        threadId: worktreeThread.id,
        userId: TEST_USER_ID,
        text: 'Reusing context from',
        timeout: 10_000,
      })

      const sourceSessionAfterFork = await getThreadSession(thread.id)
      expect(sourceSessionAfterFork).toBe(sessionBefore)
      const worktreeSession = await getThreadSession(worktreeThread.id)
      expect(worktreeSession).toBeTruthy()
      expect(worktreeSession).not.toBe(sessionBefore)
      await expect(getThreadWorktree(thread.id)).resolves.toBeUndefined()
      const worktreeInfo = await getThreadWorktree(worktreeThread.id)
      expect(worktreeInfo?.status).toBe('ready')
      expect(worktreeInfo?.worktree_directory).toContain(WORKTREE_NAME)

      const runtimeAfter = getRuntime(thread.id)
      expect(runtimeAfter).toBe(runtimeBefore)
      expect(runtimeAfter!.sdkDirectory).toBe(directories.projectDirectory)
      const worktreeRuntime = getRuntime(worktreeThread.id)
      expect(worktreeRuntime).toBeDefined()
      expect(worktreeRuntime!.sdkDirectory).toContain(WORKTREE_NAME)
      expect(worktreeRuntime!.sdkDirectory).toContain(
        `${path.sep}worktrees${path.sep}`,
      )

      // 4. Send messages to both threads. The source continues in the base
      // checkout, and the new thread runs in the worktree checkout.
      await worktreeTh.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: after-worktree-thread',
      })
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: after-source-thread',
      })

      await waitForBotMessageContaining({
        discord,
        threadId: worktreeThread.id,
        userId: TEST_USER_ID,
        text: '⬥ ok',
        afterUserMessageIncludes: 'after-worktree-thread',
        timeout: 4_000,
      })
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '⬥ ok',
        afterUserMessageIncludes: 'after-source-thread',
        timeout: 4_000,
      })

      // Wait for footers to confirm full completion in both threads.
      await waitForBotMessageContaining({
        discord,
        threadId: worktreeThread.id,
        userId: TEST_USER_ID,
        text: 'deterministic-v2',
        afterUserMessageIncludes: 'after-worktree-thread',
        timeout: 4_000,
      })
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'deterministic-v2',
        afterUserMessageIncludes: 'after-source-thread',
        timeout: 4_000,
      })

      const sourceText = await th.text()
      expect(normalizeWorktreeLifecycleText(sourceText)).toMatchInlineSnapshot(`
        "--- from: user (worktree-tester)
        Reply with exactly: before-worktree
        --- from: assistant (TestBot)
        *using deterministic-provider/deterministic-v2*
        ⬥ ok
        Creating worktree in <#THREAD_ID>
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        --- from: user (worktree-tester)
        Reply with exactly: after-source-thread
        --- from: assistant (TestBot)
        ⬥ ok
        *project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
      expect(sourceText).toContain('Reply with exactly: before-worktree')
      expect(sourceText).toContain('Reply with exactly: after-source-thread')
      expect(sourceText).not.toContain('Worktree:')
      expect((sourceText.match(/⬥ ok/g) || []).length).toBe(2)

      const worktreeText = await worktreeTh.text()
      expect(normalizeWorktreeLifecycleText(worktreeText)).toMatchInlineSnapshot(`
        "--- from: assistant (TestBot)
        🌳 **Worktree: opencode/kimaki-WORKTREE_NAME**
        📁 \`/tmp/worktrees/WORKTREE_NAME\`
        🌿 Branch: \`opencode/kimaki-WORKTREE_NAME\`
        Reusing context from <#THREAD_ID> in worktree session \`ses_TEST\`.
        --- from: user (worktree-tester)
        Reply with exactly: after-worktree-thread
        --- from: assistant (TestBot)
        ⬥ ok
        *WORKTREE_NAME ⋅ opencode/kimaki-WORKTREE_NAME ⋅ Ns ⋅ N% ⋅ deterministic-v2*"
      `)
      expect(worktreeText).toContain('Worktree:')
      expect(worktreeText).toContain('Branch:')
      expect(worktreeText).toContain('Reusing context from')
      expect(worktreeText).toContain('Reply with exactly: after-worktree-thread')
      expect(worktreeText).toContain('⬥ ok')
    },
    30_000,
  )

  test(
    '/new-worktree from a text channel creates a worktree thread that responds to messages',
    async () => {
      // 1. Run /new-worktree from the text channel (not inside a thread)
      const { id: interactionId } = await discord
        .channel(TEXT_CHANNEL_ID)
        .user(TEST_USER_ID)
        .runSlashCommand({
          name: 'new-worktree',
          options: [{ name: 'name', type: 3, value: CHANNEL_WORKTREE_NAME }],
        })

      await discord
        .channel(TEXT_CHANNEL_ID)
        .waitForInteractionAck({ interactionId, timeout: 4_000 })

      // 2. Wait for the worktree thread to appear in the channel
      const worktreeThread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return Boolean(
            t.name
            && t.name.startsWith('⬦ worktree: opencode/kimaki-')
            && t.name.includes(CHANNEL_WORKTREE_NAME),
          )
        },
      })

      const wt = discord.thread(worktreeThread.id)

      // 3. Wait for worktree to become ready (status message shows Branch:)
      await waitForBotMessageContaining({
        discord,
        threadId: worktreeThread.id,
        userId: TEST_USER_ID,
        text: 'Branch:',
        timeout: 10_000,
      })

      // 4. Verify the DB has the worktree info
      const worktreeInfo = await getThreadWorktree(worktreeThread.id)
      expect(worktreeInfo?.status).toBe('ready')
      expect(worktreeInfo?.worktree_directory).toContain(CHANNEL_WORKTREE_NAME)

      // 5. Send a message in the worktree thread and verify it responds
      await wt.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: channel-worktree-msg',
      })

      await waitForBotMessageContaining({
        discord,
        threadId: worktreeThread.id,
        userId: TEST_USER_ID,
        text: '⬥ ok',
        afterUserMessageIncludes: 'channel-worktree-msg',
        timeout: 10_000,
      })

      // Wait for footer to confirm session completion
      await waitForBotMessageContaining({
        discord,
        threadId: worktreeThread.id,
        userId: TEST_USER_ID,
        text: 'deterministic-v2',
        afterUserMessageIncludes: 'channel-worktree-msg',
        timeout: 4_000,
      })

      // 6. Verify the runtime is using the worktree directory
      const runtime = getRuntime(worktreeThread.id)
      expect(runtime).toBeDefined()
      expect(runtime!.sdkDirectory).toContain(CHANNEL_WORKTREE_NAME)
      expect(runtime!.sdkDirectory).toContain(`${path.sep}worktrees${path.sep}`)

      // 7. Snapshot the thread content
      const worktreeText = await wt.text()
      expect(normalizeWorktreeLifecycleText(worktreeText)).toMatchInlineSnapshot(`
        "--- from: assistant (TestBot)
        🌳 **Worktree: opencode/kimaki-CHANNEL_WORKTREE_NAME**
        📁 \`/tmp/worktrees/WORKTREE_NAME\`
        🌿 Branch: \`opencode/kimaki-CHANNEL_WORKTREE_NAME\`
        --- from: user (worktree-tester)
        Reply with exactly: channel-worktree-msg
        --- from: assistant (TestBot)
        *using deterministic-provider/deterministic-v2*
        ⬥ ok"
      `)
      expect(worktreeText).toContain('Branch:')
      expect(worktreeText).toContain('⬥ ok')
      expect(worktreeText).toContain('Reply with exactly: channel-worktree-msg')
    },
    30_000,
  )

  test(
    'auto-worktree from user message creates worktree thread and responds',
    async () => {
      // Channel AUTO_WORKTREE_CHANNEL_ID has worktrees enabled via toggle.
      // Sending a message should auto-create a worktree thread.
      // Include WORKTREE_SUFFIX in the message so the auto-derived branch name
      // is unique per run and doesn't collide with leftover branches.
      const autoMsg = `Reply with exactly: ${AUTO_WORKTREE_SUFFIX}`
      await discord.channel(AUTO_WORKTREE_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: autoMsg,
      })

      // The thread should have the ⬦ prefix indicating a worktree thread
      const thread = await discord.channel(AUTO_WORKTREE_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return Boolean(t.name?.startsWith('⬦ '))
        },
      })
      const th = discord.thread(thread.id)

      // Wait for the bot reply to the user message. The auto-worktree
      // creation runs in the background and the first message awaits it.
      // This is the 3rd worktree in the suite, so git can be slow.
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '⬥ ok',
        afterUserMessageIncludes: AUTO_WORKTREE_SUFFIX,
        timeout: 25_000,
      })

      // Verify runtime is in the worktree directory
      const runtime = getRuntime(thread.id)
      expect(runtime).toBeDefined()
      expect(runtime!.sdkDirectory).toContain(`${path.sep}worktrees${path.sep}`)
      expect(runtime!.sdkDirectory).not.toBe(directories.projectDirectory)

      // Verify DB has worktree info
      const worktreeInfo = await getThreadWorktree(thread.id)
      expect(worktreeInfo?.status).toBe('ready')
      expect(worktreeInfo?.worktree_directory).toBeTruthy()

      // Send a follow-up message to verify session works inside worktree
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: auto-followup',
      })

      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '⬥ ok',
        afterUserMessageIncludes: 'auto-followup',
        timeout: 4_000,
      })

      const text = await th.text()
      expect(text).toContain('⬥ ok')
      expect(text).toContain(AUTO_WORKTREE_SUFFIX)
      expect(text).toContain('Reply with exactly: auto-followup')
      // Should have at least 2 ok replies
      expect((text.match(/⬥ ok/g) || []).length).toBeGreaterThanOrEqual(2)
    },
    35_000,
  )

  test(
    'auto-worktrees fall back to normal sessions outside git repositories',
    async () => {
      await discord.channel(NON_GIT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: non-git-first',
      })

      const thread = await discord.channel(NON_GIT_CHANNEL_ID).waitForThread({
        timeout: 4_000,
        predicate: (t) => {
          return Boolean(t.name?.includes('Reply with exactly: non-git-first'))
        },
      })

      const th = discord.thread(thread.id)

      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '⬥ ok',
        afterUserMessageIncludes: 'non-git-first',
        timeout: 4_000,
      })

      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: non-git-second',
      })

      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '⬥ ok',
        afterUserMessageIncludes: 'non-git-second',
        timeout: 4_000,
      })

      // Wait for footer after second reply to stabilize the snapshot
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'deterministic-v2',
        afterUserMessageIncludes: 'non-git-second',
        timeout: 4_000,
      })

      const text = await th.text()
      expect(text).toMatchInlineSnapshot(`
        "--- from: user (worktree-tester)
        Reply with exactly: non-git-first
        --- from: assistant (TestBot)
        *using deterministic-provider/deterministic-v2*
        ⬥ ok
        --- from: user (worktree-tester)
        Reply with exactly: non-git-second
        --- from: assistant (TestBot)
        *non-git-project ⋅ main ⋅ Ns ⋅ N% ⋅ deterministic-v2*
        ⬥ ok"
      `)
      expect(text).toContain('Reply with exactly: non-git-first')
      expect(text).toContain('Reply with exactly: non-git-second')
      expect(text).not.toContain('Worktree creation failed')
      const okCount = (text.match(/⬥ ok/g) || []).length
      expect(okCount).toBe(2)
    },
    20_000,
  )
})
