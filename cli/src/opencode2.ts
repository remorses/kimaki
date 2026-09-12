// OpenCode v2 (opencode2) serve harness + client factory. Phase 0 of the v1→v2
// port: parallel to opencode.ts (v1), used only by tests for now.
//
// Verified v2 facts (@opencode/cli 2.0.2):
// - binary names are `opencode` and `opencode2`, shipped by @opencode/cli as
//   bin/opencode.exe (the .exe name is kept on every platform; postinstall
//   swaps in the native binary). Spawn the real binary, NOT
//   node_modules/.bin/opencode2 — that is a /bin/sh wrapper that survives
//   SIGTERM and orphans the server.
// - `opencode2 serve --port N --hostname H` (both flags optional; defaults to
//   127.0.0.1 and a random port).
// - auth is Basic `opencode:<password>`. We always generate the password and
//   pass it via env OPENCODE_PASSWORD so stdout never needs parsing (the
//   "server password ..." line is only printed when no env password is set).
// - every /api route requires auth, including /api/health. Readiness probe:
//   GET /api/session/active with Basic auth (cheap, 200 = ready).

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

import { OpenCode, type OpenCodeClient } from '@opencode/client'
import * as errore from 'errore'

import { getDataDir } from './config.js'
import { ServerStartError, FetchError } from './errors.js'

export type { OpenCodeClient }

/**
 * Resolve the opencode2 binary path.
 * Order: OPENCODE2_PATH env override, then the platform binary installed by
 * @opencode/cli, then bare `opencode2` on PATH.
 */
export function resolveOpencode2Command(): string {
  const envPath = process.env.OPENCODE2_PATH
  if (envPath) {
    return envPath
  }

  const resolved = errore.try(
    () => {
      const require = createRequire(import.meta.url)
      const packageJsonPath = require.resolve('@opencode/cli/package.json')
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
      const binRelative = packageJson.bin?.opencode2 || packageJson.bin?.opencode
      if (typeof binRelative !== 'string') {
        throw new Error('@opencode/cli package.json has no opencode2 bin')
      }
      return path.join(path.dirname(packageJsonPath), binRelative)
    },
    (error) => new Error('Could not resolve @opencode/cli binary', { cause: error }),
  )
  if (resolved instanceof Error) {
    return 'opencode2'
  }
  return resolved
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        const port = address.port
        server.close(() => {
          resolve(port)
        })
        return
      }
      reject(new Error('Failed to get free port'))
    })
    server.on('error', reject)
  })
}

/**
 * Build the env for the opencode2 child process. Copies process.env but strips
 * kimaki's v1 config vars so the v2 server never loads the v1-generated
 * config. Under vitest, uses a private HOME/XDG so the server cannot touch the
 * developer's real opencode state (mirrors opencode-v2/packages/core/script/test.ts).
 */
export function buildOpencode2Env({ password }: { password: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.OPENCODE_CONFIG
  delete env.OPENCODE_CONFIG_CONTENT
  delete env.OPENCODE_SERVER_PASSWORD
  env.OPENCODE_PASSWORD = password

  if (process.env.KIMAKI_VITEST === '1') {
    const home = path.join(getDataDir(), 'opencode2-vitest-home')
    const isolation = {
      HOME: home,
      OPENCODE_TEST_HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      XDG_STATE_HOME: path.join(home, '.local', 'state'),
      OPENCODE_CONFIG_DIR: path.join(home, '.config', 'opencode'),
    }
    // Pre-create so startup writes don't fail closed on missing parents.
    for (const directory of Object.values(isolation)) {
      fs.mkdirSync(directory, { recursive: true })
    }
    Object.assign(env, isolation)
    if (process.platform === 'win32') {
      env.USERPROFILE = home
    }
  }

  return env
}

export function buildBasicAuthHeader({ password }: { password: string }): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
}

export type Opencode2Server = {
  baseUrl: string
  port: number
  password: string
  process: ChildProcess
  close: () => void
  [Symbol.asyncDispose]: () => Promise<void>
}

async function waitForOpencode2Ready({
  baseUrl,
  port,
  password,
  maxAttempts = 300,
}: {
  baseUrl: string
  port: number
  password: string
  maxAttempts?: number
}): Promise<ServerStartError | true> {
  const url = `${baseUrl}/api/session/active`
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const response = await fetch(url, {
      headers: { authorization: buildBasicAuthHeader({ password }) },
      signal: AbortSignal.timeout(2000),
    }).catch((error) => new FetchError({ url, cause: error }))
    if (!(response instanceof Error)) {
      if (response.status === 200) {
        return true
      }
      // 401/403 is fatal: the server rejected our credentials, retrying
      // won't help. Other statuses may be transient during boot, keep polling.
      if (response.status === 401 || response.status === 403) {
        const body = await response.text().catch(() => '')
        return new ServerStartError({
          port,
          reason: `Readiness probe got ${response.status}: ${body.slice(0, 200)}`,
        })
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return new ServerStartError({
    port,
    reason: `opencode2 did not become ready after ${Math.round((maxAttempts * 100) / 1000)}s`,
  })
}

/**
 * Spawn `opencode2 serve` and wait until it answers authenticated requests.
 * Always generates the password (unless given) and passes it via env
 * OPENCODE_PASSWORD, so stdout is never parsed.
 */
export async function startOpencode2Server({
  port,
  password,
}: {
  port?: number
  password?: string
} = {}): Promise<ServerStartError | Opencode2Server> {
  const resolvedPort = port ?? (await getFreePort())
  const resolvedPassword = password ?? randomBytes(32).toString('base64url')
  const baseUrl = `http://127.0.0.1:${resolvedPort}`

  const serverProcess = spawn(
    resolveOpencode2Command(),
    ['serve', '--port', resolvedPort.toString(), '--hostname', '127.0.0.1'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: buildOpencode2Env({ password: resolvedPassword }),
    },
  )

  // Holder object: TS narrows a closed-over `let` to null at the later read.
  const spawnFailure: { error: Error | null } = { error: null }
  serverProcess.on('error', (error) => {
    spawnFailure.error = error
  })

  const ready = await waitForOpencode2Ready({
    baseUrl,
    port: resolvedPort,
    password: resolvedPassword,
  })
  if (ready instanceof Error) {
    serverProcess.kill('SIGTERM')
    if (spawnFailure.error) {
      return new ServerStartError({
        port: resolvedPort,
        reason: `Failed to spawn opencode2: ${spawnFailure.error.message}`,
        cause: spawnFailure.error,
      })
    }
    return ready
  }

  const close = () => {
    if (!serverProcess.killed) {
      serverProcess.kill('SIGTERM')
    }
  }
  return {
    baseUrl,
    port: resolvedPort,
    password: resolvedPassword,
    process: serverProcess,
    close,
    [Symbol.asyncDispose]: async () => {
      close()
    },
  }
}

/**
 * Create a v2 promise client. When directory is given, sets the
 * x-opencode-directory fallback header for location-scoped routes.
 */
export function createOpencode2Client({
  baseUrl,
  password,
  directory,
}: {
  baseUrl: string
  password: string
  directory?: string
}): OpenCodeClient {
  return OpenCode.make({
    baseUrl,
    headers: {
      authorization: buildBasicAuthHeader({ password }),
      ...(directory && { 'x-opencode-directory': directory }),
    },
  })
}
