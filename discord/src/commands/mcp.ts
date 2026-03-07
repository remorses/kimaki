// /mcp command - List and toggle MCP servers for the current project.
// Uses OpenCode SDK mcp.status/connect/disconnect to manage servers.
// MCP state is project-scoped (per channel), not per thread or session.
// No database storage needed — state lives in OpenCode's config.

import crypto from 'node:crypto'
import {
  MessageFlags,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ChannelType,
  type StringSelectMenuInteraction,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import type { McpStatus } from '@opencode-ai/sdk/v2'
import type { CommandContext } from './types.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import {
  resolveWorkingDirectory,
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'

const logger = createLogger(LogPrefix.MCP)

// Short-lived context map: contextHash → projectDirectory.
// Avoids embedding long directory paths in Discord customId (100 char limit).
// Entries auto-expire after 5 minutes to prevent unbounded growth from
// abandoned menus (user runs /mcp but never clicks the select menu).
const MCP_CONTEXT_TTL_MS = 5 * 60_000
const pendingMcpContexts = new Map<string, string>()

const STATUS_LABELS: Record<string, string> = {
  connected: 'connected',
  disabled: 'disabled',
  failed: 'failed',
  needs_auth: 'needs auth',
  needs_client_registration: 'needs registration',
}

function formatStatusLabel(status: string): string {
  return STATUS_LABELS[status] || status
}

/** Extract error string from McpStatus using discriminated union narrowing. */
function getStatusError(info: McpStatus): string | undefined {
  if (info.status === 'failed') {
    return info.error
  }
  if (info.status === 'needs_client_registration') {
    return info.error
  }
  return undefined
}

/** Build a one-line description for a server entry in the list. */
export function formatServerLine({
  name,
  status,
  error,
}: {
  name: string
  status: string
  error?: string
}): string {
  const label = formatStatusLabel(status)
  const errorSuffix = error ? ` — ${error}` : ''
  return `\`${label}\` **${name}**${errorSuffix}`
}

/** Determine the select menu option label for toggling a server. */
export function toggleActionLabel(status: string): string {
  if (status === 'connected') {
    return 'disconnect'
  }
  if (status === 'failed') {
    return 'reconnect'
  }
  return 'connect'
}

export async function handleMcpCommand({
  command,
}: CommandContext): Promise<void> {
  const channel = command.channel
  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel.',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const isThread = [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel.type)
  const isTextChannel = channel.type === ChannelType.GuildText

  if (!isThread && !isTextChannel) {
    await command.reply({
      content: 'This command can only be used in text channels or threads.',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const resolved = await resolveWorkingDirectory({
    channel: channel as TextChannel | ThreadChannel,
  })
  if (!resolved) {
    await command.reply({
      content: 'Could not determine project directory for this channel.',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const { projectDirectory } = resolved

  await command.deferReply({ flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS })

  const getClient = await initializeOpencodeForDirectory(projectDirectory)
  if (getClient instanceof Error) {
    await command.editReply({
      content: `Failed to connect to OpenCode server: ${getClient.message}`,
    })
    return
  }

  const client = getClient()
  const { data, error } = await client.mcp.status({
    directory: projectDirectory,
  })

  if (error || !data) {
    await command.editReply({
      content: 'Failed to fetch MCP server status.',
    })
    return
  }

  const servers = Object.entries(data)
  if (servers.length === 0) {
    await command.editReply({
      content:
        'No MCP servers configured for this project.\nAdd MCP servers in your project\'s `opencode.json` configuration.',
    })
    return
  }

  const lines = servers.map(([name, info]) => {
    return formatServerLine({ name, status: info.status, error: getStatusError(info) })
  })

  const content = `**MCP Servers** (project-wide)\n${lines.join('\n')}`

  const contextHash = crypto.randomBytes(8).toString('hex')
  pendingMcpContexts.set(contextHash, projectDirectory)
  setTimeout(() => {
    pendingMcpContexts.delete(contextHash)
  }, MCP_CONTEXT_TTL_MS)

  // Discord select option limits: label max 100 chars, description max 100 chars
  const options = servers.map(([name, info]) => ({
    label: name.slice(0, 100),
    value: name.slice(0, 100),
    description: `${formatStatusLabel(info.status)} — click to ${toggleActionLabel(info.status)}`.slice(0, 100),
  }))

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(`mcp_toggle:${contextHash}`)
    .setPlaceholder('Select MCP server to toggle')
    .addOptions(options.slice(0, 25)) // Discord max 25 options

  const actionRow =
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)

  await command.editReply({
    content,
    components: [actionRow],
  })
}

export async function handleMcpSelectMenu(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const customId = interaction.customId
  if (!customId.startsWith('mcp_toggle:')) {
    return
  }

  await interaction.deferUpdate()

  const contextHash = customId.slice('mcp_toggle:'.length)
  const projectDirectory = pendingMcpContexts.get(contextHash)

  if (!projectDirectory) {
    await interaction.editReply({
      content: 'Session expired. Run `/mcp` again.',
      components: [],
    })
    return
  }

  const serverName = interaction.values[0]
  if (!serverName) {
    await interaction.editReply({
      content: 'No server selected.',
      components: [],
    })
    return
  }

  pendingMcpContexts.delete(contextHash)

  const getClient = await initializeOpencodeForDirectory(projectDirectory)
  if (getClient instanceof Error) {
    await interaction.editReply({
      content: `Failed to connect to OpenCode server: ${getClient.message}`,
      components: [],
    })
    return
  }

  const client = getClient()

  const { data: statusData, error: statusError } = await client.mcp.status({
    directory: projectDirectory,
  })

  if (statusError || !statusData) {
    await interaction.editReply({
      content: 'Failed to refresh MCP server status.',
      components: [],
    })
    return
  }

  if (!statusData[serverName]) {
    await interaction.editReply({
      content: `Server **${serverName}** not found.`,
      components: [],
    })
    return
  }

  const serverInfo = statusData[serverName]

  if (serverInfo.status === 'connected') {
    const { error } = await client.mcp.disconnect({
      name: serverName,
      directory: projectDirectory,
    })
    if (error) {
      logger.error(`[MCP] Failed to disconnect ${serverName}:`, error)
      await interaction.editReply({
        content: `Failed to disconnect **${serverName}**.`,
        components: [],
      })
      return
    }
    logger.log(`[MCP] Disconnected server: ${serverName}`)
    await interaction.editReply({
      content: `**${serverName}** disconnected`,
      components: [],
    })
    return
  }

  if (serverInfo.status === 'needs_auth') {
    await interaction.editReply({
      content: `**${serverName}** needs authentication.\nRun \`opencode\` in the project directory to complete the OAuth flow.`,
      components: [],
    })
    return
  }

  if (serverInfo.status === 'needs_client_registration') {
    await interaction.editReply({
      content: `**${serverName}** needs client registration.${serverInfo.error ? `\n${serverInfo.error}` : ''}`,
      components: [],
    })
    return
  }

  // Connect (handles disabled and failed)
  const { error } = await client.mcp.connect({
    name: serverName,
    directory: projectDirectory,
  })
  if (error) {
    logger.error(`[MCP] Failed to connect ${serverName}:`, error)
    await interaction.editReply({
      content: `Failed to connect **${serverName}**.`,
      components: [],
    })
    return
  }
  logger.log(`[MCP] Connected server: ${serverName}`)
  await interaction.editReply({
    content: `**${serverName}** connected`,
    components: [],
  })
}
