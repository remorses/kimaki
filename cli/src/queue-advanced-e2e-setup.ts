// Shared setup for queue-advanced e2e test files.
// Extracted so vitest can parallelize the split test files across workers.

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { beforeAll, afterAll, afterEach, expect } from 'vitest'
import { ChannelType, Client, GatewayIntentBits, Partials } from 'discord.js'
import { DigitalDiscord } from 'discord-digital-twin/src'
import {
  buildDeterministicOpencodeConfig,
  type DeterministicMatcher,
} from 'opencode-deterministic-provider'
import { initTestGitRepo } from './test-utils.js'
import { setDataDir } from './config.js'
import { store } from './store.js'
import { startDiscordBot } from './discord-bot.js'
import { disposeRuntime } from './session-handler/thread-session-runtime.js'
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
} from './test-utils.js'


export function createRunDirectories({ name }: { name: string }) {
  const root = path.resolve(process.cwd(), 'tmp', name)
  fs.mkdirSync(root, { recursive: true })

  const dataDir = fs.mkdtempSync(path.join(root, 'data-'))
  const projectDirectory = path.join(root, 'project')
  fs.mkdirSync(projectDirectory, { recursive: true })
  initTestGitRepo(projectDirectory)

  return { root, dataDir, projectDirectory }
}

export function chooseLockPort({ channelId }: { channelId: string }): number {
  let hash = 0
  for (let i = 0; i < channelId.length; i++) {
    const char = channelId.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash |= 0
  }
  return 51_000 + (Math.abs(hash) % 2_000)
}

export function createDiscordJsClient({ restUrl }: { restUrl: string }) {
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

export function createDeterministicMatchers(): DeterministicMatcher[] {
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
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
      partDelaysMs: [0, 500, 0, 0, 0],
    },
  }

  const slowAbortMatcher: DeterministicMatcher = {
    id: 'slow-abort-marker',
    priority: 100,
    when: {
      latestUserTextIncludes: 'SLOW_ABORT_MARKER run long response',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'slow-start' },
        { type: 'text-delta', id: 'slow-start', delta: 'slow-response-started' },
        { type: 'text-end', id: 'slow-start' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
      partDelaysMs: [0, 0, 0, 3_000, 0],
    },
  }

  const toolFollowupMatcher: DeterministicMatcher = {
    id: 'tool-followup',
    priority: 50,
    when: { lastMessageRole: 'tool' },
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

  const typingRepulseMatcher: DeterministicMatcher = {
    id: 'typing-repulse-marker',
    priority: 101,
    when: {
      latestUserTextIncludes: 'TYPING_REPULSE_MARKER',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'typing-repulse-text' },
        { type: 'text-delta', id: 'typing-repulse-text', delta: 'repulse-first' },
        { type: 'text-end', id: 'typing-repulse-text' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
      // Keep the run busy after the first visible assistant message so tests can
      // assert that typing resumes while OpenCode is still working.
      partDelaysMs: [0, 100, 0, 0, 1_800],
    },
  }

  const pluginTimeoutSleepMatcher: DeterministicMatcher = {
    id: 'plugin-timeout-sleep',
    priority: 100,
    when: {
      latestUserTextIncludes: 'PLUGIN_TIMEOUT_SLEEP_MARKER',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'sleep-text' },
        { type: 'text-delta', id: 'sleep-text', delta: 'starting sleep 100' },
        { type: 'text-end', id: 'sleep-text' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
      partDelaysMs: [0, 0, 0, 0, 100_000],
    },
  }

  const permissionTypingMatcher: DeterministicMatcher = {
    id: 'permission-typing-marker',
    priority: 105,
    when: {
      lastMessageRole: 'user',
      latestUserTextIncludes: 'PERMISSION_TYPING_MARKER',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'permission-typing-start' },
        {
          type: 'text-delta',
          id: 'permission-typing-start',
          delta: 'requesting external read permission',
        },
        { type: 'text-end', id: 'permission-typing-start' },
        {
          type: 'tool-call',
          toolCallId: 'permission-typing-read-call',
          toolName: 'read',
          input: JSON.stringify({
            filePath: '/Users/morse/.zprofile',
          }),
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
    },
  }

  const permissionTypingFollowupMatcher: DeterministicMatcher = {
    id: 'permission-typing-followup',
    priority: 104,
    when: {
      latestUserTextIncludes: 'PERMISSION_TYPING_MARKER',
      rawPromptIncludes: 'requesting external read permission',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'permission-typing-followup' },
        {
          type: 'text-delta',
          id: 'permission-typing-followup',
          delta: 'permission-flow-done',
        },
        { type: 'text-end', id: 'permission-typing-followup' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
      // Keep run busy long enough after permission reply so typing keepalive
      // must pulse again. This makes typing resume assertions deterministic.
      partDelaysMs: [0, 0, 0, 0, 8_000],
    },
  }

  const actionButtonClickFollowupMatcher: DeterministicMatcher = {
    id: 'action-button-click-followup',
    priority: 109,
    when: {
      lastMessageRole: 'user',
      latestUserTextIncludes: 'User clicked: Continue action-buttons flow',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'action-button-click-followup' },
        {
          type: 'text-delta',
          id: 'action-button-click-followup',
          delta: 'action-buttons-click-continued',
        },
        { type: 'text-end', id: 'action-button-click-followup' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
    },
  }

  // Question tool: model asks a question, user answers via text, model follows up
  const questionToolMatcher: DeterministicMatcher = {
    id: 'question-text-answer-marker',
    priority: 106,
    when: {
      lastMessageRole: 'user',
      latestUserTextIncludes: 'QUESTION_TEXT_ANSWER_MARKER',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        {
          type: 'tool-call',
          toolCallId: 'question-text-answer-call',
          toolName: 'question',
          input: JSON.stringify({
            questions: [{
              question: 'Which option do you prefer?',
              header: 'Pick one',
              options: [
                { label: 'Alpha', description: 'Alpha option' },
                { label: 'Beta', description: 'Beta option' },
              ],
            }],
          }),
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
    },
  }

  // Question tool for select+queue drain test: model asks a question via dropdown,
  // user answers via select menu while a message is queued.
  const questionSelectQueueMatcher: DeterministicMatcher = {
    id: 'question-select-queue-marker',
    priority: 107,
    when: {
      lastMessageRole: 'user',
      latestUserTextIncludes: 'QUESTION_SELECT_QUEUE_MARKER',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        {
          type: 'tool-call',
          toolCallId: 'question-select-queue-call',
          toolName: 'question',
          input: JSON.stringify({
            questions: [{
              question: 'How to proceed?',
              header: 'Select action',
              options: [
                { label: 'Alpha', description: 'Alpha option' },
                { label: 'Beta', description: 'Beta option' },
              ],
            }],
          }),
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
    },
  }

  // Model responds with text + tool call, then after tool result the
  // follow-up matcher responds with text. This creates two assistant messages:
  // first with finish="tool-calls" + completed, second with finish="stop".
  // Reproduces the bug where the first message gets no footer even though
  // it completed normally (isAssistantMessageNaturalCompletion rejects
  // finish="tool-calls").
  const toolCallFooterMatcher: DeterministicMatcher = {
    id: 'tool-call-footer',
    priority: 108,
    when: {
      lastMessageRole: 'user',
      latestUserTextIncludes: 'TOOL_CALL_FOOTER_MARKER',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'tool-call-footer-text' },
        { type: 'text-delta', id: 'tool-call-footer-text', delta: 'running tool' },
        { type: 'text-end', id: 'tool-call-footer-text' },
        {
          type: 'tool-call',
          toolCallId: 'tool-call-footer-bash',
          toolName: 'bash',
          input: JSON.stringify({
            command: 'echo tool-call-footer-test',
            description: 'Echo for footer test',
          }),
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
    },
  }

  const toolCallFooterFollowupMatcher: DeterministicMatcher = {
    id: 'tool-call-footer-followup',
    priority: 109,
    when: {
      lastMessageRole: 'tool',
      latestUserTextIncludes: 'TOOL_CALL_FOOTER_MARKER',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'tool-call-footer-followup' },
        { type: 'text-delta', id: 'tool-call-footer-followup', delta: 'tool call completed' },
        { type: 'text-end', id: 'tool-call-footer-followup' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
    },
  }

  const undoFileMatcher: DeterministicMatcher = {
    id: 'undo-file-marker',
    priority: 111,
    when: {
      lastMessageRole: 'user',
      latestUserTextIncludes: 'UNDO_FILE_MARKER',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'undo-file-text' },
        { type: 'text-delta', id: 'undo-file-text', delta: 'creating undo file' },
        { type: 'text-end', id: 'undo-file-text' },
        {
          type: 'tool-call',
          toolCallId: 'undo-file-bash',
          toolName: 'bash',
          input: JSON.stringify({
            command: 'mkdir -p tmp && printf created > tmp/undo-marker.txt',
            description: 'Create undo marker file',
          }),
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
    },
  }

  const undoFileFollowupMatcher: DeterministicMatcher = {
    id: 'undo-file-followup',
    priority: 112,
    when: {
      latestUserTextIncludes: 'UNDO_FILE_MARKER',
      rawPromptIncludes: 'creating undo file',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'undo-file-followup' },
        { type: 'text-delta', id: 'undo-file-followup', delta: 'undo file created' },
        { type: 'text-end', id: 'undo-file-followup' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
    },
  }

  // Multi-step tool chain: model emits text + 3 parallel tool calls in one
  // response (finish="tool-calls"). All tools complete, then the follow-up
  // matcher responds with final text (finish="stop"). This creates 2 assistant
  // messages — one with finish="tool-calls" + completed, one with finish="stop".
  // With the naive fix (allowing tool-calls as natural completion), we'd get
  // 2 footers. Only the final text response should get a footer.
  const multiToolMatcher: DeterministicMatcher = {
    id: 'multi-tool',
    priority: 115,
    when: {
      lastMessageRole: 'user',
      latestUserTextIncludes: 'MULTI_TOOL_FOOTER_MARKER',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'multi-tool-text' },
        { type: 'text-delta', id: 'multi-tool-text', delta: 'investigating the issue' },
        { type: 'text-end', id: 'multi-tool-text' },
        {
          type: 'tool-call',
          toolCallId: 'multi-tool-bash-1',
          toolName: 'bash',
          input: JSON.stringify({
            command: 'echo search-done',
            description: 'Search codebase',
          }),
        },
        {
          type: 'tool-call',
          toolCallId: 'multi-tool-bash-2',
          toolName: 'bash',
          input: JSON.stringify({
            command: 'echo read-done',
            description: 'Read config file',
          }),
        },
        {
          type: 'tool-call',
          toolCallId: 'multi-tool-bash-3',
          toolName: 'bash',
          input: JSON.stringify({
            command: 'echo fix-done',
            description: 'Apply fix',
          }),
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 10, outputTokens: 15, totalTokens: 25 },
        },
      ],
    },
  }

  const multiToolFollowupMatcher: DeterministicMatcher = {
    id: 'multi-tool-followup',
    priority: 114,
    when: {
      latestUserTextIncludes: 'MULTI_TOOL_FOOTER_MARKER',
      rawPromptIncludes: 'investigating the issue',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'multi-tool-followup-text' },
        { type: 'text-delta', id: 'multi-tool-followup-text', delta: 'all done, fixed 3 files' },
        { type: 'text-end', id: 'multi-tool-followup-text' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
        },
      ],
    },
  }

  // Multi-step sequential tool chain: 3 separate tool-call steps (each a
  // separate assistant message with finish="tool-calls"), then a final text
  // response. This creates 4 assistant messages total. Without proper
  // deferred footer logic, each tool-call step would emit its own footer,
  // producing 3 spurious footers before the real one.
  //
  // Flow: user → step1 (text + tool-call) → tool result →
  //       step2 (text + tool-call) → tool result →
  //       step3 (text + tool-call) → tool result →
  //       final text (finish="stop")
  //
  // Matcher priority ensures each step fires in order: the highest-priority
  // matcher that matches wins, and each step's rawPromptIncludes check only
  // matches once the previous step's output text is in the conversation.
  const multiStepChainInitMatcher: DeterministicMatcher = {
    id: 'multi-step-chain-init',
    priority: 119,
    when: {
      lastMessageRole: 'user',
      latestUserTextIncludes: 'MULTI_STEP_CHAIN_MARKER',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'chain-step1-text' },
        { type: 'text-delta', id: 'chain-step1-text', delta: 'chain step 1: reading config' },
        { type: 'text-end', id: 'chain-step1-text' },
        {
          type: 'tool-call',
          toolCallId: 'chain-step1-bash',
          toolName: 'bash',
          input: JSON.stringify({
            command: 'echo chain-step-1-output',
            description: 'Read config',
          }),
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 5, outputTokens: 10, totalTokens: 15 },
        },
      ],
    },
  }

  const multiStepChainStep2Matcher: DeterministicMatcher = {
    id: 'multi-step-chain-step2',
    priority: 120,
    when: {
      latestUserTextIncludes: 'MULTI_STEP_CHAIN_MARKER',
      rawPromptIncludes: 'chain step 1: reading config',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'chain-step2-text' },
        { type: 'text-delta', id: 'chain-step2-text', delta: 'chain step 2: analyzing results' },
        { type: 'text-end', id: 'chain-step2-text' },
        {
          type: 'tool-call',
          toolCallId: 'chain-step2-bash',
          toolName: 'bash',
          input: JSON.stringify({
            command: 'echo chain-step-2-output',
            description: 'Analyze results',
          }),
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 15, outputTokens: 10, totalTokens: 25 },
        },
      ],
    },
  }

  const multiStepChainStep3Matcher: DeterministicMatcher = {
    id: 'multi-step-chain-step3',
    priority: 121,
    when: {
      latestUserTextIncludes: 'MULTI_STEP_CHAIN_MARKER',
      rawPromptIncludes: 'chain step 2: analyzing results',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'chain-step3-text' },
        { type: 'text-delta', id: 'chain-step3-text', delta: 'chain step 3: applying fix' },
        { type: 'text-end', id: 'chain-step3-text' },
        {
          type: 'tool-call',
          toolCallId: 'chain-step3-bash',
          toolName: 'bash',
          input: JSON.stringify({
            command: 'echo chain-step-3-output',
            description: 'Apply fix',
          }),
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 25, outputTokens: 10, totalTokens: 35 },
        },
      ],
    },
  }

  const multiStepChainFinalMatcher: DeterministicMatcher = {
    id: 'multi-step-chain-final',
    priority: 122,
    when: {
      latestUserTextIncludes: 'MULTI_STEP_CHAIN_MARKER',
      rawPromptIncludes: 'chain step 3: applying fix',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'chain-final-text' },
        { type: 'text-delta', id: 'chain-final-text', delta: 'chain complete: all 3 steps done' },
        { type: 'text-end', id: 'chain-final-text' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 35, outputTokens: 5, totalTokens: 40 },
        },
      ],
    },
  }

  return [
    slowAbortMatcher,
    typingRepulseMatcher,
    pluginTimeoutSleepMatcher,
    actionButtonClickFollowupMatcher,
    questionToolMatcher,
    questionSelectQueueMatcher,
    permissionTypingMatcher,
    permissionTypingFollowupMatcher,
    multiToolMatcher,
    multiToolFollowupMatcher,
    undoFileMatcher,
    undoFileFollowupMatcher,
    multiStepChainInitMatcher,
    multiStepChainStep2Matcher,
    multiStepChainStep3Matcher,
    multiStepChainFinalMatcher,
    raceFinalReplyMatcher,
    toolCallFooterMatcher,
    toolCallFooterFollowupMatcher,
    toolFollowupMatcher,
    userReplyMatcher,
  ]
}

export type QueueAdvancedContext = {
  directories: ReturnType<typeof createRunDirectories>
  discord: DigitalDiscord
  botClient: Client
  testStartTime: number
}

export const TEST_USER_ID = '200000000000000991'

/**
 * Sets up a full queue-advanced e2e environment: digital-twin Discord server,
 * opencode deterministic provider, database, bot client.
 * Each caller should use a unique channelId and dirName to avoid collisions
 * when vitest runs files in parallel.
 */
export function setupQueueAdvancedSuite({
  channelId,
  channelName,
  dirName,
  username,
}: {
  channelId: string
  channelName: string
  dirName: string
  username: string
}): QueueAdvancedContext {
  const ctx: QueueAdvancedContext = {
    directories: undefined as unknown as ReturnType<typeof createRunDirectories>,
    discord: undefined as unknown as DigitalDiscord,
    botClient: undefined as unknown as Client,
    testStartTime: Date.now(),
  }

  let previousDefaultVerbosity: VerbosityLevel | null = null

  beforeAll(async () => {
    ctx.testStartTime = Date.now()
    ctx.directories = createRunDirectories({ name: dirName })
    const lockPort = chooseLockPort({ channelId })
    const sessionEventsDir = path.join(ctx.directories.root, 'opencode-session-events')
    fs.mkdirSync(sessionEventsDir, { recursive: true })

    process.env['KIMAKI_LOCK_PORT'] = String(lockPort)
    process.env['KIMAKI_INTERRUPT_STEP_TIMEOUT_MS'] = '500'
    process.env['KIMAKI_LOG_OPENCODE_SESSION_EVENTS'] = '1'
    process.env['KIMAKI_OPENCODE_SESSION_EVENTS_DIR'] = sessionEventsDir
    setDataDir(ctx.directories.dataDir)
    previousDefaultVerbosity = store.getState().defaultVerbosity
    store.setState({ defaultVerbosity: 'tools_and_text' })

    const digitalDiscordDbPath = path.join(
      ctx.directories.dataDir,
      'digital-discord.db',
    )

    ctx.discord = new DigitalDiscord({
      guild: { name: `${dirName} Guild`, ownerId: TEST_USER_ID },
      channels: [
        { id: channelId, name: channelName, type: ChannelType.GuildText },
      ],
      users: [{ id: TEST_USER_ID, username }],
      dbUrl: `file:${digitalDiscordDbPath}`,
    })

    await ctx.discord.start()

    const providerNpm = url
      .pathToFileURL(
        path.resolve(process.cwd(), '..', 'opencode-deterministic-provider', 'src', 'index.ts'),
      )
      .toString()

    const opencodeConfig = buildDeterministicOpencodeConfig({
      providerName: 'deterministic-provider',
      providerNpm,
      model: 'deterministic-v2',
      smallModel: 'deterministic-v3',
      settings: { strict: false, matchers: createDeterministicMatchers() },
    })
    fs.writeFileSync(
      path.join(ctx.directories.projectDirectory, 'opencode.json'),
      JSON.stringify(opencodeConfig, null, 2),
    )

    const dbPath = path.join(ctx.directories.dataDir, 'discord-sessions.db')
    const hranaResult = await startHranaServer({ dbPath })
    if (hranaResult instanceof Error) {
      throw hranaResult
    }
    process.env['KIMAKI_DB_URL'] = hranaResult
    await initDatabase()
    await setBotToken(ctx.discord.botUserId, ctx.discord.botToken)

    await setChannelDirectory({
      channelId,
      directory: ctx.directories.projectDirectory,
      channelType: 'text',
    })
    await setChannelVerbosity(channelId, 'tools_and_text')
    const channelVerbosity = await getChannelVerbosity(channelId)
    expect(channelVerbosity).toBe('tools_and_text')

    ctx.botClient = createDiscordJsClient({ restUrl: ctx.discord.restUrl })
    await startDiscordBot({
      token: ctx.discord.botToken,
      appId: ctx.discord.botUserId,
      discordClient: ctx.botClient,
    })

    const warmup = await initializeOpencodeForDirectory(ctx.directories.projectDirectory)
    if (warmup instanceof Error) {
      throw warmup
    }
  }, 20_000)

  afterAll(async () => {
    if (ctx.directories) {
      await cleanupTestSessions({
        projectDirectory: ctx.directories.projectDirectory,
        testStartTime: ctx.testStartTime,
      })
    }

    if (ctx.botClient) {
      ctx.botClient.destroy()
    }

    await stopOpencodeServer()
    await Promise.all([
      closeDatabase().catch(() => {}),
      stopHranaServer().catch(() => {}),
      ctx.discord?.stop().catch(() => {}),
    ])

    delete process.env['KIMAKI_LOCK_PORT']
    delete process.env['KIMAKI_DB_URL']
    delete process.env['KIMAKI_INTERRUPT_STEP_TIMEOUT_MS']
    delete process.env['KIMAKI_LOG_OPENCODE_SESSION_EVENTS']
    delete process.env['KIMAKI_OPENCODE_SESSION_EVENTS_DIR']
    if (previousDefaultVerbosity) {
      store.setState({ defaultVerbosity: previousDefaultVerbosity })
    }
    if (ctx.directories) {
      fs.rmSync(ctx.directories.dataDir, { recursive: true, force: true })
    }
  }, 5_000)

  afterEach(async () => {
    const threadIds = [...store.getState().threads.keys()]
    for (const threadId of threadIds) {
      disposeRuntime(threadId)
    }
    await cleanupTestSessions({
      projectDirectory: ctx.directories.projectDirectory,
      testStartTime: ctx.testStartTime,
    })
  }, 5_000)

  return ctx
}
