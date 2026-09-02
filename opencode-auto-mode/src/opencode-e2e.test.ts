// End-to-end: a real OpenCode server loads this plugin and a fake LLM.
// No real API calls. The deterministic provider plays both the coding model
// and the Haiku-shaped classifier.

import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import { spawn, type ChildProcess, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  buildDeterministicOpencodeConfig,
  type DeterministicMatcher,
} from 'opencode-deterministic-provider'

const USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }

function textParts(delta: string, id: string) {
  return [
    { type: 'stream-start' as const, warnings: [] },
    { type: 'text-start' as const, id },
    { type: 'text-delta' as const, id, delta },
    { type: 'text-end' as const, id },
    { type: 'finish' as const, finishReason: 'stop' as const, usage: USAGE },
  ]
}

function bashCall(command: string, id: string): DeterministicMatcher['then']['parts'] {
  return [
    { type: 'stream-start', warnings: [] },
    {
      type: 'tool-call',
      toolCallId: id,
      toolName: 'bash',
      input: JSON.stringify({ command, description: 'test command' }),
    },
    { type: 'finish', finishReason: 'tool-calls', usage: USAGE },
  ]
}

function createMatchers(): DeterministicMatcher[] {
  return [
    {
      id: 'ls-call',
      priority: 100,
      when: { latestUserTextIncludes: 'AUTO_MODE_LS' },
      then: { parts: bashCall('ls', 'ls-call-1') },
    },
    {
      id: 'chmod-call',
      priority: 100,
      when: { latestUserTextIncludes: 'AUTO_MODE_CHMOD' },
      then: { parts: bashCall('chmod 777 /tmp/auto-mode-e2e-never', 'chmod-call-1') },
    },
    {
      id: 'push-call',
      priority: 100,
      when: { latestUserTextIncludes: 'AUTO_MODE_PUSH' },
      then: { parts: bashCall('git push --force origin AUTO_MODE_PUSH', 'push-call-1') },
    },
    {
      id: 'classifier-push-fast',
      priority: 200,
      when: {
        latestUserTextIncludes: 'STAGE=fast',
        rawPromptIncludes: 'git push --force origin AUTO_MODE_PUSH',
      },
      then: { parts: textParts('1', 'fast-push') },
    },
    {
      id: 'classifier-push-detailed',
      priority: 200,
      when: {
        latestUserTextIncludes: 'STAGE=detailed',
        rawPromptIncludes: 'git push --force origin AUTO_MODE_PUSH',
      },
      then: {
        parts: textParts('{"decision":"block","reason":"force push"}', 'detailed-push'),
      },
    },
    {
      id: 'classifier-fast-allow',
      priority: 150,
      when: { latestUserTextIncludes: 'STAGE=fast' },
      then: { parts: textParts('0', 'fast-allow') },
    },
    {
      id: 'tool-followup',
      priority: 50,
      when: { lastMessageRole: 'tool' },
      then: { parts: textParts('tool-followup-done', 'followup') },
    },
    {
      id: 'default',
      priority: 1,
      then: { parts: textParts('ok', 'default') },
    },
  ]
}

function toolErrorText(state: Record<string, unknown>) {
  const error = state.error
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  if (typeof state.output === 'string') return state.output
  return JSON.stringify(state)
}

function toolParts(messages: Array<{ parts?: Array<Record<string, unknown>> }>) {
  const tools: Array<{ tool?: string; status?: string; error?: string }> = []
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (part.type !== 'tool') continue
      const state = (part.state ?? {}) as Record<string, unknown>
      const status = typeof state.status === 'string' ? state.status : undefined
      if (status !== 'completed' && status !== 'error') continue
      tools.push({
        tool: typeof part.tool === 'string' ? part.tool : undefined,
        status,
        ...(status === 'error' ? { error: toolErrorText(state) } : {}),
      })
    }
  }
  return [...new Map(tools.map((tool) => [JSON.stringify(tool), tool])).values()]
}

async function freePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('no address'))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

async function waitForHealth(port: number) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const ok = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1000),
    })
      .then((response) => response.status < 500)
      .catch(() => false)
    if (ok) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`opencode serve did not become healthy\n${stderrLines.join('\n')}`)
}

let home: string
let projectDir: string
let port: number
let serverProcess: ChildProcess | undefined
const stderrLines: string[] = []
const savedEnv: Record<string, string | undefined> = {}

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'auto-mode-e2e-'))
  projectDir = path.join(home, 'project')
  await mkdir(path.join(projectDir, '.opencode'), { recursive: true })

  const xdg = {
    XDG_CONFIG_HOME: path.join(home, 'xdg-config'),
    XDG_DATA_HOME: path.join(home, 'xdg-data'),
    XDG_CACHE_HOME: path.join(home, 'xdg-cache'),
    XDG_STATE_HOME: path.join(home, 'xdg-state'),
    OPENCODE_CONFIG_DIR: path.join(home, 'opencode-config'),
  }
  for (const [key, value] of Object.entries({
    ...xdg,
    OPENCODE_AUTO_MODE: JSON.stringify({
      model: 'deterministic-provider/deterministic-v2',
    }),
  })) {
    savedEnv[key] = process.env[key]
    process.env[key] = value
  }
  for (const directory of Object.values(xdg)) {
    await mkdir(directory, { recursive: true })
  }

  const providerNpm = pathToFileURL(
    path.resolve(process.cwd(), '..', 'opencode-deterministic-provider', 'src', 'index.ts'),
  ).href
  const pluginEntry = pathToFileURL(path.join(import.meta.dirname, 'index.ts')).href
  const deterministic = buildDeterministicOpencodeConfig({
    providerName: 'deterministic-provider',
    providerNpm,
    model: 'deterministic-v2',
    smallModel: 'deterministic-v2',
    settings: { strict: false, matchers: createMatchers() },
  })

  await writeFile(
    path.join(projectDir, 'opencode.json'),
    JSON.stringify(
      {
        ...deterministic,
        plugin: [pluginEntry],
        lsp: false,
        formatter: false,
        permission: {
          bash: 'allow',
          edit: 'allow',
        },
      },
      null,
      2,
    ),
  )

  port = await freePort()
  const opencode = execFileSync('which', ['opencode'], { encoding: 'utf8' }).trim()
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...xdg,
    OPENCODE_AUTO_MODE: JSON.stringify({
      model: 'deterministic-provider/deterministic-v2',
    }),
  }
  delete env.KIMAKI
  serverProcess = spawn(opencode, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
    cwd: projectDir,
    stdio: 'pipe',
    env,
  })
  serverProcess.stderr?.on('data', (chunk) => {
    stderrLines.push(...String(chunk).split('\n').filter(Boolean))
  })
  serverProcess.stdout?.on('data', (chunk) => {
    stderrLines.push(...String(chunk).split('\n').filter(Boolean))
  })
  await waitForHealth(port)
}, 120_000)

afterAll(async () => {
  serverProcess?.kill('SIGTERM')
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (home) await rm(home, { recursive: true, force: true })
})

async function runPrompt(text: string) {
  const client = createOpencodeClient({
    baseUrl: `http://127.0.0.1:${port}`,
    directory: projectDir,
  })
  const created = await client.session.create({
    directory: projectDir,
    title: text,
  })
  const sessionID = created.data?.id
  if (!sessionID) {
    throw new Error(`session.create failed: ${JSON.stringify(created)}\n${stderrLines.join('\n')}`)
  }
  await client.session.promptAsync({
    sessionID,
    directory: projectDir,
    model: { providerID: 'deterministic-provider', modelID: 'deterministic-v2' },
    parts: [{ type: 'text', text }],
  })
  const pollStart = Date.now()
  while (Date.now() - pollStart < 20_000) {
    const messages = await client.session.messages({
      sessionID,
      directory: projectDir,
    })
    const tools = toolParts(messages.data ?? [])
    if (tools.some((tool) => tool.status === 'completed' || tool.status === 'error')) {
      return tools
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const messages = await client.session.messages({
    sessionID,
    directory: projectDir,
  })
  return toolParts(messages.data ?? [])
}

describe('opencode auto-mode e2e', () => {
  test('skips read-only bash without blocking', async () => {
    const tools = await runPrompt('AUTO_MODE_LS')
    expect(tools).toMatchInlineSnapshot(`
      [
        {
          "status": "completed",
          "tool": "bash",
        },
      ]
    `)
    const ls = tools.find((tool) => tool.tool === 'bash')
    expect(ls?.status).toBe('completed')
  }, 30_000)

  test('hard-denies chmod 777 before the classifier', async () => {
    const tools = await runPrompt('AUTO_MODE_CHMOD')
    expect(tools).toMatchInlineSnapshot(`
      [
        {
          "error": "[auto-mode] chmod 777",
          "status": "error",
          "tool": "bash",
        },
      ]
    `)
    const chmod = tools.find((tool) => tool.tool === 'bash')
    expect(chmod?.status).toBe('error')
    expect(chmod?.error ?? '').toContain('[auto-mode]')
  }, 30_000)

  test('classifier blocks git push --force', async () => {
    const tools = await runPrompt('AUTO_MODE_PUSH')
    expect(tools).toMatchInlineSnapshot(`
      [
        {
          "error": "[auto-mode] force push",
          "status": "error",
          "tool": "bash",
        },
      ]
    `)
    const push = tools.find((tool) => tool.tool === 'bash')
    expect(push?.status).toBe('error')
    expect(push?.error ?? '').toContain('force push')
  }, 30_000)
})
