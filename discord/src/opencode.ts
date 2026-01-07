// OpenCode server process manager.
// Spawns and maintains OpenCode API servers per project directory,
// handles automatic restarts on failure, and provides typed SDK clients.

import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import {
  createOpencodeClient,
  type OpencodeClient,
  type Config,
} from '@opencode-ai/sdk'
import { createLogger } from './logger.js'

const opencodeLogger = createLogger('OPENCODE')

const opencodeServers = new Map<
  string,
  {
    process: ChildProcess
    client: OpencodeClient
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

async function waitForServer(port: number, maxAttempts = 30): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const endpoints = [
        `http://localhost:${port}/api/health`,
        `http://localhost:${port}/`,
        `http://localhost:${port}/api`,
      ]

      for (const endpoint of endpoints) {
        try {
          const response = await fetch(endpoint)
          if (response.status < 500) {
            opencodeLogger.log(`Server ready on port `)
            return true
          }
        } catch (e) {
          // expected during polling, server not ready yet
          opencodeLogger.debug(`Polling ${endpoint}: not ready yet`)
        }
      }
    } catch (e) {
      // expected during polling
      opencodeLogger.debug(`Server polling attempt failed:`, e)
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(
    `Server did not start on port ${port} after ${maxAttempts} seconds`,
  )
}

export async function initializeOpencodeForDirectory(directory: string) {
  const existing = opencodeServers.get(directory)
  if (existing && !existing.process.killed) {
    opencodeLogger.log(
      `Reusing existing server on port ${existing.port} for directory: ${directory}`,
    )
    return () => {
      const entry = opencodeServers.get(directory)
      if (!entry?.client) {
        throw new Error(
          `OpenCode server for directory "${directory}" is in an error state (no client available)`,
        )
      }
      return entry.client
    }
  }

  const port = await getOpenPort()

  const opencodeCommand = process.env.OPENCODE_PATH || 'opencode'

  const serverProcess = spawn(
    opencodeCommand,
    ['serve', '--port', port.toString()],
    {
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
    },
  )

  serverProcess.stdout?.on('data', (data) => {
    opencodeLogger.log(`opencode ${directory}: ${data.toString().trim()}`)
  })

  serverProcess.stderr?.on('data', (data) => {
    opencodeLogger.error(`opencode ${directory}: ${data.toString().trim()}`)
  })

  serverProcess.on('error', (error) => {
    opencodeLogger.error(`Failed to start server on port :`, port, error)
  })

  serverProcess.on('exit', (code) => {
    opencodeLogger.log(
      `Opencode server on ${directory} exited with code:`,
      code,
    )
    opencodeServers.delete(directory)
    if (code !== 0) {
      const retryCount = serverRetryCount.get(directory) || 0
      if (retryCount < 5) {
        serverRetryCount.set(directory, retryCount + 1)
        opencodeLogger.log(
          `Restarting server for directory: ${directory} (attempt ${retryCount + 1}/5)`,
        )
        initializeOpencodeForDirectory(directory).catch((e) => {
          opencodeLogger.error(`Failed to restart opencode server:`, e)
        })
      } else {
        opencodeLogger.error(
          `Server for ${directory} crashed too many times (5), not restarting`,
        )
      }
    } else {
      serverRetryCount.delete(directory)
    }
  })

  await waitForServer(port)

  const client = createOpencodeClient({
    baseUrl: `http://localhost:${port}`,
    fetch: (request: Request) =>
      fetch(request, {
        // @ts-ignore
        timeout: false,
      }),
  })

  opencodeServers.set(directory, {
    process: serverProcess,
    client,
    port,
  })

  return () => {
    const entry = opencodeServers.get(directory)
    if (!entry?.client) {
      throw new Error(
        `OpenCode server for directory "${directory}" is in an error state (no client available)`,
      )
    }
    return entry.client
  }
}

export function getOpencodeServers() {
  return opencodeServers
}
