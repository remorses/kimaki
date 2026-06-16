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
import { ShareMarkdown, getCompactSessionContext } from './markdown.js'
import { setDataDir } from './config.js'
import { initializeOpencodeForDirectory, getOpencodeClient, stopOpencodeServer } from './opencode.js'
import { cleanupTestSessions, initTestGitRepo } from './test-utils.js'

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

  return [helloMatcher, defaultMatcher]
}

let client: OpencodeClient
let directories: ReturnType<typeof createRunDirectories>
let testStartTime: number
let sessionID: string

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
}, 20_000)

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
  expect(markdown).toContain('### 🤖 Assistant')
  expect(markdown).toContain('Hello! This is a deterministic markdown test response.')
  expect(markdown).toContain('**Started using deterministic-provider/deterministic-v2**')

  const normalized = normalizeMarkdown(markdown)
  expect(normalized).toMatchInlineSnapshot(`
    "# Markdown Test Session

    ## Session Information

    - **Created**: <date>
    - **Updated**: <date>
    - **OpenCode Version**: v<version>

    ## Conversation

    ### 👤 User

    hello markdown test


    ### 🤖 Assistant (deterministic-v2)

    **Started using deterministic-provider/deterministic-v2**

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
  const md = errore.unwrap(markdown as string)
  expect(md).toContain('# Markdown Test Session')
  expect(md).not.toContain('## Session Information')
  expect(md).toContain('## Conversation')

  const normalized = normalizeMarkdown(md)
  expect(normalized).toMatchInlineSnapshot(`
    "# Markdown Test Session

    ## Conversation

    ### 👤 User

    hello markdown test


    ### 🤖 Assistant (deterministic-v2)

    **Started using deterministic-provider/deterministic-v2**

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
