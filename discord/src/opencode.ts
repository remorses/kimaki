// OpenCode server process manager.
// Spawns and maintains OpenCode API servers per project directory,
// handles automatic restarts on failure, and provides typed SDK clients.
// Uses errore for type-safe error handling.

import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
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
} from './config.js'
import { store } from './store.js'
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

// Resolve the full path to the opencode binary so we can spawn without
// shell: true. Using shell: true creates an intermediate sh process — when
// cleanup sends SIGTERM it only kills the shell, leaving the actual opencode
// process orphaned (reparented to PID 1). Resolving the path upfront lets
// us spawn the binary directly and SIGTERM reaches the right process.
let resolvedOpencodeCommand: string | null = null

export function resolveOpencodeCommand(): string {
  if (resolvedOpencodeCommand) {
    return resolvedOpencodeCommand
  }

  const envPath = process.env.OPENCODE_PATH
  if (envPath) {
    resolvedOpencodeCommand = envPath
    return envPath
  }

  const isWindows = process.platform === 'win32'
  const whichCmd = isWindows ? 'where' : 'which'
  const result = errore.tryFn({
    try: () => {
      return execFileSync(whichCmd, ['opencode'], {
        encoding: 'utf8',
        timeout: 5000,
      }).trim().split('\n')[0]!.trim()
    },
    catch: () => new Error('opencode not found in PATH'),
  })

  if (result instanceof Error) {
    // Fall back to bare command name — spawn will fail with a clear error
    // if it can't find the binary.
    opencodeLogger.warn('Could not resolve opencode path via which, falling back to "opencode"')
    return 'opencode'
  }

  resolvedOpencodeCommand = result
  opencodeLogger.log(`Resolved opencode binary: ${result}`)
  return result
}

/**
 * Build the spawn command and args, handling Windows .cmd shims.
 * On Windows, .cmd/.bat files can't be spawned directly without a shell —
 * we wrap them with cmd.exe /d /s /c instead of using shell: true
 * (which creates an intermediate sh process that eats SIGTERM).
 */
function getSpawnCommandAndArgs(baseArgs: string[]): { command: string; args: string[] } {
  const resolved = resolveOpencodeCommand()
  if (process.platform !== 'win32') {
    return { command: resolved, args: baseArgs }
  }
  const lower = resolved.toLowerCase()
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', `"${resolved}"`, ...baseArgs] }
  }
  return { command: resolved, args: baseArgs }
}

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

  const opencodeCommand = resolveOpencodeCommand()

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

  // Allow ~/.kimaki so the agent can access kimaki data dir (logs, db, etc.)
  // without permission prompts.
  const kimakiDataDir = path
    .join(os.homedir(), '.kimaki')
    .replaceAll('\\', '/')
  externalDirectoryPermissions[kimakiDataDir] = 'allow'
  externalDirectoryPermissions[`${kimakiDataDir}/*`] = 'allow'

  if (originalRepo) {
    externalDirectoryPermissions[originalRepo] = 'allow'
    externalDirectoryPermissions[`${originalRepo}/*`] = 'allow'
  }

  // Get bot token for plugin to use Discord API
  const botTokenFromDb = await getBotTokenWithMode()
  const kimakiBotToken = process.env.KIMAKI_BOT_TOKEN || botTokenFromDb?.token

  const serveArgs = ['serve', '--port', port.toString()]
  if (store.getState().verboseOpencodeServer) {
    serveArgs.push('--print-logs', '--log-level', 'DEBUG')
  }

  const { command: spawnCommand, args: spawnArgs } = getSpawnCommandAndArgs(serveArgs)

  const serverProcess = spawn(
    spawnCommand,
    spawnArgs,
    {
      stdio: 'pipe',
      detached: false,
      cwd: directory,
      // No shell: true — the binary path is resolved upfront via
      // resolveOpencodeCommand(), and Windows .cmd shims are handled via
      // cmd.exe /c in getSpawnCommandAndArgs(). shell: true creates an
      // intermediate sh process that eats SIGTERM on cleanup, leaving
      // the real opencode process orphaned.
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
      if (store.getState().verboseOpencodeServer) {
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
      if (store.getState().verboseOpencodeServer) {
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

  serverProcess.on('exit', (code, signal) => {
    opencodeLogger.log(
      `Opencode server on ${directory} exited with code: ${code}, signal: ${signal}`,
    )
    // Capture init options before deleting the entry so auto-restart preserves
    // worktree repo access.
    const storedInitOptions = opencodeServers.get(directory)?.initOptions
    opencodeServers.delete(directory)
    // Intentional kills (SIGTERM from cleanup/restart) should not trigger
    // auto-restart. Only unexpected crashes (non-zero exit without signal)
    // get retried.
    if (signal === 'SIGTERM') {
      serverRetryCount.delete(directory)
      return
    }
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
  if (store.getState().verboseOpencodeServer) {
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

export async function stopOpencodeServer(
  directory: string,
): Promise<boolean> {
  const existing = opencodeServers.get(directory)
  if (!existing) {
    return false
  }

  opencodeLogger.log(
    `Stopping opencode server for directory: ${directory} (pid: ${existing.process.pid})`,
  )
  if (!existing.process.killed) {
    const killResult = errore.try({
      try: () => {
        existing.process.kill('SIGTERM')
      },
      catch: (error) => {
        return new Error(
          `Failed to send SIGTERM to opencode server for ${directory}`,
          {
            cause: error,
          },
        )
      },
    })
    if (killResult instanceof Error) {
      opencodeLogger.warn(killResult.message)
    }
  }

  opencodeServers.delete(directory)
  serverRetryCount.delete(directory)
  await new Promise((resolve) => {
    setTimeout(resolve, 1000)
  })
  return true
}

export async function stopOpencodeServersWithoutRuntimeDirectories({
  activeDirectories,
}: {
  activeDirectories: ReadonlyArray<string>
}): Promise<string[]> {
  const activeDirectorySet = new Set(activeDirectories)
  const directoriesToStop = [...opencodeServers.keys()].filter((directory) => {
    return !activeDirectorySet.has(directory)
  })

  const stoppedDirectories: string[] = []
  for (const directory of directoriesToStop) {
    const stopped = await stopOpencodeServer(directory)
    if (!stopped) {
      continue
    }
    stoppedDirectories.push(directory)
  }
  return stoppedDirectories
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
    await stopOpencodeServer(directory)
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
