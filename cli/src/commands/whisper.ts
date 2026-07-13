// /whisper-start, /whisper-stop, /whisper-status Discord slash commands.
// Control the local voice-transcription service from Discord (e.g. from a phone),
// mirroring the `kimaki whisper` CLI commands. Shares logic via whisper-service.js.
import { MessageFlags } from 'discord.js'
import type { CommandContext } from './types.js'
import { SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import { setOpenAIBaseUrl, setLocalWhisperModel } from '../database.js'
import {
  startWhisperService,
  stopWhisperService,
  getWhisperStatus,
  setupWhisperService,
  WHISPER_BACKEND_PRESETS,
} from '../whisper-service.js'
import {
  getLocalWhisperModelById,
  prepareLocalWhisperModel,
} from '../whisper-local.js'

const logger = createLogger(LogPrefix.VOICE)

export async function handleWhisperSetupCommand({
  command,
  appId,
}: CommandContext): Promise<void> {
  await command.deferReply({ flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS })

  const modelChoice = command.options.getString('model')
  const backend = command.options.getString('backend')
  const customCommand = command.options.getString('command')
  const healthUrlOption = command.options.getString('health-url')
  const transcriptionUrl = command.options.getString('transcription-url')

  // ── Zero-setup path: built-in local model (recommended for most users) ──
  // Downloads and runs an ONNX whisper model in-process; nothing to install
  // or configure. Everything else in this command is the advanced path.
  if (modelChoice) {
    if (modelChoice === 'off') {
      await setLocalWhisperModel(appId, null)
      await command.editReply(
        '🎤 Built-in local transcription **disabled**. Voice notes use your cloud key / configured service again.',
      )
      return
    }

    const model = getLocalWhisperModelById(modelChoice)
    if (!model) {
      await command.editReply(`⚠️ Unknown model: ${modelChoice}`)
      return
    }

    await command.editReply(
      `🎤 Setting up built-in transcription — **${model.label}** (one-time download ${model.approxSize})…`,
    )

    let lastEdit = 0
    const prepared = await prepareLocalWhisperModel({
      modelId: model.id,
      onProgress: (message) => {
        // Throttle Discord edits to avoid rate limits during multi-file downloads.
        const now = Date.now()
        if (now - lastEdit < 2500) return
        lastEdit = now
        void command
          .editReply(`🎤 Setting up **${model.label}**… ${message}`)
          .catch(() => {})
      },
    })
    if (prepared instanceof Error) {
      logger.error(`local whisper setup failed: ${prepared.message}`)
      await command.editReply(
        `⚠️ Setup failed: ${prepared.message}\nNothing was changed — try again, or use a cloud key via /transcription-key.`,
      )
      return
    }

    await setLocalWhisperModel(appId, model.id)
    await command.editReply(
      `✅ Built-in local transcription ready — **${model.label}**.\nSend a voice note to try it. No API keys, services, or URLs needed; audio never leaves this machine.`,
    )
    return
  }

  const preset = backend && backend !== 'custom'
    ? WHISPER_BACKEND_PRESETS.find((p) => p.id === backend)
    : undefined

  const launchCommand = customCommand ?? preset?.command
  const healthUrl = healthUrlOption ?? preset?.healthUrl ?? 'http://localhost:7070/health'

  const lines: string[] = []

  if (launchCommand) {
    const saved = setupWhisperService({ command: launchCommand, healthUrl })
    if (saved instanceof Error) {
      logger.error(`whisper setup failed: ${saved.message}`)
      await command.editReply(`⚠️ Failed to save whisper config: ${saved.message}`)
      return
    }
    lines.push(`🎤 Whisper service configured:`)
    lines.push(`- **Launch command:** \`${saved.command}\``)
    lines.push(`- **Health URL:** ${saved.healthUrl}`)
    if (preset) lines.push(`- **Requires:** ${preset.requires}`)
  }

  if (transcriptionUrl) {
    await setOpenAIBaseUrl(appId, transcriptionUrl)
    lines.push(`- **Transcription URL:** ${transcriptionUrl} (voice notes now route here — no env vars needed)`)
  }

  if (lines.length === 0) {
    await command.editReply(
      'Nothing to configure. Pass `backend` (or a custom `command`) to set the managed service, and/or `transcription-url` to route voice notes to a local OpenAI-compatible endpoint.',
    )
    return
  }

  lines.push('')
  lines.push(launchCommand ? 'Start it with `/whisper-start`.' : 'Send a voice note to test.')
  await command.editReply(lines.join('\n'))
}

export async function handleWhisperStartCommand({
  command,
}: CommandContext): Promise<void> {
  await command.deferReply({ flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS })
  const result = await startWhisperService()
  if (result instanceof Error) {
    logger.error(`whisper start failed: ${result.message}`)
    await command.editReply(
      `⚠️ ${result.message}`,
    )
    return
  }
  if (result.status === 'already-running') {
    await command.editReply(
      `🎤 Whisper service already running (pid ${result.pid})${result.healthy ? ' and healthy' : ' — not yet healthy'}`,
    )
    return
  }
  await command.editReply(`🎤 Whisper service started (pid ${result.pid}) and healthy`)
}

export async function handleWhisperStopCommand({
  command,
}: CommandContext): Promise<void> {
  await command.deferReply({ flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS })
  const result = stopWhisperService()
  if (result instanceof Error) {
    logger.error(`whisper stop failed: ${result.message}`)
    await command.editReply(`⚠️ Failed to stop whisper service: ${result.message}`)
    return
  }
  if (result.status === 'not-running') {
    await command.editReply('Whisper service is not running — nothing to stop')
    return
  }
  if (result.status === 'stale-pid') {
    await command.editReply(`Whisper service (pid ${result.pid}) was not running — cleared stale pid`)
    return
  }
  await command.editReply(`🛑 Stopped whisper service (pid ${result.pid}) — GPU/RAM freed`)
}

export async function handleWhisperStatusCommand({
  command,
}: CommandContext): Promise<void> {
  await command.deferReply({ flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS })
  const status = await getWhisperStatus()
  if (status instanceof Error) {
    logger.error(`whisper status failed: ${status.message}`)
    await command.editReply(`⚠️ Failed to read whisper status: ${status.message}`)
    return
  }
  if (!status.configured) {
    await command.editReply(
      '🎤 Whisper service: **not configured** — run `kimaki whisper setup` in a terminal on the host first.',
    )
    return
  }
  if (!status.running) {
    await command.editReply('🎤 Whisper service: **stopped**')
    return
  }
  await command.editReply(
    `🎤 Whisper service: **running** (pid ${status.pid}) — ${status.healthy ? 'healthy ✅' : 'NOT healthy ⚠️'} at ${status.healthUrl}`,
  )
}
