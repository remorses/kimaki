// Standalone e2e test that snapshots the OpenCode session message structure.
// No kimaki imports — only depends on:
//   1. `opencode` CLI in PATH (spawned as `opencode serve`)
//   2. `opencode-deterministic-provider` for canned model responses
//   3. `@opencode-ai/sdk/v2` for the SDK client
//
// Purpose: detect regressions in how opencode structures assistant messages
// per user turn. Since v1.14.42, opencode creates a NEW assistant message
// for each tool-call round instead of accumulating parts in one message.
// This causes SDK consumers to see multiple `finish=stop` completions per
// turn, triggering duplicate footers and other lifecycle bugs.
//
// The snapshot replaces volatile IDs with stable incremented counters
// (ses-1, msg-1, etc.) so diffs are readable across runs.
//
// NOTE: The SSE /event endpoint is broken since v1.14.42 (see opencode
// issue #26697). This test uses session.messages() polling instead.

import { execSync, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import url from 'node:url'
import { test, expect, beforeAll, afterAll } from 'vitest'
import {
  createOpencodeClient,
  type OpencodeClient,
} from '@opencode-ai/sdk/v2'
import {
  buildDeterministicOpencodeConfig,
  type DeterministicMatcher,
} from 'opencode-deterministic-provider'

// ── Test lifecycle ────────────────────────────────────────────────

let serverProcess: ChildProcess | null = null
let client: OpencodeClient
let projectDirectory: string

beforeAll(async () => {
  fs.mkdirSync(ROOT, { recursive: true })
  await startOpencodeServer()
}, 60_000)

afterAll(async () => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 1000))
    serverProcess = null
  }
}, 10_000)

// ── Tests ─────────────────────────────────────────────────────────

test('simple text response: one user message, one assistant message with finish=stop', async () => {
  const messages = await runPromptAndSnapshot({
    prompt: 'SIMPLE_TEXT_PROMPT hello',
  })

  // Expected: exactly 1 user + 1 assistant, assistant has finish=stop
  // Regression: if opencode creates multiple assistants for a single text response
  const summary = messages.map((m) => `${m.role}  ${m.id}  parent=${m.parentId}  finish=${m.finish}  completed=${m.completed}  parts=[${m.partTypes.join(',')}]`)
  expect(summary.join('\n')).toMatchInlineSnapshot(`
    "user  msg-1  parent=-  finish=-  completed=no  parts=[text,text]
    assistant  msg-2  parent=msg-1  finish=stop  completed=yes  parts=[step-start,text,step-finish]"
  `)

  const users = messages.filter((m) => m.role === 'user')
  const assistants = messages.filter((m) => m.role === 'assistant')
  expect(users.length).toBe(1)
  // This assertion detects the regression: old opencode = 1 assistant, new = potentially more
  const stopAssistants = assistants.filter((m) => m.finish === 'stop')
  expect(stopAssistants.length).toBe(1)
}, 15_000)

test('tool call + follow-up: two assistant messages, one tool-calls + one stop', async () => {
  const messages = await runPromptAndSnapshot({
    prompt: 'TOOL_CALL_PROMPT check something',
  })

  const summary = messages.map((m) => `${m.role}  ${m.id}  parent=${m.parentId}  finish=${m.finish}  completed=${m.completed}  parts=[${m.partTypes.join(',')}]`)
  expect(summary.join('\n')).toMatchInlineSnapshot(`
    "user  msg-1  parent=-  finish=-  completed=no  parts=[text,text]
    assistant  msg-2  parent=msg-1  finish=tool-calls  completed=yes  parts=[step-start,text,step-finish]
    assistant  msg-3  parent=msg-1  finish=stop  completed=yes  parts=[step-start,text,step-finish]"
  `)

  const assistants = messages.filter((m) => m.role === 'assistant')
  const toolCallAssistants = assistants.filter((m) => m.finish === 'tool-calls')
  const stopAssistants = assistants.filter((m) => m.finish === 'stop')

  // Expected: exactly 1 tool-calls + 1 stop assistant message
  // Regression: multiple stop messages for the same user turn
  expect(toolCallAssistants.length).toBe(1)
  expect(stopAssistants.length).toBe(1)
}, 15_000)

test('multi-round tool chain: 4 sequential tool calls then final text', async () => {
  // This test exercises 4 sequential tool-call rounds followed by a final
  // text response. The broken session (ses_1e36af293ffebBY871LdvybVIC)
  // showed 9 assistant messages for a single user turn with 3 having
  // finish=stop. This test tries to reproduce that pattern.
  const messages = await runPromptAndSnapshot({
    prompt: 'MULTI_ROUND_PROMPT start',
    timeoutMs: 20_000,
  })

  const summary = messages.map((m) => `${m.role}  ${m.id}  parent=${m.parentId}  finish=${m.finish}  completed=${m.completed}  parts=[${m.partTypes.join(',')}]`)
  expect(summary.join('\n')).toMatchInlineSnapshot(`
    "user  msg-1  parent=-  finish=-  completed=no  parts=[text,text]
    assistant  msg-2  parent=msg-1  finish=tool-calls  completed=yes  parts=[step-start,text,step-finish]
    assistant  msg-3  parent=msg-1  finish=tool-calls  completed=yes  parts=[step-start,text,step-finish]
    assistant  msg-4  parent=msg-1  finish=tool-calls  completed=yes  parts=[step-start,text,step-finish]
    assistant  msg-5  parent=msg-1  finish=tool-calls  completed=yes  parts=[step-start,text,step-finish]
    assistant  msg-6  parent=msg-1  finish=stop  completed=yes  parts=[step-start,text,step-finish]"
  `)

  const assistants = messages.filter((m) => m.role === 'assistant')
  const stopAssistants = assistants.filter((m) => m.finish === 'stop')

  // CRITICAL: there must be exactly ONE finish=stop assistant message per user turn.
  // If this fails with >1, opencode is creating multiple stop completions per turn,
  // which causes duplicate footers in SDK consumers like kimaki.
  expect(stopAssistants.length).toBe(1)
}, 30_000)

// ── Matchers ──────────────────────────────────────────────────────

function createMatchers(): DeterministicMatcher[] {
  // Simple text response — should be ONE assistant message with finish=stop
  const simpleText: DeterministicMatcher = {
    id: 'simple-text',
    priority: 10,
    when: { latestUserTextIncludes: 'SIMPLE_TEXT_PROMPT' },
    then: {
      defaultPartDelayMs: 10,
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'txt-1' },
        { type: 'text-delta', id: 'txt-1', delta: 'Hello ' },
        { type: 'text-delta', id: 'txt-1', delta: 'world' },
        { type: 'text-end', id: 'txt-1' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        },
      ],
    },
  }

  // Tool call step — model calls bash, then gets tool result back
  const toolCallStep: DeterministicMatcher = {
    id: 'tool-call-step',
    priority: 20,
    when: {
      lastMessageRole: 'user',
      latestUserTextIncludes: 'TOOL_CALL_PROMPT',
    },
    then: {
      defaultPartDelayMs: 10,
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'tc-txt' },
        { type: 'text-delta', id: 'tc-txt', delta: 'Let me check' },
        { type: 'text-end', id: 'tc-txt' },
        {
          type: 'tool-call',
          toolCallId: 'call-bash-1',
          toolName: 'bash',
          input: JSON.stringify({ command: 'echo done', description: 'test command' }),
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 },
        },
      ],
    },
  }

  // Follow-up after tool result — text response with finish=stop
  const toolFollowup: DeterministicMatcher = {
    id: 'tool-followup',
    priority: 21,
    when: {
      lastMessageRole: 'tool',
      latestUserTextIncludes: 'TOOL_CALL_PROMPT',
    },
    then: {
      defaultPartDelayMs: 10,
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'fu-txt' },
        { type: 'text-delta', id: 'fu-txt', delta: 'Tool result received' },
        { type: 'text-end', id: 'fu-txt' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 150, outputTokens: 15, totalTokens: 165 },
        },
      ],
    },
  }

  // Multi-round tool chain: 4 sequential bash calls then final text.
  // After each tool-call, opencode calls the model with lastRole=tool (v3 prompt)
  // or lastRole=assistant (if opencode creates a continuation message before
  // the tool result arrives). We match by checking if previous round text
  // markers (e.g. "Round 1") appear in the prompt text.
  //
  // Priority ordering ensures the latest round marker wins (highest priority
  // checked first, earlier markers are also present but lower-priority matchers
  // are skipped).

  const multiRound1: DeterministicMatcher = {
    id: 'multi-round-1',
    priority: 30,
    when: {
      latestUserTextIncludes: 'MULTI_ROUND_PROMPT',
    },
    then: {
      defaultPartDelayMs: 5,
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'mr1' },
        { type: 'text-delta', id: 'mr1', delta: 'Round 1' },
        { type: 'text-end', id: 'mr1' },
        {
          type: 'tool-call',
          toolCallId: 'mr-bash-1',
          toolName: 'bash',
          input: JSON.stringify({ command: 'echo ROUND_1_DONE', description: 'round 1' }),
        },
        { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
      ],
    },
  }

  const multiRound2: DeterministicMatcher = {
    id: 'multi-round-2',
    priority: 31,
    when: {
      latestUserTextIncludes: 'MULTI_ROUND_PROMPT',
      promptTextIncludes: 'Round 1',
    },
    then: {
      defaultPartDelayMs: 5,
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'mr2' },
        { type: 'text-delta', id: 'mr2', delta: 'Round 2' },
        { type: 'text-end', id: 'mr2' },
        {
          type: 'tool-call',
          toolCallId: 'mr-bash-2',
          toolName: 'bash',
          input: JSON.stringify({ command: 'echo ROUND_2_DONE', description: 'round 2' }),
        },
        { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 150, outputTokens: 20, totalTokens: 170 } },
      ],
    },
  }

  const multiRound3: DeterministicMatcher = {
    id: 'multi-round-3',
    priority: 32,
    when: {
      latestUserTextIncludes: 'MULTI_ROUND_PROMPT',
      promptTextIncludes: 'Round 2',
    },
    then: {
      defaultPartDelayMs: 5,
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'mr3' },
        { type: 'text-delta', id: 'mr3', delta: 'Round 3' },
        { type: 'text-end', id: 'mr3' },
        {
          type: 'tool-call',
          toolCallId: 'mr-bash-3',
          toolName: 'bash',
          input: JSON.stringify({ command: 'echo ROUND_3_DONE', description: 'round 3' }),
        },
        { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 200, outputTokens: 20, totalTokens: 220 } },
      ],
    },
  }

  const multiRound4: DeterministicMatcher = {
    id: 'multi-round-4',
    priority: 33,
    when: {
      latestUserTextIncludes: 'MULTI_ROUND_PROMPT',
      promptTextIncludes: 'Round 3',
    },
    then: {
      defaultPartDelayMs: 5,
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'mr4' },
        { type: 'text-delta', id: 'mr4', delta: 'Round 4' },
        { type: 'text-end', id: 'mr4' },
        {
          type: 'tool-call',
          toolCallId: 'mr-bash-4',
          toolName: 'bash',
          input: JSON.stringify({ command: 'echo ROUND_4_DONE', description: 'round 4' }),
        },
        { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 250, outputTokens: 20, totalTokens: 270 } },
      ],
    },
  }

  const multiFinal: DeterministicMatcher = {
    id: 'multi-final',
    priority: 34,
    when: {
      latestUserTextIncludes: 'MULTI_ROUND_PROMPT',
      promptTextIncludes: 'Round 4',
    },
    then: {
      defaultPartDelayMs: 5,
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'mrf' },
        { type: 'text-delta', id: 'mrf', delta: 'All rounds complete' },
        { type: 'text-end', id: 'mrf' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 300, outputTokens: 10, totalTokens: 310 } },
      ],
    },
  }

  return [
    simpleText, toolCallStep, toolFollowup,
    multiRound1, multiRound2, multiRound3, multiRound4, multiFinal,
  ]
}

// ── Utilities ─────────────────────────────────────────────────────

const ROOT = path.resolve(process.cwd(), 'tmp', 'opencode-event-snapshot-e2e')

function initGitRepo(directory: string): void {
  if (fs.existsSync(path.join(directory, '.git'))) {
    return
  }
  execSync('git init -b main', { cwd: directory, stdio: 'pipe' })
  execSync('git config user.email "test@test.com"', { cwd: directory, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: directory, stdio: 'pipe' })
  execSync('git commit --allow-empty -m "init"', { cwd: directory, stdio: 'pipe' })
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('Could not get port')))
        return
      }
      const port = addr.port
      server.close(() => resolve(port))
    })
  })
}

function createIdStabilizer() {
  const counters: Record<string, number> = {}
  const mapping = new Map<string, string>()

  function stabilize(prefix: string, rawId: string): string {
    const existing = mapping.get(rawId)
    if (existing) {
      return existing
    }
    counters[prefix] = (counters[prefix] || 0) + 1
    const stable = `${prefix}-${counters[prefix]}`
    mapping.set(rawId, stable)
    return stable
  }

  return { stabilize }
}

// ── Server lifecycle ──────────────────────────────────────────────

async function startOpencodeServer(): Promise<void> {
  const serverPort = await findFreePort()
  projectDirectory = path.join(ROOT, 'project')
  fs.mkdirSync(projectDirectory, { recursive: true })
  initGitRepo(projectDirectory)

  const providerNpm = url
    .pathToFileURL(
      path.resolve(process.cwd(), '..', 'opencode-deterministic-provider', 'src', 'index.ts'),
    )
    .toString()

  const opencodeConfig = buildDeterministicOpencodeConfig({
    providerName: 'deterministic-provider',
    providerNpm,
    model: 'snapshot-model',
    smallModel: 'snapshot-model',
    settings: {
      strict: false,
      matchers: createMatchers(),
      defaultPartDelayMs: 5,
    },
  })

  const fullConfig = {
    ...opencodeConfig,
    lsp: false,
    formatter: false,
    permission: {
      edit: 'allow',
      bash: 'allow',
      webfetch: 'allow',
    },
  }

  fs.writeFileSync(
    path.join(projectDirectory, 'opencode.json'),
    JSON.stringify(fullConfig, null, 2),
  )

  serverProcess = spawn('opencode', ['serve', '--port', String(serverPort)], {
    stdio: 'pipe',
    cwd: projectDirectory,
    env: {
      ...process.env,
      OPENCODE_HOME: path.join(ROOT, 'opencode-home'),
    },
  })

  const baseUrl = `http://127.0.0.1:${serverPort}`
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${baseUrl}/health`)
      if (resp.ok) {
        break
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200))
  }

  client = createOpencodeClient({
    baseUrl,
    directory: projectDirectory,
  })
}

// ── Prompt runner ─────────────────────────────────────────────────

type MessageSnapshot = {
  role: string
  id: string
  parentId: string
  finish: string
  completed: string
  partTypes: string[]
}

async function runPromptAndSnapshot({
  prompt,
  timeoutMs = 10_000,
}: {
  prompt: string
  timeoutMs?: number
}): Promise<MessageSnapshot[]> {
  const session = await client.session.create({
    directory: projectDirectory,
  })
  const sessionID = session.data!.id

  await client.session.promptAsync({
    sessionID,
    directory: projectDirectory,
    parts: [{ type: 'text', text: prompt }],
  })

  // Poll until session has at least one completed assistant with finish=stop
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const msgs = await client.session.messages({
      sessionID,
      directory: projectDirectory,
    })
    const assistants = (msgs.data || []).filter((m) => m.info.role === 'assistant')
    const hasStop = assistants.some((m) => {
      if (m.info.role !== 'assistant') return false
      return m.info.finish === 'stop' && m.info.time.completed
    })
    if (hasStop) {
      await new Promise((r) => setTimeout(r, 300))
      break
    }
    await new Promise((r) => setTimeout(r, 100))
  }

  // Fetch final state
  const msgs = await client.session.messages({
    sessionID,
    directory: projectDirectory,
  })

  const stabilizer = createIdStabilizer()
  const s = stabilizer.stabilize

  const result: MessageSnapshot[] = (msgs.data || []).map((m) => {
    const { info } = m
    if (info.role === 'assistant') {
      return {
        role: 'assistant',
        id: s('msg', info.id),
        parentId: s('msg', info.parentID),
        finish: info.finish || '-',
        completed: info.time.completed ? 'yes' : 'no',
        partTypes: m.parts.map((p) => p.type),
      }
    }
    return {
      role: info.role,
      id: s('msg', info.id),
      parentId: '-',
      finish: '-',
      completed: 'no',
      partTypes: m.parts.map((p) => p.type),
    }
  })

  await client.session.delete({ sessionID, directory: projectDirectory }).catch(() => {})

  return result
}
