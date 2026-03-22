// OpenCode single-server process manager.
//
// Architecture: ONE opencode serve process shared by all project directories.
// Each SDK client uses the x-opencode-directory header to scope requests to a
// specific project. The server lazily creates and caches an Instance per unique
// directory path internally.
//
// Per-directory permissions (external_directory rules for worktrees, tmpdir,
// etc.) are passed via session.create({ permission }) at session creation time,
// NOT via the server config. The server config has permissive defaults
// (edit: allow, bash: allow, external_directory: ask) and session-level rules
// override them via opencode's findLast() evaluation (last matching rule wins).
//
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
  type PermissionRuleset,
} from '@opencode-ai/sdk/v2'

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
import {
  ensureKimakiCommandShim,
  getPathEnvKey,
  getSpawnCommandAndArgs,
  prependPathEntry,
  selectResolvedCommand,
} from './opencode-command.js'

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
  const timeoutSeconds = Math.round((maxAttempts * 100) / 1000)
  const baseReason = `Server did not start after ${timeoutSeconds} seconds`
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

// ── Single server state ──────────────────────────────────────────
// One opencode serve process, shared by all project directories.
// Clients are created per-directory with the x-opencode-directory header.

type SingleServer = {
  process: ChildProcess
  port: number
  baseUrl: string
}

type ServerLifecycleEvent =
  | { type: 'started'; port: number }
  | { type: 'stopped' }

let singleServer: SingleServer | null = null
let serverRetryCount = 0
const serverLifecycleListeners = new Set<(event: ServerLifecycleEvent) => void>()
let processCleanupHandlersRegistered = false
let startingServerProcess: ChildProcess | null = null

// Cached SDK clients per directory. Each client has a fixed
// x-opencode-directory header pointing to its project directory.
const clientCache = new Map<string, OpencodeClient>()

function notifyServerLifecycle(event: ServerLifecycleEvent): void {
  for (const listener of serverLifecycleListeners) {
    listener(event)
  }
}

export function subscribeOpencodeServerLifecycle(
  listener: (event: ServerLifecycleEvent) => void,
): () => void {
  serverLifecycleListeners.add(listener)
  return () => {
    serverLifecycleListeners.delete(listener)
  }
}

function killSingleServerProcessNow({
  reason,
}: {
  reason: string
}): void {
  if (!singleServer) {
    return
  }

  const serverProcess = singleServer.process
  const pid = serverProcess.pid
  if (!pid || serverProcess.killed) {
    return
  }

  const killResult = errore.try({
    try: () => {
      serverProcess.kill('SIGTERM')
    },
    catch: (error) => {
      return new Error('Failed to send SIGTERM to opencode server', {
        cause: error,
      })
    },
  })

  if (killResult instanceof Error) {
    opencodeLogger.warn(
      `[cleanup:${reason}] ${killResult.message} (pid: ${pid}, port: ${singleServer.port})`,
    )
    return
  }

  opencodeLogger.log(
    `[cleanup:${reason}] Sent SIGTERM to opencode server (pid: ${pid}, port: ${singleServer.port})`,
  )
}

function killStartingServerProcessNow({
  reason,
}: {
  reason: string
}): void {
  const serverProcess = startingServerProcess
  if (!serverProcess) {
    return
  }

  const pid = serverProcess.pid
  if (!pid || serverProcess.killed) {
    return
  }

  const killResult = errore.try({
    try: () => {
      serverProcess.kill('SIGTERM')
    },
    catch: (error) => {
      return new Error('Failed to send SIGTERM to starting opencode server', {
        cause: error,
      })
    },
  })

  if (killResult instanceof Error) {
    opencodeLogger.warn(
      `[cleanup:${reason}] ${killResult.message} (pid: ${pid})`,
    )
    return
  }

  opencodeLogger.log(
    `[cleanup:${reason}] Sent SIGTERM to starting opencode server (pid: ${pid})`,
  )
}

function ensureProcessCleanupHandlersRegistered(): void {
  if (processCleanupHandlersRegistered) {
    return
  }
  processCleanupHandlersRegistered = true

  opencodeLogger.log('Registering process cleanup handlers for opencode server')

  process.on('exit', () => {
    killSingleServerProcessNow({ reason: 'process-exit' })
    killStartingServerProcessNow({ reason: 'process-exit' })
  })

  // Fallback for short-lived CLI subcommands that call process.exit without
  // running discord-bot.ts shutdown handlers.
  process.on('SIGINT', () => {
    killSingleServerProcessNow({ reason: 'sigint' })
    killStartingServerProcessNow({ reason: 'sigint' })
  })
  process.on('SIGTERM', () => {
    killSingleServerProcessNow({ reason: 'sigterm' })
    killStartingServerProcessNow({ reason: 'sigterm' })
  })
}

// ── Resolve opencode binary ──────────────────────────────────────
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
    const resolvedFromEnv = selectResolvedCommand({
      output: envPath,
      isWindows: process.platform === 'win32',
    })
    if (resolvedFromEnv) {
      resolvedOpencodeCommand = resolvedFromEnv
      return resolvedFromEnv
    }
  }

  const isWindows = process.platform === 'win32'
  const whichCmd = isWindows ? 'where' : 'which'
  const result = errore.try({
    try: () => {
      const commandOutput = execFileSync(whichCmd, ['opencode'], {
        encoding: 'utf8',
        timeout: 5000,
      })
      const resolved = selectResolvedCommand({
        output: commandOutput,
        isWindows,
      })
      if (resolved) {
        return resolved
      }
      throw new Error('opencode not found in PATH')
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
  maxAttempts = 300,
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
      // Connection refused or other transient errors - continue polling.
      // Use 100ms interval instead of 1s so we detect readiness faster.
      // Critical for scale-to-zero cold starts where every ms matters.
      await new Promise((resolve) => setTimeout(resolve, 100))
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
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return new ServerStartError({
    port,
    reason: buildStartupTimeoutReason({
      maxAttempts,
      stderrTail: startupStderrTail,
    }),
  })
}

// ── Single server lifecycle ──────────────────────────────────────
// The server is started lazily on first initializeOpencodeForDirectory() call.
// It uses permissive defaults (edit: allow, bash: allow, external_directory: ask).
// Per-directory permissions are applied at session creation time instead.

// In-flight promise to prevent concurrent startups from racing
let startingServer: Promise<ServerStartError | SingleServer> | null = null

async function ensureSingleServer(): Promise<ServerStartError | SingleServer> {
  if (singleServer && !singleServer.process.killed) {
    return singleServer
  }

  // Deduplicate concurrent startup attempts
  if (startingServer) {
    return startingServer
  }

  startingServer = startSingleServer()
  try {
    return await startingServer
  } finally {
    startingServer = null
  }
}

async function startSingleServer(): Promise<ServerStartError | SingleServer> {
  ensureProcessCleanupHandlersRegistered()

  const port = await getOpenPort()

  const serveArgs = ['serve', '--port', port.toString()]
  if (store.getState().verboseOpencodeServer) {
    serveArgs.push('--print-logs', '--log-level', 'DEBUG')
  }

  const {
    command: spawnCommand,
    args: spawnArgs,
    windowsVerbatimArguments,
  } = getSpawnCommandAndArgs({
    resolvedCommand: resolveOpencodeCommand(),
    baseArgs: serveArgs,
  })

  // Server config uses permissive defaults. Per-directory external_directory
  // permissions are set at session creation time via session.create({ permission }).
  // Common directories (tmpdir, ~/.config/opencode, ~/.kimaki) are pre-allowed
  // at the server level so they never trigger permission prompts regardless of
  // whether session-level rules compose correctly.
  const tmpdir = os.tmpdir().replaceAll('\\', '/')
  const opencodeConfigDir = path
    .join(os.homedir(), '.config', 'opencode')
    .replaceAll('\\', '/')
  const kimakiDataDir = path
    .join(os.homedir(), '.kimaki')
    .replaceAll('\\', '/')
  const externalDirectoryPermissions: Record<string, 'ask' | 'allow' | 'deny'> = {
    '*': 'ask',
    '/tmp': 'allow',
    '/tmp/*': 'allow',
    '/private/tmp': 'allow',
    '/private/tmp/*': 'allow',
    [tmpdir]: 'allow',
    [`${tmpdir}/*`]: 'allow',
    [opencodeConfigDir]: 'allow',
    [`${opencodeConfigDir}/*`]: 'allow',
    [kimakiDataDir]: 'allow',
    [`${kimakiDataDir}/*`]: 'allow',
  }
  const kimakiShimDirectory = ensureKimakiCommandShim({
    dataDir: getDataDir(),
    execPath: process.execPath,
    execArgv: process.execArgv,
    entryScript: process.argv[1] || fileURLToPath(new URL('../bin.js', import.meta.url)),
  })
  const pathEnvKey = getPathEnvKey(process.env)
  const pathEnv = kimakiShimDirectory instanceof Error
    ? process.env[pathEnvKey]
    : prependPathEntry({
        entry: kimakiShimDirectory,
        existingPath: process.env[pathEnvKey],
      })
  if (kimakiShimDirectory instanceof Error) {
    opencodeLogger.warn(kimakiShimDirectory.message)
  }
  const gatewayToken = store.getState().gatewayToken

  const serverProcess = spawn(
    spawnCommand,
    spawnArgs,
    {
      stdio: 'pipe',
      detached: false,
      windowsVerbatimArguments,
      // No project-specific cwd — the server handles all directories via
      // x-opencode-directory header. Use home dir as a neutral working dir.
      cwd: os.homedir(),
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          lsp: false,
          formatter: false,
          plugin: [new URL('../src/kimaki-opencode-plugin.ts', import.meta.url).href],
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
        KIMAKI: '1',
        KIMAKI_DATA_DIR: getDataDir(),
        KIMAKI_LOCK_PORT: getLockPort().toString(),
        ...(gatewayToken && { KIMAKI_DB_AUTH_TOKEN: gatewayToken }),
        // Guard: prevents agents from running `kimaki` root command inside
        // an OpenCode session, which would steal the lock port and break the bot.
        KIMAKI_OPENCODE_PROCESS: '1',
        ...(getHranaUrl() && { KIMAKI_DB_URL: getHranaUrl()! }),
        ...(process.env.KIMAKI_SENTRY_DSN && {
          KIMAKI_SENTRY_DSN: process.env.KIMAKI_SENTRY_DSN,
        }),
        ...(pathEnv && { [pathEnvKey]: pathEnv }),
      },
    },
  )

  startingServerProcess = serverProcess

  // Buffer logs until we know if server started successfully.
  // Once ready, switch to forwarding if --verbose-opencode-server is set.
  const logBuffer: string[] = []
  const startupStderrTail: string[] = []
  let serverReady = false

  logBuffer.push(
    `Spawned opencode serve --port ${port} (pid: ${serverProcess.pid})`,
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
          opencodeLogger.log(`[server:${port}] ${line}`)
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
          opencodeLogger.error(`[server:${port}] ${line}`)
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
    if (startingServerProcess === serverProcess) {
      startingServerProcess = null
    }

    opencodeLogger.log(
      `Opencode server exited with code: ${code}, signal: ${signal}`,
    )
    singleServer = null
    clientCache.clear()
    notifyServerLifecycle({ type: 'stopped' })

    // Intentional kills (SIGTERM from cleanup/restart) should not trigger
    // auto-restart. Only unexpected crashes (non-zero exit without signal)
    // get retried.
    if (signal === 'SIGTERM') {
      serverRetryCount = 0
      return
    }
    if (code !== 0) {
      if (serverRetryCount < 5) {
        serverRetryCount += 1
        opencodeLogger.log(
          `Restarting server (attempt ${serverRetryCount}/5)`,
        )
        ensureSingleServer().then(
          (result) => {
            if (result instanceof Error) {
              opencodeLogger.error(`Failed to restart opencode server:`, result)
              void notifyError(result, `OpenCode server restart failed`)
            }
          },
        )
      } else {
        const crashError = new Error(
          `Server crashed too many times (5), not restarting`,
        )
        opencodeLogger.error(crashError.message)
        void notifyError(crashError, `OpenCode server crash loop exhausted`)
      }
    } else {
      serverRetryCount = 0
    }
  })

  const waitResult = await waitForServer({
    port,
    startupStderrTail,
  })
  if (waitResult instanceof Error) {
    killStartingServerProcessNow({ reason: 'startup-failed' })
    if (startingServerProcess === serverProcess) {
      startingServerProcess = null
    }

    // Dump buffered logs on failure
    opencodeLogger.error(`Server failed to start:`)
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
      opencodeLogger.log(`[server:${port}:startup] ${line}`)
    }
  }

  const server: SingleServer = {
    process: serverProcess,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
  }
  if (startingServerProcess === serverProcess) {
    startingServerProcess = null
  }
  singleServer = server
  notifyServerLifecycle({ type: 'started', port })
  return server
}

// ── Client cache ─────────────────────────────────────────────────
// One SDK client per directory, each with a fixed x-opencode-directory header.

function getOrCreateClient({
  baseUrl,
  directory,
}: {
  baseUrl: string
  directory: string
}): OpencodeClient {
  const cached = clientCache.get(directory)
  if (cached) {
    return cached
  }

  const fetchWithTimeout = (request: Request) =>
    fetch(request, {
      // @ts-ignore
      timeout: false,
    })

  const client = createOpencodeClient({
    baseUrl,
    directory,
    fetch: fetchWithTimeout as typeof fetch,
  })
  clientCache.set(directory, client)
  return client
}

// ── Public API ───────────────────────────────────────────────────
// Same signatures as before so callers don't need to change.

/**
 * Initialize OpenCode server for a directory.
 * Starts the single shared server if not running, then returns a client
 * factory scoped to the given directory via x-opencode-directory header.
 *
 * @param directory - The project directory to scope requests to
 * @param options.originalRepoDirectory - For worktrees: the original repo directory
 *   (no longer used for server-level permissions — use buildSessionPermissions
 *   at session.create() time instead)
 */
export async function initializeOpencodeForDirectory(
  directory: string,
  _options?: { originalRepoDirectory?: string; channelId?: string },
): Promise<OpenCodeErrors | (() => OpencodeClient)> {
  // Verify directory exists and is accessible
  const accessCheck = errore.tryFn({
    try: () => {
      fs.accessSync(directory, fs.constants.R_OK | fs.constants.X_OK)
    },
    catch: () => new DirectoryNotAccessibleError({ directory }),
  })
  if (accessCheck instanceof Error) {
    return accessCheck
  }

  const server = await ensureSingleServer()
  if (server instanceof Error) {
    return server
  }

  opencodeLogger.log(
    `Using shared server on port ${server.port} for directory: ${directory}`,
  )

  return () => {
    if (!singleServer) {
      throw new ServerNotReadyError({ directory })
    }
    return getOrCreateClient({
      baseUrl: singleServer.baseUrl,
      directory,
    })
  }
}

/**
 * Build per-session permission rules for external_directory access.
 * These rules are passed to session.create({ permission }) and override
 * the server-level defaults via opencode's findLast() evaluation.
 *
 * This replaces the old per-server OPENCODE_CONFIG_CONTENT external_directory
 * permissions — now each session carries its own directory-scoped rules.
 */
export function buildSessionPermissions({
  directory,
  originalRepoDirectory,
}: {
  directory: string
  originalRepoDirectory?: string
}): PermissionRuleset {
  // Normalize path separators for cross-platform compatibility (Windows uses backslashes)
  const tmpdir = os.tmpdir().replaceAll('\\', '/')
  const normalizedDirectory = directory.replaceAll('\\', '/')
  const originalRepo = originalRepoDirectory?.replaceAll('\\', '/')

  const rules: PermissionRuleset = [
    // Base rule: ask for unknown external directories
    { permission: 'external_directory', pattern: '*', action: 'ask' },
    // Allow tmpdir access
    { permission: 'external_directory', pattern: '/tmp', action: 'allow' },
    { permission: 'external_directory', pattern: '/tmp/*', action: 'allow' },
    { permission: 'external_directory', pattern: '/private/tmp', action: 'allow' },
    { permission: 'external_directory', pattern: '/private/tmp/*', action: 'allow' },
    { permission: 'external_directory', pattern: tmpdir, action: 'allow' },
    { permission: 'external_directory', pattern: `${tmpdir}/*`, action: 'allow' },
    // Allow the project directory itself
    { permission: 'external_directory', pattern: normalizedDirectory, action: 'allow' },
    { permission: 'external_directory', pattern: `${normalizedDirectory}/*`, action: 'allow' },
  ]

  // Allow ~/.config/opencode so the agent doesn't get permission prompts when
  // it tries to read the global AGENTS.md or opencode config (the path is
  // visible in the system prompt, so models sometimes try to read it).
  const opencodeConfigDir = path
    .join(os.homedir(), '.config', 'opencode')
    .replaceAll('\\', '/')
  rules.push(
    { permission: 'external_directory', pattern: opencodeConfigDir, action: 'allow' },
    { permission: 'external_directory', pattern: `${opencodeConfigDir}/*`, action: 'allow' },
  )

  // Allow ~/.kimaki so the agent can access kimaki data dir (logs, db, etc.)
  // without permission prompts.
  const kimakiDataDir = path
    .join(os.homedir(), '.kimaki')
    .replaceAll('\\', '/')
  rules.push(
    { permission: 'external_directory', pattern: kimakiDataDir, action: 'allow' },
    { permission: 'external_directory', pattern: `${kimakiDataDir}/*`, action: 'allow' },
  )

  // Allow opencode tool output artifacts under XDG data so agents can inspect
  // prior tool outputs without interactive permission prompts.
  const opencodeToolOutputDir = path
    .join(os.homedir(), '.local', 'share', 'opencode', 'tool-output')
    .replaceAll('\\', '/')
  rules.push(
    {
      permission: 'external_directory',
      pattern: opencodeToolOutputDir,
      action: 'allow',
    },
    {
      permission: 'external_directory',
      pattern: `${opencodeToolOutputDir}/*`,
      action: 'allow',
    },
  )

  // For worktrees: allow access to the original repository directory
  if (originalRepo) {
    rules.push(
      { permission: 'external_directory', pattern: originalRepo, action: 'allow' },
      { permission: 'external_directory', pattern: `${originalRepo}/*`, action: 'allow' },
    )
  }

  return rules
}

/**
 * Parse raw permission strings into PermissionRuleset entries.
 *
 * Accepted formats:
 *   "tool:action"           → { permission: tool, pattern: "*", action }
 *   "tool:pattern:action"   → { permission: tool, pattern,      action }
 *
 * The action must be one of "allow", "deny", "ask" (case-insensitive).
 * Parts are trimmed to tolerate whitespace from YAML deserialization.
 * Invalid entries are silently skipped (bad user input shouldn't crash the bot).
 * If `raw` is not an array, returns empty (defensive against malformed YAML markers).
 */
export function parsePermissionRules(raw: unknown): PermissionRuleset {
  if (!Array.isArray(raw)) {
    return []
  }
  const validActions = new Set(['allow', 'deny', 'ask'])
  return raw.flatMap((entry) => {
    if (typeof entry !== 'string') {
      return []
    }
    const parts = entry.split(':').map((s) => {
      return s.trim()
    })
    if (parts.length === 2) {
      const [permission, rawAction] = parts
      const action = rawAction!.toLowerCase()
      if (!permission || !validActions.has(action)) {
        return []
      }
      return [{ permission, pattern: '*', action: action as 'allow' | 'deny' | 'ask' }]
    }
    if (parts.length >= 3) {
      // Last segment is the action, first segment is the permission,
      // everything in between is the pattern (may contain colons in theory,
      // but unlikely for tool patterns).
      const permission = parts[0]!
      const rawAction = parts[parts.length - 1]!
      const action = rawAction.toLowerCase()
      const pattern = parts.slice(1, -1).join(':')
      if (!permission || !pattern || !validActions.has(action)) {
        return []
      }
      return [{ permission, pattern, action: action as 'allow' | 'deny' | 'ask' }]
    }
    return []
  })
}

// ── Public helpers ───────────────────────────────────────────────
// These helpers expose the single shared server and directory-scoped clients.

export function getOpencodeServerPort(_directory?: string): number | null {
  return singleServer?.port ?? null
}

export function getOpencodeClient(directory: string): OpencodeClient | null {
  if (!singleServer) {
    return null
  }
  return getOrCreateClient({
    baseUrl: singleServer.baseUrl,
    directory,
  })
}

/**
 * Stop the single opencode server.
 * Used for process teardown, tests, and explicit restarts.
 */
export async function stopOpencodeServer(): Promise<boolean> {
  if (!singleServer) {
    return false
  }

  const server = singleServer
  opencodeLogger.log(
    `Stopping opencode server (pid: ${server.process.pid}, port: ${server.port})`,
  )
  if (!server.process.killed) {
    const killResult = errore.try({
      try: () => {
        server.process.kill('SIGTERM')
      },
      catch: (error) => {
        return new Error('Failed to send SIGTERM to opencode server', {
          cause: error,
        })
      },
    })
    if (killResult instanceof Error) {
      opencodeLogger.warn(killResult.message)
    }
  }

  killStartingServerProcessNow({ reason: 'stop-opencode-server' })
  startingServerProcess = null

  singleServer = null
  clientCache.clear()
  serverRetryCount = 0
  await new Promise((resolve) => {
    setTimeout(resolve, 1000)
  })
  return true
}

/**
 * Restart the single opencode server.
 * Kills the existing process and starts a new one.
 * All directory clients are invalidated and recreated on next use.
 * Used for resolving opencode state issues, refreshing auth, plugins, etc.
 */
export async function restartOpencodeServer(): Promise<OpenCodeErrors | true> {
  if (singleServer) {
    await stopOpencodeServer()
  }

  // Reset retry count for the fresh start
  serverRetryCount = 0

  const result = await ensureSingleServer()
  if (result instanceof Error) {
    return result
  }
  return true
}
