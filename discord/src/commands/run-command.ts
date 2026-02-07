// /run-shell-command command - Run an arbitrary shell command in the project directory.
// Resolves the project directory from the channel and executes the command with it as cwd.

import { ChannelType, type TextChannel, type ThreadChannel } from 'discord.js'
import type { CommandContext } from './types.js'
import { resolveTextChannel, getKimakiMetadata, SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import { execAsync } from '../worktree-utils.js'

const logger = createLogger(LogPrefix.INTERACTION)

const MAX_OUTPUT_CHARS = 1900

export async function handleRunCommand({ command }: CommandContext): Promise<void> {
  const channel = command.channel

  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel.',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
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
      content: 'This command can only be used in a text channel or thread.',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const textChannel = isThread
    ? await resolveTextChannel(channel as ThreadChannel)
    : (channel as TextChannel)
  const { projectDirectory: directory } = await getKimakiMetadata(textChannel)

  if (!directory) {
    await command.reply({
      content: 'Could not determine project directory for this channel.',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const input = command.options.getString('command', true)

  await command.deferReply({ flags: SILENT_MESSAGE_FLAGS })

  try {
    const { stdout, stderr } = await execAsync(input, { cwd: directory, timeout: 30_000 })
    const output = [stdout, stderr].filter(Boolean).join('\n').trim()

    const header = `Ran \`${input}\` in \`${directory}\``
    if (!output) {
      await command.editReply({ content: header })
      return
    }

    const codeBlock = formatOutput(output, header)
    await command.editReply({ content: codeBlock })
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; message?: string }
    const output = [execError.stdout, execError.stderr].filter(Boolean).join('\n').trim()
    logger.error(`[RUN-COMMAND] Failed to run "${input}":`, error)

    const header = `\`${input}\` failed`
    const codeBlock = formatOutput(output || execError.message || 'Unknown error', header)
    await command.editReply({ content: codeBlock })
  }
}

function formatOutput(output: string, header: string): string {
  // Reserve space for header + newline + code block delimiters (```\n...\n```)
  const overhead = header.length + 1 + 3 + 1 + 1 + 3 // header\n```\n...\n```
  const maxContent = MAX_OUTPUT_CHARS - overhead
  const truncated = output.length > maxContent
    ? output.slice(0, maxContent - 14) + '\n... truncated'
    : output
  return `${header}\n\`\`\`\n${truncated}\n\`\`\``
}
