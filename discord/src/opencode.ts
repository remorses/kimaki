// OpenCode server process manager.
// Spawns and maintains OpenCode API servers per project directory,
// handles automatic restarts on failure, and provides typed SDK clients.
// Uses errore for type-safe error handling.

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import {
  createOpencodeClient,
  type OpencodeClient,
  type Config as SdkConfig,
} from '@opencode-ai/sdk/v2'
import { getBotTokenWithMode } from './database.js'
import {
  getDataDir,
  getLockPort,
  getVerboseOpencodeServer,
} from './config.js'
import { getHranaUrl } from './hrana-server.js'

// SDK Config type is simplified; opencode accepts nested permission objects with path patterns
type PermissionAction = 'ask' | 'allow' | 'deny'
type PermissionRule = PermissionAction | Record<string, PermissionAction>
type Config = Omit<SdkConfig, 'permission'> & {
  permission?: {
    edit?: PermissionRule
    bash?: PermissionRule
    external_directory?: PermissionRule
    webfetch?: PermissionRule
    [key: string]: PermissionRule | undefined
  }
}
import * as errore from 'errore'
import { createLogger, LogPrefix } from './logger.js'
import { notifyError } from './sentry.js'
import {
  DirectoryNotAccessibleError,
  ServerStartError,
  ServerNotReadyError,
  FetchError,
  type OpenCodeErrors,
} from './errors.js'

const opencodeLogger = createLogger(LogPrefix.OPENCODE)

const STARTUP_STDERR_TAIL_LIMIT = 30
const STARTUP_STDERR_LINE_MAX_LENGTH = 120
const STARTUP_ERROR_REASON_MAX_LENGTH = 1500
const ANSI_ESCAPE_REGEX =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g

function truncateWithEllipsis({
  value,
  maxLength,
}: {
  value: string
  maxLength: number
}): string {
  if (maxLength <= 3) {
    return value.slice(0, maxLength)
  }
  if (value.length <= maxLength) {
    return value
  }
  return `${value.slice(0, maxLength - 3)}...`
}

function stripAnsiCodes(value: string): string {
  return value.replaceAll(ANSI_ESCAPE_REGEX, '')
}

function splitOutputChunkLines(chunk: string): string[] {
  return chunk
    .split(/\r?\n/g)
    .map((line) => stripAnsiCodes(line).trim())
    .filter((line) => line.length > 0)
}

function sanitizeForCodeFence(line: string): string {
  return line.replaceAll('```', '`\u200b``')
}

function pushStartupStderrTail({
  stderrTail,
  chunk,
}: {
  stderrTail: string[]
  chunk: string
}): void {
  const incomingLines = splitOutputChunkLines(chunk)
  const truncatedLines = incomingLines.map((line) => {
    const sanitizedLine = sanitizeForCodeFence(line)
    return truncateWithEllipsis({
      value: sanitizedLine,
      maxLength: STARTUP_STDERR_LINE_MAX_LENGTH,
    })
  })
  stderrTail.push(...truncatedLines)
  if (stderrTail.length > STARTUP_STDERR_TAIL_LIMIT) {
    stderrTail.splice(0, stderrTail.length - STARTUP_STDERR_TAIL_LIMIT)
  }
}

function buildStartupTimeoutReason({
  maxAttempts,
  stderrTail,
}: {
  maxAttempts: number
  stderrTail: string[]
}): string {
  const baseReason = `Server did not start after ${maxAttempts} seconds`
  if (stderrTail.length === 0) {
    return baseReason
  }

  const formatReason = ({
    lines,
    omitted,
  }: {
    lines: string[]
    omitted: number
  }): string => {
    const omittedLine =
      omitted > 0
        ? `[... ${omitted} older stderr lines omitted to fit Discord ...]\n`
        : ''
    const stderrCodeBlock = `${omittedLine}${lines.join('\n')}`
    return `${baseReason}\nLast opencode stderr lines:\n\`\`\`text\n${stderrCodeBlock}\n\`\`\``
  }

  let lines = [...stderrTail]
  let omitted = 0
  let formattedReason = formatReason({ lines, omitted })

  while (
    formattedReason.length > STARTUP_ERROR_REASON_MAX_LENGTH &&
    lines.length > 0
  ) {
    lines = lines.slice(1)
    omitted += 1
    formattedReason = formatReason({ lines, omitted })
  }

  return truncateWithEllipsis({
    value: formattedReason,
    maxLength: STARTUP_ERROR_REASON_MAX_LENGTH,
  })
}

type ServerInitOptions = { originalRepoDirectory?: string; channelId?: string }

const opencodeServers = new Map<
  string,
  {
    process: ChildProcess
    client: OpencodeClient
    port: number
    /** Original options used to spawn this server, reused on auto-restart */
    initOptions?: ServerInitOptions
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

async function waitForServer({
  port,
  maxAttempts = 30,
  startupStderrTail,
}: {
  port: number
  maxAttempts?: number
  startupStderrTail: string[]
}): Promise<ServerStartError | true> {
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
  return new ServerStartError({
    port,
    reason: buildStartupTimeoutReason({
      maxAttempts,
      stderrTail: startupStderrTail,
    }),
  })
}

/**
 * Initialize OpenCode server for a directory.
 * @param directory - The directory to run the server in (cwd)
 * @param options.originalRepoDirectory - For worktrees: the original repo directory to allow access to
 */
export async function initializeOpencodeForDirectory(
  directory: string,
  options?: { originalRepoDirectory?: string; channelId?: string },
): Promise<OpenCodeErrors | (() => OpencodeClient)> {
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

  // Normalize path separators for cross-platform compatibility (Windows uses backslashes)
  const tmpdir = os.tmpdir().replaceAll('\\', '/')
  const originalRepo = options?.originalRepoDirectory?.replaceAll('\\', '/')
  const normalizedDirectory = directory.replaceAll('\\', '/')

  // Build external_directory permissions, optionally including original repo for worktrees.
  const externalDirectoryPermissions: Record<string, PermissionAction> = {
    '*': 'ask',
    '/tmp': 'allow',
    '/tmp/*': 'allow',
    '/private/tmp': 'allow',
    '/private/tmp/*': 'allow',
    [tmpdir]: 'allow',
    [`${tmpdir}/*`]: 'allow',
    [normalizedDirectory]: 'allow',
    [`${normalizedDirectory}/*`]: 'allow',
  }
  // Allow ~/.config/opencode so the agent doesn't get permission prompts when
  // it tries to read the global AGENTS.md or opencode config (the path is
  // visible in the system prompt, so models sometimes try to read it).
  const opencodeConfigDir = path
    .join(os.homedir(), '.config', 'opencode')
    .replaceAll('\\', '/')
  externalDirectoryPermissions[opencodeConfigDir] = 'allow'
  externalDirectoryPermissions[`${opencodeConfigDir}/*`] = 'allow'

  if (originalRepo) {
    externalDirectoryPermissions[originalRepo] = 'allow'
    externalDirectoryPermissions[`${originalRepo}/*`] = 'allow'
  }

  // Get bot token for plugin to use Discord API
  const botTokenFromDb = await getBotTokenWithMode()
  const kimakiBotToken = process.env.KIMAKI_BOT_TOKEN || botTokenFromDb?.token

  const serveArgs = ['serve', '--port', port.toString()]
  if (getVerboseOpencodeServer()) {
    serveArgs.push('--print-logs', '--log-level', 'DEBUG')
  }

  const serverProcess = spawn(
    opencodeCommand,
    serveArgs,
    {
      stdio: 'pipe',
      detached: false,
      cwd: directory,
      shell: true, // Required for .cmd files on Windows
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          lsp: false,
          formatter: false,
          plugin: [new URL('../src/opencode-plugin.ts', import.meta.url).href],
          permission: {
            edit: 'allow',
            bash: 'allow',
            external_directory: externalDirectoryPermissions,
            webfetch: 'allow',
          },
          agent: {
            explore: {
              permission: {
                '*': 'deny',
                grep: 'allow',
                glob: 'allow',
                list: 'allow',
                read: {
                  '*': 'allow',
                  '*.env': 'deny',
                  '*.env.*': 'deny',
                  '*.env.example': 'allow',
                },
                webfetch: 'allow',
                websearch: 'allow',
                codesearch: 'allow',
                external_directory: externalDirectoryPermissions,
              },
            },
          },
          skills: {
            paths: [path.resolve(__dirname, '..', 'skills')],
          },
        } satisfies Config),
        OPENCODE_PORT: port.toString(),
        KIMAKI_DATA_DIR: getDataDir(),
        KIMAKI_LOCK_PORT: getLockPort().toString(),
        ...(kimakiBotToken && { KIMAKI_BOT_TOKEN: kimakiBotToken }),

        ...(getHranaUrl() && { KIMAKI_DB_URL: getHranaUrl()! }),
        ...(process.env.KIMAKI_SENTRY_DSN && {
          KIMAKI_SENTRY_DSN: process.env.KIMAKI_SENTRY_DSN,
        }),
      },
    },
  )

  // Buffer logs until we know if server started successfully.
  // Once ready, switch to forwarding if --verbose-opencode-server is set.
  const logBuffer: string[] = []
  const startupStderrTail: string[] = []
  let serverReady = false
  const shortDir = path.basename(directory)

  logBuffer.push(
    `Spawned opencode serve --port ${port} in ${directory} (pid: ${serverProcess.pid})`,
  )

  serverProcess.stdout?.on('data', (data) => {
    try {
      const chunk = data.toString()
      const lines = splitOutputChunkLines(chunk)
      if (!serverReady) {
        logBuffer.push(...lines.map((line) => `[stdout] ${line}`))
        return
      }
      if (getVerboseOpencodeServer()) {
        for (const line of lines) {
          opencodeLogger.log(`[${shortDir}:${port}] ${line}`)
        }
      }
    } catch (error) {
      logBuffer.push(`Failed to process stdout startup logs: ${error}`)
    }
  })

  serverProcess.stderr?.on('data', (data) => {
    try {
      const chunk = data.toString()
      const lines = splitOutputChunkLines(chunk)
      if (!serverReady) {
        logBuffer.push(...lines.map((line) => `[stderr] ${line}`))
        pushStartupStderrTail({ stderrTail: startupStderrTail, chunk })
        return
      }
      if (getVerboseOpencodeServer()) {
        for (const line of lines) {
          opencodeLogger.error(`[${shortDir}:${port}] ${line}`)
        }
      }
    } catch (error) {
      logBuffer.push(`Failed to process stderr startup logs: ${error}`)
    }
  })

  serverProcess.on('error', (error) => {
    logBuffer.push(`Failed to start server on port ${port}: ${error}`)
  })

  serverProcess.on('exit', (code) => {
    opencodeLogger.log(
      `Opencode server on ${directory} exited with code:`,
      code,
    )
    // Capture init options before deleting the entry so auto-restart preserves
    // worktree repo access.
    const storedInitOptions = opencodeServers.get(directory)?.initOptions
    opencodeServers.delete(directory)
    if (code !== 0) {
      const retryCount = serverRetryCount.get(directory) || 0
      if (retryCount < 5) {
        serverRetryCount.set(directory, retryCount + 1)
        opencodeLogger.log(
          `Restarting server for directory: ${directory} (attempt ${retryCount + 1}/5)`,
        )
        initializeOpencodeForDirectory(directory, storedInitOptions).then(
          (result) => {
            if (result instanceof Error) {
              opencodeLogger.error(`Failed to restart opencode server:`, result)
              void notifyError(result, `OpenCode server restart failed for ${directory}`)
            }
          },
        )
      } else {
        const crashError = new Error(
          `Server for ${directory} crashed too many times (5), not restarting`,
        )
        opencodeLogger.error(crashError.message)
        void notifyError(crashError, `OpenCode server crash loop exhausted`)
      }
    } else {
      serverRetryCount.delete(directory)
    }
  })

  const waitResult = await waitForServer({
    port,
    startupStderrTail,
  })
  if (waitResult instanceof Error) {
    // Dump buffered logs on failure
    opencodeLogger.error(`Server failed to start for ${directory}:`)
    for (const line of logBuffer) {
      opencodeLogger.error(`  ${line}`)
    }
    return waitResult
  }
  serverReady = true
  opencodeLogger.log(`Server ready on port ${port}`)

  // When verbose mode is enabled, also dump startup logs so plugin loading
  // errors and other startup output are visible in kimaki.log.
  if (getVerboseOpencodeServer()) {
    for (const line of logBuffer) {
      opencodeLogger.log(`[${shortDir}:${port}:startup] ${line}`)
    }
  }

  const baseUrl = `http://127.0.0.1:${port}`
  const fetchWithTimeout = (request: Request) =>
    fetch(request, {
      // @ts-ignore
      timeout: false,
    })

  const client = createOpencodeClient({
    baseUrl,
    fetch: fetchWithTimeout as typeof fetch,
  })

  opencodeServers.set(directory, {
    process: serverProcess,
    client,
    port,
    initOptions: options,
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

export function getOpencodeClient(directory: string): OpencodeClient | null {
  const entry = opencodeServers.get(directory)
  return entry?.client ?? null
}

/**
 * Restart the opencode server for a directory.
 * Kills the existing process and reinitializes a new one.
 * Used for resolving opencode state issues, refreshing auth, plugins, etc.
 */
export async function restartOpencodeServer(
  directory: string,
): Promise<OpenCodeErrors | true> {
  const existing = opencodeServers.get(directory)
  // Preserve init options (originalRepoDirectory) so the restarted
  // server retains worktree access.
  const storedInitOptions = existing?.initOptions

  if (existing) {
    opencodeLogger.log(
      `Killing existing server for directory: ${directory} (pid: ${existing.process.pid})`,
    )
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

  const result = await initializeOpencodeForDirectory(
    directory,
    storedInitOptions,
  )
  if (result instanceof Error) {
    return result
  }
  return true
}
