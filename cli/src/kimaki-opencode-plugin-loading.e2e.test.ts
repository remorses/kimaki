// E2e test for OpenCode plugin loading.
// Spawns one `opencode serve` with the same plugin list kimaki writes (its own
// plugin plus @subrouter/opencode), then checks stderr for load errors and
// hits the real HTTP API. One server for both plugins, because that is how
// they actually run, and because booting two costs seconds per file.
// No Discord infrastructure and no real provider APIs.

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { PROVIDER_IDS, type AccountsFile } from '@subrouter/cli'
import { resolveOpencodeCommand } from './opencode.js'
import { getSpawnCommandAndArgs } from './opencode-command.js'
import { chooseLockPort } from './test-utils.js'

const require = createRequire(import.meta.url)

const port = chooseLockPort({ key: 'opencode-plugin-loading-e2e' })
const projectDir = path.resolve(process.cwd(), 'tmp', 'plugin-loading-e2e')
const subrouterHome = path.join(projectDir, 'subrouter-home')
const stderrLines: string[] = []

let serverProcess: ChildProcess | undefined

async function api<T>(routePath: string): Promise<T> {
  const url = new URL(routePath, `http://127.0.0.1:${port}`)
  url.searchParams.set('directory', projectDir)
  const response = await fetch(url, { headers: { 'x-opencode-directory': projectDir } })
  if (!response.ok) throw new Error(`${routePath} returned ${response.status}`)
  return (await response.json()) as T
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 60; attempt++) {
    const ok = await fetch(`http://127.0.0.1:${port}/api/health`)
      .then((r) => r.status < 500)
      .catch(() => false)
    if (ok) return true
    await new Promise((resolve) => {
      setTimeout(resolve, 500)
    })
  }
  return false
}

beforeAll(async () => {
  fs.rmSync(projectDir, { recursive: true, force: true })
  const opencodeRoot = path.join(projectDir, 'opencode-test-home')
  const xdgDirectories = {
    OPENCODE_CONFIG_DIR: path.join(opencodeRoot, '.opencode-kimaki'),
    XDG_CONFIG_HOME: path.join(opencodeRoot, '.config'),
    XDG_DATA_HOME: path.join(opencodeRoot, '.local', 'share'),
    XDG_CACHE_HOME: path.join(opencodeRoot, '.cache'),
    XDG_STATE_HOME: path.join(opencodeRoot, '.local', 'state'),
  }
  ;[...Object.values(xdgDirectories), subrouterHome].forEach((directory) => {
    fs.mkdirSync(directory, { recursive: true })
  })

  const { command, args, windowsVerbatimArguments } = getSpawnCommandAndArgs({
    resolvedCommand: resolveOpencodeCommand(),
    baseArgs: ['serve', '--port', port.toString(), '--print-logs', '--log-level', 'DEBUG'],
  })

  serverProcess = spawn(command, args, {
    stdio: 'pipe',
    cwd: projectDir,
    windowsVerbatimArguments,
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        lsp: false,
        formatter: false,
        plugin: [
          new URL('../src/kimaki-opencode-plugin.ts', import.meta.url).href,
          pathToFileURL(require.resolve('@subrouter/opencode')).href,
        ],
      }),
      OPENCODE_TEST_HOME: opencodeRoot,
      SUBROUTER_HOME: subrouterHome,
      SUBROUTER_MANUAL_OAUTH: '1',
      ...xdgDirectories,
    },
  })

  serverProcess.stderr?.on('data', (data) => {
    stderrLines.push(...data.toString().split('\n').filter(Boolean))
  })

  expect(await waitForHealth()).toBe(true)
}, 120_000)

afterAll(() => {
  serverProcess?.kill('SIGTERM')
})

test('server loads both plugins without errors', () => {
  const pluginErrorPatterns = [
    /plugin.*error/i,
    /failed to load plugin/i,
    /cannot find module/i,
    /ERR_MODULE_NOT_FOUND/i,
    /plugin.*failed/i,
    /plugin.*crash/i,
  ]
  const errorLines = stderrLines.filter((line) => {
    return pluginErrorPatterns.some((pattern) => {
      return pattern.test(line)
    })
  })
  expect(errorLines).toEqual([])
})

test('subrouter is a connected provider so /model accepts subrouter/default', async () => {
  const providers = await api<{
    all: Array<{
      id: string
      name: string
      models: Record<
        string,
        {
          name: string
          capabilities: {
            attachment: boolean
            input: { image: boolean; pdf: boolean }
          }
        }
      >
    }>
    connected: string[]
  }>('/provider')

  expect(providers.connected).toContain('subrouter')
  const subrouter = providers.all.find((entry) => {
    return entry.id === 'subrouter'
  })
  expect(subrouter?.name).toBe('Subrouter')
  expect(subrouter?.models.default).toMatchObject({
    capabilities: {
      attachment: true,
      input: { image: true, pdf: true },
    },
  })
})

test('login offers subrouter and asks which subscription to add first', async () => {
  const methods = await api<
    Record<
      string,
      Array<{
        type: string
        label: string
        prompts?: Array<{ type: string; key: string; options?: Array<{ value: string }> }>
      }>
    >
  >('/provider/auth')

  expect(methods.subrouter).toHaveLength(1)
  expect(methods.subrouter?.[0]).toMatchObject({ type: 'oauth', label: 'Add a subscription' })

  // Derived from subrouter, not hardcoded: it adds providers over time and a
  // literal list here just breaks on the next one.
  const prompt = methods.subrouter?.[0]?.prompts?.[0]
  expect(prompt).toMatchObject({ type: 'select', key: 'provider' })
  expect(prompt?.options?.map((option) => option.value)).toEqual([...PROVIDER_IDS])
})

test('authorize and callback add an opencode-go subscription', async () => {
  const url = new URL('/provider/subrouter/oauth/authorize', `http://127.0.0.1:${port}`)
  url.searchParams.set('directory', projectDir)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-opencode-directory': projectDir },
    body: JSON.stringify({ method: 0, inputs: { provider: 'opencode-go' } }),
  })

  expect(response.ok).toBe(true)
  const authorization = (await response.json()) as { url: string; method: string; instructions: string }
  expect(authorization.method).toBe('code')
  expect(authorization.url).toBe('https://console.opencode.ai')
  expect(authorization.instructions).toContain('API key')

  const callbackUrl = new URL(
    '/provider/subrouter/oauth/callback',
    `http://127.0.0.1:${port}`,
  )
  callbackUrl.searchParams.set('directory', projectDir)
  const callbackResponse = await fetch(callbackUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-opencode-directory': projectDir,
    },
    body: JSON.stringify({ method: 0, code: 'zen-key-1' }),
  })

  expect(callbackResponse.ok).toBe(true)
  const accounts = JSON.parse(
    fs.readFileSync(path.join(subrouterHome, 'accounts.json'), 'utf8'),
  ) as AccountsFile
  expect(accounts.providers['opencode-go']?.accounts).toMatchObject([
    { type: 'api', key: 'zen-key-1' },
  ])
})
