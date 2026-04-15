// E2e test verifying that the opencode server populates the `finish` field
// on assistant messages. This field is critical for kimaki's footer logic:
// isAssistantMessageNaturalCompletion checks `message.finish !== 'tool-calls'`
// to suppress footers on intermediate tool-call steps.
// When `finish` is missing/null, every completed assistant message gets a
// spurious footer, breaking multi-step tool chains (16 test failures).
//
// Direct SDK test — no Discord layer needed since this is a server-level bug.

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { test, expect, beforeAll, afterAll } from 'vitest'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import {
  buildDeterministicOpencodeConfig,
  type DeterministicMatcher,
} from 'opencode-deterministic-provider'
import { setDataDir } from './config.js'
import { initializeOpencodeForDirectory, stopOpencodeServer } from './opencode.js'
import { cleanupTestSessions, initTestGitRepo } from './test-utils.js'

const ROOT = path.resolve(process.cwd(), 'tmp', 'finish-field-e2e')

function createRunDirectories() {
  fs.mkdirSync(ROOT, { recursive: true })
  const dataDir = fs.mkdtempSync(path.join(ROOT, 'data-'))
  const projectDirectory = path.join(ROOT, 'project')
  fs.mkdirSync(projectDirectory, { recursive: true })
  initTestGitRepo(projectDirectory)
  return { dataDir, projectDirectory }
}

function createMatchers(): DeterministicMatcher[] {
  // Tool-call step: finish="tool-calls"
  const toolCallMatcher: DeterministicMatcher = {
    id: 'finish-tool-call',
    priority: 20,
    when: {
      lastMessageRole: 'user',
      latestUserTextIncludes: 'FINISH_FIELD_TOOLCALL',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'ft' },
        { type: 'text-delta', id: 'ft', delta: 'calling tool' },
        { type: 'text-end', id: 'ft' },
        {
          type: 'tool-call',
          toolCallId: 'finish-bash',
          toolName: 'bash',
          input: JSON.stringify({ command: 'echo ok', description: 'test' }),
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
    },
  }

  // Follow-up after tool result: finish="stop"
  const followupMatcher: DeterministicMatcher = {
    id: 'finish-followup',
    priority: 21,
    when: {
      lastMessageRole: 'tool',
      latestUserTextIncludes: 'FINISH_FIELD_TOOLCALL',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'ff' },
        { type: 'text-delta', id: 'ff', delta: 'tool done' },
        { type: 'text-end', id: 'ff' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
    },
  }

  return [toolCallMatcher, followupMatcher]
}

let client: OpencodeClient
let directories: ReturnType<typeof createRunDirectories>
let testStartTime: number

beforeAll(async () => {
  testStartTime = Date.now()
  directories = createRunDirectories()
  setDataDir(directories.dataDir)

  const providerNpm = url
    .pathToFileURL(
      path.resolve(process.cwd(), '..', 'opencode-deterministic-provider', 'src', 'index.ts'),
    )
    .toString()

  const opencodeConfig = buildDeterministicOpencodeConfig({
    providerName: 'deterministic-provider',
    providerNpm,
    model: 'deterministic-v2',
    smallModel: 'deterministic-v2',
    settings: { strict: false, matchers: createMatchers() },
  })
  fs.writeFileSync(
    path.join(directories.projectDirectory, 'opencode.json'),
    JSON.stringify(opencodeConfig, null, 2),
  )

  const getClient = await initializeOpencodeForDirectory(directories.projectDirectory)
  if (getClient instanceof Error) {
    throw getClient
  }
  client = getClient()
}, 20_000)

afterAll(async () => {
  await cleanupTestSessions({
    projectDirectory: directories.projectDirectory,
    testStartTime,
  })
  await stopOpencodeServer()
}, 5_000)

test('tool-call step has finish="tool-calls", follow-up has finish="stop"', async () => {
  const session = await client.session.create({
    directory: directories.projectDirectory,
    title: 'finish-field-test',
  })
  const sessionID = session.data!.id

  await client.session.promptAsync({
    sessionID,
    directory: directories.projectDirectory,
    parts: [{ type: 'text', text: 'FINISH_FIELD_TOOLCALL' }],
  })

  // Poll until we have 2 completed assistant messages (tool-call + follow-up)
  const maxWait = 8_000
  const pollStart = Date.now()
  let completedAssistants: Array<{ finish: string | null; partTypes: string[] }> = []

  while (Date.now() - pollStart < maxWait) {
    const msgs = await client.session.messages({
      sessionID,
      directory: directories.projectDirectory,
    })
    completedAssistants = (msgs.data || [])
      .filter((m) => {
        return m.info.role === 'assistant' && m.info.time.completed
      })
      .map((m) => {
        return {
          finish: (m.info as Record<string, unknown>).finish as string | null ?? null,
          partTypes: m.parts.map((p) => { return p.type }),
        }
      })
    if (completedAssistants.length >= 2) {
      break
    }
    await new Promise((resolve) => { setTimeout(resolve, 100) })
  }

  // Snapshot completed assistant messages — finish should NOT be null
  expect(completedAssistants).toMatchInlineSnapshot(`
    [
      {
        "finish": "tool-calls",
        "partTypes": [
          "step-start",
          "text",
          "step-finish",
        ],
      },
      {
        "finish": "stop",
        "partTypes": [
          "step-start",
          "text",
          "step-finish",
        ],
      },
    ]
  `)

  const finishes = completedAssistants.map((m) => { return m.finish })
  expect(finishes).toEqual(['tool-calls', 'stop'])
}, 5_000)
