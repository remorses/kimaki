// Discord slash command and interaction handler.
// Routes adapter-normalized command and component events to existing command handlers.


import type { DiscordAdapter } from './platform/discord-adapter.js'
import { PLATFORM_MESSAGE_FLAGS } from './platform/message-flags.js'
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
  handleModelVariantSelectMenu,
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
import {
  handleModelVariantCommand,
  handleVariantQuickSelectMenu,
  handleVariantScopeSelectMenu,
} from './commands/model-variant.js'
import { createLogger, LogPrefix } from './logger.js'
import type {
  AutocompleteEvent,
  ButtonEvent,
  CommandEvent,
  ModalSubmitEvent,
  SelectMenuEvent,
} from './platform/types.js'
import { notifyError } from './sentry.js'

const interactionLogger = createLogger(LogPrefix.INTERACTION)

type RepliableEvent = {
  reply(options: { content: string; flags: number }): Promise<void>
}

async function handleInteractionError({
  interaction,
  error,
}: {
  interaction: RepliableEvent
  error: unknown
}) {
  interactionLogger.error('[INTERACTION] Error handling interaction:', error)
  void notifyError(error, 'Interaction handler error')
  try {
    await interaction.reply({
      content: 'An error occurred processing this command.',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL,
    })
  } catch (replyError) {
    interactionLogger.error(
      '[INTERACTION] Failed to send error reply:',
      replyError,
    )
  }
}

function ensurePermission({
  interaction,
}: {
  interaction: CommandEvent | ButtonEvent | SelectMenuEvent | ModalSubmitEvent
}) {
  if (interaction.access.canUseKimaki) {
    return true
  }
  void interaction.reply({
    content: `You don't have permission to use this.\nTo use Kimaki, ask a server admin to give you the **Kimaki** role.`,
    flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL,
  })
  return false
}

async function handleAutocomplete({
  interaction,
  appId,
}: {
  interaction: AutocompleteEvent
  appId: string
}) {
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
  }
}

async function handleCommand({
  interaction,
  appId,
}: {
  interaction: CommandEvent
  appId: string
}) {
  if (!ensurePermission({ interaction })) {
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
      await handleToggleWorktreesCommand({ command: interaction, appId })
      return
    case 'worktrees':
      await handleWorktreesCommand({ command: interaction, appId })
      return
    case 'toggle-mention-mode':
      await handleToggleMentionModeCommand({ command: interaction, appId })
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
      await handleRestartOpencodeServerCommand({ command: interaction, appId })
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
      await handleUpgradeAndRestartCommand({ command: interaction, appId })
      return
    case 'transcription-key':
      await handleTranscriptionApiKeyCommand({ interaction, appId })
      return
    case 'mcp':
      await handleMcpCommand({ command: interaction, appId })
      return
  }

  if (interaction.commandName.endsWith('-agent') && interaction.commandName !== 'agent') {
    await handleQuickAgentCommand({ command: interaction, appId })
    return
  }

  if (
    interaction.commandName.endsWith('-cmd') ||
    interaction.commandName.endsWith('-skill') ||
    interaction.commandName.endsWith('-mcp-prompt')
  ) {
    await handleUserCommand({ command: interaction, appId })
  }
}

async function handleButton({ interaction }: { interaction: ButtonEvent }) {
  if (!ensurePermission({ interaction })) {
    return
  }

  if (interaction.customId.startsWith('transcription_apikey:')) {
    await handleTranscriptionApiKeyButton(interaction)
    return
  }

  if (
    interaction.customId.startsWith('permission_once:') ||
    interaction.customId.startsWith('permission_always:') ||
    interaction.customId.startsWith('permission_reject:')
  ) {
    await handlePermissionButton(interaction)
    return
  }

  if (interaction.customId.startsWith('file_upload_btn:')) {
    await handleFileUploadButton(interaction)
    return
  }

  if (interaction.customId.startsWith('action_button:')) {
    await handleActionButton(interaction)
    return
  }

  if (interaction.customId.startsWith('html_action:')) {
    await interaction.runHtmlAction?.()
  }
}

async function handleSelectMenu({ interaction }: { interaction: SelectMenuEvent }) {
  if (!ensurePermission({ interaction })) {
    return
  }

  if (interaction.customId.startsWith('fork_select:')) {
    await handleForkSelectMenu(interaction)
    return
  }
  if (interaction.customId.startsWith('model_provider:')) {
    await handleProviderSelectMenu(interaction)
    return
  }
  if (interaction.customId.startsWith('model_select:')) {
    await handleModelSelectMenu(interaction)
    return
  }
  if (interaction.customId.startsWith('model_scope:')) {
    await handleModelScopeSelectMenu(interaction)
    return
  }
  if (interaction.customId.startsWith('model_variant:')) {
    await handleModelVariantSelectMenu(interaction)
    return
  }
  if (interaction.customId.startsWith('variant_quick:')) {
    await handleVariantQuickSelectMenu(interaction)
    return
  }
  if (interaction.customId.startsWith('variant_scope:')) {
    await handleVariantScopeSelectMenu(interaction)
    return
  }
  if (interaction.customId.startsWith('agent_select:')) {
    await handleAgentSelectMenu(interaction)
    return
  }
  if (interaction.customId.startsWith('verbosity_select:')) {
    await handleVerbositySelectMenu(interaction)
    return
  }
  if (interaction.customId.startsWith('ask_question:')) {
    await handleAskQuestionSelectMenu(interaction)
    return
  }
  if (interaction.customId.startsWith('mcp_toggle:')) {
    await handleMcpSelectMenu(interaction)
    return
  }
  if (interaction.customId.startsWith('login_provider:')) {
    await handleLoginProviderSelectMenu(interaction)
    return
  }
  if (interaction.customId.startsWith('login_method:')) {
    await handleLoginMethodSelectMenu(interaction)
  }
}

async function handleModalSubmit({ interaction }: { interaction: ModalSubmitEvent }) {
  if (!ensurePermission({ interaction })) {
    return
  }

  if (interaction.customId.startsWith('login_apikey:')) {
    await handleApiKeyModalSubmit(interaction)
    return
  }
  if (interaction.customId.startsWith('transcription_apikey_modal:')) {
    await handleTranscriptionApiKeyModalSubmit(interaction)
    return
  }
  if (interaction.customId.startsWith('file_upload_modal:')) {
    await handleFileUploadModalSubmit(interaction)
  }
}

export function registerInteractionHandler({
  discordAdapter,
  appId,
}: {
  discordAdapter: DiscordAdapter
  appId: string
}) {
  interactionLogger.log('[REGISTER] Interaction handler registered')

  discordAdapter.onAutocomplete(async (interaction) => {
    try {
      await handleAutocomplete({ interaction, appId })
    } catch (error) {
      interactionLogger.error('[INTERACTION] Error handling autocomplete:', error)
      void notifyError(error, 'Interaction autocomplete error')
      await interaction.respond([]).catch(() => {
        return undefined
      })
    }
  })

  discordAdapter.onCommand(async (interaction) => {
    try {
      await handleCommand({ interaction, appId })
    } catch (error) {
      await handleInteractionError({ interaction, error })
    }
  })

  discordAdapter.onButton(async (interaction) => {
    try {
      await handleButton({ interaction })
    } catch (error) {
      await handleInteractionError({ interaction, error })
    }
  })

  discordAdapter.onSelectMenu(async (interaction) => {
    try {
      await handleSelectMenu({ interaction })
    } catch (error) {
      await handleInteractionError({ interaction, error })
    }
  })

  discordAdapter.onModalSubmit(async (interaction) => {
    try {
      await handleModalSubmit({ interaction })
    } catch (error) {
      await handleInteractionError({ interaction, error })
    }
  })
}
