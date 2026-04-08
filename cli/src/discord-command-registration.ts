// Discord slash command registration logic, extracted from cli.ts to avoid
// circular dependencies (cli → discord-bot → interaction-handler → command → cli).
// Imported by both cli.ts (startup registration) and restart-opencode-server.ts
// (post-restart re-registration).

import {
  type REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js'
import type { Command as OpencodeCommand } from '@opencode-ai/sdk/v2'
import { createDiscordRest } from './discord-urls.js'
import { createLogger, LogPrefix } from './logger.js'
import { store, type RegisteredUserCommand } from './store.js'
import {
  sanitizeAgentName,
  buildQuickAgentCommandDescription,
} from './commands/agent.js'

const cliLogger = createLogger(LogPrefix.CLI)

// Commands to skip when registering user commands (reserved names)
export const SKIP_USER_COMMANDS = ['init']

export type AgentInfo = {
  name: string
  description?: string
  mode: string
  hidden?: boolean
}

function getDiscordCommandSuffix(
  command: OpencodeCommand,
): '-cmd' | '-skill' | '-mcp-prompt' {
  if (command.source === 'skill') {
    return '-skill'
  }
  if (command.source === 'mcp') {
    return '-mcp-prompt'
  }
  return '-cmd'
}

type DiscordCommandSummary = {
  id: string
  name: string
}

function isDiscordCommandSummary(value: unknown): value is DiscordCommandSummary {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const id = Reflect.get(value, 'id')
  const name = Reflect.get(value, 'name')
  return typeof id === 'string' && typeof name === 'string'
}

async function deleteLegacyGlobalCommands({
  rest,
  appId,
  commandNames,
}: {
  rest: REST
  appId: string
  commandNames: Set<string>
}) {
  try {
    const response = await rest.get(Routes.applicationCommands(appId))
    if (!Array.isArray(response)) {
      cliLogger.warn(
        'COMMANDS: Unexpected global command payload while cleaning legacy global commands',
      )
      return
    }

    const legacyGlobalCommands = response
      .filter(isDiscordCommandSummary)
      .filter((command) => {
        return commandNames.has(command.name)
      })

    if (legacyGlobalCommands.length === 0) {
      return
    }

    const deletionResults = await Promise.allSettled(
      legacyGlobalCommands.map(async (command) => {
        await rest.delete(Routes.applicationCommand(appId, command.id))
        return command
      }),
    )

    const failedDeletions = deletionResults.filter((result) => {
      return result.status === 'rejected'
    })
    if (failedDeletions.length > 0) {
      cliLogger.warn(
        `COMMANDS: Failed to delete ${failedDeletions.length} legacy global command(s)`,
      )
    }

    const deletedCount = deletionResults.length - failedDeletions.length
    if (deletedCount > 0) {
      cliLogger.info(
        `COMMANDS: Deleted ${deletedCount} legacy global command(s) to avoid guild/global duplicates`,
      )
    }
  } catch (error) {
    cliLogger.warn(
      `COMMANDS: Could not clean legacy global commands: ${error instanceof Error ? error.stack : String(error)}`,
    )
  }
}

// Discord slash command descriptions must be 1-100 chars.
// Truncate to 100 so @sapphire/shapeshift validation never throws.
function truncateCommandDescription(description: string): string {
  return description.slice(0, 100)
}

export async function registerCommands({
  token,
  appId,
  guildIds,
  userCommands = [],
  agents = [],
}: {
  token: string
  appId: string
  guildIds: string[]
  userCommands?: OpencodeCommand[]
  agents?: AgentInfo[]
}) {
  const commands = [
    new SlashCommandBuilder()
      .setName('resume')
      .setDescription(truncateCommandDescription('Resume an existing OpenCode session'))
      .addStringOption((option) => {
        option
          .setName('session')
          .setDescription(truncateCommandDescription('The session to resume'))
          .setRequired(true)
          .setAutocomplete(true)

        return option
      })
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('new-session')
      .setDescription(truncateCommandDescription('Start a new OpenCode session'))
      .addStringOption((option) => {
        option
          .setName('prompt')
          .setDescription(truncateCommandDescription('Prompt content for the session'))
          .setRequired(true)

        return option
      })
      .addStringOption((option) => {
        option
          .setName('files')
          .setDescription(
            truncateCommandDescription('Files to mention (comma or space separated; autocomplete)'),
          )
          .setAutocomplete(true)
          .setMaxLength(6000)

        return option
      })
      .addStringOption((option) => {
        option
          .setName('agent')
          .setDescription(truncateCommandDescription('Agent to use for this session'))
          .setAutocomplete(true)

        return option
      })
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('new-worktree')
      .setDescription(
        truncateCommandDescription('Create a git worktree branch from HEAD by default. Optionally pick a base branch.'),
      )
      .addStringOption((option) => {
        option
          .setName('name')
          .setDescription(
            truncateCommandDescription('Name for worktree (optional in threads - uses thread name)'),
          )
          .setRequired(false)

        return option
      })
      .addStringOption((option) => {
        option
          .setName('base-branch')
          .setDescription(
            truncateCommandDescription('Branch to create the worktree from (default: HEAD)'),
          )
          .setRequired(false)
          .setAutocomplete(true)

        return option
      })
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('merge-worktree')
      .setDescription(
        truncateCommandDescription('Squash-merge worktree into default branch. Aborts if main has uncommitted changes.'),
      )
      .addStringOption((option) => {
        option
          .setName('target-branch')
          .setDescription(
            truncateCommandDescription('Branch to merge into (default: origin/HEAD or main)'),
          )
          .setRequired(false)
          .setAutocomplete(true)

        return option
      })
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('toggle-worktrees')
      .setDescription(
        truncateCommandDescription('Toggle automatic git worktree creation for new sessions in this channel'),
      )
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('worktrees')
      .setDescription(truncateCommandDescription('List all active worktree sessions'))
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('tasks')
      .setDescription(truncateCommandDescription('List scheduled tasks created via send --send-at'))
      .addBooleanOption((option) => {
        return option
          .setName('all')
          .setDescription(
            truncateCommandDescription('Include completed, cancelled, and failed tasks'),
          )
      })
      .setDMPermission(false)
      .toJSON(),

    new SlashCommandBuilder()
      .setName('add-project')
      .setDescription(
        truncateCommandDescription('Create Discord channels for a project. Use `npx kimaki project add` for unlisted projects'),
      )
      .addStringOption((option) => {
        option
          .setName('project')
          .setDescription(
            truncateCommandDescription('Recent OpenCode projects. Use `npx kimaki project add` if not listed'),
          )
          .setRequired(true)
          .setAutocomplete(true)

        return option
      })
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('remove-project')
      .setDescription(truncateCommandDescription('Remove Discord channels for a project'))
      .addStringOption((option) => {
        option
          .setName('project')
          .setDescription(truncateCommandDescription('Select a project to remove'))
          .setRequired(true)
          .setAutocomplete(true)

        return option
      })
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('create-new-project')
      .setDescription(
        truncateCommandDescription('Create a new project folder, initialize git, and start a session'),
      )
      .addStringOption((option) => {
        option
          .setName('name')
          .setDescription(truncateCommandDescription('Name for the new project folder'))
          .setRequired(true)

        return option
      })
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('abort')
      .setDescription(truncateCommandDescription('Abort the current OpenCode request in this thread'))
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('compact')
      .setDescription(
        truncateCommandDescription('Compact the session context by summarizing conversation history'),
      )
      .setDMPermission(false)
      .toJSON(),

    new SlashCommandBuilder()
      .setName('share')
      .setDescription(truncateCommandDescription('Share the current session as a public URL'))
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('diff')
      .setDescription(truncateCommandDescription('Show git diff as a shareable URL'))
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('fork')
      .setDescription(truncateCommandDescription('Fork the session from a past user message'))
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('btw')
      .setDescription(truncateCommandDescription('Ask something without polluting or blocking the current session'))
      .addStringOption((option) => {
        option
          .setName('prompt')
          .setDescription(truncateCommandDescription('The message to send in the forked session'))
          .setRequired(true)
        return option
      })
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('model')
      .setDescription(truncateCommandDescription('Set the preferred model for this channel or session'))
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('model-variant')
      .setDescription(
        truncateCommandDescription('Quickly change the thinking level variant for the current model'),
      )
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('unset-model-override')
      .setDescription(truncateCommandDescription('Remove model override and use default instead'))
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('login')
      .setDescription(
        truncateCommandDescription('Authenticate with an AI provider (OAuth or API key). Use this instead of /connect'),
      )
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('agent')
      .setDescription(truncateCommandDescription('Set the preferred agent for this channel or session'))
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('queue')
      .setDescription(
        truncateCommandDescription('Queue a message to be sent after the current response finishes'),
      )
      .addStringOption((option) => {
        option
          .setName('message')
          .setDescription(truncateCommandDescription('The message to queue'))
          .setRequired(true)

        return option
      })
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('clear-queue')
      .setDescription(truncateCommandDescription('Clear all queued messages in this thread'))
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('queue-command')
      .setDescription(
        truncateCommandDescription('Queue a user command to run after the current response finishes'),
      )
      .addStringOption((option) => {
        option
          .setName('command')
          .setDescription(truncateCommandDescription('The command to run'))
          .setRequired(true)
          .setAutocomplete(true)
        return option
      })
      .addStringOption((option) => {
        option
          .setName('arguments')
          .setDescription(truncateCommandDescription('Arguments to pass to the command'))
          .setRequired(false)
        return option
      })
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('undo')
      .setDescription(truncateCommandDescription('Undo the last assistant message (revert file changes)'))
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('redo')
      .setDescription(truncateCommandDescription('Redo previously undone changes'))
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('verbosity')
      .setDescription(truncateCommandDescription('Set output verbosity for this channel'))
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('restart-opencode-server')
      .setDescription(
        truncateCommandDescription('Restart opencode server and re-register slash commands'),
      )
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('run-shell-command')
      .setDescription(
        truncateCommandDescription('Run a shell command in the project directory. Tip: prefix messages with ! as shortcut'),
      )
      .addStringOption((option) => {
        option
          .setName('command')
          .setDescription(truncateCommandDescription('Command to run'))
          .setRequired(true)
        return option
      })
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('context-usage')
      .setDescription(
        truncateCommandDescription('Show token usage and context window percentage for this session'),
      )
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('session-id')
      .setDescription(
        truncateCommandDescription('Show current session ID and opencode attach command for this thread'),
      )
      .setDMPermission(false)
      .toJSON(),

    new SlashCommandBuilder()
      .setName('upgrade-and-restart')
      .setDescription(
        truncateCommandDescription('Upgrade kimaki to the latest version and restart the bot'),
      )
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('transcription-key')
      .setDescription(
        truncateCommandDescription('Set API key for voice message transcription (OpenAI or Gemini)'),
      )
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('mcp')
      .setDescription(truncateCommandDescription('List and manage MCP servers for this project'))
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('screenshare')
      .setDescription(truncateCommandDescription('Start screen sharing via VNC tunnel (auto-stops after 30 minutes)'))
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('screenshare-stop')
      .setDescription(truncateCommandDescription('Stop screen sharing'))
      .setDMPermission(false)
      .toJSON(),
  ]

  // Dynamic commands are registered in priority order: agents → user commands → skills → MCP prompts.
  // This ordering matters because we slice to MAX_DISCORD_COMMANDS (100) at the end,
  // so lower-priority dynamic commands get trimmed first if the total exceeds the limit.

  // 1. Agent-specific quick commands like /plan-agent, /build-agent
  // Filter to primary/all mode agents (same as /agent command shows), excluding hidden agents
  const primaryAgents = agents.filter(
    (a) => (a.mode === 'primary' || a.mode === 'all') && !a.hidden,
  )
  for (const agent of primaryAgents) {
    const sanitizedName = sanitizeAgentName(agent.name)
    // Skip if sanitized name is empty or would create invalid command name
    // Discord command names must start with a lowercase letter or number
    if (!sanitizedName || !/^[a-z0-9]/.test(sanitizedName)) {
      continue
    }
    // Truncate base name before appending suffix so the -agent suffix is never
    // lost to Discord's 32-char command name limit.
    const agentSuffix = '-agent'
    const agentBaseName = sanitizedName.slice(0, 32 - agentSuffix.length)
    const commandName = `${agentBaseName}${agentSuffix}`
    const description = buildQuickAgentCommandDescription({
      agentName: agent.name,
      description: agent.description,
    })

    commands.push(
      new SlashCommandBuilder()
        .setName(commandName)
        .setDescription(truncateCommandDescription(description))
        .setDMPermission(false)
        .toJSON(),
    )
  }

  // 2. User-defined commands, skills, and MCP prompts (ordered by priority)
  // Also populate registeredUserCommands in the store for /queue-command autocomplete
  const newRegisteredCommands: RegisteredUserCommand[] = []
  // Sort: regular commands first, then skills, then MCP prompts
  const sourceOrder: Record<string, number> = { config: 0, skill: 1, mcp: 2 }
  const sortedUserCommands = [...userCommands].sort((a, b) => {
    return (sourceOrder[a.source || ''] ?? 0) - (sourceOrder[b.source || ''] ?? 0)
  })
  for (const cmd of sortedUserCommands) {
    if (SKIP_USER_COMMANDS.includes(cmd.name)) {
      continue
    }

    // Sanitize command name: oh-my-opencode uses MCP commands with colons and slashes,
    // which Discord doesn't allow in command names.
    // Discord command names: lowercase, alphanumeric and hyphens only, must start with letter/number.
    const sanitizedName = cmd.name
      .toLowerCase()
      .replace(/[:/]/g, '-') // Replace : and / with hyphens first
      .replace(/[^a-z0-9-]/g, '-') // Replace any other non-alphanumeric chars
      .replace(/-+/g, '-') // Collapse multiple hyphens
      .replace(/^-|-$/g, '') // Remove leading/trailing hyphens

    // Skip if sanitized name is empty - would create invalid command name like "-cmd"
    if (!sanitizedName) {
      continue
    }

    const commandSuffix = getDiscordCommandSuffix(cmd)

    // Truncate base name before appending suffix so the suffix is never
    // lost to Discord's 32-char command name limit.
    const baseName = sanitizedName.slice(0, 32 - commandSuffix.length)
    const commandName = `${baseName}${commandSuffix}`
    const description = cmd.description || `Run /${cmd.name} command`

    newRegisteredCommands.push({
      name: cmd.name,
      discordCommandName: commandName,
      description,
      source: cmd.source,
    })

    commands.push(
      new SlashCommandBuilder()
        .setName(commandName)
        .setDescription(truncateCommandDescription(description))
        .addStringOption((option) => {
          option
            .setName('arguments')
            .setDescription(truncateCommandDescription('Arguments to pass to the command'))
            .setRequired(false)
          return option
        })
        .setDMPermission(false)
        .toJSON(),
    )
  }
  store.setState({ registeredUserCommands: newRegisteredCommands })

  // Discord allows max 100 guild commands. Slice to stay within the limit,
  // trimming lowest-priority dynamic commands (MCP prompts, then skills) first.
  const MAX_DISCORD_COMMANDS = 100
  if (commands.length > MAX_DISCORD_COMMANDS) {
    cliLogger.warn(
      `COMMANDS: ${commands.length} commands exceed Discord limit of ${MAX_DISCORD_COMMANDS}, truncating to ${MAX_DISCORD_COMMANDS}`,
    )
    commands.length = MAX_DISCORD_COMMANDS
  }

  const rest = createDiscordRest(token)
  const uniqueGuildIds = Array.from(new Set(guildIds.filter((guildId) => guildId)))
  const guildCommandNames = new Set(
    commands
      .map((command) => {
        return command.name
      })
      .filter((name): name is string => {
        return typeof name === 'string'
      }),
  )

  if (uniqueGuildIds.length === 0) {
    cliLogger.warn('COMMANDS: No guilds available, skipping slash command registration')
    return
  }

  try {
    // PUT is a bulk overwrite: Discord matches by name, updates changed fields
    // (description, options, etc.) in place, creates new commands, and deletes
    // any not present in the body. No local diffing needed.
    const results = await Promise.allSettled(
      uniqueGuildIds.map(async (guildId) => {
        const response = await rest.put(
          Routes.applicationGuildCommands(appId, guildId),
          {
            body: commands,
          },
        )

        const registeredCount = Array.isArray(response)
          ? response.length
          : commands.length

        return { guildId, registeredCount }
      }),
    )

    const failedGuilds = results
      .map((result, index) => {
        if (result.status === 'fulfilled') {
          return null
        }

        return {
          guildId: uniqueGuildIds[index],
          error:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        }
      })
      .filter((value): value is { guildId: string; error: string } => {
        return value !== null
      })

    if (failedGuilds.length > 0) {
      failedGuilds.forEach((failure) => {
        cliLogger.warn(
          `COMMANDS: Failed to register slash commands for guild ${failure.guildId}: ${failure.error}`,
        )
      })
      throw new Error(
        `Failed to register slash commands for ${failedGuilds.length} guild(s)`,
      )
    }

    const successfulGuilds = results.length
    const firstRegisteredCount = results[0]
    const registeredCommandCount =
      firstRegisteredCount && firstRegisteredCount.status === 'fulfilled'
        ? firstRegisteredCount.value.registeredCount
        : commands.length

    // In gateway mode, global application routes (/applications/{app_id}/commands)
    // are denied by the proxy (DeniedWithoutGuild). Legacy global commands only
    // exist for self-hosted bots that previously registered commands globally.
    const isGateway = store.getState().discordBaseUrl !== 'https://discord.com'
    if (!isGateway) {
      await deleteLegacyGlobalCommands({
        rest,
        appId,
        commandNames: guildCommandNames,
      })
    }

    cliLogger.info(
      `COMMANDS: Successfully registered ${registeredCommandCount} slash commands for ${successfulGuilds} guild(s)`,
    )
  } catch (error) {
    cliLogger.error(
      'COMMANDS: Failed to register slash commands: ' + String(error),
    )
    throw error
  }
}
