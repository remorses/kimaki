// E2e test for worktree lifecycle: /new-worktree inside an existing thread,
// then verify the session still works after sdkDirectory switches.
// Validates that handleDirectoryChanged() reconnects the event listener
// so events from the worktree Instance reach the runtime (PR #75 fix).
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
  waitForBotReplyAfterUserMessage,
} from './test-utils.js'
import { execAsync } from './worktrees.js'

const TEST_USER_ID = '200000000000000901'
const TEXT_CHANNEL_ID = '200000000000000902'
// Unique worktree name per run to avoid collisions with leftover worktrees
const WORKTREE_SUFFIX = Date.now().toString(36).slice(-6)
const WORKTREE_NAME = `wt-e2e-${WORKTREE_SUFFIX}`

function createRunDirectories() {
  const root = path.resolve(process.cwd(), 'tmp', 'worktree-lifecycle-e2e')
  fs.mkdirSync(root, { recursive: true })
  const dataDir = fs.mkdtempSync(path.join(root, 'data-'))
  const projectDirectory = path.join(root, 'project')
  fs.mkdirSync(projectDirectory, { recursive: true })
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
      botClient.destroy()
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
    // Clean up the git worktree created during the test
    if (directories) {
      const worktreeBranch = `opencode/kimaki-${WORKTREE_NAME}`
      await execAsync(
        `git worktree list --porcelain`,
        { cwd: directories.projectDirectory },
      ).then(({ stdout }) => {
        // Find and remove any worktree for our test branch
        const lines = stdout.split('\n')
        let currentPath = ''
        for (const line of lines) {
          if (line.startsWith('worktree ')) {
            currentPath = line.slice('worktree '.length)
          }
          if (line.startsWith('branch ') && line.includes(worktreeBranch) && currentPath) {
            return execAsync(
              `git worktree remove --force ${JSON.stringify(currentPath)}`,
              { cwd: directories.projectDirectory },
            )
          }
        }
      }).catch(() => { return })
      await execAsync(
        `git branch -D ${JSON.stringify(`opencode/kimaki-${WORKTREE_NAME}`)}`,
        { cwd: directories.projectDirectory },
      ).catch(() => { return })
      fs.rmSync(directories.dataDir, { recursive: true, force: true })
    }
  }, 5_000)

  test(
    'session responds after /new-worktree switches sdkDirectory in existing thread',
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

      // Wait for first run to fully complete (footer appears)
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '*project',
        timeout: 4_000,
      })

      // Capture runtime — should survive the directory switch
      const runtimeBefore = getRuntime(thread.id)
      expect(runtimeBefore).toBeDefined()
      expect(runtimeBefore!.sdkDirectory).toBe(directories.projectDirectory)

      // 2. Run /new-worktree inside the thread (in-thread flow).
      // This creates a pending worktree, then background creates the git worktree,
      // then marks it ready. Next message will pick up the worktree directory.
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

      // 3. Wait for worktree to become ready — the background creation
      // edits the starter message to include the branch name.
      // Git worktree creation involves real git operations, so allow more time.
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'Branch:',
        timeout: 10_000,
      })

      // 4. Send a message after the worktree is ready.
      // Without handleDirectoryChanged (PR #75), the event listener is still
      // subscribed to the old project directory's Instance, so this message
      // gets processed but the response events never reach the runtime.
      await th.user(TEST_USER_ID).sendMessage({
        content: 'Reply with exactly: after-worktree',
      })

      // 5. Verify the bot actually responds — this is the core assertion.
      // If the listener wasn't reconnected, this will time out.
      await waitForBotReplyAfterUserMessage({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        userMessageIncludes: 'after-worktree',
        timeout: 4_000,
      })

      // Wait for the footer to confirm full completion
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'deterministic-v2',
        afterUserMessageIncludes: 'after-worktree',
        timeout: 4_000,
      })

      // Runtime instance should be the same (not recreated)
      const runtimeAfter = getRuntime(thread.id)
      expect(runtimeAfter).toBe(runtimeBefore)

      // sdkDirectory should now point to the worktree path
      expect(runtimeAfter!.sdkDirectory).not.toBe(directories.projectDirectory)
      // Folder name drops the `opencode-kimaki-` prefix (branch name keeps it).
      // See getManagedWorktreeDirectory in worktrees.ts.
      expect(runtimeAfter!.sdkDirectory).toContain(WORKTREE_NAME)
      expect(runtimeAfter!.sdkDirectory).toContain(
        `${path.sep}worktrees${path.sep}`,
      )

      // Snapshot uses dynamic worktree name so we verify structure, not exact text
      const text = await th.text()
      expect(text).toContain('Reply with exactly: before-worktree')
      expect(text).toContain('⬥ ok')
      expect(text).toContain('Worktree:')
      expect(text).toContain('Branch:')
      expect(text).toContain('Reply with exactly: after-worktree')
      // The second "⬥ ok" proves the bot responded after the worktree switch
      const okCount = (text.match(/⬥ ok/g) || []).length
      expect(okCount).toBe(2)
    },
    30_000,
  )
})
