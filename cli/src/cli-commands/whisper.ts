// Local voice-transcription service lifecycle commands.
//
// Kimaki can transcribe Discord voice notes through a LOCAL OpenAI-compatible
// server instead of the paid Gemini/OpenAI cloud (set OPENAI_BASE_URL at it).
// These commands manage that local service's lifecycle so users can spin it up
// on demand and free the GPU when idle, without juggling separate terminals.
//
//   kimaki whisper start    launch the configured local transcription service
//   kimaki whisper stop     stop it (frees GPU/RAM)
//   kimaki whisper status   report whether it is running + healthy
//
// The service is generic: any command that exposes an OpenAI-compatible endpoint
// works (e.g. a Whisper shim, speaches, faster-whisper-server, whisper.cpp).
// Config lives at <data-dir>/whisper.json; sensible defaults require no setup
// for the common "shim on :7070" case.
import { goke } from 'goke'
import { z } from 'zod'
import * as errore from 'errore'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { createLogger, LogPrefix } from '../logger.js'
import { getDataDir } from '../config.js'
import { EXIT_NO_RESTART } from '../cli-runner.js'

const cliLogger = createLogger(LogPrefix.VOICE)
const cli = goke()

class WhisperConfigError extends errore.createTaggedError({
  name: 'WhisperConfigError',
  message: 'Failed to $action whisper config at $path',
}) {}

class WhisperServiceError extends errore.createTaggedError({
  name: 'WhisperServiceError',
  message: '$reason',
}) {}

interface WhisperConfig {
  /** Command to launch the local transcription service (run via a shell). */
  command: string
  /** Working directory to launch it from. Defaults to the data dir. */
  cwd?: string
  /** Health-check URL polled after start and by `status`. */
  healthUrl: string
  /** Seconds to wait for the health check to pass on start. */
  startTimeoutSeconds: number
}

const DEFAULT_CONFIG: WhisperConfig = {
  command: 'kimaki-whisper-shim',
  healthUrl: 'http://localhost:7070/health',
  startTimeoutSeconds: 60,
}

function configPath(): string {
  return path.join(getDataDir(), 'whisper.json')
}

function pidPath(): string {
  return path.join(getDataDir(), 'whisper.pid')
}

function loadConfig(): WhisperConfigError | WhisperConfig {
  const file = configPath()
  const raw = errore.try(
    () => fs.readFileSync(file, 'utf-8'),
    (e) => new WhisperConfigError({ action: 'read', path: file, cause: e }),
  )
  // No config file yet: use defaults (the common shim-on-7070 case).
  if (raw instanceof Error) return { ...DEFAULT_CONFIG }

  const parsed = errore.try(
    () => JSON.parse(raw) as Partial<WhisperConfig>,
    (e) => new WhisperConfigError({ action: 'parse', path: file, cause: e }),
  )
  if (parsed instanceof Error) return parsed

  return { ...DEFAULT_CONFIG, ...parsed }
}

function saveConfig({ config }: { config: WhisperConfig }): WhisperConfigError | null {
  const file = configPath()
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
    () => fs.readFileSync(pidPath(), 'utf-8'),
    (e) => new WhisperConfigError({ action: 'read pid for', path: pidPath(), cause: e }),
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

async function isHealthy({ url }: { url: string }): Promise<boolean> {
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
    if (await isHealthy({ url })) return true
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return false
}

cli
  .command('whisper start', 'Start the local voice-transcription service')
  .option(
    '--command [command]',
    z
      .string()
      .optional()
      .describe('Command to launch the service (persists to whisper.json)'),
  )
  .option(
    '--health-url [url]',
    z
      .string()
      .optional()
      .describe('Health-check URL (persists to whisper.json)'),
  )
  .action(async (options: { command?: string; healthUrl?: string }) => {
    const loaded = loadConfig()
    if (loaded instanceof Error) {
      cliLogger.error(loaded.message)
      process.exit(EXIT_NO_RESTART)
    }

    const config: WhisperConfig = {
      ...loaded,
      command: options.command ?? loaded.command,
      healthUrl: options.healthUrl ?? loaded.healthUrl,
    }

    // Persist any overrides so the next start/stop uses the same settings.
    if (options.command || options.healthUrl) {
      const saved = saveConfig({ config })
      if (saved instanceof Error) {
        cliLogger.error(saved.message)
        process.exit(EXIT_NO_RESTART)
      }
    }

    // Already running? Report and exit success (idempotent start).
    const existingPid = readPid()
    if (existingPid !== null && isProcessAlive({ pid: existingPid })) {
      const healthy = await isHealthy({ url: config.healthUrl })
      cliLogger.log(
        `Whisper service already running (pid ${existingPid})${healthy ? ' and healthy' : ' (not yet healthy)'}`,
      )
      process.exit(0)
    }

    cliLogger.log(`Starting whisper service: ${config.command}`)
    const child = spawn(config.command, {
      shell: true,
      cwd: config.cwd || getDataDir(),
      stdio: 'ignore',
      detached: true,
    })

    if (child.pid === undefined) {
      cliLogger.error('Failed to spawn whisper service (no pid)')
      process.exit(EXIT_NO_RESTART)
    }
    child.unref()

    const saved = saveConfig({ config })
    if (saved instanceof Error) {
      cliLogger.warn(`Started but could not persist config: ${saved.message}`)
    }
    const wrotePid = errore.try(
      () => fs.writeFileSync(pidPath(), String(child.pid)),
      (e) => new WhisperConfigError({ action: 'write pid for', path: pidPath(), cause: e }),
    )
    if (wrotePid instanceof Error) {
      cliLogger.warn(wrotePid.message)
    }

    const healthy = await waitForHealthy({
      url: config.healthUrl,
      timeoutSeconds: config.startTimeoutSeconds,
    })
    if (!healthy) {
      cliLogger.error(
        `Whisper service started (pid ${child.pid}) but did not become healthy within ${config.startTimeoutSeconds}s at ${config.healthUrl}. Check its logs.`,
      )
      process.exit(EXIT_NO_RESTART)
    }

    cliLogger.log(`Whisper service healthy (pid ${child.pid}) at ${config.healthUrl}`)
    process.exit(0)
  })

cli
  .command('whisper stop', 'Stop the local voice-transcription service (frees GPU/RAM)')
  .action(async () => {
    const pid = readPid()
    if (pid === null) {
      cliLogger.log('No whisper service pid on record — nothing to stop')
      process.exit(0)
    }

    if (!isProcessAlive({ pid })) {
      cliLogger.log(`Whisper service (pid ${pid}) is not running — clearing stale pid`)
      const removed = errore.try(
        () => fs.rmSync(pidPath(), { force: true }),
        (e) => new WhisperConfigError({ action: 'remove pid for', path: pidPath(), cause: e }),
      )
      if (removed instanceof Error) cliLogger.warn(removed.message)
      process.exit(0)
    }

    // Kill the whole process group (detached start makes the child a group
    // leader), so a wrapper + its child service both stop. Fall back to a plain
    // single-process kill if the group signal fails (e.g. not a group leader).
    const killedGroup = errore.try(
      () => process.kill(-pid, 'SIGTERM'),
      (e) => new WhisperServiceError({ reason: `group kill failed for ${pid}`, cause: e }),
    )
    if (killedGroup instanceof Error) {
      const killedSingle = errore.try(
        () => process.kill(pid, 'SIGTERM'),
        (e) => new WhisperServiceError({ reason: `failed to stop pid ${pid}`, cause: e }),
      )
      if (killedSingle instanceof Error) {
        cliLogger.error(killedSingle.message)
        process.exit(EXIT_NO_RESTART)
      }
    }

    const removed = errore.try(
      () => fs.rmSync(pidPath(), { force: true }),
      (e) => new WhisperConfigError({ action: 'remove pid for', path: pidPath(), cause: e }),
    )
    if (removed instanceof Error) {
      cliLogger.warn(removed.message)
    }
    cliLogger.log(`Stopped whisper service (pid ${pid})`)
    process.exit(0)
  })

cli
  .command('whisper status', 'Report whether the local transcription service is running')
  .option('--json', 'Output as JSON')
  .action(async (options: { json?: boolean }) => {
    const loaded = loadConfig()
    if (loaded instanceof Error) {
      cliLogger.error(loaded.message)
      process.exit(EXIT_NO_RESTART)
    }

    const pid = readPid()
    const running = pid !== null && isProcessAlive({ pid })
    const healthy = running ? await isHealthy({ url: loaded.healthUrl }) : false

    if (options.json) {
      process.stdout.write(
        JSON.stringify(
          { running, healthy, pid: running ? pid : null, healthUrl: loaded.healthUrl },
          null,
          2,
        ) + '\n',
      )
      process.exit(0)
    }

    if (!running) {
      cliLogger.log('Whisper service: stopped')
      process.exit(0)
    }
    cliLogger.log(
      `Whisper service: running (pid ${pid}) — ${healthy ? 'healthy' : 'NOT healthy'} at ${loaded.healthUrl}`,
    )
    process.exit(0)
  })

export default cli
