// End-to-end: a real local OpenCode v2 server loads this plugin and a fake LLM.

import { OpenCode, type SessionMessageInfo } from '@opencode/client'
import { spawn, type ChildProcess } from 'node:child_process'
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
const SERVER_PASSWORD = 'auto-mode-e2e'
const AUTHORIZATION = `Basic ${Buffer.from(`opencode:${SERVER_PASSWORD}`).toString('base64')}`

function textParts(delta: string, id: string) {
  return [
    { type: 'stream-start' as const, warnings: [] },
    { type: 'text-start' as const, id },
    { type: 'text-delta' as const, id, delta },
    { type: 'text-end' as const, id },
    { type: 'finish' as const, finishReason: 'stop' as const, usage: USAGE },
  ]
}

function shellCall(command: string, id: string): DeterministicMatcher['then']['parts'] {
  return [
    { type: 'stream-start', warnings: [] },
    {
      type: 'tool-call',
      toolCallId: id,
      toolName: 'shell',
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
      then: { parts: shellCall('ls', 'ls-call-1') },
    },
    {
      id: 'chmod-call',
      priority: 100,
      when: { latestUserTextIncludes: 'AUTO_MODE_CHMOD' },
      then: { parts: shellCall('chmod 777 /tmp/auto-mode-e2e-never', 'chmod-call-1') },
    },
    {
      id: 'push-call',
      priority: 100,
      when: { latestUserTextIncludes: 'AUTO_MODE_PUSH' },
      then: { parts: shellCall('git push --force origin AUTO_MODE_PUSH', 'push-call-1') },
    },
    {
      id: 'classifier-push-fast',
      priority: 200,
      when: {
        rawPromptIncludes: '\\nSTAGE=fast\\n',
      },
      then: { parts: textParts('1', 'fast-push') },
    },
    {
      id: 'classifier-push-detailed',
      priority: 200,
      when: {
        rawPromptIncludes: '\\nSTAGE=detailed\\n',
      },
      then: {
        parts: textParts('{"decision":"block","reason":"force push"}', 'detailed-push'),
      },
    },
    {
      id: 'tool-followup',
      priority: 50,
      when: {
        lastMessageRole: 'tool',
        latestUserTextIncludes: 'AUTO_MODE_LS',
      },
      then: { parts: textParts('tool-followup-done', 'followup') },
    },
  ]
}

function toolParts(messages: SessionMessageInfo[]) {
  const tools: Array<{ tool?: string; status?: string; error?: string }> = []
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    for (const part of message.content) {
      if (part.type !== 'tool') continue
      const state = part.state
      const status = state.status
      if (status !== 'completed' && status !== 'error') continue
      if (state.status === 'error') {
        tools.push({ tool: part.name, status, error: state.error.message })
        continue
      }
      tools.push({ tool: part.name, status })
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
      headers: { authorization: AUTHORIZATION },
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
    OPENCODE_AUTO_MODE: JSON.stringify({ model: 'main' }),
    OPENCODE_PASSWORD: SERVER_PASSWORD,
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
  const pluginEntry = import.meta.dirname
  const deterministic = buildDeterministicOpencodeConfig({
    providerName: 'deterministic-provider',
    providerNpm,
    model: 'deterministic-v2',
    smallModel: 'deterministic-v2',
    settings: { strict: true, matchers: createMatchers() },
  })

  await writeFile(
    path.join(projectDir, 'opencode.json'),
    JSON.stringify(
      {
        ...deterministic,
        plugins: [pluginEntry],
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
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      ...xdg,
      OPENCODE_AUTO_MODE: JSON.stringify({ model: 'main' }),
      OPENCODE_PASSWORD: SERVER_PASSWORD,
    }).filter(([key]) => key !== 'KIMAKI'),
  )
  serverProcess = spawn('opencode2', ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
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
  const client = OpenCode.make({
    baseUrl: `http://127.0.0.1:${port}`,
    headers: { authorization: AUTHORIZATION },
  })
  const created = await client.session.create({
    title: text,
    location: { directory: projectDir },
    model: { providerID: 'deterministic-provider', id: 'deterministic-v2' },
  })
  const sessionID = created.id
  await client.session.prompt({
    sessionID,
    text,
  })
  const pollStart = Date.now()
  while (Date.now() - pollStart < 20_000) {
    const messages = await client.message.list({ sessionID })
    const tools = toolParts(messages.data)
    if (tools.length > 0) return tools
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`No tool result received\n${stderrLines.join('\n')}`)
}

describe('opencode auto-mode e2e', () => {
  test('skips read-only shell without blocking', async () => {
    const tools = await runPrompt('AUTO_MODE_LS')
    expect(tools).toMatchInlineSnapshot(`
      [
        {
          "status": "completed",
          "tool": "shell",
        },
      ]
    `)
    const ls = tools.find((tool) => tool.tool === 'shell')
    expect(ls?.status).toBe('completed')
  }, 30_000)

  test('hard-denies chmod 777 before the classifier', async () => {
    const tools = await runPrompt('AUTO_MODE_CHMOD')
    expect(tools).toMatchInlineSnapshot(`
      [
        {
          "error": "[auto-mode] chmod 777",
          "status": "error",
          "tool": "shell",
        },
      ]
    `)
    const chmod = tools.find((tool) => tool.tool === 'shell')
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
          "tool": "shell",
        },
      ]
    `)
    const push = tools.find((tool) => tool.tool === 'shell')
    expect(push?.status).toBe('error')
    expect(push?.error ?? '').toContain('force push')
  }, 30_000)
})
