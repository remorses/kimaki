// /whisper-start, /whisper-stop, /whisper-status Discord slash commands.
// Control the local voice-transcription service from Discord (e.g. from a phone),
// mirroring the `kimaki whisper` CLI commands. Shares logic via whisper-service.js.
import { MessageFlags } from 'discord.js'
import type { CommandContext } from './types.js'
import { SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import {
  startWhisperService,
  stopWhisperService,
  getWhisperStatus,
} from '../whisper-service.js'

const logger = createLogger(LogPrefix.VOICE)

export async function handleWhisperStartCommand({
  command,
}: CommandContext): Promise<void> {
  await command.deferReply({ flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS })
  const result = await startWhisperService()
  if (result instanceof Error) {
    logger.error(`whisper start failed: ${result.message}`)
    await command.editReply(`⚠️ Failed to start whisper service: ${result.message}`)
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
  if (!status.running) {
    await command.editReply('🎤 Whisper service: **stopped**')
    return
  }
  await command.editReply(
    `🎤 Whisper service: **running** (pid ${status.pid}) — ${status.healthy ? 'healthy ✅' : 'NOT healthy ⚠️'} at ${status.healthUrl}`,
  )
}
