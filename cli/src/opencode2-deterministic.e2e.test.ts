// E2E test proving opencode2 (OpenCode v2) can load opencode-deterministic-provider
// via a project opencode.json using the `aisdk:file://` package route, stream a
// deterministic text turn (session.text.* + session.execution.succeeded), and run
// a deterministic tool turn (session.tool.called/success on the v2 `shell` tool).

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { V2Event } from '@opencode-ai/client'
import {
  buildDeterministicOpencode2Config,
  type DeterministicMatcher,
} from 'opencode-deterministic-provider'

import {
  createOpencode2Client,
  startOpencode2Server,
  type Opencode2Server,
  type OpenCodeClient,
} from './opencode2.js'

const TEXT_REPLY = 'deterministic reply text'

function buildMatchers(): DeterministicMatcher[] {
  const textMatcher: DeterministicMatcher = {
    id: 'v2-text-turn',
    priority: 10,
    when: {
      lastMessageRole: 'user',
      latestUserTextIncludes: 'hello-marker',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'v2-text' },
        { type: 'text-delta', id: 'v2-text', delta: 'deterministic reply ' },
        { type: 'text-delta', id: 'v2-text', delta: 'text' },
        { type: 'text-end', id: 'v2-text' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
    },
  }
  // v2 renamed the bash tool to `shell` (opencode-v2/packages/core/src/tool/
  // plugin/shell.ts: name = "shell"; input = { command, workdir?, timeout?,
  // background? }). Kimaki's v1 description/hasSideEffect fields do not exist.
  const toolMatcher: DeterministicMatcher = {
    id: 'v2-tool-turn',
    priority: 20,
    when: {
      lastMessageRole: 'user',
      latestUserTextIncludes: 'tool-marker',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        {
          type: 'tool-call',
          toolCallId: 'det-shell-call-1',
          toolName: 'shell',
          input: JSON.stringify({ command: 'echo det-tool-ok' }),
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ],
    },
  }
  return [textMatcher, toolMatcher]
}

let server: Opencode2Server
let client: OpenCodeClient
let tempDir: string
const events: V2Event[] = []
const subscribeController = new AbortController()
const createdSessionIds: string[] = []

function eventSessionId(event: V2Event): string | undefined {
  const data: unknown = event.data
  if (typeof data !== 'object' || data === null || !('sessionID' in data)) {
    return undefined
  }
  return typeof data.sessionID === 'string' ? data.sessionID : undefined
}

// Snapshot helper: session.* types only, minus ephemeral chrome
// (session.status / session.idle can trail execution.succeeded by a tick),
// with consecutive duplicates collapsed (delta/progress chunk counts are
// timing-dependent: the server can coalesce back-to-back deltas).
function sessionEventTypes(sessionId: string): string[] {
  const types = events
    .filter((event) => eventSessionId(event) === sessionId)
    .map((event) => event.type)
    .filter((type) => {
      return (
        type.startsWith('session.') &&
        type !== 'session.status' &&
        type !== 'session.idle'
      )
    })
  return types.filter((type, index) => type !== types[index - 1])
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 15_000, label = 'condition' }: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${label}. Collected event types: ${events
      .map((event) => event.type)
      .join(', ')}`,
  )
}

function executionEnded(sessionId: string): boolean {
  return events.some((event) => {
    return (
      (event.type === 'session.execution.succeeded' ||
        event.type === 'session.execution.failed' ||
        event.type === 'session.execution.interrupted') &&
      event.data.sessionID === sessionId
    )
  })
}

beforeAll(async () => {
  // realpath: macOS mkdtemp returns /var/... but the server resolves /private/var/...
  tempDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-opencode2-det-')),
  )
  execFileSync('git', ['init', '-q'], { cwd: tempDir })

  const config = buildDeterministicOpencode2Config({
    model: 'deterministic-v2',
    settings: {
      strict: false,
      matchers: buildMatchers(),
    },
    // v2 ordered permission rules (last match wins); allow the shell tool so
    // the echo command runs without a permission.asked round-trip.
    permissions: [{ action: 'shell', resource: '*', effect: 'allow' }],
  })
  fs.writeFileSync(
    path.join(tempDir, 'opencode.json'),
    JSON.stringify(config, null, 2),
  )

  const started = await startOpencode2Server()
  if (started instanceof Error) {
    throw started
  }
  server = started
  client = createOpencode2Client({
    baseUrl: server.baseUrl,
    password: server.password,
    directory: tempDir,
  })

  // Subscribe BEFORE any prompt. SSE is volatile: missed events are gone.
  void (async () => {
    const subscription = client.event.subscribe({
      signal: subscribeController.signal,
    })
    try {
      for await (const event of subscription) {
        events.push(event)
      }
    } catch {
      // aborted during teardown
    }
  })()
}, 120_000)

afterAll(async () => {
  for (const sessionId of createdSessionIds) {
    await client.session.remove({ sessionID: sessionId }).catch(() => undefined)
  }
  subscribeController.abort()
  server?.close()
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('text turn streams deltas and succeeds with full text on ended', async () => {
  const session = await client.session.create({
    title: 'deterministic text turn',
    location: { directory: tempDir },
  })
  createdSessionIds.push(session.id)

  await client.session.prompt({
    sessionID: session.id,
    text: 'Reply please hello-marker',
  })

  await waitFor(() => executionEnded(session.id), {
    label: `execution end for ${session.id}`,
  })

  const types = sessionEventTypes(session.id)
  expect(types).toMatchInlineSnapshot(`
    [
      "session.created",
      "session.inbox.enqueued",
      "session.execution.started",
      "session.instructions.updated",
      "session.inbox.delivered",
      "session.step.started",
      "session.text.started",
      "session.text.delta",
      "session.text.ended",
      "session.step.streamed",
      "session.step.ended",
      "session.usage.updated",
      "session.execution.succeeded",
    ]
  `)

  // Causal order: admit -> drain wakes -> delivery inside the drain ->
  // durable text -> success. Note: execution.started precedes inbox.delivered
  // (the delivered projection inserts the user message inside the drain).
  const orderedTypes = [
    'session.inbox.enqueued',
    'session.execution.started',
    'session.inbox.delivered',
    'session.text.ended',
    'session.execution.succeeded',
  ]
  const indexes = orderedTypes.map((type) => types.indexOf(type))
  expect(indexes.every((index) => index >= 0)).toBe(true)
  expect([...indexes].sort((a, b) => a - b)).toEqual(indexes)

  const textEnded = events.find((event) => {
    return (
      event.type === 'session.text.ended' && event.data.sessionID === session.id
    )
  })
  if (!textEnded || textEnded.type !== 'session.text.ended') {
    throw new Error('missing session.text.ended event')
  }
  expect(textEnded.data.text).toBe(TEXT_REPLY)
}, 30_000)

test('tool turn emits session.tool.called and session.tool.success', async () => {
  const session = await client.session.create({
    title: 'deterministic tool turn',
    location: { directory: tempDir },
  })
  createdSessionIds.push(session.id)

  await client.session.prompt({
    sessionID: session.id,
    text: 'Run the shell tool now tool-marker',
  })

  // Fallback if a permission still gets asked despite the config allow rule:
  // reply once using ask data.id as requestID.
  const repliedPermissionIds = new Set<string>()
  await waitFor(
    async () => {
      for (const event of events) {
        if (
          event.type === 'permission.asked' &&
          event.data.sessionID === session.id &&
          !repliedPermissionIds.has(event.data.id)
        ) {
          repliedPermissionIds.add(event.data.id)
          await client.permission.reply({
            sessionID: session.id,
            requestID: event.data.id,
            reply: 'once',
          })
        }
      }
      return executionEnded(session.id)
    },
    { label: `tool execution end for ${session.id}` },
  )

  const types = sessionEventTypes(session.id)
  expect(types).toMatchInlineSnapshot(`
    [
      "session.created",
      "session.inbox.enqueued",
      "session.execution.started",
      "session.instructions.updated",
      "session.inbox.delivered",
      "session.step.started",
      "session.tool.input.started",
      "session.tool.input.ended",
      "session.tool.called",
      "session.step.streamed",
      "session.tool.progress",
      "session.tool.success",
      "session.step.ended",
      "session.usage.updated",
      "session.step.started",
      "session.text.started",
      "session.text.delta",
      "session.text.ended",
      "session.step.streamed",
      "session.step.ended",
      "session.usage.updated",
      "session.execution.succeeded",
    ]
  `)

  expect(types).toContain('session.tool.called')
  expect(types).toContain('session.tool.success')
  expect(types).toContain('session.execution.succeeded')
  expect(types).not.toContain('session.execution.failed')

  const toolSuccess = events.find((event) => {
    return (
      event.type === 'session.tool.success' &&
      event.data.sessionID === session.id
    )
  })
  if (!toolSuccess || toolSuccess.type !== 'session.tool.success') {
    throw new Error('missing session.tool.success event')
  }
  const textContent = toolSuccess.data.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
  expect(textContent).toContain('det-tool-ok')
}, 30_000)
