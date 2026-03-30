// E2e capture tests for generating real OpenCode session-event JSONL fixtures.
// Uses opencode-cached-provider + Gemini to record real tool/lifecycle streams
// (task, interruption, permission, action buttons, and question flows).

import fs from 'node:fs'

import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { ChannelType, Client, GatewayIntentBits, Partials, type APIMessage } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import { CachedOpencodeProviderProxy } from 'opencode-cached-provider'
import { setDataDir } from './config.js'
import { store } from './store.js'
import { startDiscordBot } from './discord-bot.js'
import {
  closeDatabase,
  getChannelVerbosity,
  initDatabase,
  setBotToken,
  setChannelDirectory,
  setChannelVerbosity,
  type VerbosityLevel,
} from './database.js'
import { startHranaServer, stopHranaServer } from './hrana-server.js'
import { chooseLockPort, cleanupTestSessions, initTestGitRepo } from './test-utils.js'
import { waitForBotMessageContaining, waitForBotReplyAfterUserMessage } from './test-utils.js'
import { stopOpencodeServer } from './opencode.js'
import { disposeRuntime, pendingPermissions } from './session-handler/thread-session-runtime.js'
import { pendingActionButtonContexts } from './commands/action-buttons.js'
import { pendingQuestionContexts } from './commands/ask-question.js'
import type { OpencodeEventLogEntry } from './session-handler/opencode-session-event-log.js'

const geminiApiKey =
  process.env['GEMINI_API_KEY'] ||
  process.env['GOOGLE_GENERATIVE_AI_API_KEY'] ||
  ''
const geminiModel = process.env['GEMINI_FLASH_MODEL'] || 'gemini-2.5-flash'
const shouldRunRealCapture =
  geminiApiKey.length > 0 && process.env['KIMAKI_RUN_REAL_EVENT_CAPTURE'] === '1'
const realCaptureTest = shouldRunRealCapture ? test : test.skip

const TEST_USER_ID = '200000000000003001'
const TEXT_CHANNEL_ID = '200000000000003002'

function createRunDirectories() {
  const root = path.resolve(process.cwd(), 'tmp', 'event-stream-real-capture-e2e')
  fs.mkdirSync(root, { recursive: true })

  const dataDir = fs.mkdtempSync(path.join(root, 'data-'))
  const projectDirectory = path.join(root, 'project')
  const providerCacheDbPath = path.join(root, 'provider-cache.db')
  const sessionEventsDir = path.join(root, 'opencode-session-events')
  const fixtureOutputDir = path.resolve(
    process.cwd(),
    'src',
    'session-handler',
    'event-stream-fixtures',
  )
  fs.mkdirSync(projectDirectory, { recursive: true })
  initTestGitRepo(projectDirectory)
  fs.mkdirSync(sessionEventsDir, { recursive: true })

  return {
    root,
    dataDir,
    projectDirectory,
    providerCacheDbPath,
    sessionEventsDir,
    fixtureOutputDir,
  }
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

function readJsonlEvents(filePath: string): OpencodeEventLogEntry[] {
  const content = fs.readFileSync(filePath, 'utf8')
  const lines = content.split('\n').filter((line) => {
    return line.trim().length > 0
  })
  return lines.map((line) => {
    return JSON.parse(line) as OpencodeEventLogEntry
  })
}

function hasToolEvent({ events, tool }: { events: OpencodeEventLogEntry[]; tool: string }): boolean {
  return events.some((line) => {
    if (line.event.type !== 'message.part.updated') {
      return false
    }
    const part = line.event.properties.part
    if (part.type !== 'tool') {
      return false
    }
    return part.tool === tool
  })
}

function listJsonlFiles(directory: string): string[] {
  return fs.readdirSync(directory).filter((name) => {
    return name.endsWith('.jsonl')
  })
}

async function waitForNewOrUpdatedSessionLog({
  directory,
  before,
  timeoutMs,
}: {
  directory: string
  before: Map<string, { size: number; mtimeMs: number }>
  timeoutMs: number
}): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const files = listJsonlFiles(directory)
    const changedFiles = files.filter((fileName) => {
      const filePath = path.join(directory, fileName)
      const stat = fs.statSync(filePath)
      const previous = before.get(fileName)
      if (!previous) {
        return true
      }
      return stat.size > previous.size || stat.mtimeMs > previous.mtimeMs
    })
    if (changedFiles.length > 0) {
      const newest = [...changedFiles].sort((a, b) => {
        const aMtime = fs.statSync(path.join(directory, a)).mtimeMs
        const bMtime = fs.statSync(path.join(directory, b)).mtimeMs
        return bMtime - aMtime
      })[0]
      if (newest) {
        return path.join(directory, newest)
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 200)
    })
  }
  throw new Error('Timed out waiting for changed session event log file')
}

async function waitForPendingPermission({
  threadId,
  timeoutMs,
}: {
  threadId: string
  timeoutMs: number
}): Promise<{ contextHash: string; messageId: string }> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const perms = pendingPermissions.get(threadId)
    const first = perms ? [...perms.values()][0] : undefined
    if (first?.contextHash && first.messageId) {
      return { contextHash: first.contextHash, messageId: first.messageId }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100)
    })
  }
  throw new Error('Timed out waiting for pending permission context')
}

async function waitForPendingActionButtons({
  threadId,
  timeoutMs,
}: {
  threadId: string
  timeoutMs: number
}): Promise<{ contextHash: string; messageId: string }> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const entry = [...pendingActionButtonContexts.entries()].find(([, context]) => {
      return context.thread.id === threadId && !context.resolved && Boolean(context.messageId)
    })
    if (entry && entry[1].messageId) {
      return { contextHash: entry[0], messageId: entry[1].messageId }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100)
    })
  }
  throw new Error('Timed out waiting for pending action buttons context')
}

async function waitForPendingQuestion({
  discord,
  threadId,
  timeoutMs,
}: {
  discord: DigitalDiscord
  threadId: string
  timeoutMs: number
}): Promise<{ contextHash: string; questionMessage: APIMessage }> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const entry = [...pendingQuestionContexts.entries()].find(([, context]) => {
      return context.thread.id === threadId
    })
    if (entry) {
      const [contextHash, context] = entry
      const questionMessage = await discord.thread(threadId).waitForMessage({
        timeout: 10_000,
        predicate: (message) => {
          return message.author.id === discord.botUserId
            && message.content.includes('Choose one option')
        },
      })
      if (questionMessage) {
        return {
          contextHash,
          questionMessage,
        }
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100)
    })
  }
  throw new Error('Timed out waiting for pending question context')
}

describe('real event stream capture fixtures (cached provider)', () => {
  const directories = createRunDirectories()
  let lockPort = 0
  let previousDefaultVerbosity: VerbosityLevel | null = null
  let testStartTime = Date.now()
  let botClient: Client | null = null

  const proxy = new CachedOpencodeProviderProxy({
    cacheDbPath: directories.providerCacheDbPath,
    targetBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: geminiApiKey,
    cacheMethods: ['POST'],
  })

  const digitalDiscordDbPath = path.join(
    directories.dataDir,
    'digital-discord.db',
  )

  const discord = new DigitalDiscord({
    guild: {
      name: 'Real Event Capture Guild',
      ownerId: TEST_USER_ID,
    },
    channels: [
      {
        id: TEXT_CHANNEL_ID,
        name: 'real-event-capture',
        type: ChannelType.GuildText,
      },
    ],
    users: [
      {
        id: TEST_USER_ID,
        username: 'real-capture-user',
      },
    ],
    dbUrl: `file:${digitalDiscordDbPath}`,
  })

  async function captureFixture({
    fixtureName,
    beforeFiles,
    assertEvents,
  }: {
    fixtureName: string
    beforeFiles: Map<string, { size: number; mtimeMs: number }>
    assertEvents: (events: OpencodeEventLogEntry[]) => void
  }): Promise<void> {
    const newLogPath = await waitForNewOrUpdatedSessionLog({
      directory: directories.sessionEventsDir,
      before: beforeFiles,
      timeoutMs: 120_000,
    })
    const fixturePath = path.join(directories.fixtureOutputDir, fixtureName)
    fs.copyFileSync(newLogPath, fixturePath)
    const events = readJsonlEvents(fixturePath)
    assertEvents(events)
  }

  function getSessionLogState(): Map<string, { size: number; mtimeMs: number }> {
    const files = listJsonlFiles(directories.sessionEventsDir)
    return new Map(
      files.map((fileName) => {
        const stat = fs.statSync(path.join(directories.sessionEventsDir, fileName))
        return [fileName, { size: stat.size, mtimeMs: stat.mtimeMs }]
      }),
    )
  }

  beforeAll(async () => {
    testStartTime = Date.now()
    lockPort = chooseLockPort({ key: TEXT_CHANNEL_ID })

    listJsonlFiles(directories.sessionEventsDir).forEach((fileName) => {
      fs.rmSync(path.join(directories.sessionEventsDir, fileName), {
        force: true,
      })
    })

    process.env['KIMAKI_LOCK_PORT'] = String(lockPort)
    process.env['KIMAKI_LOG_OPENCODE_SESSION_EVENTS'] = '1'
    process.env['KIMAKI_OPENCODE_SESSION_EVENTS_DIR'] = directories.sessionEventsDir
    setDataDir(directories.dataDir)

    previousDefaultVerbosity = store.getState().defaultVerbosity
    store.setState({ defaultVerbosity: 'tools_and_text' })

    await Promise.all([proxy.start(), discord.start()])

    const opencodeConfig = proxy.buildOpencodeConfig({
      providerName: 'cached-google-real-events',
      providerNpm: '@ai-sdk/google',
      model: geminiModel,
      smallModel: geminiModel,
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
    expect(await getChannelVerbosity(TEXT_CHANNEL_ID)).toBe('tools_and_text')

    botClient = createDiscordJsClient({ restUrl: discord.restUrl })
    await startDiscordBot({
      token: discord.botToken,
      appId: discord.botUserId,
      discordClient: botClient,
    })
  }, 180_000)

  afterEach(async () => {
    [...pendingActionButtonContexts.values()].forEach((context) => {
      clearTimeout(context.timer)
    })
    pendingActionButtonContexts.clear()
    pendingQuestionContexts.clear()
    pendingPermissions.clear()

    const threadIds = [...store.getState().threads.keys()]
    threadIds.forEach((threadId) => {
      disposeRuntime(threadId)
    })
    await cleanupTestSessions({
      projectDirectory: directories.projectDirectory,
      testStartTime,
    })
  }, 180_000)

  afterAll(async () => {
    await cleanupTestSessions({
      projectDirectory: directories.projectDirectory,
      testStartTime,
    })

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
      proxy.stop().catch(() => {
        return
      }),
      discord.stop().catch(() => {
        return
      }),
    ])

    delete process.env['KIMAKI_LOCK_PORT']
    delete process.env['KIMAKI_DB_URL']
    delete process.env['KIMAKI_LOG_OPENCODE_SESSION_EVENTS']
    delete process.env['KIMAKI_OPENCODE_SESSION_EVENTS_DIR']

    if (previousDefaultVerbosity) {
      store.setState({ defaultVerbosity: previousDefaultVerbosity })
    }

    fs.rmSync(directories.dataDir, { recursive: true, force: true })
  }, 180_000)

  realCaptureTest(
    'capture real task flow fixture',
    async () => {
      const beforeFiles = getSessionLogState()
      const prompt =
        'REAL_FIXTURE_TASK_NORMAL. First response MUST be exactly one tool call: tool `task` with {"description":"inspect repository","subagent_type":"general","prompt":"Read this repository and return exactly: task-subagent-done"}. Do not answer with plain text before the tool call. After the task result returns, respond with exactly: task-normal-done.'

      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: prompt,
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 120_000,
        predicate: (t) => {
          return t.name?.includes('REAL_FIXTURE_TASK_NORMAL') ?? false
        },
      })

      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '┣ task',
        timeout: 300_000,
      })

      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'task-normal-done',
        timeout: 300_000,
      })

      await captureFixture({
        fixtureName: 'real-session-task-normal.jsonl',
        beforeFiles,
        assertEvents: (events) => {
          expect(events.length).toBeGreaterThan(0)
          expect(hasToolEvent({ events, tool: 'task' })).toBe(true)
        },
      })
    },
    900_000,
  )

  realCaptureTest(
    'capture real task interruption fixture',
    async () => {
      const beforeFiles = getSessionLogState()
      const setupPrompt =
        'REAL_FIXTURE_TASK_INTERRUPT_START. First response MUST call tool `task` with {"description":"long analysis","subagent_type":"general","prompt":"Perform a long analysis over many files and produce extensive notes"}. Do not send plain text before the tool call.'

      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: setupPrompt,
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 120_000,
        predicate: (t) => {
          return t.name?.includes('REAL_FIXTURE_TASK_INTERRUPT_START') ?? false
        },
      })

      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: '┣ task',
        timeout: 300_000,
      })

      await discord.thread(thread.id).user(TEST_USER_ID).sendMessage({
        content: 'REAL_FIXTURE_TASK_INTERRUPT_FOLLOWUP. Stop and reply with exactly: task-interrupt-done.',
      })

      await waitForBotReplyAfterUserMessage({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        userMessageIncludes: 'REAL_FIXTURE_TASK_INTERRUPT_FOLLOWUP',
        timeout: 300_000,
      })

      await captureFixture({
        fixtureName: 'real-session-task-user-interruption.jsonl',
        beforeFiles,
        assertEvents: (events) => {
          expect(events.length).toBeGreaterThan(0)
          expect(hasToolEvent({ events, tool: 'task' })).toBe(true)
        },
      })
    },
    900_000,
  )

  realCaptureTest(
    'capture real permission fixture for external path access',
    async () => {
      const beforeFiles = getSessionLogState()
      const prompt =
        'REAL_FIXTURE_PERMISSION_EXTERNAL. Use bash (hasSideEffect false) to read this file outside the workspace: /Users/morse/.zprofile. Then summarize the first line.'

      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: prompt,
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 120_000,
        predicate: (t) => {
          return t.name?.includes('REAL_FIXTURE_PERMISSION_EXTERNAL') ?? false
        },
      })

      const pending = await waitForPendingPermission({
        threadId: thread.id,
        timeoutMs: 300_000,
      })

      const interaction = await discord.thread(thread.id).user(TEST_USER_ID).clickButton({
        messageId: pending.messageId,
        customId: `permission_once:${pending.contextHash}`,
      })

      await discord.thread(thread.id).waitForInteractionAck({
        interactionId: interaction.id,
        timeout: 30_000,
      })
      await discord.thread(thread.id).waitForBotReply({ timeout: 300_000 })

      await captureFixture({
        fixtureName: 'real-session-permission-external-file.jsonl',
        beforeFiles,
        assertEvents: (events) => {
          const hasPermissionAsked = events.some((line) => {
            return line.event.type === 'permission.asked'
          })
          const hasPermissionReplied = events.some((line) => {
            return line.event.type === 'permission.replied'
          })
          expect(hasPermissionAsked).toBe(true)
          expect(hasPermissionReplied).toBe(true)
        },
      })
    },
    900_000,
  )

  realCaptureTest(
    'capture real action buttons fixture',
    async () => {
      const beforeFiles = getSessionLogState()
      const prompt =
        'REAL_FIXTURE_ACTION_BUTTONS. First response MUST call tool `kimaki_action_buttons` with {"buttons":[{"label":"Approve capture","color":"green"}]}. Do not send text before the tool call. After user clicks, reply exactly: action-buttons-done.'

      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: prompt,
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 120_000,
        predicate: (t) => {
          return t.name?.includes('REAL_FIXTURE_ACTION_BUTTONS') ?? false
        },
      })

      const action = await waitForPendingActionButtons({
        threadId: thread.id,
        timeoutMs: 300_000,
      })

      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'Action Required',
        timeout: 300_000,
      })

      const interaction = await discord.thread(thread.id).user(TEST_USER_ID).clickButton({
        messageId: action.messageId,
        customId: `action_button:${action.contextHash}:0`,
      })

      await discord.thread(thread.id).waitForInteractionAck({
        interactionId: interaction.id,
        timeout: 30_000,
      })
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'action-buttons-done',
        timeout: 300_000,
      })

      await captureFixture({
        fixtureName: 'real-session-action-buttons.jsonl',
        beforeFiles,
        assertEvents: (events) => {
          expect(events.length).toBeGreaterThan(0)
          const hasActionTool = hasToolEvent({ events, tool: 'kimaki_action_buttons' })
          expect(hasActionTool).toBe(true)
        },
      })
    },
    900_000,
  )

  realCaptureTest(
    'capture real question tool fixture',
    async () => {
      const beforeFiles = getSessionLogState()
      const prompt =
        'REAL_FIXTURE_QUESTION_TOOL. First response MUST call tool `question` with {"questions":[{"question":"Choose one option","header":"Pick one","options":[{"label":"Alpha","description":"Alpha option"},{"label":"Beta","description":"Beta option"}]}]}. Do not send text before the tool call. After user selects, reply exactly: question-tool-done.'

      await discord.channel(TEXT_CHANNEL_ID).user(TEST_USER_ID).sendMessage({
        content: prompt,
      })

      const thread = await discord.channel(TEXT_CHANNEL_ID).waitForThread({
        timeout: 120_000,
        predicate: (t) => {
          return t.name?.includes('REAL_FIXTURE_QUESTION_TOOL') ?? false
        },
      })

      const pending = await waitForPendingQuestion({
        discord,
        threadId: thread.id,
        timeoutMs: 300_000,
      })

      const interaction = await discord.thread(thread.id).user(TEST_USER_ID).selectMenu({
        messageId: pending.questionMessage.id,
        customId: `ask_question:${pending.contextHash}:0`,
        values: ['0'],
      })

      await discord.thread(thread.id).waitForInteractionAck({
        interactionId: interaction.id,
        timeout: 30_000,
      })
      await waitForBotMessageContaining({
        discord,
        threadId: thread.id,
        userId: TEST_USER_ID,
        text: 'question-tool-done',
        timeout: 300_000,
      })

      await captureFixture({
        fixtureName: 'real-session-question-tool.jsonl',
        beforeFiles,
        assertEvents: (events) => {
          const hasQuestionAsked = events.some((line) => {
            return line.event.type === 'question.asked'
          })
          const hasQuestionReplied = events.some((line) => {
            return line.event.type === 'question.replied'
          })
          expect(hasQuestionAsked).toBe(true)
          expect(hasQuestionReplied).toBe(true)
        },
      })
    },
    900_000,
  )
})
