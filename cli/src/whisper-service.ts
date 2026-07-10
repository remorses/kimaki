// Core lifecycle logic for a local voice-transcription service, shared by the
// `kimaki whisper` CLI commands and the Discord `/whisper-*` slash commands.
//
// Kimaki can transcribe Discord voice notes through a LOCAL OpenAI-compatible
// server instead of the paid Gemini/OpenAI cloud (point OPENAI_BASE_URL at it).
// This module manages that service's lifecycle so users can spin it up on demand
// and free the GPU when idle, without juggling separate terminals.
//
// The service is generic: any command exposing an OpenAI-compatible endpoint
// works (a Whisper shim, speaches, faster-whisper-server, whisper.cpp). Config
// lives at <data-dir>/whisper.json; the PID is tracked at <data-dir>/whisper.pid.
import * as errore from 'errore'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { getDataDir } from './config.js'

export class WhisperConfigError extends errore.createTaggedError({
  name: 'WhisperConfigError',
  message: 'Failed to $action whisper config at $path',
}) {}

export class WhisperServiceError extends errore.createTaggedError({
  name: 'WhisperServiceError',
  message: '$reason',
}) {}

export interface WhisperConfig {
  /** Command to launch the local transcription service (run via a shell). */
  command: string
  /** Working directory to launch it from. Defaults to the data dir. */
  cwd?: string
  /** Health-check URL polled after start and by `status`. */
  healthUrl: string
  /** Seconds to wait for the health check to pass on start. */
  startTimeoutSeconds: number
}

export const DEFAULT_WHISPER_CONFIG: WhisperConfig = {
  command: 'kimaki-whisper-shim',
  healthUrl: 'http://localhost:7070/health',
  startTimeoutSeconds: 60,
}

export function whisperConfigPath(): string {
  return path.join(getDataDir(), 'whisper.json')
}

function whisperPidPath(): string {
  return path.join(getDataDir(), 'whisper.pid')
}

export function loadWhisperConfig(): WhisperConfigError | WhisperConfig {
  const file = whisperConfigPath()
  const raw = errore.try(
    () => fs.readFileSync(file, 'utf-8'),
    (e) => new WhisperConfigError({ action: 'read', path: file, cause: e }),
  )
  // No config file yet: use defaults (the common shim-on-7070 case).
  if (raw instanceof Error) return { ...DEFAULT_WHISPER_CONFIG }

  const parsed = errore.try(
    () => JSON.parse(raw) as Partial<WhisperConfig>,
    (e) => new WhisperConfigError({ action: 'parse', path: file, cause: e }),
  )
  if (parsed instanceof Error) return parsed

  return { ...DEFAULT_WHISPER_CONFIG, ...parsed }
}

export function saveWhisperConfig({
  config,
}: {
  config: WhisperConfig
}): WhisperConfigError | null {
  const file = whisperConfigPath()
  const result = errore.try(
    () => {
      fs.mkdirSync(getDataDir(), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n')
    },
    (e) => new WhisperConfigError({ action: 'write', path: file, cause: e }),
  )
  return result instanceof Error ? result : null
}

function readPid(): number | null {
  const raw = errore.try(
    () => fs.readFileSync(whisperPidPath(), 'utf-8'),
    (e) => new WhisperConfigError({ action: 'read pid for', path: whisperPidPath(), cause: e }),
  )
  if (raw instanceof Error) return null
  const pid = Number(raw.trim())
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

function isProcessAlive({ pid }: { pid: number }): boolean {
  // signal 0 does not kill; it only checks the process exists and is signalable.
  const result = errore.try(
    () => process.kill(pid, 0),
    (e) => new WhisperServiceError({ reason: `process ${pid} not signalable`, cause: e }),
  )
  return !(result instanceof Error)
}

export async function isWhisperHealthy({ url }: { url: string }): Promise<boolean> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(4000),
  }).catch((e) => new WhisperServiceError({ reason: 'health check failed', cause: e }))
  if (res instanceof Error) return false
  return res.ok
}

async function waitForHealthy({
  url,
  timeoutSeconds,
}: {
  url: string
  timeoutSeconds: number
}): Promise<boolean> {
  const deadline = Date.now() + timeoutSeconds * 1000
  while (Date.now() < deadline) {
    if (await isWhisperHealthy({ url })) return true
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return false
}

export interface WhisperStatus {
  running: boolean
  healthy: boolean
  pid: number | null
  healthUrl: string
}

export async function getWhisperStatus(): Promise<WhisperConfigError | WhisperStatus> {
  const config = loadWhisperConfig()
  if (config instanceof Error) return config

  const pid = readPid()
  const running = pid !== null && isProcessAlive({ pid })
  const healthy = running ? await isWhisperHealthy({ url: config.healthUrl }) : false

  return { running, healthy, pid: running ? pid : null, healthUrl: config.healthUrl }
}

export type WhisperStartResult =
  | { status: 'already-running'; pid: number; healthy: boolean }
  | { status: 'started'; pid: number; healthUrl: string }

export async function startWhisperService({
  overrides,
}: {
  overrides?: Partial<Pick<WhisperConfig, 'command' | 'healthUrl'>>
} = {}): Promise<WhisperConfigError | WhisperServiceError | WhisperStartResult> {
  const loaded = loadWhisperConfig()
  if (loaded instanceof Error) return loaded

  const config: WhisperConfig = {
    ...loaded,
    command: overrides?.command ?? loaded.command,
    healthUrl: overrides?.healthUrl ?? loaded.healthUrl,
  }

  // Idempotent start: if already running, report and return.
  const existingPid = readPid()
  if (existingPid !== null && isProcessAlive({ pid: existingPid })) {
    const healthy = await isWhisperHealthy({ url: config.healthUrl })
    return { status: 'already-running', pid: existingPid, healthy }
  }

  const child = spawn(config.command, {
    shell: true,
    cwd: config.cwd || getDataDir(),
    stdio: 'ignore',
    detached: true,
  })
  if (child.pid === undefined) {
    return new WhisperServiceError({ reason: 'failed to spawn whisper service (no pid)' })
  }
  child.unref()

  const saved = saveWhisperConfig({ config })
  if (saved instanceof Error) return saved

  const wrotePid = errore.try(
    () => fs.writeFileSync(whisperPidPath(), String(child.pid)),
    (e) => new WhisperConfigError({ action: 'write pid for', path: whisperPidPath(), cause: e }),
  )
  if (wrotePid instanceof Error) return wrotePid

  const healthy = await waitForHealthy({
    url: config.healthUrl,
    timeoutSeconds: config.startTimeoutSeconds,
  })
  if (!healthy) {
    return new WhisperServiceError({
      reason: `service started (pid ${child.pid}) but did not become healthy within ${config.startTimeoutSeconds}s at ${config.healthUrl}`,
    })
  }

  return { status: 'started', pid: child.pid, healthUrl: config.healthUrl }
}

export type WhisperStopResult =
  | { status: 'not-running' }
  | { status: 'stale-pid'; pid: number }
  | { status: 'stopped'; pid: number }

export function stopWhisperService(): WhisperServiceError | WhisperStopResult {
  const pid = readPid()
  if (pid === null) return { status: 'not-running' }

  const clearPid = () =>
    errore.try(
      () => fs.rmSync(whisperPidPath(), { force: true }),
      (e) => new WhisperConfigError({ action: 'remove pid for', path: whisperPidPath(), cause: e }),
    )

  if (!isProcessAlive({ pid })) {
    clearPid()
    return { status: 'stale-pid', pid }
  }

  // Kill the whole process group (detached start makes the child a group
  // leader), so a wrapper + its child service both stop. Fall back to a plain
  // single-process kill if the group signal fails.
  const killedGroup = errore.try(
    () => process.kill(-pid, 'SIGTERM'),
    (e) => new WhisperServiceError({ reason: `group kill failed for ${pid}`, cause: e }),
  )
  if (killedGroup instanceof Error) {
    const killedSingle = errore.try(
      () => process.kill(pid, 'SIGTERM'),
      (e) => new WhisperServiceError({ reason: `failed to stop pid ${pid}`, cause: e }),
    )
    if (killedSingle instanceof Error) return killedSingle
  }

  clearPid()
  return { status: 'stopped', pid }
}
