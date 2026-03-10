// /run-shell-command command - Run an arbitrary shell command in the project directory.
// Resolves the project directory from the channel and executes the command with it as cwd.
// Also used by the ! prefix shortcut in discord messages (e.g. "!ls -la").
// Messages starting with ! are intercepted before session handling and routed here.


import type { CommandContext } from './types.js'
import { PLATFORM_MESSAGE_FLAGS } from '../platform/message-flags.js'
import {
  resolveWorkingDirectory,
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import { execAsync } from '../worktrees.js'
import { stripAnsi } from '../utils.js'
import { isTextChannel, isThreadChannel } from './channel-ref.js'

const logger = createLogger(LogPrefix.INTERACTION)

const MAX_OUTPUT_CHARS = 1900

export async function runShellCommand({
  command,
  directory,
}: {
  command: string
  directory: string
}): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, { cwd: directory })
    const output = stripAnsi([stdout, stderr].filter(Boolean).join('\n').trim())

    const header = `\`${command}\` exited with 0`
    if (!output) {
      return header
    }
    return formatOutput(output, header)
  } catch (error) {
    const execError = error as {
      stdout?: string
      stderr?: string
      message?: string
      code?: number | string
    }
    const output = stripAnsi(
      [execError.stdout, execError.stderr].filter(Boolean).join('\n').trim(),
    )
    const exitCode = execError.code ?? 1
    logger.error(
      `[RUN-COMMAND] Command "${command}" exited with ${exitCode}:`,
      error,
    )

    const header = `\`${command}\` exited with ${exitCode}`
    return formatOutput(output || execError.message || 'Unknown error', header)
  }
}

export async function handleRunCommand({
  command,
}: CommandContext): Promise<void> {
  const channel = command.channel

  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel.',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  if (!isThreadChannel(channel) && !isTextChannel(channel)) {
    await command.reply({
      content: 'This command can only be used in a text channel or thread.',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const resolved = await resolveWorkingDirectory({ channel })

  if (!resolved) {
    await command.reply({
      content: 'Could not determine project directory for this channel.',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const input = command.options.getString('command', true)

  await command.deferReply()

  const result = await runShellCommand({
    command: input,
    directory: resolved.workingDirectory,
  })
  await command.editReply({ content: result })
}

function formatOutput(output: string, header: string): string {
  // Reserve space for header + newline + code block delimiters (```\n...\n```)
  const overhead = header.length + 1 + 3 + 1 + 1 + 3 // header\n```\n...\n```
  const maxContent = MAX_OUTPUT_CHARS - overhead
  const truncated =
    output.length > maxContent
      ? output.slice(0, maxContent - 14) + '\n... truncated'
      : output
  return `${header}\n\`\`\`\n${truncated}\n\`\`\``
}
