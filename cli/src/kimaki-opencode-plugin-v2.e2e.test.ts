// E2e: OpenCode v2 loads the Kimaki IPC plugin directory and registers
// kimaki_sleep. A deterministic matcher calls the tool; Unknown tool means
// the plugin did not load.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'

import type { V2Event } from '@opencode/client'
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

const pluginDirectory = path.join(import.meta.dirname, '../dist/kimaki-opencode-plugin')

function buildMatchers(): DeterministicMatcher[] {
  const sleepMatcher: DeterministicMatcher = {
    id: 'v2-kimaki-sleep',
    priority: 20,
    when: {
      lastMessageRole: 'user',
      latestUserTextIncludes: 'sleep-marker',
    },
    then: {
      parts: [
        { type: 'stream-start', warnings: [] },
        {
          type: 'tool-call',
          toolCallId: 'det-sleep-call-1',
          toolName: 'kimaki_sleep',
          input: JSON.stringify({
            until: '2030-01-01T09:00:00Z',
            reason: 'plugin load probe',
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
  const invalidTools = [
    {
      id: 'invalid-max-files',
      toolName: 'kimaki_file_upload',
      input: { prompt: 'Upload', maxFiles: 11 },
    },
    {
      id: 'invalid-fractional-max-files',
      toolName: 'kimaki_file_upload',
      input: { prompt: 'Upload', maxFiles: 1.5 },
    },
    {
      id: 'invalid-button-count',
      toolName: 'kimaki_action_buttons',
      input: { buttons: [] },
    },
    {
      id: 'invalid-maximum-button-count',
      toolName: 'kimaki_action_buttons',
      input: {
        buttons: ['One', 'Two', 'Three', 'Four'].map((label) => ({ label })),
      },
    },
    {
      id: 'invalid-button-label',
      toolName: 'kimaki_action_buttons',
      input: { buttons: [{ label: '' }] },
    },
    {
      id: 'invalid-button-color',
      toolName: 'kimaki_action_buttons',
      input: { buttons: [{ label: 'Continue', color: 'purple' }] },
    },
  ] as const
  return [
    sleepMatcher,
    ...invalidTools.map(
      (item): DeterministicMatcher => ({
        id: item.id,
        priority: 20,
        when: {
          lastMessageRole: 'user',
          latestUserTextIncludes: item.id,
        },
        then: {
          parts: [
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: `call-${item.id}`,
              toolName: item.toolName,
              input: JSON.stringify(item.input),
            },
            {
              type: 'finish',
              finishReason: 'tool-calls',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          ],
        },
      }),
    ),
  ]
}

let server: Opencode2Server
let client: OpenCodeClient
let tempDir: string
const events: V2Event[] = []
const stderrLines: string[] = []
const subscribeController = new AbortController()
const createdSessionIds: string[] = []

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
      .join(', ')}\nstderr:\n${stderrLines.slice(-40).join('\n')}`,
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
  expect(fs.existsSync(path.join(pluginDirectory, 'index.js'))).toBe(true)
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-opencode2-plugin-')))
  execFileSync('git', ['init', '-q'], { cwd: tempDir })

  const config = {
    ...buildDeterministicOpencode2Config({
      model: 'deterministic-v2',
      settings: {
        strict: false,
        matchers: buildMatchers(),
      },
      permissions: [{ action: 'kimaki_sleep', resource: '*', effect: 'allow' }],
    }),
    plugins: [pluginDirectory],
  }
  fs.writeFileSync(path.join(tempDir, 'opencode.json'), JSON.stringify(config, null, 2))

  const started = await startOpencode2Server()
  if (started instanceof Error) {
    throw started
  }
  server = started
  server.process.stderr?.on('data', (chunk) => {
    stderrLines.push(...chunk.toString().split('\n').filter(Boolean))
  })
  client = createOpencode2Client({
    baseUrl: server.baseUrl,
    password: server.password,
    directory: tempDir,
  })

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

  await client.plugin.awaitActivation({
    location: { directory: tempDir },
  })
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

test('v2 plugin directory is active', async () => {
  const listed = await client.plugin.list({
    location: { directory: tempDir },
  })
  const kimaki = listed.data.find((plugin) => plugin.id === 'kimaki')
  expect(kimaki).toMatchObject({
    id: 'kimaki',
    state: { status: 'active' },
  })
})

test('kimaki_sleep is a real tool, not Unknown tool', async () => {
  const session = await client.session.create({
    title: 'kimaki sleep plugin load',
    location: { directory: tempDir },
  })
  createdSessionIds.push(session.id)

  await client.session.prompt({
    sessionID: session.id,
    text: 'Sleep now sleep-marker',
  })

  await waitFor(() => executionEnded(session.id), {
    label: `sleep tool execution end for ${session.id}`,
  })

  const toolFailed = events.find((event) => {
    return event.type === 'session.tool.failed' && event.data.sessionID === session.id
  })
  if (toolFailed && toolFailed.type === 'session.tool.failed') {
    expect(toolFailed.data.error.message).not.toContain('Unknown tool')
  }

  const toolSuccess = events.find((event) => {
    return event.type === 'session.tool.success' && event.data.sessionID === session.id
  })
  if (!toolSuccess || toolSuccess.type !== 'session.tool.success') {
    throw new Error(`missing session.tool.success. stderr:\n${stderrLines.slice(-40).join('\n')}`)
  }
  const textContent = toolSuccess.data.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
  expect(textContent).toContain('sleep is only available in the main session')
}, 30_000)

test.each([
  'invalid-max-files',
  'invalid-fractional-max-files',
  'invalid-button-count',
  'invalid-maximum-button-count',
  'invalid-button-label',
  'invalid-button-color',
])('rejects invalid tool input: %s', async (marker) => {
  const session = await client.session.create({
    title: marker,
    location: { directory: tempDir },
  })
  createdSessionIds.push(session.id)
  await client.session.prompt({ sessionID: session.id, text: marker })
  await waitFor(() => executionEnded(session.id), {
    label: `invalid tool execution end for ${session.id}`,
  })
  const failure = events.find((event) => {
    return event.type === 'session.tool.failed' && event.data.sessionID === session.id
  })
  expect(failure?.type).toBe('session.tool.failed')
  if (failure?.type === 'session.tool.failed') {
    expect(failure.data.error.message).not.toContain('Unknown tool')
  }
})
