// Command dispatcher and exports.
// Central registry for all slash commands, autocomplete, and select menu handlers.

import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
} from 'discord.js'

// Command handlers
export { handleSessionCommand, handleSessionAutocomplete } from './session.js'
export { handleResumeCommand, handleResumeAutocomplete } from './resume.js'
export { handleAddProjectCommand, handleAddProjectAutocomplete } from './add-project.js'
export { handleCreateNewProjectCommand } from './create-new-project.js'
export { handleAcceptCommand, handleRejectCommand } from './permissions.js'
export { handleAbortCommand } from './abort.js'
export { handleShareCommand } from './share.js'
export { handleForkCommand, handleForkSelectMenu } from './fork.js'
export { handleModelCommand, handleProviderSelectMenu, handleModelSelectMenu } from './model.js'
export { handleQueueCommand, handleClearQueueCommand } from './queue.js'
export { handleUndoCommand, handleRedoCommand } from './undo-redo.js'

// Re-export types
export type { CommandContext, AutocompleteContext, CommandHandler, AutocompleteHandler, SelectMenuHandler } from './types.js'

// Import for dispatcher
import { handleSessionCommand, handleSessionAutocomplete } from './session.js'
import { handleResumeCommand, handleResumeAutocomplete } from './resume.js'
import { handleAddProjectCommand, handleAddProjectAutocomplete } from './add-project.js'
import { handleCreateNewProjectCommand } from './create-new-project.js'
import { handleAcceptCommand, handleRejectCommand } from './permissions.js'
import { handleAbortCommand } from './abort.js'
import { handleShareCommand } from './share.js'
import { handleForkCommand, handleForkSelectMenu } from './fork.js'
import { handleModelCommand, handleProviderSelectMenu, handleModelSelectMenu } from './model.js'
import { handleQueueCommand, handleClearQueueCommand } from './queue.js'
import { handleUndoCommand, handleRedoCommand } from './undo-redo.js'

/**
 * Dispatch a chat input command to the appropriate handler.
 */
export async function dispatchCommand({
  command,
  appId,
}: {
  command: ChatInputCommandInteraction
  appId: string
}): Promise<boolean> {
  switch (command.commandName) {
    case 'session':
      await handleSessionCommand({ command, appId })
      return true

    case 'resume':
      await handleResumeCommand({ command, appId })
      return true

    case 'add-project':
      await handleAddProjectCommand({ command, appId })
      return true

    case 'create-new-project':
      await handleCreateNewProjectCommand({ command, appId })
      return true

    case 'accept':
    case 'accept-always':
      await handleAcceptCommand({ command, appId })
      return true

    case 'reject':
      await handleRejectCommand({ command, appId })
      return true

    case 'abort':
      await handleAbortCommand({ command, appId })
      return true

    case 'share':
      await handleShareCommand({ command, appId })
      return true

    case 'fork':
      await handleForkCommand(command)
      return true

    case 'model':
      await handleModelCommand({ interaction: command, appId })
      return true

    case 'queue':
      await handleQueueCommand({ command, appId })
      return true

    case 'clear-queue':
      await handleClearQueueCommand({ command, appId })
      return true

    case 'undo':
      await handleUndoCommand({ command, appId })
      return true

    case 'redo':
      await handleRedoCommand({ command, appId })
      return true

    default:
      return false
  }
}

/**
 * Dispatch an autocomplete interaction to the appropriate handler.
 */
export async function dispatchAutocomplete({
  interaction,
  appId,
}: {
  interaction: AutocompleteInteraction
  appId: string
}): Promise<boolean> {
  switch (interaction.commandName) {
    case 'session':
      await handleSessionAutocomplete({ interaction, appId })
      return true

    case 'resume':
      await handleResumeAutocomplete({ interaction, appId })
      return true

    case 'add-project':
      await handleAddProjectAutocomplete({ interaction, appId })
      return true

    default:
      return false
  }
}

/**
 * Dispatch a select menu interaction to the appropriate handler.
 */
export async function dispatchSelectMenu(
  interaction: StringSelectMenuInteraction,
): Promise<boolean> {
  const customId = interaction.customId

  if (customId.startsWith('fork_select:')) {
    await handleForkSelectMenu(interaction)
    return true
  }

  if (customId.startsWith('model_provider:')) {
    await handleProviderSelectMenu(interaction)
    return true
  }

  if (customId.startsWith('model_select:')) {
    await handleModelSelectMenu(interaction)
    return true
  }

  return false
}
