// /mcp: the MCP servers of the folder this thread or channel runs in, as a
// table with one Connect / Disconnect button per row. The buttons call
// OpenCode's mcp.connect and mcp.disconnect, which keep the state in memory
// per location: opencode.json is not changed, so a toggle lasts until
// OpenCode reloads that folder.
//
//   /mcp ─▶ mcp.list ─▶ table page (a Section per server, its button as accessory)
//   mcp:connect:<id> ─▶ row shows Connecting ─▶ mcp.connect (waits for the handshake) ─▶ page again
//   mcp:disconnect:<id> ─▶ mcp.disconnect ─▶ page again
//   mcp:page:<n> ─▶ that page
//
// Custom IDs carry a hash of the server name: names have no length limit.

import crypto from 'node:crypto'
import type { McpServer } from '@opencode/client'
import {
  ButtonStyle,
  ComponentType,
  MessageFlags,
  SlashCommandBuilder,
  type APIComponentInContainer,
  type APISectionComponent,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js'

import { oc, type Bot } from '../bot.ts'
import { button, formatError, truncate } from '../format-parts.ts'
import { replyError, resolveTarget, type InteractionRoutes } from '../interaction-context.ts'

const PREFIX = 'mcp:'
// Discord allows 40 components: container, header and pager use 5, each row 4 (separator, section, text, button).
const PAGE_SIZE = 8
const MAX_ERROR_CHARS = 200

const serverId = (name: string) => crypto.createHash('sha256').update(name).digest('hex').slice(0, 16)

// Status text and the button that changes it, like the OpenCode TUI (tui/src/component/dialog-mcp.tsx).
function control(status: McpServer['status']) {
  const reason = (label: string, error: string) => `${label}: ${truncate(error.replace(/\s+/g, ' '), MAX_ERROR_CHARS)}`
  switch (status.status) {
    case 'connected':
      return { text: 'Connected', action: 'disconnect', label: 'Disconnect', style: ButtonStyle.Secondary } as const
    case 'pending':
      return { text: 'Connecting…', action: 'connect', label: 'Connecting', style: ButtonStyle.Secondary, disabled: true } as const
    case 'disabled':
      return { text: 'Disabled', action: 'connect', label: 'Connect', style: ButtonStyle.Success } as const
    case 'failed':
      return { text: reason('Failed', status.error), action: 'connect', label: 'Retry', style: ButtonStyle.Primary } as const
    case 'needs_auth':
      return { text: reason('Sign in required', status.error), action: 'connect', label: 'Retry', style: ButtonStyle.Primary } as const
  }
}

function serverRow(server: McpServer): APISectionComponent {
  const { text, action, label, style, ...rest } = control(server.status)
  return {
    type: ComponentType.Section,
    components: [{ type: ComponentType.TextDisplay, content: `**${server.name}**\n-# ${text}` }],
    accessory: { ...button({ customId: `${PREFIX}${action}:${serverId(server.name)}`, label, style }), ...rest },
  }
}

function textMessage(content: string) {
  return { flags: MessageFlags.IsComponentsV2 as const, components: [{ type: ComponentType.TextDisplay as const, content }] }
}

function mcpMessage({ directory, servers, page, notice }: { directory: string; servers: readonly McpServer[]; page: number; notice: string | null }) {
  const pages = Math.max(1, Math.ceil(servers.length / PAGE_SIZE))
  const current = Math.min(Math.max(0, Number.isSafeInteger(page) ? page : 0), pages - 1)
  const header = [
    notice,
    `### MCP servers${pages > 1 ? ` (${current + 1}/${pages})` : ''}`,
    `-# \`${directory}\``,
    servers.length === 0
      ? 'No MCP servers configured. Add them to the `mcp` section of opencode.json.'
      : '-# Changes last until OpenCode reloads this folder. opencode.json is not changed.',
  ].filter((line) => line !== null)
  const rows = servers.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)
    .flatMap((server): APIComponentInContainer[] => [{ type: ComponentType.Separator }, serverRow(server)])
  const pager: APIComponentInContainer[] = pages > 1
    ? [{
        type: ComponentType.ActionRow,
        components: [
          { ...button({ customId: `${PREFIX}page:${current - 1}`, label: 'Previous' }), disabled: current === 0 },
          { ...button({ customId: `${PREFIX}page:${current + 1}`, label: 'Next' }), disabled: current === pages - 1 },
        ],
      }]
    : []
  return {
    flags: MessageFlags.IsComponentsV2 as const,
    components: [{ type: ComponentType.Container as const, components: [{ type: ComponentType.TextDisplay as const, content: header.join('\n') }, ...rows, ...pager] }],
    allowedMentions: { parse: [] },
  }
}

async function listServers(bot: Bot, directory: string) {
  const listed = await oc(bot, 'mcp.list', (client) => client.mcp.list({ location: { directory } }))
  if (listed instanceof Error) return listed
  return listed.data
}

async function mcpCommand(bot: Bot, interaction: ChatInputCommandInteraction) {
  const target = await resolveTarget(bot, interaction.channelId)
  if (target instanceof Error) return replyError(interaction, target)
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })
  const servers = await listServers(bot, target.directory)
  if (servers instanceof Error) return replyError(interaction, servers)
  await interaction.editReply(mcpMessage({ directory: target.directory, servers, page: 0, notice: null }))
}

// The message is Components V2 from the command on, so errors become a notice line, never plain content.
async function mcpButton(bot: Bot, interaction: ButtonInteraction) {
  const [action, value = ''] = interaction.customId.slice(PREFIX.length).split(':')
  const target = await resolveTarget(bot, interaction.channelId)
  if (target instanceof Error) return replyError(interaction, target)
  await interaction.deferUpdate()
  const { directory } = target
  const show = async ({ page, notice = null }: { page: number; notice?: string | null }) => {
    const servers = await listServers(bot, directory)
    if (servers instanceof Error) return interaction.editReply(textMessage(formatError(servers.message)))
    return interaction.editReply(mcpMessage({ directory, servers, page, notice }))
  }
  if (action !== 'connect' && action !== 'disconnect') return show({ page: Number(value) })

  const servers = await listServers(bot, directory)
  if (servers instanceof Error) return interaction.editReply(textMessage(formatError(servers.message)))
  const index = servers.findIndex((server) => serverId(server.name) === value)
  const server = servers[index]
  if (!server) return show({ page: 0, notice: 'That MCP server is no longer configured.' })
  const page = Math.floor(index / PAGE_SIZE)
  // Connecting waits for the handshake, which can take seconds.
  if (action === 'connect') {
    const pending = servers.map((entry) => (entry === server ? { ...entry, status: { status: 'pending' as const } } : entry))
    await interaction.editReply(mcpMessage({ directory, servers: pending, page, notice: null }))
  }
  const input = { server: server.name, location: { directory } }
  const done = await oc(bot, `mcp.${action}`, (client) => (action === 'connect' ? client.mcp.connect(input) : client.mcp.disconnect(input)))
  return show({ page, notice: done instanceof Error ? formatError(done.message) : null })
}

export const mcpRoutes: InteractionRoutes = {
  commands: {
    mcp: { definition: new SlashCommandBuilder().setName('mcp').setDescription('List MCP servers and connect or disconnect them'), run: mcpCommand },
  },
  buttons: { [PREFIX]: mcpButton },
}
