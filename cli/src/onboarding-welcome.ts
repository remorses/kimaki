// Onboarding welcome message for the default kimaki channel.
// Sends a message explaining what Kimaki is, then creates a thread from it
// so the user can respond there to start a tutorial session.
// Sends a smaller follow-up message inside the thread with the installer
// mention so the notification is less noisy.
// Posted once when the default channel is first created.

import { ThreadAutoArchiveDuration, type TextChannel } from 'discord.js'
import { createLogger, LogPrefix } from './logger.js'
import { TUTORIAL_WELCOME_TEXT } from './onboarding-tutorial.js'

const logger = createLogger(LogPrefix.CHANNEL)

function buildWelcomeText(): string {
  return `**Kimaki** lets you code from Discord. Send a message in any project channel and an AI agent edits code, runs commands, and searches your codebase — all on your machine.
**What you can do:**
- Use \`/add-project\` to create a Discord channel linked to one OpenCode project (git repo)
- Collaborate with teammates in the same session
- Upload images and files, the bot can share screenshots back
${TUTORIAL_WELCOME_TEXT}`
}

function buildThreadPrompt({ mentionUserId }: { mentionUserId?: string }): string {
  const mentionSuffix = mentionUserId ? ` <@${mentionUserId}>` : ''
  return `Want to build an example browser game? Respond in this thread.${mentionSuffix}`
}

export async function sendWelcomeMessage({
  channel,
  mentionUserId,
}: {
  channel: TextChannel
  mentionUserId?: string
}): Promise<void> {
  try {
    const message = await channel.send(buildWelcomeText())
    const thread = await message.startThread({
      name: 'Kimaki tutorial',
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: 'Onboarding tutorial thread',
    })
    await thread.send(buildThreadPrompt({ mentionUserId }))
    logger.log(`Sent welcome message with thread to #${channel.name}`)
  } catch (error) {
    logger.warn(
      `Failed to send welcome message to #${channel.name}: ${error instanceof Error ? error.stack : String(error)}`,
    )
  }
}
