// Deterministic markdown export tests.
// Uses the shared opencode server manager with the deterministic provider,
// creates sessions with known content, and validates markdown output.
// No dependency on machine-local session state.

import fs from 'node:fs'
import path from 'node:path'
import { test, expect, beforeAll, afterAll } from 'vitest'
import type { OpencodeClient } from './opencode.js'
import * as errore from 'errore'
import {
  buildDeterministicOpencode2Config,
  type DeterministicMatcher,
} from 'opencode-deterministic-provider'
import { ShareMarkdown, getCompactSessionContext } from './markdown.js'
import { setDataDir } from './config.js'
import { initializeOpencodeForDirectory, stopOpencodeServer } from './opencode.js'
import { chooseLockPort, cleanupTestSessions, initTestGitRepo } from './test-utils.js'

const ROOT = path.resolve(process.cwd(), 'tmp', 'markdown-test')

function createRunDirectories() {
  fs.mkdirSync(ROOT, { recursive: true })
  const dataDir = fs.mkdtempSync(path.join(ROOT, 'data-'))
  const projectDirectory = path.join(ROOT, 'project')
  fs.mkdirSync(projectDirectory, { recursive: true })
  initTestGitRepo(projectDirectory)
  return { dataDir, projectDirectory }
}

function createMatchers(): DeterministicMatcher[] {
  const helloMatcher: DeterministicMatcher = {
    id: 'hello-reply',
    priority: 100,
    when: { lastMessageRole: 'user', latestUserTextIncludes: 'hello markdown test' },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'hello-text' },
        { type: 'text-delta', id: 'hello-text', delta: 'Hello! This is a deterministic markdown test response.' },
        { type: 'text-end', id: 'hello-text' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 } },
      ],
    },
  }

  const toolCallMatcher: DeterministicMatcher = {
    id: 'tool-call-reply',
    priority: 90,
    when: { lastMessageRole: 'user', latestUserTextIncludes: 'use a tool please' },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
         { type: 'tool-call', toolCallId: 'tc1', toolName: 'shell', input: JSON.stringify({ command: 'echo hello world', description: 'Print greeting' }) },
        { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      ],
    },
  }

  const defaultMatcher: DeterministicMatcher = {
    id: 'default-reply',
    priority: 1,
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'default-text' },
        { type: 'text-delta', id: 'default-text', delta: 'ok' },
        { type: 'text-end', id: 'default-text' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 } },
      ],
    },
  }

  return [helloMatcher, toolCallMatcher, defaultMatcher]
}

let client: OpencodeClient
let directories: ReturnType<typeof createRunDirectories>
let testStartTime: number
let sessionID: string
let toolSessionID: string

beforeAll(async () => {
  testStartTime = Date.now()
  directories = createRunDirectories()
  process.env['KIMAKI_LOCK_PORT'] = String(chooseLockPort({ key: 'markdown-test' }))
  setDataDir(directories.dataDir)

  const opencodeConfig = buildDeterministicOpencode2Config({
    providerName: 'deterministic-provider',
    model: 'deterministic-v2',
    extraModels: ['deterministic-v2'],
    settings: {
      strict: false,
      matchers: createMatchers(),
    },
    permissions: [
      { action: 'shell', resource: '*', effect: 'allow' },
      { action: 'edit', resource: '*', effect: 'allow' },
    ],
  })
  fs.writeFileSync(
    path.join(directories.projectDirectory, 'opencode.json'),
    JSON.stringify(opencodeConfig, null, 2),
  )

  // Start the shared opencode server via kimaki's server manager
  const getClient = await initializeOpencodeForDirectory(
    directories.projectDirectory,
  )
  if (getClient instanceof Error) {
    throw getClient
  }
  client = getClient()

  // Create a session and send a known prompt
  const createResult = await client.session.create({
    location: { directory: directories.projectDirectory },
    title: 'Markdown Test Session',
  })
  sessionID = createResult.id

  await client.session.prompt({
    sessionID,
    text: 'hello markdown test',
  })

  // Wait for assistant text parts to be fully written (not just message existence).
  // The deterministic provider responds instantly but opencode writes parts
  // asynchronously, so we must poll until non-empty text content appears.
  // Under parallel test load the server is slower, so use generous timeouts.
  const maxWait = 15_000
  const pollStart = Date.now()
  while (Date.now() - pollStart < maxWait) {
    const msgs = await client.message.list({
      sessionID,
    })
    const assistantMsg = msgs.data.find((m) => m.type === 'assistant')
    const hasTextParts = assistantMsg?.type === 'assistant' && assistantMsg.content.some((p) => {
      return p.type === 'text' && p.text
    })
    if (hasTextParts) {
      // Extra wait for step-start and other parts to be flushed
      await new Promise((resolve) => {
        setTimeout(resolve, 500)
      })
      break
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 200)
    })
  }

  // Create a second session that triggers a tool call (bash echo)
  const toolCreateResult = await client.session.create({
    location: { directory: directories.projectDirectory },
    title: 'Tool Call Session',
  })
  toolSessionID = toolCreateResult.id

  await client.session.prompt({
    sessionID: toolSessionID,
    text: 'use a tool please',
  })

  // Wait for tool execution to complete
  const toolMaxWait = 15_000
  const toolPollStart = Date.now()
  while (Date.now() - toolPollStart < toolMaxWait) {
    const msgs = await client.message.list({
      sessionID: toolSessionID,
    })
    const messages = msgs.data
    const hasToolPart = messages.some((m) =>
      m.type === 'assistant' && m.content.some((p) => {
        return p.type === 'tool' && p.state.status === 'completed'
      }),
    )
    if (hasToolPart) {
      await new Promise((resolve) => { setTimeout(resolve, 500) })
      break
    }
    await new Promise((resolve) => { setTimeout(resolve, 200) })
  }
}, 30_000)

afterAll(async () => {
  if (directories) {
    await cleanupTestSessions({
      projectDirectory: directories.projectDirectory,
      testStartTime,
    })
  }
  await stopOpencodeServer()
  delete process.env['KIMAKI_LOCK_PORT']
  if (directories) {
    fs.rmSync(directories.dataDir, { recursive: true, force: true })
  }
}, 5_000)

// Strip dynamic parts (timestamps, durations, branch names) for stable assertions
function normalizeMarkdown(md: string): string {
  return md
    // Normalize "Completed in Xs" to a fixed string
    .replace(/\*Completed in [\d.]+[ms]+\*/g, '*Completed in Xs*')
    // Normalize "Duration: Xs" tool timing
    .replace(/\*Duration: [\d.]+[ms]+\*/g, '*Duration: Xs*')
    // Normalize ISO dates in session info
    .replace(/\*\*Created\*\*: .+/g, '**Created**: <date>')
    .replace(/\*\*Updated\*\*: .+/g, '**Updated**: <date>')
    // Normalize opencode version
    .replace(/\*\*OpenCode Version\*\*: v[\d.]+.*/g, '**OpenCode Version**: v<version>')
    // Strip git branch context injected by opencode into user messages
    .replace(/\[Current branch: [^\]]+\]\n?\n?/g, '')
    .replace(/\[current git branch is [^\]]+\]\n?\n?/g, '')
    .replace(/\[warning: repository is in detached HEAD[^\]]*\]\n?\n?/g, '')
}

test('generate markdown with system info', async () => {
  const exporter = new ShareMarkdown(client)

  const markdownResult = await exporter.generate({
    sessionID,
    includeSystemInfo: true,
  })

  expect(errore.isOk(markdownResult)).toBe(true)
  const markdown = errore.unwrap(markdownResult)

  expect(markdown).toContain('# Markdown Test Session')
  expect(markdown).toContain('## Session Information')
  expect(markdown).toContain('## Conversation')
  expect(markdown).toContain('### 👤 User')
  expect(markdown).toContain('hello markdown test')
  expect(markdown).toContain(
    '### 🤖 Assistant (deterministic-provider/deterministic-v2)',
  )
  expect(markdown).toContain('Hello! This is a deterministic markdown test response.')

  const normalized = normalizeMarkdown(markdown)
  expect(normalized).toMatchInlineSnapshot(`
    "# Markdown Test Session

    ## Session Information

    - **Created**: <date>
    - **Updated**: <date>

    ## Conversation

    ### 👤 User

    hello markdown test


    ### 🤖 Assistant (deterministic-provider/deterministic-v2)

    Hello! This is a deterministic markdown test response.


    *Completed in Xs*
    "
  `)
})

test('generate markdown without system info', async () => {
  const exporter = new ShareMarkdown(client)

  const markdown = await exporter.generate({
    sessionID,
    includeSystemInfo: false,
  })

  expect(errore.isOk(markdown)).toBe(true)
  if (markdown instanceof Error) throw markdown
  const md = markdown
  expect(md).toContain('# Markdown Test Session')
  expect(md).not.toContain('## Session Information')
  expect(md).toContain('## Conversation')

  const normalized = normalizeMarkdown(md)
  expect(normalized).toMatchInlineSnapshot(`
    "# Markdown Test Session

    ## Conversation

    ### 👤 User

    hello markdown test


    ### 🤖 Assistant (deterministic-provider/deterministic-v2)

    Hello! This is a deterministic markdown test response.


    *Completed in Xs*
    "
  `)
})

test('error handling for non-existent session', async () => {
  const exporter = new ShareMarkdown(client)
  const badSessionID = 'ses_nonexistent_' + Date.now()

  const result = await exporter.generate({ sessionID: badSessionID })
  expect(result).toBeInstanceOf(Error)
  if (!(result instanceof Error)) throw new Error('Expected session error')
  expect(result.message).toContain(`Session ${badSessionID} not found`)
})

test('getCompactSessionContext generates compact format', async () => {
  const contextResult = await getCompactSessionContext({
    client,
    sessionId: sessionID,
    includeSystemPrompt: false,
    maxMessages: 10,
  })

  expect(errore.isOk(contextResult)).toBe(true)
  const context = errore.unwrap(contextResult)

  expect(context).toBeTruthy()
  // User text may be prefixed with branch context injected by opencode
  expect(context).toContain('hello markdown test')
  expect(context).toContain('[User]:')
  expect(context).toContain('[Assistant]:')
  expect(context).toContain('Hello! This is a deterministic markdown test response.')
  expect(context).not.toContain('[System Prompt]')
})

test('generate markdown with lastAssistantOnly', async () => {
  const exporter = new ShareMarkdown(client)

  const markdownResult = await exporter.generate({
    sessionID,
    lastAssistantOnly: true,
  })

  expect(errore.isOk(markdownResult)).toBe(true)
  const markdown = errore.unwrap(markdownResult)

  // lastAssistantOnly should NOT include title header or conversation section header
  expect(markdown).not.toContain('# Markdown Test Session')
  expect(markdown).not.toContain('## Conversation')
  // Should contain the assistant response
  expect(markdown).toContain('Hello! This is a deterministic markdown test response.')
})

test('compact tools: tool calls show one-liner with line count', async () => {
  const exporter = new ShareMarkdown(client)

  const result = await exporter.generate({
    sessionID: toolSessionID,
    compactTools: true,
  })

  expect(errore.isOk(result)).toBe(true)
  const md = errore.unwrap(result)

  // Compact mode: exact one-liner format with params and line count
  expect(md).toContain(
    '> 🛠️ **shell** command=echo hello world, description=Print greeting',
  )
  expect(md).toMatch(/\(\d+ lines?\)/)
  // Should NOT contain full output code blocks or input YAML
  expect(md).not.toContain('**Output:**')
  expect(md).not.toContain('**Input:**')
  expect(md).not.toContain('```yaml')
})

test('verbose tools: tool calls show full input and output', async () => {
  const exporter = new ShareMarkdown(client)

  const result = await exporter.generate({
    sessionID: toolSessionID,
    compactTools: false,
  })

  expect(errore.isOk(result)).toBe(true)
  const md = errore.unwrap(result)

  // Verbose mode: full tool rendering with input YAML and output code block
  expect(md).toContain('#### 🛠️ Tool: shell')
  expect(md).toContain('**Input:**')
  expect(md).toContain('```yaml')
  expect(md).toContain('**Output:**')
  expect(md).toContain('hello world')
})
