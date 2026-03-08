// Discord slash command and interaction handler.
// Processes all slash commands (/session, /resume, /fork, /model, /abort, etc.)
// and manages autocomplete, select menu interactions for the bot.

import {
  Events,
  MessageFlags,
  type Client,
  type Interaction,
} from 'discord.js'
import {
  handleSessionCommand,
  handleSessionAutocomplete,
} from './commands/session.js'
import {
  handleNewWorktreeCommand,
  handleNewWorktreeAutocomplete,
} from './commands/new-worktree.js'
import {
  handleMergeWorktreeCommand,
  handleMergeWorktreeAutocomplete,
} from './commands/merge-worktree.js'
import { handleToggleWorktreesCommand } from './commands/worktree-settings.js'
import { handleWorktreesCommand } from './commands/worktrees.js'
import { handleToggleMentionModeCommand } from './commands/mention-mode.js'
import {
  handleResumeCommand,
  handleResumeAutocomplete,
} from './commands/resume.js'
import {
  handleAddProjectCommand,
  handleAddProjectAutocomplete,
} from './commands/add-project.js'
import {
  handleRemoveProjectCommand,
  handleRemoveProjectAutocomplete,
} from './commands/remove-project.js'
import { handleCreateNewProjectCommand } from './commands/create-new-project.js'
import { handlePermissionButton } from './commands/permissions.js'
import { handleAbortCommand } from './commands/abort.js'
import { handleCompactCommand } from './commands/compact.js'
import { handleShareCommand } from './commands/share.js'
import { handleDiffCommand } from './commands/diff.js'
import { handleForkCommand, handleForkSelectMenu } from './commands/fork.js'
import {
  handleModelCommand,
  handleProviderSelectMenu,
  handleModelSelectMenu,
  handleModelScopeSelectMenu,
} from './commands/model.js'
import { handleUnsetModelCommand } from './commands/unset-model.js'
import {
  handleLoginCommand,
  handleLoginProviderSelectMenu,
  handleLoginMethodSelectMenu,
  handleApiKeyModalSubmit,
} from './commands/login.js'
import {
  handleTranscriptionApiKeyButton,
  handleTranscriptionApiKeyCommand,
  handleTranscriptionApiKeyModalSubmit,
} from './commands/gemini-apikey.js'
import {
  handleAgentCommand,
  handleAgentSelectMenu,
  handleQuickAgentCommand,
} from './commands/agent.js'
import { handleAskQuestionSelectMenu } from './commands/ask-question.js'
import {
  handleFileUploadButton,
  handleFileUploadModalSubmit,
} from './commands/file-upload.js'
import { handleActionButton } from './commands/action-buttons.js'
import { handleHtmlActionButton } from './html-actions.js'
import {
  handleQueueCommand,
  handleClearQueueCommand,
  handleQueueCommandCommand,
  handleQueueCommandAutocomplete,
} from './commands/queue.js'
import { handleUndoCommand, handleRedoCommand } from './commands/undo-redo.js'
import { handleUserCommand } from './commands/user-command.js'
import {
  handleVerbosityCommand,
  handleVerbositySelectMenu,
} from './commands/verbosity.js'
import { handleRestartOpencodeServerCommand } from './commands/restart-opencode-server.js'
import { handleRunCommand } from './commands/run-command.js'
import { handleContextUsageCommand } from './commands/context-usage.js'
import { handleSessionIdCommand } from './commands/session-id.js'
import { handleUpgradeAndRestartCommand } from './commands/upgrade.js'
import { handleMcpCommand, handleMcpSelectMenu } from './commands/mcp.js'
import { handleModelVariantSelectMenu } from './commands/model.js'
import {
  handleModelVariantCommand,
  handleVariantQuickSelectMenu,
  handleVariantScopeSelectMenu,
} from './commands/model-variant.js'
import { hasKimakiBotPermission } from './discord-utils.js'
import { createLogger, LogPrefix } from './logger.js'
import { notifyError } from './sentry.js'

const interactionLogger = createLogger(LogPrefix.INTERACTION)

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

            case 'queue-command':
              await handleQueueCommandAutocomplete({ interaction, appId })
              return

            case 'new-worktree':
              await handleNewWorktreeAutocomplete({ interaction, appId })
              return

            case 'merge-worktree':
              await handleMergeWorktreeAutocomplete({ interaction, appId })
              return

            default:
              await interaction.respond([])
              return
          }
        }

        if (interaction.isChatInputCommand()) {
          interactionLogger.log(
            `[COMMAND] Processing: ${interaction.commandName}`,
          )

          if (!hasKimakiBotPermission(interaction.member, interaction.guild)) {
            await interaction.reply({
              content: `You don't have permission to use this command.\nTo use Kimaki, ask a server admin to give you the **Kimaki** role.`,
              flags: MessageFlags.Ephemeral,
            })
            return
          }

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

            case 'toggle-worktrees':
              await handleToggleWorktreesCommand({
                command: interaction,
                appId,
              })
              return

            case 'worktrees':
              await handleWorktreesCommand({
                command: interaction,
                appId,
              })
              return

            case 'toggle-mention-mode':
              await handleToggleMentionModeCommand({
                command: interaction,
                appId,
              })
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
              await handleCreateNewProjectCommand({
                command: interaction,
                appId,
              })
              return

            case 'abort':
            case 'stop':
              await handleAbortCommand({ command: interaction, appId })
              return

            case 'compact':
              await handleCompactCommand({ command: interaction, appId })
              return

            case 'share':
              await handleShareCommand({ command: interaction, appId })
              return

            case 'diff':
              await handleDiffCommand({ command: interaction, appId })
              return

            case 'fork':
              await handleForkCommand(interaction)
              return

            case 'model':
              await handleModelCommand({ interaction, appId })
              return

            case 'model-variant':
              await handleModelVariantCommand({ interaction, appId })
              return

            case 'unset-model-override':
              await handleUnsetModelCommand({ interaction, appId })
              return

            case 'login':
              await handleLoginCommand({ interaction, appId })
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

            case 'queue-command':
              await handleQueueCommandCommand({ command: interaction, appId })
              return

            case 'undo':
              await handleUndoCommand({ command: interaction, appId })
              return

            case 'redo':
              await handleRedoCommand({ command: interaction, appId })
              return

            case 'verbosity':
              await handleVerbosityCommand({ command: interaction, appId })
              return

            case 'restart-opencode-server':
              await handleRestartOpencodeServerCommand({
                command: interaction,
                appId,
              })
              return

            case 'run-shell-command':
              await handleRunCommand({ command: interaction, appId })
              return

            case 'context-usage':
              await handleContextUsageCommand({ command: interaction, appId })
              return

            case 'session-id':
              await handleSessionIdCommand({ command: interaction, appId })
              return

            case 'upgrade-and-restart':
              await handleUpgradeAndRestartCommand({
                command: interaction,
                appId,
              })
              return

            case 'transcription-key':
              await handleTranscriptionApiKeyCommand({
                interaction,
                appId,
              })
              return

            case 'mcp':
              await handleMcpCommand({ command: interaction, appId })
              return
          }

          // Handle quick agent commands (ending with -agent suffix, but not the base /agent command)
          if (
            interaction.commandName.endsWith('-agent') &&
            interaction.commandName !== 'agent'
          ) {
            await handleQuickAgentCommand({ command: interaction, appId })
            return
          }

          // Handle user-defined commands (ending with -cmd, -skill, or -mcp-prompt suffix)
          if (
            interaction.commandName.endsWith('-cmd') ||
            interaction.commandName.endsWith('-skill') ||
            interaction.commandName.endsWith('-mcp-prompt')
          ) {
            await handleUserCommand({ command: interaction, appId })
            return
          }
          return
        }

        if (interaction.isButton()) {
          if (!hasKimakiBotPermission(interaction.member, interaction.guild)) {
            await interaction.reply({
              content: `You don't have permission to use this.\nTo use Kimaki, ask a server admin to give you the **Kimaki** role.`,
              flags: MessageFlags.Ephemeral,
            })
            return
          }

          const customId = interaction.customId

          if (customId.startsWith('transcription_apikey:')) {
            await handleTranscriptionApiKeyButton(interaction)
            return
          }

          if (
            customId.startsWith('permission_once:') ||
            customId.startsWith('permission_always:') ||
            customId.startsWith('permission_reject:')
          ) {
            await handlePermissionButton(interaction)
            return
          }

          if (customId.startsWith('file_upload_btn:')) {
            await handleFileUploadButton(interaction)
            return
          }

          if (customId.startsWith('action_button:')) {
            await handleActionButton(interaction)
            return
          }

          if (customId.startsWith('html_action:')) {
            await handleHtmlActionButton(interaction)
            return
          }
          return
        }

        if (interaction.isStringSelectMenu()) {
          if (!hasKimakiBotPermission(interaction.member, interaction.guild)) {
            await interaction.reply({
              content: `You don't have permission to use this.\nTo use Kimaki, ask a server admin to give you the **Kimaki** role.`,
              flags: MessageFlags.Ephemeral,
            })
            return
          }

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

          if (customId.startsWith('model_scope:')) {
            await handleModelScopeSelectMenu(interaction)
            return
          }

          if (customId.startsWith('model_variant:')) {
            await handleModelVariantSelectMenu(interaction)
            return
          }

          if (customId.startsWith('variant_quick:')) {
            await handleVariantQuickSelectMenu(interaction)
            return
          }

          if (customId.startsWith('variant_scope:')) {
            await handleVariantScopeSelectMenu(interaction)
            return
          }

          if (customId.startsWith('agent_select:')) {
            await handleAgentSelectMenu(interaction)
            return
          }

          if (customId.startsWith('verbosity_select:')) {
            await handleVerbositySelectMenu(interaction)
            return
          }

          if (customId.startsWith('ask_question:')) {
            await handleAskQuestionSelectMenu(interaction)
            return
          }

          if (customId.startsWith('mcp_toggle:')) {
            await handleMcpSelectMenu(interaction)
            return
          }

          if (customId.startsWith('login_provider:')) {
            await handleLoginProviderSelectMenu(interaction)
            return
          }

          if (customId.startsWith('login_method:')) {
            await handleLoginMethodSelectMenu(interaction)
            return
          }
          return
        }

        if (interaction.isModalSubmit()) {
          if (!hasKimakiBotPermission(interaction.member, interaction.guild)) {
            await interaction.reply({
              content: `You don't have permission to use this.\nTo use Kimaki, ask a server admin to give you the **Kimaki** role.`,
              flags: MessageFlags.Ephemeral,
            })
            return
          }

          const customId = interaction.customId

          if (customId.startsWith('login_apikey:')) {
            await handleApiKeyModalSubmit(interaction)
            return
          }

          if (customId.startsWith('transcription_apikey_modal:')) {
            await handleTranscriptionApiKeyModalSubmit(interaction)
            return
          }

          if (customId.startsWith('file_upload_modal:')) {
            await handleFileUploadModalSubmit(interaction)
            return
          }
          return
        }
      } catch (error) {
        interactionLogger.error(
          '[INTERACTION] Error handling interaction:',
          error,
        )
        void notifyError(error, 'Interaction handler error')
        try {
          if (
            interaction.isRepliable() &&
            !interaction.replied &&
            !interaction.deferred
          ) {
            await interaction.reply({
              content: 'An error occurred processing this command.',
              flags: MessageFlags.Ephemeral,
            })
          }
        } catch (replyError) {
          interactionLogger.error(
            '[INTERACTION] Failed to send error reply:',
            replyError,
          )
        }
      }
    },
  )
}
