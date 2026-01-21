// OpenCode server process manager.
// Spawns and maintains OpenCode API servers per project directory,
// handles automatic restarts on failure, and provides typed SDK clients.
// Uses errore for type-safe error handling.

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import { createOpencodeClient, type OpencodeClient, type Config } from '@opencode-ai/sdk'
import {
  createOpencodeClient as createOpencodeClientV2,
  type OpencodeClient as OpencodeClientV2,
} from '@opencode-ai/sdk/v2'
import * as errore from 'errore'
import { createLogger } from './logger.js'
import {
  DirectoryNotAccessibleError,
  ServerStartError,
  ServerNotReadyError,
  FetchError,
  type OpenCodeErrors,
} from './errors.js'

const opencodeLogger = createLogger('OPENCODE')

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
  for (let i = 0; i < maxAttempts; i++) {
    const endpoints = [
      `http://127.0.0.1:${port}/api/health`,
      `http://127.0.0.1:${port}/`,
      `http://127.0.0.1:${port}/api`,
    ]

    for (const endpoint of endpoints) {
      const response = await errore.tryAsync({
        try: () => fetch(endpoint),
        catch: (e) => new FetchError({ url: endpoint, cause: e }),
      })
      if (errore.isError(response)) {
        // Connection refused or other transient errors - continue polling
        opencodeLogger.debug(`Server polling attempt failed: ${response.message}`)
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
  if (errore.isError(accessCheck)) {
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
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        lsp: false,
        formatter: false,
        permission: {
          edit: 'allow',
          bash: 'allow',
          webfetch: 'allow',
        },
      } satisfies Config),
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
          if (errore.isError(result)) {
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
  if (errore.isError(waitResult)) {
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
