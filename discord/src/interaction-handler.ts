// Discord slash command and interaction handler.
// Processes all slash commands (/session, /resume, /fork, /model, /abort, etc.)
// and manages autocomplete, select menu interactions for the bot.

import { Events, type Client, type Interaction } from 'discord.js'
import { handleSessionCommand, handleSessionAutocomplete } from './commands/session.js'
import { handleNewWorktreeCommand } from './commands/worktree.js'
import { handleMergeWorktreeCommand } from './commands/merge-worktree.js'
import { handleResumeCommand, handleResumeAutocomplete } from './commands/resume.js'
import { handleAddProjectCommand, handleAddProjectAutocomplete } from './commands/add-project.js'
import {
  handleRemoveProjectCommand,
  handleRemoveProjectAutocomplete,
} from './commands/remove-project.js'
import { handleCreateNewProjectCommand } from './commands/create-new-project.js'
import { handlePermissionSelectMenu } from './commands/permissions.js'
import { handleAbortCommand } from './commands/abort.js'
import { handleShareCommand } from './commands/share.js'
import { handleForkCommand, handleForkSelectMenu } from './commands/fork.js'
import {
  handleModelCommand,
  handleProviderSelectMenu,
  handleModelSelectMenu,
} from './commands/model.js'
import { handleAgentCommand, handleAgentSelectMenu, handleQuickAgentCommand } from './commands/agent.js'
import { handleAskQuestionSelectMenu } from './commands/ask-question.js'
import { handleQueueCommand, handleClearQueueCommand } from './commands/queue.js'
import { handleUndoCommand, handleRedoCommand } from './commands/undo-redo.js'
import { handleUserCommand } from './commands/user-command.js'
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

  discordClient.on(Events.InteractionCreate, async (interaction: Interaction) => {
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
        switch (interaction.commandName) {
          case 'new-session':
            await handleSessionAutocomplete({ interaction, appId })
            return

          case 'resume':
            await handleResumeAutocomplete({ interaction, appId })
            return

          case 'add-project':
            await handleAddProjectAutocomplete({ interaction, appId })
            return

          case 'remove-project':
            await handleRemoveProjectAutocomplete({ interaction, appId })
            return

          default:
            await interaction.respond([])
            return
        }
      }

      if (interaction.isChatInputCommand()) {
        interactionLogger.log(`[COMMAND] Processing: ${interaction.commandName}`)

        switch (interaction.commandName) {
          case 'new-session':
            await handleSessionCommand({ command: interaction, appId })
            return

          case 'new-worktree':
            await handleNewWorktreeCommand({ command: interaction, appId })
            return

          case 'merge-worktree':
            await handleMergeWorktreeCommand({ command: interaction, appId })
            return

          case 'resume':
            await handleResumeCommand({ command: interaction, appId })
            return

          case 'add-project':
            await handleAddProjectCommand({ command: interaction, appId })
            return

          case 'remove-project':
            await handleRemoveProjectCommand({ command: interaction, appId })
            return

          case 'create-new-project':
            await handleCreateNewProjectCommand({ command: interaction, appId })
            return

          case 'abort':
          case 'stop':
            await handleAbortCommand({ command: interaction, appId })
            return

          case 'share':
            await handleShareCommand({ command: interaction, appId })
            return

          case 'fork':
            await handleForkCommand(interaction)
            return

          case 'model':
            await handleModelCommand({ interaction, appId })
            return

          case 'agent':
            await handleAgentCommand({ interaction, appId })
            return

          case 'queue':
            await handleQueueCommand({ command: interaction, appId })
            return

          case 'clear-queue':
            await handleClearQueueCommand({ command: interaction, appId })
            return

          case 'undo':
            await handleUndoCommand({ command: interaction, appId })
            return

          case 'redo':
            await handleRedoCommand({ command: interaction, appId })
            return
        }

        // Handle quick agent commands (ending with -agent suffix, but not the base /agent command)
        if (interaction.commandName.endsWith('-agent') && interaction.commandName !== 'agent') {
          await handleQuickAgentCommand({ command: interaction, appId })
          return
        }

        // Handle user-defined commands (ending with -cmd suffix)
        if (interaction.commandName.endsWith('-cmd')) {
          await handleUserCommand({ command: interaction, appId })
          return
        }
        return
      }

      if (interaction.isStringSelectMenu()) {
        const customId = interaction.customId

        if (customId.startsWith('fork_select:')) {
          await handleForkSelectMenu(interaction)
          return
        }

        if (customId.startsWith('model_provider:')) {
          await handleProviderSelectMenu(interaction)
          return
        }

        if (customId.startsWith('model_select:')) {
          await handleModelSelectMenu(interaction)
          return
        }

        if (customId.startsWith('agent_select:')) {
          await handleAgentSelectMenu(interaction)
          return
        }

        if (customId.startsWith('ask_question:')) {
          await handleAskQuestionSelectMenu(interaction)
          return
        }

        if (customId.startsWith('permission:')) {
          await handlePermissionSelectMenu(interaction)
          return
        }
        return
      }
    } catch (error) {
      interactionLogger.error('[INTERACTION] Error handling interaction:', error)
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
  })
}
