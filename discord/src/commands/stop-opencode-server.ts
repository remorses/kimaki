// /stop-opencode-server command - Stop the OpenCode server after inactivity checks.
// Shows derived inactivity time in minutes for the current project's server scope.

import {
  ChannelType,
  MessageFlags,
  type ThreadChannel,
  type TextChannel,
} from 'discord.js'
import type { CommandContext } from './types.js'
import {
  stopOpencodeServer,
} from '../opencode.js'
import {
  getDirectoryRuntimeInactivitySnapshot,
  disposeRuntimesForDirectory,
} from '../session-handler/thread-session-runtime.js'
import {
  resolveWorkingDirectory,
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import {
  DEFAULT_RUNTIME_IDLE_MS,
} from '../runtime-idle-sweeper.js'

function formatInactivityMinutes(inactiveForMs: number | null): string {
  if (inactiveForMs === null) {
    return 'unknown'
  }
  return `${Math.floor(inactiveForMs / 60_000)}m`
}

export async function handleStopOpencodeServerCommand({
  command,
}: CommandContext): Promise<void> {
  const channel = command.channel

  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const isThread = [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel.type)
  const isTextChannel = channel.type === ChannelType.GuildText

  if (!isThread && !isTextChannel) {
    await command.reply({
      content: 'This command can only be used in text channels or threads',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const resolved = await resolveWorkingDirectory({
    channel: channel as TextChannel | ThreadChannel,
  })

  if (!resolved) {
    await command.reply({
      content: 'Could not determine project directory for this channel',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const { projectDirectory } = resolved

  await command.deferReply({ flags: SILENT_MESSAGE_FLAGS })

  const nowMs = Date.now()
  const runtimeSnapshot = getDirectoryRuntimeInactivitySnapshot({
    directory: projectDirectory,
    nowMs,
  })
  const inactivityMs = runtimeSnapshot.inactiveForMs

  if (runtimeSnapshot.hasNonIdleRuntime) {
    await command.editReply({
      content: `OpenCode server not stopped: activity is still in progress. Last inactivity: ${formatInactivityMinutes(inactivityMs)}.`,
    })
    return
  }

  if (runtimeSnapshot.runtimeCount > 0 && inactivityMs !== null && inactivityMs < DEFAULT_RUNTIME_IDLE_MS) {
    await command.editReply({
      content: `OpenCode server not stopped: inactivity is ${formatInactivityMinutes(inactivityMs)} (needs at least 60m).`,
    })
    return
  }

  const disposedCount = disposeRuntimesForDirectory({
    directory: projectDirectory,
  })
  const stopped = await stopOpencodeServer(projectDirectory)

  if (!stopped) {
    await command.editReply({
      content: `No running OpenCode server found. Last inactivity: ${formatInactivityMinutes(inactivityMs)}.`,
    })
    return
  }

  await command.editReply({
    content: `OpenCode server stopped. Last inactivity: ${formatInactivityMinutes(inactivityMs)}. Disposed ${disposedCount} runtime${disposedCount === 1 ? '' : 's'}.`,
  })
}
