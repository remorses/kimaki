// /session-id command - Show current session ID and an opencode attach command.


import type { CommandContext } from './types.js'
import { PLATFORM_MESSAGE_FLAGS } from '../platform/message-flags.js'
import { getThreadSession } from '../database.js'
import {
  resolveWorkingDirectory,
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import {
  getOpencodeServerPort,
  initializeOpencodeForDirectory,
} from '../opencode.js'
import { createLogger, LogPrefix } from '../logger.js'
import { isThreadChannel } from './channel-ref.js'

const logger = createLogger(LogPrefix.SESSION)

function shellQuote(value: string): string {
  if (!value) {
    return "''"
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export async function handleSessionIdCommand({
  command,
}: CommandContext): Promise<void> {
  const channel = command.channel

  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  if (!isThreadChannel(channel)) {
    await command.reply({
      content:
        'This command can only be used in a thread with an active session',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const resolved = await resolveWorkingDirectory({ channel })

  if (!resolved) {
    await command.reply({
      content: 'Could not determine project directory for this channel',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const { projectDirectory, workingDirectory } = resolved
  const sessionId = await getThreadSession(channel.id)

  if (!sessionId) {
    await command.reply({
      content: 'No active session in this thread',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  await command.deferReply({ flags: SILENT_MESSAGE_FLAGS })

  let port = getOpencodeServerPort(projectDirectory)
  if (!port) {
    const getClient = await initializeOpencodeForDirectory(projectDirectory)
    if (getClient instanceof Error) {
      await command.editReply({
        content: `Session ID: \`${sessionId}\`\nFailed to resolve OpenCode server port: ${getClient.message}`,
      })
      return
    }
    port = getOpencodeServerPort(projectDirectory)
  }

  if (!port) {
    await command.editReply({
      content: `Session ID: \`${sessionId}\`\nCould not determine OpenCode server port`,
    })
    return
  }

  const attachUrl = `http://127.0.0.1:${port}`
  const attachCommand = `opencode attach ${attachUrl} --session ${sessionId} --dir ${shellQuote(workingDirectory)}`

  await command.editReply({
    content: `**Session ID:** \`${sessionId}\`\n**Attach command:**\n\`\`\`bash\n${attachCommand}\n\`\`\``,
  })
  logger.log(`Session ID shown for thread ${channel.id}: ${sessionId}`)
}
