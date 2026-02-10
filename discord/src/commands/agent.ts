// /agent command - Set the preferred agent for this channel or session.
// Also provides quick agent commands like /plan-agent, /build-agent that switch instantly.

import {
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ChannelType,
  type ThreadChannel,
  type TextChannel,
} from 'discord.js'
import crypto from 'node:crypto'
import { setChannelAgent, setSessionAgent, clearSessionModel, getThreadSession, getSessionAgent, getChannelAgent } from '../database.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import { resolveTextChannel, getKimakiMetadata } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'

const agentLogger = createLogger(LogPrefix.AGENT)

const pendingAgentContexts = new Map<
  string,
  {
    dir: string
    channelId: string
    sessionId?: string
    isThread: boolean
  }
>()

/**
 * Context for agent commands, containing channel/session info.
 */
export type AgentCommandContext = {
  dir: string
  channelId: string
  sessionId?: string
  isThread: boolean
}

export type CurrentAgentInfo =
  | { type: 'session'; agent: string }
  | { type: 'channel'; agent: string }
  | { type: 'none' }

/**
 * Get the current agent info for a channel/session, including where it comes from.
 * Priority: session > channel > none
 */
export async function getCurrentAgentInfo({
  sessionId,
  channelId,
}: {
  sessionId?: string
  channelId?: string
}): Promise<CurrentAgentInfo> {
  if (sessionId) {
    const sessionAgent = await getSessionAgent(sessionId)
    if (sessionAgent) {
      return { type: 'session', agent: sessionAgent }
    }
  }
  if (channelId) {
    const channelAgent = await getChannelAgent(channelId)
    if (channelAgent) {
      return { type: 'channel', agent: channelAgent }
    }
  }
  return { type: 'none' }
}

/**
 * Sanitize an agent name to be a valid Discord command name component.
 * Lowercase, alphanumeric and hyphens only.
 */
export function sanitizeAgentName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

/**
 * Resolve the context for an agent command (directory, channel, session).
 * Returns null if the command cannot be executed in this context.
 */
export async function resolveAgentCommandContext({
  interaction,
  appId,
}: {
  interaction: ChatInputCommandInteraction
  appId: string
}): Promise<AgentCommandContext | null> {
  const channel = interaction.channel

  if (!channel) {
    await interaction.editReply({ content: 'This command can only be used in a channel' })
    return null
  }

  const isThread = [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel.type)

  let projectDirectory: string | undefined
  let channelAppId: string | undefined
  let targetChannelId: string
  let sessionId: string | undefined

  if (isThread) {
    const thread = channel as ThreadChannel
    const textChannel = await resolveTextChannel(thread)
    const metadata = await getKimakiMetadata(textChannel)
    projectDirectory = metadata.projectDirectory
    channelAppId = metadata.channelAppId
    targetChannelId = textChannel?.id || channel.id

    sessionId = await getThreadSession(thread.id)
  } else if (channel.type === ChannelType.GuildText) {
    const textChannel = channel as TextChannel
    const metadata = await getKimakiMetadata(textChannel)
    projectDirectory = metadata.projectDirectory
    channelAppId = metadata.channelAppId
    targetChannelId = channel.id
  } else {
    await interaction.editReply({
      content: 'This command can only be used in text channels or threads',
    })
    return null
  }

  if (channelAppId && channelAppId !== appId) {
    await interaction.editReply({ content: 'This channel is not configured for this bot' })
    return null
  }

  if (!projectDirectory) {
    await interaction.editReply({
      content: 'This channel is not configured with a project directory',
    })
    return null
  }

  return {
    dir: projectDirectory,
    channelId: targetChannelId,
    sessionId,
    isThread,
  }
}

/**
 * Set the agent preference for a context (session or channel).
 * When switching agents for a session, clears session model preference
 * so the new agent's model takes effect (agent model > channel model).
 */
export async function setAgentForContext({
  context,
  agentName,
}: {
  context: AgentCommandContext
  agentName: string
}): Promise<void> {
  if (context.isThread && context.sessionId) {
    await setSessionAgent(context.sessionId, agentName)
    // Clear session model so the new agent's model takes effect
    await clearSessionModel(context.sessionId)
    agentLogger.log(`Set agent ${agentName} for session ${context.sessionId} (cleared session model)`)
  } else {
    await setChannelAgent(context.channelId, agentName)
    agentLogger.log(`Set agent ${agentName} for channel ${context.channelId}`)
  }
}

export async function handleAgentCommand({
  interaction,
  appId,
}: {
  interaction: ChatInputCommandInteraction
  appId: string
}): Promise<void> {
  await interaction.deferReply({ ephemeral: true })

  const context = await resolveAgentCommandContext({ interaction, appId })
  if (!context) {
    return
  }

  try {
    const getClient = await initializeOpencodeForDirectory(context.dir)
    if (getClient instanceof Error) {
      await interaction.editReply({ content: getClient.message })
      return
    }

    const agentsResponse = await getClient().app.agents({
      query: { directory: context.dir },
    })

    if (!agentsResponse.data || agentsResponse.data.length === 0) {
      await interaction.editReply({ content: 'No agents available' })
      return
    }

    const agents = agentsResponse.data
      .filter((agent) => {
        const hidden = (agent as { hidden?: boolean }).hidden
        return (agent.mode === 'primary' || agent.mode === 'all') && !hidden
      })
      .slice(0, 25)

    if (agents.length === 0) {
      await interaction.editReply({ content: 'No primary agents available' })
      return
    }

    const currentAgentInfo = await getCurrentAgentInfo({
      sessionId: context.sessionId,
      channelId: context.channelId,
    })

    const currentAgentText = (() => {
      switch (currentAgentInfo.type) {
        case 'session':
          return `**Current (session override):** \`${currentAgentInfo.agent}\``
        case 'channel':
          return `**Current (channel override):** \`${currentAgentInfo.agent}\``
        case 'none':
          return '**Current:** none'
      }
    })()

    const contextHash = crypto.randomBytes(8).toString('hex')
    pendingAgentContexts.set(contextHash, context)

    const options = agents.map((agent) => ({
      label: agent.name.slice(0, 100),
      value: agent.name,
      description: (agent.description || `${agent.mode} agent`).slice(0, 100),
    }))

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`agent_select:${contextHash}`)
      .setPlaceholder('Select an agent')
      .addOptions(options)

    const actionRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)

    await interaction.editReply({
      content: `**Set Agent Preference**\n${currentAgentText}\nSelect an agent:`,
      components: [actionRow],
    })
  } catch (error) {
    agentLogger.error('Error loading agents:', error)
    await interaction.editReply({
      content: `Failed to load agents: ${error instanceof Error ? error.message : 'Unknown error'}`,
    })
  }
}

export async function handleAgentSelectMenu(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const customId = interaction.customId

  if (!customId.startsWith('agent_select:')) {
    return
  }

  await interaction.deferUpdate()

  const contextHash = customId.replace('agent_select:', '')
  const context = pendingAgentContexts.get(contextHash)

  if (!context) {
    await interaction.editReply({
      content: 'Selection expired. Please run /agent again.',
      components: [],
    })
    return
  }

  const selectedAgent = interaction.values[0]
  if (!selectedAgent) {
    await interaction.editReply({
      content: 'No agent selected',
      components: [],
    })
    return
  }

  try {
    await setAgentForContext({ context, agentName: selectedAgent })

    if (context.isThread && context.sessionId) {
      await interaction.editReply({
        content: `Agent preference set for this session: **${selectedAgent}**`,
        components: [],
      })
    } else {
      await interaction.editReply({
        content: `Agent preference set for this channel: **${selectedAgent}**\nAll new sessions in this channel will use this agent.`,
        components: [],
      })
    }

    pendingAgentContexts.delete(contextHash)
  } catch (error) {
    agentLogger.error('Error saving agent preference:', error)
    await interaction.editReply({
      content: `Failed to save agent preference: ${error instanceof Error ? error.message : 'Unknown error'}`,
      components: [],
    })
  }
}

/**
 * Handle quick agent commands like /plan-agent, /build-agent.
 * These instantly switch to the specified agent without showing a dropdown.
 *
 * Optimized for speed: skips opencode server entirely.
 * The agent name is already validated at command registration time (cli.ts registers
 * commands from the agents list), so we trust the command name directly instead of
 * calling initializeOpencodeForDirectory + app.agents() to re-validate.
 * This eliminates two HTTP round-trips (~400-1000ms) that the old implementation had.
 */
export async function handleQuickAgentCommand({
  command,
  appId,
}: {
  command: ChatInputCommandInteraction
  appId: string
}): Promise<void> {
  // Extract agent name from command: "plan-agent" → "plan"
  const sanitizedAgentName = command.commandName.replace(/-agent$/, '')

  await command.deferReply({ ephemeral: true })

  const context = await resolveAgentCommandContext({ interaction: command, appId })
  if (!context) {
    return
  }

  try {
    // Check current agent and set new one.
    // getCurrentAgentInfo is fast (DB only), use it for the "was X" text.
    const previousAgent = await getCurrentAgentInfo({
      sessionId: context.sessionId,
      channelId: context.channelId,
    })
    const previousAgentName = previousAgent.type !== 'none' ? previousAgent.agent : undefined

    if (previousAgentName === sanitizedAgentName) {
      await command.editReply({
        content: `Already using **${sanitizedAgentName}** agent`,
      })
      return
    }

    // Set the agent preference (DB write only, no HTTP calls)
    await setAgentForContext({ context, agentName: sanitizedAgentName })

    const previousText = previousAgentName ? ` (was **${previousAgentName}**)` : ''

    if (context.isThread && context.sessionId) {
      await command.editReply({
        content: `Switched to **${sanitizedAgentName}** agent for this session${previousText}`,
      })
    } else {
      await command.editReply({
        content: `Switched to **${sanitizedAgentName}** agent for this channel${previousText}\nAll new sessions will use this agent.`,
      })
    }
  } catch (error) {
    agentLogger.error('Error in quick agent command:', error)
    await command.editReply({
      content: `Failed to switch agent: ${error instanceof Error ? error.message : 'Unknown error'}`,
    })
  }
}
