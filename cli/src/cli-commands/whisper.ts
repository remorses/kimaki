// Local voice-transcription service lifecycle commands (CLI).
//
//   kimaki whisper setup    interactively pick + wire a local transcription service
//   kimaki whisper start    launch the configured service
//   kimaki whisper stop     stop it (frees GPU/RAM)
//   kimaki whisper status   report configured / running / healthy
//
// Thin wrapper over ../whisper-service.js, shared with the Discord `/whisper-*`
// slash commands.
import { goke } from 'goke'
import { z } from 'zod'
import * as clack from '@clack/prompts'
import { createLogger, LogPrefix } from '../logger.js'
import { EXIT_NO_RESTART } from '../cli-runner.js'
import {
  startWhisperService,
  stopWhisperService,
  getWhisperStatus,
  setupWhisperService,
  WHISPER_BACKEND_PRESETS,
} from '../whisper-service.js'

const cliLogger = createLogger(LogPrefix.VOICE)
const cli = goke()

cli
  .command('whisper setup', 'Pick and wire a local voice-transcription service')
  .option(
    '--command [command]',
    z.string().optional().describe('Launch command (skips the interactive picker)'),
  )
  .option(
    '--health-url [url]',
    z.string().optional().describe('Health-check URL for the service'),
  )
  .action(async (options: { command?: string; healthUrl?: string }) => {
    // Non-interactive path: both flags provided (or a TTY-less shell).
    const nonInteractive = !process.stdin.isTTY

    const chosen = await (async (): Promise<{ command: string; healthUrl: string } | null> => {
      if (options.command) {
        return {
          command: options.command,
          healthUrl: options.healthUrl ?? 'http://localhost:7070/health',
        }
      }
      if (nonInteractive) {
        cliLogger.error(
          'kimaki whisper setup needs a TTY, or pass --command <cmd> [--health-url <url>].',
        )
        cliLogger.error(
          'Presets: ' +
            WHISPER_BACKEND_PRESETS.map((p) => `${p.id} (${p.requires})`).join('; '),
        )
        process.exit(EXIT_NO_RESTART)
      }

      const pick = await clack.select({
        message: 'Which local transcription backend do you want Kimaki to manage?',
        options: [
          ...WHISPER_BACKEND_PRESETS.map((p) => ({
            value: p.id,
            label: p.label,
            hint: `requires ${p.requires}`,
          })),
          { value: 'custom', label: 'Custom command', hint: 'paste your own' },
        ],
      })
      if (clack.isCancel(pick)) return null

      if (pick === 'custom') {
        const cmd = await clack.text({
          message: 'Command to launch the service',
          placeholder: 'e.g. uvicorn ... --port 8000 ...',
        })
        if (clack.isCancel(cmd)) return null
        const url = await clack.text({
          message: 'Health-check URL',
          initialValue: 'http://localhost:8000/health',
        })
        if (clack.isCancel(url)) return null
        return { command: cmd, healthUrl: url }
      }

      const preset = WHISPER_BACKEND_PRESETS.find((p) => p.id === pick)!
      return { command: preset.command, healthUrl: preset.healthUrl }
    })()

    if (chosen === null) {
      cliLogger.log('Setup cancelled')
      process.exit(0)
    }

    const saved = setupWhisperService({
      command: chosen.command,
      healthUrl: chosen.healthUrl,
    })
    if (saved instanceof Error) {
      cliLogger.error(saved.message)
      process.exit(EXIT_NO_RESTART)
    }

    cliLogger.log(`Configured whisper service: ${saved.command}`)
    cliLogger.log(`Health URL: ${saved.healthUrl}`)
    cliLogger.log('')
    cliLogger.log('Next steps:')
    cliLogger.log('  1. Ensure the backend it launches is installed (see the presets/docs).')
    cliLogger.log('  2. Point Kimaki at it:  OPENAI_BASE_URL=<your /v1 base>  (and any dummy OPENAI_API_KEY)')
    cliLogger.log('  3. Start it:  kimaki whisper start   (or /whisper-start in Discord)')
    process.exit(0)
  })

cli
  .command('whisper start', 'Start the local voice-transcription service')
  .option(
    '--command [command]',
    z.string().optional().describe('Command to launch the service (persists to whisper.json)'),
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
    if (!status.configured) {
      cliLogger.log('Whisper service: not configured — run `kimaki whisper setup`')
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
