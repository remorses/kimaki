// OpenCode single-server process manager.
//
// Architecture: ONE opencode serve process shared by all project directories.
// Each SDK client uses the x-opencode-directory header to scope requests to a
// specific project. The server lazily creates and caches an Instance per unique
// directory path internally.
//
// Native V2 permissions: agent rules, then session overrides (last match wins).
// A configured deny blocks before saved approvals; saved allows can satisfy ask.
// Broad directory allows stay in generated config so project policy can win.
// Session overrides carry original-checkout file restrictions and explicit CLI
// rules, not defaults. File-tool permissions do not sandbox shell execution.
//
// Uses errore for type-safe error handling.

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import { randomBytes } from 'node:crypto'
import { OpenCode, type OpenCodeClient, type PermissionRuleset } from '@opencode/client'
import {
  DEFAULT_PRESET_NAME,
  loadModelsDevCatalog,
  loadPresets,
  modelsDevInputModalities,
  modelsDevLimit,
  PROVIDER_DISPLAY_NAME,
  PROVIDER_ID,
  resolveCandidates,
  resolvePresetModels,
} from '@subrouter/cli'
import { applyPatchApiId, shouldUseApplyPatch } from '@subrouter/opencode/provider'
import { resolveOpencode2Command } from './opencode2.js'

export type OpencodeClient = OpenCodeClient

import {
  restartGlobalEventListener,
  waitForGlobalEventListener,
} from './session-handler/global-event-listener.js'
import {
  getDataDir,
  getLockPort,
  getRestrictExternalDirectories,
  getOpencodeHostname,
  getOpencodePort,
} from './config.js'
import { store } from './store.js'
import { getHranaUrl } from './hrana-server.js'

export function resolveSubrouterPluginSpec({ isDev }: { isDev: boolean }) {
  const require = createRequire(import.meta.url)
  const entry = require.resolve('@subrouter/opencode')
  if (isDev) return pathToFileURL(entry).href

  const packageJsonPath = require.resolve('@subrouter/opencode/package.json')
  const version = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version
  if (typeof version !== 'string' || !version) {
    throw new Error(`Missing @subrouter/opencode version in ${packageJsonPath}`)
  }
  return `@subrouter/opencode@${version}`
}

export async function buildSubrouterProviderConfig() {
  const require = createRequire(import.meta.url)
  // Native v2 loads AI SDK factories only through the aisdk: prefix. A bare
  // file:// package is treated as a native ProviderPackage and never calls
  // createSubrouter(), so the generated provider is present but unused.
  const packageEntry = `aisdk:${pathToFileURL(require.resolve('@subrouter/opencode/provider')).href}`
  const presets = await loadPresets().catch(() => ({
    version: 1 as const,
    presets: {},
  }))
  const catalog = await loadModelsDevCatalog({})
  const names = new Set([DEFAULT_PRESET_NAME, ...Object.keys(presets.presets)])
  const takenApiIds = new Set<string>()
  const presetByApiId: Record<string, string> = {}
  const models = Object.fromEntries(
    await Promise.all(
      [...names].map(async (name) => {
        const presetModels = await resolvePresetModels(name)
        const candidates =
          presetModels instanceof Error
            ? []
            : (await resolveCandidates({ presetModels })).candidates
        const candidate = candidates[0]
        const input = new Set<'text' | 'audio' | 'image' | 'video' | 'pdf'>(['text'])
        for (const current of candidates) {
          const modalities = modelsDevInputModalities({
            provider: current.provider,
            modelId: current.modelId,
            catalog,
          })
          for (const modality of modalities ?? []) input.add(modality)
        }
        const limit = candidate
          ? modelsDevLimit({
              provider: candidate.provider,
              modelId: candidate.modelId,
              catalog,
            })
          : null
        const apiId =
          candidate && shouldUseApplyPatch(candidate.modelId)
            ? applyPatchApiId({
                preset: name,
                modelId: candidate.modelId,
                taken: takenApiIds,
              })
            : null
        if (apiId) {
          takenApiIds.add(apiId)
          presetByApiId[apiId] = name
        }
        return [
          name,
          {
            name,
            ...(apiId && { modelID: apiId }),
            capabilities: {
              tools: true,
              input: [...input],
              output: ['text'],
            },
            cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
            limit: limit ?? { context: 200_000, output: 64_000 },
          },
        ]
      }),
    ),
  )
  return {
    [PROVIDER_ID]: {
      name: PROVIDER_DISPLAY_NAME,
      package: packageEntry,
      settings: { presetByApiId },
      models,
    },
  }
}

type PermissionAction = 'ask' | 'allow' | 'deny'
import * as errore from 'errore'
import { createLogger, LogPrefix } from './logger.js'
import { notifyError } from './sentry.js'
import {
  DirectoryNotAccessibleError,
  ServerStartError,
  ServerNotReadyError,
  FetchError,
  OpenCodeSdkError,
  type OpenCodeErrors,
} from './errors.js'
import {
  ensureKimakiCommandShim,
  getIncompatibleOpencodeVersionError,
  getPathEnvKey,
  getSpawnCommandAndArgs,
  prependPathEntry,
  selectResolvedCommand,
} from './opencode-command.js'
import { skillPermissionRules } from './skill-filter.js'

const opencodeLogger = createLogger(LogPrefix.OPENCODE)

/**
 * Build Basic auth headers from OPENCODE_SERVER_PASSWORD env var.
 * Returns empty object when no password is set.
 */
export function getOpencodeServerAuthHeaders({
  password,
}: {
  password?: string
} = {}): Record<string, string> {
  const serverPassword =
    password || process.env.OPENCODE_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD
  if (!serverPassword) return {}
  const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode'
  const encoded = Buffer.from(`${username}:${serverPassword}`).toString('base64')
  return { Authorization: `Basic ${encoded}` }
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1'])

export function publicOpencodeBindRequiresPassword({
  hostname,
}: {
  hostname: string | null | undefined
}): boolean {
  if (!hostname) return false
  return !LOOPBACK_HOSTNAMES.has(hostname)
}

// Always pass --hostname so opencode.json server.hostname / mdns cannot bind 0.0.0.0.
const DEFAULT_OPENCODE_HOSTNAME = '127.0.0.1'

export function buildOpencodeServeArgs({
  port,
  hostname,
}: {
  port: number
  hostname?: string | null
}): string[] {
  return ['serve', '--port', port.toString(), '--hostname', hostname || DEFAULT_OPENCODE_HOSTNAME]
}

// Tracks directories that have been initialized, to avoid repeated log spam
// from the external sync polling loop.
const initializedDirectories = new Set<string>()

const STARTUP_STDERR_TAIL_LIMIT = 30
const STARTUP_STDERR_LINE_MAX_LENGTH = 120
const STARTUP_ERROR_REASON_MAX_LENGTH = 1500
const ANSI_ESCAPE_REGEX =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g

export async function requestHealthcheck({
  url,
  timeoutMs = 2000,
  headers,
  signal,
}: {
  url: string
  timeoutMs?: number
  headers?: Record<string, string>
  signal?: AbortSignal
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timeout: NodeJS.Timeout | null = null
    const settle = (handler: () => void) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      handler()
    }
    const onAbort = () => {
      settle(() => {
        req.destroy()
        reject(signal?.reason instanceof Error ? signal.reason : new Error('Health check aborted'))
      })
    }

    const req = http.request(
      url,
      {
        method: 'GET',
        headers: {
          connection: 'close',
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
        res.on('end', () => {
          settle(() => {
            resolve({
              status: res.statusCode || 0,
              body: Buffer.concat(chunks).toString('utf-8'),
            })
          })
        })
        res.on('error', (error) => {
          settle(() => reject(error))
        })
      },
    )
    req.on('error', (error) => {
      settle(() => reject(error))
    })
    timeout = setTimeout(() => {
      settle(() => {
        req.destroy()
        reject(new Error(`Health check request timed out after ${timeoutMs}ms`))
      })
    }, timeoutMs)
    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
    req.end()
  })
}

export function isOpencodeServerReadyResponse({ status }: { status: number }) {
  return status === 200
}

export function parseOpencodeServerDiscovery(body: string): {
  port: number
  password: string
} | null {
  const parsed = errore.try(
    () => JSON.parse(body) as unknown,
    (cause) => new Error('Invalid OpenCode server discovery response', { cause }),
  )
  if (parsed instanceof Error || typeof parsed !== 'object' || parsed === null) {
    return null
  }
  if (!('port' in parsed) || !('password' in parsed)) return null
  const { port, password } = parsed
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return null
  }
  if (typeof password !== 'string' || password.length === 0) return null
  return { port, password }
}

function truncateWithEllipsis({ value, maxLength }: { value: string; maxLength: number }): string {
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

function sanitizeOutputLine(line: string): string {
  return stripAnsiCodes(line).trim()
}

function sanitizeForCodeFence(line: string): string {
  return line.replaceAll('```', '`\u200b``')
}

function pushStartupStderrTail({ stderrTail, line }: { stderrTail: string[]; line: string }): void {
  const sanitizedLine = sanitizeOutputLine(line)
  if (sanitizedLine.length === 0) {
    return
  }

  const truncatedLine = truncateWithEllipsis({
    value: sanitizeForCodeFence(sanitizedLine),
    maxLength: STARTUP_STDERR_LINE_MAX_LENGTH,
  })

  stderrTail.push(truncatedLine)
  if (stderrTail.length > STARTUP_STDERR_TAIL_LIMIT) {
    stderrTail.splice(0, stderrTail.length - STARTUP_STDERR_TAIL_LIMIT)
  }
}

function subscribeToProcessLogStream({
  stream,
  onLine,
}: {
  stream: NodeJS.ReadableStream | null | undefined
  onLine: (line: string) => void
}): readline.Interface | null {
  if (!stream) {
    return null
  }

  const logReader = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  })

  logReader.on('line', (line) => {
    const sanitizedLine = sanitizeOutputLine(line)
    if (sanitizedLine.length === 0) {
      return
    }
    onLine(sanitizedLine)
  })

  return logReader
}

function formatStartupStderrReason({
  baseReason,
  stderrTail,
}: {
  baseReason: string
  stderrTail: string[]
}): string {
  if (stderrTail.length === 0) {
    return baseReason
  }

  const formatReason = ({ lines, omitted }: { lines: string[]; omitted: number }): string => {
    const omittedLine =
      omitted > 0 ? `[... ${omitted} older stderr lines omitted to fit Discord ...]\n` : ''
    const stderrCodeBlock = `${omittedLine}${lines.join('\n')}`
    return `${baseReason}\nLast opencode stderr lines:\n\`\`\`text\n${stderrCodeBlock}\n\`\`\``
  }

  let lines = [...stderrTail]
  let omitted = 0
  let formattedReason = formatReason({ lines, omitted })

  while (formattedReason.length > STARTUP_ERROR_REASON_MAX_LENGTH && lines.length > 0) {
    lines = lines.slice(1)
    omitted += 1
    formattedReason = formatReason({ lines, omitted })
  }

  return truncateWithEllipsis({
    value: formattedReason,
    maxLength: STARTUP_ERROR_REASON_MAX_LENGTH,
  })
}

function buildStartupTimeoutReason({
  maxAttempts,
  stderrTail,
}: {
  maxAttempts: number
  stderrTail: string[]
}): string {
  const timeoutSeconds = Math.round((maxAttempts * 100) / 1000)
  return formatStartupStderrReason({
    baseReason: `Server did not start after ${timeoutSeconds} seconds`,
    stderrTail,
  })
}

function describeChildExit({
  code,
  signal,
}: {
  code: number | null
  signal: NodeJS.Signals | null
}): string {
  if (signal) return `signal ${signal}`
  if (code === null) return 'an unknown exit'
  return `code ${code}`
}

export async function waitForServer({
  port,
  password,
  directory,
  maxAttempts = 300,
  startupStderrTail,
  child,
}: {
  port: number
  password: string
  directory?: string
  maxAttempts?: number
  startupStderrTail: string[]
  child?: ChildProcess | null
}): Promise<ServerStartError | true> {
  const endpoint = new URL(`http://127.0.0.1:${port}/api/session/active`)
  if (directory) {
    endpoint.searchParams.set('directory', directory)
  }

  const childExit: { code: number | null; signal: NodeJS.Signals | null } = {
    code: null,
    signal: null,
  }
  const healthcheckAbort = new AbortController()
  const onChildExit = (code: number | null, signal: NodeJS.Signals | null) => {
    childExit.code = code
    childExit.signal = signal
    if (!healthcheckAbort.signal.aborted) {
      healthcheckAbort.abort()
    }
  }
  child?.once('exit', onChildExit)
  if (child?.exitCode !== null && child?.exitCode !== undefined) {
    onChildExit(child.exitCode, child.signalCode)
  }

  const childHasExited = () => {
    return Boolean(
      child && (child.exitCode !== null || childExit.code !== null || childExit.signal),
    )
  }
  const exitedBeforeReady = () => {
    const code = child?.exitCode ?? childExit.code ?? null
    const signal = child?.signalCode ?? childExit.signal ?? null
    return new ServerStartError({
      port,
      reason: formatStartupStderrReason({
        baseReason: `Server process exited with ${describeChildExit({ code, signal })} before becoming ready`,
        stderrTail: startupStderrTail,
      }),
    })
  }

  try {
    for (let i = 0; i < maxAttempts; i++) {
      if (childHasExited()) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve)
        })
        return exitedBeforeReady()
      }

      const response = await requestHealthcheck({
        url: endpoint.toString(),
        headers: getOpencodeServerAuthHeaders({ password }),
        signal: healthcheckAbort.signal,
      }).catch((e) => new FetchError({ url: endpoint.toString(), cause: e }))

      if (childHasExited()) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve)
        })
        return exitedBeforeReady()
      }

      if (response instanceof Error) {
        // Connection refused or other transient errors - continue polling.
        // Use 100ms interval instead of 1s so we detect readiness faster.
        // Critical for scale-to-zero cold starts where every ms matters.
        await new Promise((resolve) => setTimeout(resolve, 100))
        continue
      }
      if (isOpencodeServerReadyResponse(response)) return true
      if (response.status === 401 || response.status === 403) {
        return new ServerStartError({
          port,
          reason: `Readiness probe was rejected with HTTP ${response.status}`,
        })
      }
      const body = response.body
      // Fatal errors that won't resolve with retrying
      if (body.includes('BunInstallFailedError')) {
        return new ServerStartError({ port, reason: body.slice(0, 200) })
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  } finally {
    child?.off('exit', onChildExit)
  }

  return new ServerStartError({
    port,
    reason: buildStartupTimeoutReason({
      maxAttempts,
      stderrTail: startupStderrTail,
    }),
  })
}

// ── Single server state ──────────────────────────────────────────
// One opencode serve process, shared by all project directories.
// Clients are created per-directory with the x-opencode-directory header.

type SingleServer = {
  process: ChildProcess | null
  port: number
  baseUrl: string
  password: string
  /** True when this server was discovered from the bot's hrana endpoint,
   *  not spawned by this process. We must not kill it on cleanup. */
  discovered?: boolean
}

type ServerLifecycleEvent = { type: 'started'; port: number } | { type: 'stopped' }

let singleServer: SingleServer | null = null
let serverRetryCount = 0
const serverLifecycleListeners = new Set<(event: ServerLifecycleEvent) => void>()
let processCleanupHandlersRegistered = false
let startingServerProcess: ChildProcess | null = null
let stoppingServer: Promise<boolean> | null = null
const intentionallyStoppedChildren = new WeakSet<ChildProcess>()
const clientCache = new Map<string, OpencodeClient>()
const STOP_CHILD_EXIT_TIMEOUT_MS = 500

function notifyServerLifecycle(event: ServerLifecycleEvent): void {
  for (const listener of serverLifecycleListeners) {
    listener(event)
  }
}

function clearSingleServer(): boolean {
  if (!singleServer) return false
  singleServer = null
  clientCache.clear()
  notifyServerLifecycle({ type: 'stopped' })
  return true
}

function releaseServerOwnedByChild(child: ChildProcess): boolean {
  if (singleServer?.process !== child) return false
  return clearSingleServer()
}

function waitForChildExit({
  child,
  timeoutMs = STOP_CHILD_EXIT_TIMEOUT_MS,
}: {
  child: ChildProcess
  timeoutMs?: number
}): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)

  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timeout)
      resolve(true)
    }
    const timeout = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs)
    child.once('exit', onExit)
  })
}

async function terminateChildProcess({
  child,
  reason,
  label,
}: {
  child: ChildProcess
  reason: string
  label: string
}): Promise<boolean> {
  sendSigtermToChild({ child, reason, label })
  const exitedGracefully = await waitForChildExit({ child })
  if (exitedGracefully) return true
  if (!child.pid) return child.exitCode !== null || child.signalCode !== null

  const forceResult = errore.try(
    () => process.kill(child.pid!, 'SIGKILL'),
    (error) => new Error('Failed to force-stop OpenCode server', { cause: error }),
  )
  if (forceResult instanceof Error) {
    opencodeLogger.warn(forceResult.message)
    return false
  }
  const exitedAfterKill = await waitForChildExit({ child })
  if (!exitedAfterKill) {
    opencodeLogger.warn(`OpenCode server did not exit after SIGKILL (pid: ${child.pid})`)
    return false
  }
  return true
}

export function subscribeOpencodeServerLifecycle(
  listener: (event: ServerLifecycleEvent) => void,
): () => void {
  serverLifecycleListeners.add(listener)
  return () => {
    serverLifecycleListeners.delete(listener)
  }
}

function markChildIntentionallyStopped(child: ChildProcess | null | undefined): void {
  if (!child) return
  intentionallyStoppedChildren.add(child)
}

function sendSigtermToChild({
  child,
  reason,
  label,
}: {
  child: ChildProcess
  reason: string
  label: string
}): void {
  markChildIntentionallyStopped(child)
  const pid = child.pid
  if (!pid || child.killed) {
    return
  }

  const killResult = errore.try(
    () => {
      child.kill('SIGTERM')
    },
    (error) => {
      return new Error(`Failed to send SIGTERM to ${label}`, {
        cause: error,
      })
    },
  )

  if (killResult instanceof Error) {
    opencodeLogger.warn(`[cleanup:${reason}] ${killResult.message} (pid: ${pid})`)
    return
  }

  opencodeLogger.log(`[cleanup:${reason}] Sent SIGTERM to ${label} (pid: ${pid})`)
}

function killSingleServerProcessNow({ reason }: { reason: string }): void {
  if (!singleServer) {
    return
  }

  // Never kill a server we didn't spawn (discovered from another process)
  if (singleServer.discovered || !singleServer.process) {
    return
  }

  sendSigtermToChild({
    child: singleServer.process,
    reason,
    label: `opencode server (port: ${singleServer.port})`,
  })
}

function killStartingServerProcessNow({ reason }: { reason: string }): void {
  if (!startingServerProcess) {
    return
  }

  sendSigtermToChild({
    child: startingServerProcess,
    reason,
    label: 'starting opencode server',
  })
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

  // Fallback for CLI subcommands without their own signal handling. Any signal
  // listener disables Node's default exit, so if we are the only listener we
  // must exit ourselves. Otherwise the process ignores Ctrl+C and, in the bot,
  // keeps holding the hrana lock port. If another owner exists (the bot
  // lifecycle handlers, a subcommand), it decides when to exit.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      killSingleServerProcessNow({ reason: signal.toLowerCase() })
      killStartingServerProcessNow({ reason: signal.toLowerCase() })
      if (process.listenerCount(signal) > 1) {
        return
      }
      process.exit(128 + os.constants.signals[signal])
    })
  }
}

// ── Resolve opencode binary ──────────────────────────────────────
// Resolve the full path to the opencode binary so we can spawn without
// shell: true. Using shell: true creates an intermediate sh process — when
// cleanup sends SIGTERM it only kills the shell, leaving the actual opencode
// process orphaned (reparented to PID 1). Resolving the path upfront lets
// us spawn the binary directly and SIGTERM reaches the right process.
//
// Resolution order:
// 1. OPENCODE_PATH env var (explicit user override)
// 2. `which opencode` / `where opencode` (system PATH)
// 3. Fall back to bare "opencode" (spawn will fail with a clear error)
//
// OpenCode must be installed globally before running kimaki. The bot startup
// checks for it via ensureCommandAvailable and prompts to install if missing.

let resolvedOpencodeCommand: string | null = null

export function resolveOpencodeCommand(): string {
  const envPath = process.env.OPENCODE2_PATH || process.env.OPENCODE_PATH
  if (envPath) {
    resolvedOpencodeCommand = envPath
    opencodeLogger.log(`Resolved opencode2 binary from env: ${envPath}`)
    return envPath
  }

  if (resolvedOpencodeCommand) {
    return resolvedOpencodeCommand
  }

  const resolved = resolveOpencode2Command()
  resolvedOpencodeCommand = resolved
  opencodeLogger.log(`Resolved opencode2 binary: ${resolved}`)
  return resolved
}

export async function assertCompatibleOpencodeVersion({
  resolvedCommand = resolveOpencodeCommand(),
}: {
  resolvedCommand?: string
} = {}): Promise<OpencodeIncompatibleVersionError | true> {
  const { command, args } = getSpawnCommandAndArgs({
    resolvedCommand,
    baseArgs: ['--version'],
  })
  const result = await execAsync(
    { command, args },
    { timeout: 5000, encoding: 'utf8' },
  ).catch((cause) => {
    return new Error('Failed to read OpenCode version', { cause })
  })
  if (result instanceof Error) {
    opencodeLogger.warn(result.message)
    return true
  }
  const incompatible = getIncompatibleOpencodeVersionError(
    `${result.stdout}\n${result.stderr}`,
  )
  if (incompatible) return incompatible
  return true
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

// ── Single server lifecycle ──────────────────────────────────────
// The server is started lazily on first initializeOpencodeForDirectory() call.
// It uses permissive defaults (edit: allow, bash: allow, webfetch: allow, and
// external_directory: '*' allow unless --restrict-directories is set).

// In-flight promise to prevent concurrent startups from racing
let startingServer: Promise<
  ServerStartError | OpencodeIncompatibleVersionError | SingleServer
> | null = null
let preferredStartupDirectory: string | null = null

function ensureOpencodeHomeDirectories({ directories }: { directories: Record<string, string> }) {
  Object.values(directories).map((directory) => {
    fs.mkdirSync(directory, { recursive: true })
  })
}

/**
 * Try to discover an OpenCode server already running in the bot process.
 * Queries the hrana server on the lock port for the OpenCode server port,
 * then verifies the server is healthy. Returns null if no server found.
 */
async function discoverExistingServer(): Promise<SingleServer | null> {
  const lockPort = getLockPort()
  const serviceAuthToken = store.getState().gatewayToken
  if (!serviceAuthToken) return null
  const portResponse = await requestHealthcheck({
    url: `http://127.0.0.1:${lockPort}/kimaki/opencode-port`,
    timeoutMs: 2000,
    headers: { Authorization: `Bearer ${serviceAuthToken}` },
  }).catch(() => null)
  if (!portResponse || portResponse.status !== 200) return null
  const discovered = parseOpencodeServerDiscovery(portResponse.body)
  if (!discovered) return null

  const healthResponse = await requestHealthcheck({
    url: `http://127.0.0.1:${discovered.port}/api/session/active`,
    timeoutMs: 2000,
    headers: getOpencodeServerAuthHeaders({ password: discovered.password }),
  }).catch(() => null)
  if (!healthResponse || !isOpencodeServerReadyResponse(healthResponse)) return null

  opencodeLogger.log(
    `Discovered existing OpenCode server on port ${discovered.port} via hrana lock port ${lockPort}`,
  )
  return {
    process: null,
    port: discovered.port,
    baseUrl: `http://127.0.0.1:${discovered.port}`,
    password: discovered.password,
    discovered: true,
  }
}

function stoppedDuringStartupError(port: number) {
  return new ServerStartError({
    port,
    reason: 'OpenCode server stopped during startup',
  })
}

async function ensureSingleServer({
  directory,
}: {
  directory?: string
} = {}): Promise<ServerStartError | OpencodeIncompatibleVersionError | SingleServer> {
  const startupDirectory = directory || preferredStartupDirectory || undefined
  for (;;) {
    if (stoppingServer) {
      await stoppingServer
      continue
    }
    if (singleServer) return singleServer
    // Deduplicate concurrent startup attempts (covers both discovery and spawn)
    if (startingServer) return startingServer

    // Wrap discovery + spawn in a single shared promise so concurrent callers
    // don't each run discoverExistingServer() and then each spawn a server.
    const startup = (async () => {
      // Try to discover an already-running server from the bot process via
      // the hrana server's /kimaki/opencode-port endpoint. This lets CLI
      // subcommands (kimaki session list, archive, wait, etc.) reuse the
      // bot's OpenCode server instead of spawning a redundant one.
      const discovered = await discoverExistingServer()
      if (discovered) {
        if (stoppingServer) return stoppedDuringStartupError(discovered.port)
        singleServer = discovered
        return discovered
      }

      return startSingleServer({ directory: startupDirectory })
    })()
    startingServer = startup

    try {
      return await startup
    } finally {
      if (startingServer === startup) startingServer = null
    }
  }
}

async function startSingleServer({
  directory,
}: {
  directory?: string
} = {}): Promise<ServerStartError | SingleServer> {
  ensureProcessCleanupHandlersRegistered()
  if (stoppingServer) return stoppedDuringStartupError(getOpencodePort() ?? 0)

  const configuredPort = getOpencodePort()
  const port = configuredPort ?? (await getOpenPort())
  if (stoppingServer) return stoppedDuringStartupError(port)
  const hostname = getOpencodeHostname() ?? DEFAULT_OPENCODE_HOSTNAME

  if (
    publicOpencodeBindRequiresPassword({ hostname }) &&
    !process.env.OPENCODE_PASSWORD &&
    !process.env.OPENCODE_SERVER_PASSWORD
  ) {
    return new ServerStartError({
      port,
      reason: `OPENCODE_SERVER_PASSWORD is required when --opencode-hostname is ${hostname}`,
    })
  }

  const serverPassword =
    process.env.OPENCODE_PASSWORD ||
    process.env.OPENCODE_SERVER_PASSWORD ||
    randomBytes(32).toString('base64url')
  process.env.OPENCODE_PASSWORD = serverPassword
  process.env.OPENCODE_SERVER_PASSWORD = serverPassword

  const serveArgs = buildOpencodeServeArgs({ port, hostname })

  const {
    command: spawnCommand,
    args: spawnArgs,
    windowsVerbatimArguments,
  } = getSpawnCommandAndArgs({
    resolvedCommand: resolveOpencodeCommand(),
    baseArgs: serveArgs,
  })

  // Server config uses permissive defaults. By default every external directory
  // is allowed: opencode's own 'ask' default produced constant permission
  // prompts for ordinary reads, and users who want protection can add their own
  // `deny`/`ask` rules in opencode.json (project config is loaded after this
  // file, so it wins).
  // With --restrict-directories the old behaviour comes back: only a small set
  // of known-safe paths is pre-allowed and everything else falls through to the
  // user's opencode.json default (which is 'ask' unless they changed it).
  const externalDirectoryPermissions = buildServerExternalDirectoryPermissions()
  const kimakiShimDirectory = ensureKimakiCommandShim({
    dataDir: getDataDir(),
    execPath: process.execPath,
    execArgv: process.execArgv,
    entryScript: process.argv[1] || fileURLToPath(new URL('../bin.js', import.meta.url)),
  })
  const pathEnvKey = getPathEnvKey(process.env)
  const pathEnv =
    kimakiShimDirectory instanceof Error
      ? process.env[pathEnvKey]
      : prependPathEntry({
          entry: kimakiShimDirectory,
          existingPath: process.env[pathEnvKey],
        })
  if (kimakiShimDirectory instanceof Error) {
    opencodeLogger.warn(kimakiShimDirectory.message)
  }
  const gatewayToken = store.getState().gatewayToken
  const vitestOpencodeEnv = (() => {
    if (process.env.KIMAKI_VITEST !== '1') {
      return {}
    }
    const root = path.join(getDataDir(), 'opencode-vitest-home')
    const directories = {
      OPENCODE_TEST_HOME: root,
      OPENCODE_CONFIG_DIR: path.join(root, '.opencode-kimaki'),
      XDG_CONFIG_HOME: path.join(root, '.config'),
      XDG_DATA_HOME: path.join(root, '.local', 'share'),
      XDG_CACHE_HOME: path.join(root, '.cache'),
      XDG_STATE_HOME: path.join(root, '.local', 'state'),
    }
    // OpenCode writes state/config files into these XDG locations during boot.
    // In CI, a fresh temp data dir means the parent folders may not exist yet,
    // and some writes fail closed with NotFound before OpenCode has a chance to
    // create them lazily. Pre-create the directories so startup-time tests do
    // not flap based on process scheduling.
    ensureOpencodeHomeDirectories({ directories })
    return directories
  })()

  // Write config to a file instead of passing via OPENCODE_CONFIG_CONTENT env var.
  // OPENCODE_CONFIG (file path) is loaded before project config in opencode's
  // priority chain, so project-level opencode.json can override kimaki defaults.
  // OPENCODE_CONFIG_CONTENT was loaded last and overrode user project configs,
  // causing issue #90 (project permissions not being respected).
  const kimakiPluginDirectory = path.join(
    __dirname,
    path.basename(__dirname) === 'src' ? '../dist/kimaki-opencode-plugin' : 'kimaki-opencode-plugin',
  )
  if (!fs.existsSync(path.join(kimakiPluginDirectory, 'index.js'))) {
    return new ServerStartError({
      port,
      reason: `Built Kimaki OpenCode plugin not found at ${kimakiPluginDirectory}. Run pnpm tsc in cli.`,
    })
  }
  const opencodeConfig = {
    $schema: 'https://opencode.ai/config.json',
    lsp: false,
    formatter: false,
    media: {
      image: {
        auto_resize: true,
        max_width: 2000,
        max_height: 2000,
        max_base64_bytes: 4 * 1024 * 1024,
      },
    },
    plugins: [kimakiPluginDirectory],
    providers: await buildSubrouterProviderConfig(),
    permissions: [
      { action: 'edit', resource: '*', effect: 'allow' as const },
      { action: 'shell', resource: '*', effect: 'allow' as const },
      { action: 'read', resource: '*', effect: 'allow' as const },
      { action: 'question', resource: '*', effect: 'allow' as const },
      ...Object.entries(externalDirectoryPermissions).map(([resource, effect]) => {
        return {
          action: 'external_directory' as const,
          resource,
          effect,
        }
      }),
      ...skillPermissionRules({
        enabledSkills: store.getState().enabledSkills,
        disabledSkills: store.getState().disabledSkills,
      }),
    ],
  }
  const opencodeConfigPath = path.join(getDataDir(), 'opencode-config.json')
  const opencodeConfigJson = JSON.stringify(opencodeConfig, null, 2)
  const existingContent = (() => {
    try {
      return fs.readFileSync(opencodeConfigPath, 'utf-8')
    } catch {
      return ''
    }
  })()
  if (existingContent !== opencodeConfigJson) {
    fs.writeFileSync(opencodeConfigPath, opencodeConfigJson)
  }
  if (stoppingServer) return stoppedDuringStartupError(port)

  const serverProcess = spawn(spawnCommand, spawnArgs, {
    stdio: 'pipe',
    detached: false,
    windowsVerbatimArguments,
    // No project-specific cwd — the server handles all directories via
    // x-opencode-directory header. Use home dir as a neutral working dir.
    cwd: os.homedir(),
    env: {
      ...process.env,
      OPENCODE_CONFIG: opencodeConfigPath,
      OPENCODE_PASSWORD: serverPassword,
      OPENCODE_SERVER_PASSWORD: serverPassword,
      OPENCODE_CONFIG_CONTENT: undefined,
      OPENCODE_PORT: port.toString(),
      KIMAKI: '1',
      // The browser is not on this machine, so no localhost callback fires.
      SUBROUTER_MANUAL_OAUTH: '1',
      OPENCODE_EXPERIMENTAL_WORKSPACES: 'true',
      OPENCODE_ENABLE_EXA: '1',
      KIMAKI_DATA_DIR: getDataDir(),
      KIMAKI_LOCK_PORT: getLockPort().toString(),
      KIMAKI_PARENT_LOCK_PORT: getLockPort().toString(),
      ...(gatewayToken && { KIMAKI_DB_AUTH_TOKEN: gatewayToken }),
      // Guard: prevents agents from running `kimaki` root command inside
      // an OpenCode session, which would steal the lock port and break the bot.
      KIMAKI_OPENCODE_PROCESS: '1',
      ...(getHranaUrl() && { KIMAKI_DB_URL: getHranaUrl()! }),
      ...(process.env.KIMAKI_SENTRY_DSN && {
        KIMAKI_SENTRY_DSN: process.env.KIMAKI_SENTRY_DSN,
      }),
      ...vitestOpencodeEnv,
      ...(pathEnv && { [pathEnvKey]: pathEnv }),
    },
  })

  startingServerProcess = serverProcess
  if (stoppingServer) {
    await terminateChildProcess({
      child: serverProcess,
      reason: 'stop-opencode-server',
      label: 'starting opencode server',
    })
    if (startingServerProcess === serverProcess) {
      startingServerProcess = null
    }
    return stoppedDuringStartupError(port)
  }

  // Buffer logs until we know if server started successfully.
  const logBuffer: string[] = []
  const startupStderrTail: string[] = []
  let serverReady = false

  logBuffer.push(`Spawned opencode ${serveArgs.join(' ')} (pid: ${serverProcess.pid})`)

  const stdoutReader = subscribeToProcessLogStream({
    stream: serverProcess.stdout,
    onLine: (line) => {
      if (!serverReady) {
        logBuffer.push(`[stdout] ${line}`)
        return
      }
      opencodeLogger.log(line)
    },
  })

  const stderrReader = subscribeToProcessLogStream({
    stream: serverProcess.stderr,
    onLine: (line) => {
      if (!serverReady) {
        logBuffer.push(`[stderr] ${line}`)
        pushStartupStderrTail({ stderrTail: startupStderrTail, line })
        return
      }
      opencodeLogger.error(line)
    },
  })

  serverProcess.on('error', (error) => {
    logBuffer.push(`Failed to start server on port ${port}: ${error}`)
  })

  serverProcess.on('exit', (code, signal) => {
    stdoutReader?.close()
    stderrReader?.close()

    if (startingServerProcess === serverProcess) {
      startingServerProcess = null
    }

    opencodeLogger.log(`Opencode server exited with code: ${code}, signal: ${signal}`)
    const wasActiveServer = releaseServerOwnedByChild(serverProcess)
    if (!wasActiveServer) return

    // Restart only unexpected crashes. Intentional Kimaki stops are tracked
    // per child; @opencode/cli can exit 130 with signal null after SIGTERM.
    if (
      intentionallyStoppedChildren.has(serverProcess) ||
      global.shuttingDown ||
      signal === 'SIGINT'
    ) {
      serverRetryCount = 0
      return
    }
    if (code !== 0) {
      if (serverRetryCount < 5) {
        serverRetryCount += 1
        opencodeLogger.log(`Restarting server (attempt ${serverRetryCount}/5)`)
        void ensureSingleServer().then((result) => {
          if (result instanceof Error) {
            opencodeLogger.error(`Failed to restart opencode server:`, result)
            void notifyError(result, `OpenCode server restart failed`)
          }
        })
      } else {
        const crashError = new Error(`Server crashed too many times (5), not restarting`)
        opencodeLogger.error(crashError.message)
        void notifyError(crashError, `OpenCode server crash loop exhausted`)
      }
    } else {
      serverRetryCount = 0
    }
  })

  const waitResult = await waitForServer({
    port,
    password: serverPassword,
    directory,
    startupStderrTail,
    child: serverProcess,
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
  // stopOpencodeServer() may have run while we waited (bot shutdown). Never
  // publish a server that nobody will stop.
  if (global.shuttingDown || serverProcess.killed) {
    killStartingServerProcessNow({ reason: 'stopped-during-startup' })
    if (startingServerProcess === serverProcess) {
      startingServerProcess = null
    }
    return new ServerStartError({ port, reason: 'stopped during startup' })
  }
  opencodeLogger.log(`Server ready on port ${port}`)

  // Always dump startup logs so plugin loading errors and other startup output
  // are visible in kimaki.log.
  for (const line of logBuffer) {
    opencodeLogger.log(line)
  }

  const server: SingleServer = {
    process: serverProcess,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    password: serverPassword,
  }
  if (stoppingServer) {
    await terminateChildProcess({
      child: serverProcess,
      reason: 'stop-opencode-server',
      label: 'starting opencode server',
    })
    if (startingServerProcess === serverProcess) {
      startingServerProcess = null
    }
    return stoppedDuringStartupError(port)
  }
  if (startingServerProcess === serverProcess) {
    startingServerProcess = null
  }
  singleServer = server
  notifyServerLifecycle({ type: 'started', port })
  return server
}

function getOrCreateClient({
  baseUrl,
  password,
  directory,
}: {
  baseUrl: string
  password: string
  directory: string
}): OpencodeClient {
  const cached = clientCache.get(directory)
  if (cached) {
    return cached
  }

  const client = OpenCode.make({
    baseUrl,
    headers: {
      ...getOpencodeServerAuthHeaders({ password }),
      'x-opencode-directory': directory,
    },
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
  if (accessCheck instanceof Error) return accessCheck

  preferredStartupDirectory = directory

  const server = await ensureSingleServer({ directory })
  if (server instanceof Error) return server

  if (!initializedDirectories.has(directory)) {
    initializedDirectories.add(directory)
  }

  const client = getOrCreateClient({
    baseUrl: server.baseUrl,
    password: server.password,
    directory,
  })
  const activation = await client.plugin
    .awaitActivation({ location: { directory } })
    .catch((e) => new OpenCodeSdkError({ operation: 'plugin.awaitActivation', cause: e }))
  if (activation instanceof Error) {
    opencodeLogger.warn(
      `OpenCode plugins did not finish activating for ${directory}: ${activation.message}`,
    )
  }

  return () => {
    if (!singleServer) {
      throw new ServerNotReadyError({ directory })
    }
    return getOrCreateClient({
      baseUrl: singleServer.baseUrl,
      password: singleServer.password,
      directory,
    })
  }
}

/**
 * Known-safe paths that never need an external_directory prompt, used only when
 * --restrict-directories is active. Without the flag every path is allowed and
 * this list is irrelevant.
 */
function knownSafeExternalDirectories(): string[] {
  const tmpdir = os.tmpdir().replaceAll('\\', '/')
  const homeDirectory = ({ relativePath }: { relativePath: string }) => {
    return path.resolve(os.homedir(), relativePath.replaceAll('\\', '/'))
  }
  return [
    '/tmp',
    '/private/tmp',
    tmpdir,
    // The agent can read the global AGENTS.md and opencode config; the path is
    // visible in the system prompt so models routinely try to open it.
    homeDirectory({ relativePath: '.config/opencode' }),
    // The Anthropic plugin rewrites the name in the system prompt, so some
    // models try this misspelled path instead.
    homeDirectory({ relativePath: '.config/openc0de' }),
    // Cached opensrc checkouts.
    homeDirectory({ relativePath: '.opensrc' }),
    // Kimaki data dir (logs, db, etc).
    homeDirectory({ relativePath: '.kimaki' }),
    // Prior opencode tool outputs.
    homeDirectory({ relativePath: '.local/share/opencode/tool-output' }),
    // Language toolchain caches, so builds can inspect downloaded modules.
    homeDirectory({ relativePath: '.cache/zig' }),
    homeDirectory({ relativePath: '.cargo' }),
    homeDirectory({ relativePath: '.cache/go-build' }),
    homeDirectory({ relativePath: 'go/pkg' }),
  ]
}

/**
 * Build the server-level `permission.external_directory` value.
 *
 * Default: `{ '*': 'allow' }` — no prompt for any directory.
 * With --restrict-directories: an allow-list of known-safe paths only. There is
 * deliberately no catch-all '*': 'ask' entry so opencode's own 'ask' default
 * still applies to everything else.
 *
 * Always an object, never the plain string 'allow'. opencode deep-merges config
 * files (remeda mergeDeep) and this file is loaded before the project's
 * opencode.json, so object keys from the project merge on top of these and win
 * via findLast(). A plain string would instead be replaced wholesale by the
 * project object, dropping allow-all for every unmatched path.
 */
function buildServerExternalDirectoryPermissions(): Record<string, 'ask' | 'allow' | 'deny'> {
  if (!getRestrictExternalDirectories()) {
    return { [ALL_EXTERNAL_DIRECTORIES_PATTERN]: 'allow' }
  }

  const permissions: Record<string, 'ask' | 'allow' | 'deny'> = {}
  for (const directory of knownSafeExternalDirectories()) {
    permissions[directory] = 'allow'
    permissions[`${directory}/*`] = 'allow'
  }
  return permissions
}

/**
 * Session overrides beat agent/project rules; keep broad allows in server config.
 * FileAccess uses relative read/edit resources inside the project, skipping the
 * external_directory gate. Cover both forms; shell execution is not sandboxed.
 */
export function buildSessionPermissions({
  directory,
  originalRepoDirectory,
}: {
  directory: string
  originalRepoDirectory?: string
}): PermissionRuleset {
  if (!originalRepoDirectory) return []
  const paths =
    path.win32.isAbsolute(directory) && !path.posix.isAbsolute(directory) ? path.win32 : path.posix
  const originalRepo = paths.resolve(originalRepoDirectory).replaceAll('\\', '/')
  const relative = paths.relative(directory, originalRepoDirectory).replaceAll('\\', '/')
  if (!relative) return []
  // A nested worktree has original-checkout siblings at every ancestor level.
  const relativeRoot = relative.split('/').every((part) => part === '..') ? '..' : relative
  const resources = [...new Set([originalRepo, relativeRoot])].flatMap((root) => {
    return [root, `${root.replace(/\/$/, '')}/*`]
  })
  return [
    {
      action: 'external_directory',
      resource: `${originalRepo.replace(/\/$/, '')}/*`,
      effect: 'deny',
    },
    ...['read', 'edit'].flatMap((action) => {
      return resources.map((resource) => ({ action, resource, effect: 'deny' as const }))
    }),
  ]
}

const ALL_EXTERNAL_DIRECTORIES_PATTERN = '*'

/**
 * Parse raw permission strings into PermissionRuleset entries.
 *
 * Accepted formats:
 *   "tool:effect"          -> { action: tool, resource: "*", effect }
 *   "tool:resource:effect" -> { action: tool, resource, effect }
 *
 * The effect must be one of "allow", "deny", "ask" (case-insensitive).
 * Parts are trimmed to tolerate whitespace from YAML deserialization.
 * Invalid entries are silently skipped (bad user input shouldn't crash the bot).
 * If `raw` is not an array, returns empty (defensive against malformed YAML markers).
 */
export function parsePermissionRules(raw: unknown): PermissionRuleset {
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.flatMap((entry) => {
    if (typeof entry !== 'string') {
      return []
    }
    const parts = entry.split(':').map((s) => {
      return s.trim()
    })
    if (parts.length < 2) return []
    const legacyAction = parts[0]!
    const action =
      ({ bash: 'shell', task: 'subagent', write: 'edit', patch: 'edit' } as const)[
        legacyAction as 'bash' | 'task' | 'write' | 'patch'
      ] || legacyAction
    const effect = parts[parts.length - 1]!.toLowerCase()
    const resource = parts.length === 2 ? '*' : parts.slice(1, -1).join(':')
    if (!action || !resource || (effect !== 'allow' && effect !== 'deny' && effect !== 'ask'))
      return []
    return [{ action, resource, effect }]
  })
}

// ── Injection guard per-session config ───────────────────────────
// Per-session injection guard patterns are written as JSON files to
// <dataDir>/injection-guard/<sessionId>.json. The injection guard plugin
// (running inside the opencode server process) reads KIMAKI_DATA_DIR env
// var to find these files in tool.execute.after.
// This avoids needing env vars (which are per-process, not per-session).

function getInjectionGuardDir(): string {
  return path.join(getDataDir(), 'injection-guard')
}

/**
 * Write per-session injection guard config so the plugin picks it up.
 * Only call this if injectionGuardPatterns is non-empty.
 */
export function writeInjectionGuardConfig({
  sessionId,
  scanPatterns,
}: {
  sessionId: string
  scanPatterns: string[]
}): void {
  if (scanPatterns.length === 0) {
    return
  }
  try {
    const dir = getInjectionGuardDir()
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify({ scanPatterns }))
  } catch {
    // Best effort -- don't crash the bot if data dir write fails
  }
}

/**
 * Remove per-session injection guard config file.
 */
export function removeInjectionGuardConfig({ sessionId }: { sessionId: string }): void {
  try {
    fs.unlinkSync(path.join(getInjectionGuardDir(), `${sessionId}.json`))
  } catch {
    // File may already be gone
  }
}

/**
 * Read per-session injection guard config. Used by the kimaki plugin
 * inside the opencode server process.
 */
export function readInjectionGuardConfig({
  sessionId,
}: {
  sessionId: string
}): { scanPatterns: string[] } | null {
  try {
    const raw = fs.readFileSync(path.join(getInjectionGuardDir(), `${sessionId}.json`), 'utf-8')
    return JSON.parse(raw) as { scanPatterns: string[] }
  } catch {
    return null
  }
}

// ── Public helpers ───────────────────────────────────────────────
// These helpers expose the single shared server and directory-scoped clients.

export function getOpencodeServerPort(_directory?: string): number | null {
  return singleServer?.port ?? null
}

export function getOpencodeServerConnection(): {
  port: number
  baseUrl: string
  password: string
} | null {
  if (!singleServer) return null
  return {
    port: singleServer.port,
    baseUrl: singleServer.baseUrl,
    password: singleServer.password,
  }
}

export function getOpencodeServerBaseUrl(): string | null {
  return singleServer?.baseUrl ?? null
}

export function getOpencodeClient(directory: string): OpencodeClient | null {
  if (!singleServer) {
    return null
  }
  return getOrCreateClient({
    baseUrl: singleServer.baseUrl,
    password: singleServer.password,
    directory,
  })
}

// Structural union of the OpenCode v2 SDK error response shapes. The concrete
// type of `result.error` varies per route, so we describe the fields each shape
// may carry instead of importing every per-route error union:
//   - NotFoundError / BadRequestError: { name, data: { message } }
//   - InvalidRequestError: { _tag, message }
//   - EffectHttpApiErrorBadRequest: { _tag: "BadRequest" } (no message)
//   - some routes also surface { errors: [...] }
export type SdkErrorResponse = {
  data?: { message?: string; ref?: string } | null
  message?: string
  errors?: unknown[]
  _tag?: string
  name?: string
}

/**
 * Extract a human-readable message from an OpenCode SDK error response.
 * Probes each known shape and falls back to a generic message.
 */
export function extractSdkErrorMessage(error: SdkErrorResponse | null | undefined): string {
  if (!error) {
    return 'Unknown OpenCode API error'
  }

  if (error.data?.message) {
    const name = error.name ? `${error.name}: ` : ''
    const ref = error.data.ref ? ` (${error.data.ref})` : ''
    return `${name}${error.data.message}${ref}`
  }

  if (error.message) {
    return error.message
  }

  if (error.errors && error.errors.length > 0) {
    return JSON.stringify(error.errors)
  }

  if (error._tag) {
    return error._tag
  }

  if (error.name) {
    return error.name
  }

  return 'Unknown OpenCode API error'
}

/**
 * Stop the single opencode server.
 * Used for process teardown, tests, and explicit restarts.
 */
async function stopOpencodeServerNow({
  server,
}: {
  server: SingleServer | null
}): Promise<boolean> {
  const startingChild = startingServerProcess
  if (startingChild) {
    const stoppedStarting = await terminateChildProcess({
      child: startingChild,
      reason: 'stop-opencode-server',
      label: 'starting opencode server',
    })
    if (startingServerProcess === startingChild) {
      startingServerProcess = null
    }
    if (!stoppedStarting && !startingServer && !server) return false
  }
  const startup = startingServer
  if (startup) {
    await startup
    if (startingServer === startup) startingServer = null
  }

  if (!server) return true
  if (server.discovered || !server.process) {
    serverRetryCount = 0
    return true
  }

  opencodeLogger.log(`Stopping opencode server (pid: ${server.process.pid}, port: ${server.port})`)
  const stopped = await terminateChildProcess({
    child: server.process,
    reason: 'stop-opencode-server',
    label: `opencode server (port: ${server.port})`,
  })
  if (!stopped) return false
  serverRetryCount = 0
  // Don't dispose the global listener here — it will reconnect when
  // the server restarts. Only abort the current SSE connection so it
  // doesn't hang on a dead server.
  restartGlobalEventListener()
  return true
}

export function stopOpencodeServer(): Promise<boolean> {
  if (stoppingServer) return stoppingServer
  const server = singleServer
  if (!server && !startingServer && !startingServerProcess) {
    return Promise.resolve(false)
  }

  // Assign stoppingServer before stop work so concurrent ensure waits.
  const stopping = Promise.resolve()
    .then(() => stopOpencodeServerNow({ server }))
    .finally(() => {
      if (stoppingServer === stopping) stoppingServer = null
    })
  stoppingServer = stopping
  clearSingleServer()
  return stopping
}

/**
 * Restart the single opencode server.
 * Kills the existing process and starts a new one.
 * Used for resolving opencode state issues, refreshing auth, plugins, etc.
 */
export async function restartOpencodeServer(): Promise<OpenCodeErrors | true> {
  const port = singleServer?.port ?? getOpencodePort() ?? 0
  if (singleServer || startingServer || startingServerProcess) {
    const stopped = await stopOpencodeServer()
    if (!stopped) {
      return new ServerStartError({
        port,
        reason: 'Existing OpenCode server did not stop',
      })
    }
  }

  // Reset retry count for the fresh start
  serverRetryCount = 0

  const result = await ensureSingleServer()
  if (result instanceof Error) return result
  restartGlobalEventListener()
  await waitForGlobalEventListener()
  return true
}
