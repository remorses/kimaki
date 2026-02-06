// /diff command - Show git diff as a shareable URL.

import { ChannelType, type TextChannel, type ThreadChannel } from 'discord.js'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import type { CommandContext } from './types.js'
import { resolveTextChannel, getKimakiMetadata, SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'

const execAsync = promisify(exec)
const logger = createLogger(LogPrefix.DIFF)

export async function handleDiffCommand({ command }: CommandContext): Promise<void> {
  const channel = command.channel

  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel',
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
      content: 'This command can only be used in a text channel or thread',
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
      content: 'Could not determine project directory for this channel',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  await command.deferReply({ flags: SILENT_MESSAGE_FLAGS })

  try {
    const projectName = path.basename(directory)
    const title = `${projectName}: Discord /diff`
    const { stdout, stderr } = await execAsync(`bunx critique --web "${title}" --json`, {
      cwd: directory,
      timeout: 30000,
    })

    // critique --json outputs JSON on the last line: {"url":"...","id":"..."} or {"error":"..."}
    const output = stdout || stderr
    const lines = output.trim().split('\n')
    const jsonLine = lines[lines.length - 1]
    if (!jsonLine) {
      await command.editReply({
        content: 'No changes to show',
      })
      return
    }

    let result: { url?: string; id?: string; error?: string }
    try {
      result = JSON.parse(jsonLine)
    } catch {
      // Fallback: try to find URL in output
      const urlMatch = output.match(/https?:\/\/critique\.work\/[^\s]+/)
      if (urlMatch) {
        await command.editReply({
          content: `[diff](${urlMatch[0]})`,
        })
        logger.log(`Diff shared: ${urlMatch[0]}`)
        return
      }
      await command.editReply({
        content: 'No changes to show',
      })
      return
    }

    if (result.error || !result.url) {
      await command.editReply({
        content: result.error || 'No changes to show',
      })
      return
    }

    await command.editReply({
      content: `[diff](${result.url})`,
    })
    logger.log(`Diff shared: ${result.url}`)
  } catch (error) {
    logger.error('[DIFF] Error:', error)

    // exec error includes stdout/stderr - try to parse JSON from it
    const execError = error as { stdout?: string; stderr?: string; message?: string }
    const output = execError.stdout || execError.stderr || ''

    // Check if critique output JSON even on error
    const lines = output.trim().split('\n')
    const jsonLine = lines[lines.length - 1]
    if (jsonLine) {
      try {
        const result = JSON.parse(jsonLine) as { error?: string }
        if (result.error) {
          await command.editReply({
            content: result.error,
          })
          return
        }
      } catch {
        // not JSON, continue to generic error
      }
    }

    // Check for common errors
    const message = execError.message || 'Unknown error'
    if (message.includes('command not found') || message.includes('ENOENT')) {
      await command.editReply({
        content: 'bunx/critique not available',
      })
      return
    }

    await command.editReply({
      content: `Failed to generate diff: ${message.slice(0, 200)}`,
    })
  }
}
