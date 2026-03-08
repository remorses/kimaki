// Onboarding welcome message for the default kimaki channel.
// Sends a plain text message explaining what Kimaki is and how to use it.
// Posted once when the default channel is first created.

import type { TextChannel } from 'discord.js'
import { createLogger, LogPrefix } from './logger.js'

const logger = createLogger(LogPrefix.CHANNEL)

const WELCOME_TEXT = `**Kimaki** lets you code from Discord. Send a message in any project channel and an AI agent edits code, runs commands, and searches your codebase — all on your machine.
**What you can do:**
- Add your projects with \`/add-project\` and code from anywhere
- Collaborate with teammates in the same session
- Upload images and files, the bot can share screenshots back
- Expose dev servers with \`kimaki tunnel\` so anyone can access your localhost
Send a message in this channel to get started.`

export async function sendWelcomeMessage({
  channel,
}: {
  channel: TextChannel
}): Promise<void> {
  try {
    await channel.send(WELCOME_TEXT)
    logger.log(`Sent welcome message to #${channel.name}`)
  } catch (error) {
    logger.warn(
      `Failed to send welcome message to #${channel.name}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
