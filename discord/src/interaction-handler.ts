// Discord slash command and interaction handler.
// Processes all slash commands (/session, /resume, /fork, /model, /abort, etc.)
// and manages autocomplete, select menu interactions for the bot.

import { Events, type Client, type Interaction } from 'discord.js'
import { dispatchCommand, dispatchAutocomplete, dispatchSelectMenu } from './commands/index.js'
import { createLogger } from './logger.js'

const interactionLogger = createLogger('INTERACTION')

export function registerInteractionHandler({
  discordClient,
  appId,
}: {
  discordClient: Client
  appId: string
}) {
  interactionLogger.log('[REGISTER] Interaction handler registered')

  discordClient.on(
    Events.InteractionCreate,
    async (interaction: Interaction) => {
      try {
        interactionLogger.log(
          `[INTERACTION] Received: ${interaction.type} - ${
            interaction.isChatInputCommand()
              ? interaction.commandName
              : interaction.isAutocomplete()
                ? `autocomplete:${interaction.commandName}`
                : 'other'
          }`,
        )

        if (interaction.isAutocomplete()) {
          const handled = await dispatchAutocomplete({ interaction, appId })
          if (!handled) {
            await interaction.respond([])
          }
          return
        }

        if (interaction.isChatInputCommand()) {
          interactionLogger.log(`[COMMAND] Processing: ${interaction.commandName}`)
          await dispatchCommand({ command: interaction, appId })
          return
        }

        if (interaction.isStringSelectMenu()) {
          await dispatchSelectMenu(interaction)
          return
        }
      } catch (error) {
        interactionLogger.error('[INTERACTION] Error handling interaction:', error)
        // Try to respond to the interaction if possible
        try {
          if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
            await interaction.reply({
              content: 'An error occurred processing this command.',
              ephemeral: true,
            })
          }
        } catch (replyError) {
          interactionLogger.error('[INTERACTION] Failed to send error reply:', replyError)
        }
      }
    },
  )
}
