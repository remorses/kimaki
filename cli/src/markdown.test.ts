// Deterministic markdown export tests.
// Uses the shared opencode server manager with the deterministic provider,
// creates sessions with known content, and validates markdown output.
// No dependency on machine-local session state.

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { test, expect, beforeAll, afterAll } from 'vitest'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import * as errore from 'errore'
import {
  buildDeterministicOpencodeConfig,
  type DeterministicMatcher,
} from 'opencode-deterministic-provider'
import {
  ShareMarkdown,
  fileBaseName,
  formatCompactToolSummary,
  formatDuration,
  getCompactSessionContext,
  truncateChars,
  userPromptDurationMs,
} from './markdown.js'
import { setDataDir } from './config.js'
import { initializeOpencodeForDirectory, getOpencodeClient, stopOpencodeServer } from './opencode.js'
import { cleanupTestSessions, initTestGitRepo } from './test-utils.js'

test('truncateChars keeps short text and ellipsizes long text', () => {
  expect(truncateChars('hello world', 80)).toBe('hello world')
  expect(truncateChars('  a   b  ', 80)).toBe('a b')
  expect(truncateChars('abcdefghij', 5)).toBe('abcd…')
  expect(truncateChars('ab', 1)).toBe('…')
})

test('formatDuration uses ms, seconds, then minutes', () => {
  expect(formatDuration(250)).toBe('250ms')
  expect(formatDuration(1500)).toBe('1.5s')
  expect(formatDuration(65_000)).toBe('1m 5s')
})

test('userPromptDurationMs spans user send to last following assistant', () => {
  const messages = [
    { info: { role: 'user', time: { created: 1000 } } },
    { info: { role: 'assistant', time: { created: 1100, completed: 4000 } } },
    { info: { role: 'assistant', time: { created: 4100, completed: 9000 } } },
    { info: { role: 'user', time: { created: 20_000 } } },
    { info: { role: 'assistant', time: { created: 20_100, completed: 21_000 } } },
  ]
  expect(userPromptDurationMs({ messages, userIndex: 0 })).toBe(8000)
  expect(userPromptDurationMs({ messages, userIndex: 3 })).toBe(1000)
})

test('fileBaseName strips directories on posix and windows paths', () => {
  expect(fileBaseName('/Users/morse/README.md')).toBe('README.md')
  expect(fileBaseName('src\\cli.ts')).toBe('cli.ts')
})

test('formatCompactToolSummary indexes read, task, and bash inputs', () => {
  expect(formatCompactToolSummary({
    tool: 'read',
    input: { filePath: '/Users/morse/Documents/GitHub/kimakivoice/README.md', offset: 1 },
  })).toBe('README.md')

  expect(formatCompactToolSummary({
    tool: 'task',
    input: { description: 'analyze gpuix-solid', task_id: 'ses_child123' },
  })).toBe('analyze gpuix-solid ses_child123')

  expect(formatCompactToolSummary({
    tool: 'task',
    input: { description: 'analyze gpuix-solid' },
    metadata: { sessionId: 'ses_from_meta' },
  })).toBe('analyze gpuix-solid ses_from_meta')

  expect(formatCompactToolSummary({
    tool: 'bash',
    input: { command: 'echo hello world', description: 'Print greeting' },
  })).toBe('echo hello world')

  expect(formatCompactToolSummary({
    tool: 'bash',
    input: {
      command: 'a'.repeat(120),
      description: 'Rebuild native addon',
    },
    maxChars: 80,
  })).toBe('Rebuild native addon')

  expect(formatCompactToolSummary({
    tool: 'grep',
    input: { pattern: 'ShareMarkdown', path: 'cli/src/markdown.ts' },
    maxChars: 40,
  })).toBe('pattern=ShareMarkdown path=cli/src/mark…')
})

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
    when: { latestUserTextIncludes: 'hello markdown test' },
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
    when: { latestUserTextIncludes: 'use a tool please' },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: 'tc1', toolName: 'bash', input: JSON.stringify({ command: 'echo hello world', description: 'Print greeting' }) },
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
  setDataDir(directories.dataDir)

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
      matchers: createMatchers(),
    },
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
    directory: directories.projectDirectory,
    title: 'Markdown Test Session',
  })
  sessionID = createResult.data!.id

  // Send prompt and wait for completion (promptAsync returns immediately)
  await client.session.promptAsync({
    sessionID,
    directory: directories.projectDirectory,
    model: {
      providerID: 'deterministic-provider',
      modelID: 'deterministic-v2',
    },
    parts: [{ type: 'text', text: 'hello markdown test' }],
  })

  // Wait for assistant text parts to be fully written (not just message existence).
  // The deterministic provider responds instantly but opencode writes parts
  // asynchronously, so we must poll until non-empty text content appears.
  // Under parallel test load the server is slower, so use generous timeouts.
  const maxWait = 15_000
  const pollStart = Date.now()
  while (Date.now() - pollStart < maxWait) {
    const msgs = await client.session.messages({
      sessionID,
      directory: directories.projectDirectory,
    })
    const assistantMsg = msgs.data?.find((m) => m.info.role === 'assistant')
    const hasTextParts = assistantMsg?.parts?.some((p) => {
      return p.type === 'text' && p.text && !p.synthetic
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
    directory: directories.projectDirectory,
    title: 'Tool Call Session',
  })
  toolSessionID = toolCreateResult.data!.id

  await client.session.promptAsync({
    sessionID: toolSessionID,
    directory: directories.projectDirectory,
    model: {
      providerID: 'deterministic-provider',
      modelID: 'deterministic-v2',
    },
    parts: [{ type: 'text', text: 'use a tool please' }],
  })

  // Wait for tool execution to complete
  const toolMaxWait = 15_000
  const toolPollStart = Date.now()
  while (Date.now() - toolPollStart < toolMaxWait) {
    const msgs = await client.session.messages({
      sessionID: toolSessionID,
      directory: directories.projectDirectory,
    })
    const messages = msgs.data || []
    const hasToolPart = messages.some((m) =>
      m.parts.some((p) => p.type === 'tool' && p.state?.status === 'completed'),
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
  if (directories) {
    fs.rmSync(directories.dataDir, { recursive: true, force: true })
  }
}, 5_000)

// Strip dynamic parts (timestamps, durations, branch names) for stable assertions
function normalizeMarkdown(md: string): string {
  return md
    .replace(/^duration: .+$/gm, 'duration: <duration>')
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
  expect(markdown).toContain('### user')
  expect(markdown).toContain('hello markdown test')
  expect(markdown).toContain(
    '### assistant (deterministic-provider/deterministic-v2)',
  )
  expect(markdown).toContain('Hello! This is a deterministic markdown test response.')
  expect(markdown).not.toContain('Started using')
  expect(markdown).not.toContain('Completed in')
  expect(markdown).toMatch(/^duration: /m)

  const normalized = normalizeMarkdown(markdown)
  expect(normalized).toMatchInlineSnapshot(`
    "# Markdown Test Session

    ## Session Information

    - **Created**: <date>
    - **Updated**: <date>
    - **OpenCode Version**: v<version>

    ## Conversation

    ### user

    hello markdown test


    ### assistant (deterministic-provider/deterministic-v2)

    Hello! This is a deterministic markdown test response.


    duration: <duration>
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
  const md = errore.unwrap(markdown as string)
  expect(md).toContain('# Markdown Test Session')
  expect(md).not.toContain('## Session Information')
  expect(md).toContain('## Conversation')

  const normalized = normalizeMarkdown(md)
  expect(normalized).toMatchInlineSnapshot(`
    "# Markdown Test Session

    ## Conversation

    ### user

    hello markdown test


    ### assistant (deterministic-provider/deterministic-v2)

    Hello! This is a deterministic markdown test response.


    duration: <duration>
    "
  `)
})

test('error handling for non-existent session', async () => {
  const exporter = new ShareMarkdown(client)
  const badSessionID = 'ses_nonexistent_' + Date.now()

  const result = await exporter.generate({ sessionID: badSessionID })
  expect(result).toBeInstanceOf(Error)
  expect((result as Error).message).toContain(`Session ${badSessionID} not found`)
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

test('thinking is omitted unless includeThinking is set', async () => {
  const exporter = new ShareMarkdown(client)
  const hidden = await exporter.generate({
    sessionID,
    includeThinking: false,
  })
  expect(errore.isOk(hidden)).toBe(true)
  expect(errore.unwrap(hidden)).not.toContain('thinking:')

  const shown = await exporter.generate({
    sessionID,
    includeThinking: true,
  })
  expect(errore.isOk(shown)).toBe(true)
  expect(errore.unwrap(shown)).not.toContain('💭')
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
  expect(md).toContain('tool: bash echo hello world')
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
  expect(md).toContain('#### tool: bash')
  expect(md).toContain('**Input:**')
  expect(md).toContain('```yaml')
  expect(md).toContain('**Output:**')
  expect(md).toContain('hello world')
})
