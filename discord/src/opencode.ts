// OpenCode server process manager.
// Spawns and maintains OpenCode API servers per project directory,
// handles automatic restarts on failure, and provides typed SDK clients.
// Uses errore for type-safe error handling.

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk'
import {
  createOpencodeClient as createOpencodeClientV2,
  type OpencodeClient as OpencodeClientV2,
} from '@opencode-ai/sdk/v2'
import * as errore from 'errore'
import { createLogger, LogPrefix } from './logger.js'
import {
  DirectoryNotAccessibleError,
  ServerStartError,
  ServerNotReadyError,
  FetchError,
  type OpenCodeErrors,
} from './errors.js'

const opencodeLogger = createLogger(LogPrefix.OPENCODE)

const opencodeServers = new Map<
  string,
  {
    process: ChildProcess
    client: OpencodeClient
    clientV2: OpencodeClientV2
    port: number
  }
>()

const serverRetryCount = new Map<string, number>()

async function getOpenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        const port = address.port
        server.close(() => {
          resolve(port)
        })
      } else {
        reject(new Error('Failed to get port'))
      }
    })
    server.on('error', reject)
  })
}

async function waitForServer(port: number, maxAttempts = 30): Promise<ServerStartError | true> {
  const endpoint = `http://127.0.0.1:${port}/api/health`
  for (let i = 0; i < maxAttempts; i++) {
    const response = await errore.tryAsync({
      try: () => fetch(endpoint),
      catch: (e) => new FetchError({ url: endpoint, cause: e }),
    })
    if (response instanceof Error) {
      // Connection refused or other transient errors - continue polling
      await new Promise((resolve) => setTimeout(resolve, 1000))
      continue
    }
    if (response.status < 500) {
      return true
    }
    const body = await response.text()
    // Fatal errors that won't resolve with retrying
    if (body.includes('BunInstallFailedError')) {
      return new ServerStartError({ port, reason: body.slice(0, 200) })
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return new ServerStartError({ port, reason: `Server did not start after ${maxAttempts} seconds` })
}

export async function initializeOpencodeForDirectory(directory: string): Promise<OpenCodeErrors | (() => OpencodeClient)> {
  const existing = opencodeServers.get(directory)
  if (existing && !existing.process.killed) {
    opencodeLogger.log(
      `Reusing existing server on port ${existing.port} for directory: ${directory}`,
    )
    return () => {
      const entry = opencodeServers.get(directory)
      if (!entry?.client) {
        throw new ServerNotReadyError({ directory })
      }
      return entry.client
    }
  }

  // Verify directory exists and is accessible before spawning
  const accessCheck = errore.tryFn({
    try: () => {
      fs.accessSync(directory, fs.constants.R_OK | fs.constants.X_OK)
    },
    catch: () => new DirectoryNotAccessibleError({ directory }),
  })
  if (accessCheck instanceof Error) {
    return accessCheck
  }

  const port = await getOpenPort()

  const opencodeCommand = process.env.OPENCODE_PATH || 'opencode'

  const serverProcess = spawn(opencodeCommand, ['serve', '--port', port.toString()], {
    stdio: 'pipe',
    detached: false,
    cwd: directory,
    env: {
      ...process.env,
      // SDK Config type is simplified; opencode accepts nested permission objects
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        lsp: false,
        formatter: false,
        permission: {
          edit: 'allow',
          bash: 'allow',
          external_directory: {
            '*': 'ask',
            '/tmp': 'allow',
            '/tmp/*': 'allow',
            '/private/var/folders/8w/*': 'allow',
            '/private/var/folders/8w': 'allow',
            '/private/tmp': 'allow',
            '/private/tmp/*': 'allow',
            'env:$TMPDIR': 'allow',
            'env:$TMPDIR/*': 'allow',
          },
          webfetch: 'allow',
        },
      }),
      OPENCODE_PORT: port.toString(),
    },
  })

  // Buffer logs until we know if server started successfully
  const logBuffer: string[] = []
  logBuffer.push(
    `Spawned opencode serve --port ${port} in ${directory} (pid: ${serverProcess.pid})`,
  )

  serverProcess.stdout?.on('data', (data) => {
    logBuffer.push(`[stdout] ${data.toString().trim()}`)
  })

  serverProcess.stderr?.on('data', (data) => {
    logBuffer.push(`[stderr] ${data.toString().trim()}`)
  })

  serverProcess.on('error', (error) => {
    logBuffer.push(`Failed to start server on port ${port}: ${error}`)
  })

  serverProcess.on('exit', (code) => {
    opencodeLogger.log(`Opencode server on ${directory} exited with code:`, code)
    opencodeServers.delete(directory)
    if (code !== 0) {
      const retryCount = serverRetryCount.get(directory) || 0
      if (retryCount < 5) {
        serverRetryCount.set(directory, retryCount + 1)
        opencodeLogger.log(
          `Restarting server for directory: ${directory} (attempt ${retryCount + 1}/5)`,
        )
        initializeOpencodeForDirectory(directory).then((result) => {
          if (result instanceof Error) {
            opencodeLogger.error(`Failed to restart opencode server:`, result)
          }
        })
      } else {
        opencodeLogger.error(`Server for ${directory} crashed too many times (5), not restarting`)
      }
    } else {
      serverRetryCount.delete(directory)
    }
  })

  const waitResult = await waitForServer(port)
  if (waitResult instanceof Error) {
    // Dump buffered logs on failure
    opencodeLogger.error(`Server failed to start for ${directory}:`)
    for (const line of logBuffer) {
      opencodeLogger.error(`  ${line}`)
    }
    return waitResult
  }
  opencodeLogger.log(`Server ready on port ${port}`)

  const baseUrl = `http://127.0.0.1:${port}`
  const fetchWithTimeout = (request: Request) =>
    fetch(request, {
      // @ts-ignore
      timeout: false,
    })

  const client = createOpencodeClient({
    baseUrl,
    fetch: fetchWithTimeout,
  })

  const clientV2 = createOpencodeClientV2({
    baseUrl,
    fetch: fetchWithTimeout as typeof fetch,
  })

  opencodeServers.set(directory, {
    process: serverProcess,
    client,
    clientV2,
    port,
  })

  return () => {
    const entry = opencodeServers.get(directory)
    if (!entry?.client) {
      throw new ServerNotReadyError({ directory })
    }
    return entry.client
  }
}

export function getOpencodeServers() {
  return opencodeServers
}

export function getOpencodeServerPort(directory: string): number | null {
  const entry = opencodeServers.get(directory)
  return entry?.port ?? null
}

export function getOpencodeClientV2(directory: string): OpencodeClientV2 | null {
  const entry = opencodeServers.get(directory)
  return entry?.clientV2 ?? null
}

/**
 * Restart the opencode server for a directory.
 * Kills the existing process and reinitializes a new one.
 * Used for resolving opencode state issues, refreshing auth, plugins, etc.
 */
export async function restartOpencodeServer(directory: string): Promise<OpenCodeErrors | true> {
  const existing = opencodeServers.get(directory)

  if (existing) {
    opencodeLogger.log(`Killing existing server for directory: ${directory} (pid: ${existing.process.pid})`)
    // Reset retry count so the exit handler doesn't auto-restart
    serverRetryCount.set(directory, 999)
    existing.process.kill('SIGTERM')
    opencodeServers.delete(directory)
    // Give the process time to fully terminate
    await new Promise((resolve) => {
      setTimeout(resolve, 1000)
    })
  }

  // Reset retry count for the fresh start
  serverRetryCount.delete(directory)

  const result = await initializeOpencodeForDirectory(directory)
  if (result instanceof Error) {
    return result
  }
  return true
}
