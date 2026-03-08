// Onboarding welcome message for the default kimaki channel.
// Sends a message explaining what Kimaki is, then creates a thread from it
// so the user can respond there to start a tutorial session.
// Posted once when the default channel is first created.

import { ThreadAutoArchiveDuration, type TextChannel } from 'discord.js'
import { createLogger, LogPrefix } from './logger.js'

const logger = createLogger(LogPrefix.CHANNEL)

const WELCOME_TEXT = `**Kimaki** lets you code from Discord. Send a message in any project channel and an AI agent edits code, runs commands, and searches your codebase — all on your machine.
**What you can do:**
- Add your projects with \`/add-project\` and code from anywhere
- Collaborate with teammates in the same session
- Upload images and files, the bot can share screenshots back
Want to build an example browser game? Respond in this thread.`

export async function sendWelcomeMessage({
  channel,
}: {
  channel: TextChannel
}): Promise<void> {
  try {
    const message = await channel.send(WELCOME_TEXT)
    await message.startThread({
      name: 'Kimaki tutorial',
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: 'Onboarding tutorial thread',
    })
    logger.log(`Sent welcome message with thread to #${channel.name}`)
  } catch (error) {
    logger.warn(
      `Failed to send welcome message to #${channel.name}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
