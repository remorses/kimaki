// Local voice-transcription service lifecycle commands (CLI).
//
//   kimaki whisper start    launch the configured local transcription service
//   kimaki whisper stop     stop it (frees GPU/RAM)
//   kimaki whisper status   report whether it is running + healthy
//
// Thin wrapper over ../whisper-service.js, shared with the Discord `/whisper-*`
// slash commands.
import { goke } from 'goke'
import { z } from 'zod'
import { createLogger, LogPrefix } from '../logger.js'
import { EXIT_NO_RESTART } from '../cli-runner.js'
import {
  startWhisperService,
  stopWhisperService,
  getWhisperStatus,
} from '../whisper-service.js'

const cliLogger = createLogger(LogPrefix.VOICE)
const cli = goke()

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
    z.string().optional().describe('Health-check URL (persists to whisper.json)'),
  )
  .action(async (options: { command?: string; healthUrl?: string }) => {
    const result = await startWhisperService({
      overrides: {
        ...(options.command && { command: options.command }),
        ...(options.healthUrl && { healthUrl: options.healthUrl }),
      },
    })
    if (result instanceof Error) {
      cliLogger.error(result.message)
      process.exit(EXIT_NO_RESTART)
    }
    if (result.status === 'already-running') {
      cliLogger.log(
        `Whisper service already running (pid ${result.pid})${result.healthy ? ' and healthy' : ' (not yet healthy)'}`,
      )
      process.exit(0)
    }
    cliLogger.log(`Whisper service healthy (pid ${result.pid}) at ${result.healthUrl}`)
    process.exit(0)
  })

cli
  .command('whisper stop', 'Stop the local voice-transcription service (frees GPU/RAM)')
  .action(async () => {
    const result = stopWhisperService()
    if (result instanceof Error) {
      cliLogger.error(result.message)
      process.exit(EXIT_NO_RESTART)
    }
    if (result.status === 'not-running') {
      cliLogger.log('No whisper service pid on record — nothing to stop')
      process.exit(0)
    }
    if (result.status === 'stale-pid') {
      cliLogger.log(`Whisper service (pid ${result.pid}) was not running — cleared stale pid`)
      process.exit(0)
    }
    cliLogger.log(`Stopped whisper service (pid ${result.pid})`)
    process.exit(0)
  })

cli
  .command('whisper status', 'Report whether the local transcription service is running')
  .option('--json', 'Output as JSON')
  .action(async (options: { json?: boolean }) => {
    const status = await getWhisperStatus()
    if (status instanceof Error) {
      cliLogger.error(status.message)
      process.exit(EXIT_NO_RESTART)
    }
    if (options.json) {
      process.stdout.write(JSON.stringify(status, null, 2) + '\n')
      process.exit(0)
    }
    if (!status.running) {
      cliLogger.log('Whisper service: stopped')
      process.exit(0)
    }
    cliLogger.log(
      `Whisper service: running (pid ${status.pid}) — ${status.healthy ? 'healthy' : 'NOT healthy'} at ${status.healthUrl}`,
    )
    process.exit(0)
  })

export default cli
