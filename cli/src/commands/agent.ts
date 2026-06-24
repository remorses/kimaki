// /agent command - Set the preferred agent for this channel or session.
// Also provides quick agent commands like /plan-agent, /build-agent that switch instantly.
// When a prompt is provided to a quick agent command (e.g. /plan-agent "fix the bug"),
// the prompt is sent with that agent and the session keeps that agent afterwards.

import {
  ChatInputCommandInteraction,
  StringSelectMenuInteraction,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ChannelType,
  ThreadAutoArchiveDuration,
  type ThreadChannel,
  MessageFlags,
} from 'discord.js'
import crypto from 'node:crypto'
import {
  setChannelAgent,
  setSessionAgent,
  clearSessionModel,
  getThreadSession,
  getSessionAgent,
  getChannelAgent,
  getChannelWorktreesEnabled,
} from '../database.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import {
  resolveTextChannel,
  resolveWorkingDirectory,
  getKimakiMetadata,
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import { getOrCreateRuntime } from '../session-handler/thread-session-runtime.js'
import { createLogger, LogPrefix } from '../logger.js'
import { getCurrentModelInfo } from './model.js'
import { isGitRepositoryRoot } from '../worktrees.js'
import {
  formatAutoWorktreeName,
  createWorktreeInBackground,
  worktreeCreatingMessage,
} from './new-worktree.js'
import { WORKTREE_PREFIX } from './merge-worktree.js'
import { store } from '../store.js'

const agentLogger = createLogger(LogPrefix.AGENT)

const AGENT_CONTEXT_TTL_MS = 10 * 60 * 1000
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
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

const QUICK_AGENT_DESCRIPTION_PATTERN = /^\[agent:([^\]]+)\]/

/**
 * Build quick-agent command description with an embedded original agent name.
 * Metadata format: [agent:<original-name>] <visible description>
 */
export function buildQuickAgentCommandDescription({
  agentName,
  description,
}: {
  agentName: string
  description?: string
}): string {
  const metadataPrefix = `[agent:${agentName}]`
  if (metadataPrefix.length > 100) {
    return metadataPrefix.slice(0, 100)
  }

  const visibleDescription = description || `Switch to ${agentName} agent`
  const maxVisibleLength = 100 - metadataPrefix.length - 1

  if (maxVisibleLength <= 0) {
    return metadataPrefix
  }

  const trimmedVisible = visibleDescription.slice(0, maxVisibleLength).trim()
  if (!trimmedVisible) {
    return metadataPrefix
  }

  return `${metadataPrefix} ${trimmedVisible}`
}

function parseQuickAgentNameFromDescription(
  description: string | undefined,
): string | undefined {
  if (!description) {
    return undefined
  }
  const match = QUICK_AGENT_DESCRIPTION_PATTERN.exec(description)
  if (!match) {
    return undefined
  }
  const agentName = match[1]?.trim()
  if (!agentName) {
    return undefined
  }
  return agentName
}

async function resolveQuickAgentNameFromInteraction({
  command,
}: {
  command: ChatInputCommandInteraction
}): Promise<string | undefined> {
  const fromCommandObject = parseQuickAgentNameFromDescription(
    command.command?.description,
  )
  if (fromCommandObject) {
    return fromCommandObject
  }

  if (!command.guild) {
    return undefined
  }

  const fetchedCommand = await command.guild.commands.fetch(command.commandId)
  if (!fetchedCommand) {
    return undefined
  }

  return parseQuickAgentNameFromDescription(fetchedCommand.description)
}

/**
 * Resolve the context for an agent command (directory, channel, session).
 * Returns null if the command cannot be executed in this context.
 */
export async function resolveAgentCommandContext({
  interaction,
}: {
  interaction: ChatInputCommandInteraction
  appId: string
}): Promise<AgentCommandContext | null> {
  const channel = interaction.channel

  if (!channel) {
    await interaction.editReply({
      content: 'This command can only be used in a channel',
    })
    return null
  }

  const isThread = [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel.type)

  let projectDirectory: string | undefined
  let targetChannelId: string
  let sessionId: string | undefined

  if (isThread) {
    const thread = channel as ThreadChannel
    const textChannel = await resolveTextChannel(thread)
    const metadata = await getKimakiMetadata(textChannel)
    projectDirectory = metadata.projectDirectory
    targetChannelId = textChannel?.id || channel.id

    sessionId = await getThreadSession(thread.id)
  } else if (channel.type === ChannelType.GuildText) {
    const metadata = await getKimakiMetadata(channel)
    projectDirectory = metadata.projectDirectory
    targetChannelId = channel.id
  } else {
    await interaction.editReply({
      content: 'This command can only be used in text channels or threads',
    })
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
    agentLogger.log(
      `Set agent ${agentName} for session ${context.sessionId} (cleared session model)`,
    )
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
  await interaction.deferReply()

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
      directory: context.dir,
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
    setTimeout(() => {
      pendingAgentContexts.delete(contextHash)
    }, AGENT_CONTEXT_TTL_MS).unref()

    const options = agents.map((agent) => ({
      label: agent.name.slice(0, 100),
      value: agent.name,
      description: (agent.description || `${agent.mode} agent`).slice(0, 100),
    }))

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`agent_select:${contextHash}`)
      .setPlaceholder('Select an agent')
      .addOptions(options)

    const actionRow =
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)

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
        content: `Agent preference set for this session: **${selectedAgent}**\nThe agent will change on the next message.`,
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
 * The slash command name is sanitized for Discord and can be lossy
 * (for example gpt5.4 -> gpt5-4-agent). To keep the original agent name,
 * registration stores [agent:<name>] metadata in the description and this
 * handler resolves from that metadata first.
 */
export async function handleQuickAgentCommand({
  command,
  appId,
}: {
  command: ChatInputCommandInteraction
  appId: string
}): Promise<void> {
  const fallbackAgentName = command.commandName.replace(/-agent$/, '')
  const prompt = command.options.getString('prompt') || undefined

  // Prompt mode: send the prompt with this agent immediately.
  if (prompt) {
    return handleQuickAgentWithPrompt({ command, appId, fallbackAgentName, prompt })
  }

  // No prompt: switch the persistent agent preference (original behavior).
  await command.deferReply()

  const context = await resolveAgentCommandContext({
    interaction: command,
    appId,
  })
  if (!context) {
    return
  }

  try {
    const resolvedAgentName =
      (await resolveQuickAgentNameFromInteraction({ command })) ||
      fallbackAgentName

    // Check current agent and set new one.
    // getCurrentAgentInfo is fast (DB only), use it for the "was X" text.
    const previousAgent = await getCurrentAgentInfo({
      sessionId: context.sessionId,
      channelId: context.channelId,
    })
    const previousAgentName =
      previousAgent.type !== 'none' ? previousAgent.agent : undefined

    if (previousAgentName === resolvedAgentName) {
      await command.editReply({
        content: `Already using **${resolvedAgentName}** agent`,
      })
      return
    }

    // Set the agent preference in DB for this context.
    await setAgentForContext({ context, agentName: resolvedAgentName })

    const previousText = previousAgentName
      ? ` (was **${previousAgentName}**)`
      : ''

    // Resolve the model that will now be used for the new agent so we can
    // show it in the reply. setAgentForContext already cleared any session
    // model preference, so getCurrentModelInfo falls through to the agent's
    // configured model (or channel/global/default).
    const modelInfo = await (async () => {
      const getClient = await initializeOpencodeForDirectory(context.dir)
      if (getClient instanceof Error) {
        return { type: 'none' as const }
      }
      return getCurrentModelInfo({
        sessionId: context.sessionId,
        channelId: context.channelId,
        appId,
        agentPreference: resolvedAgentName,
        getClient,
        directory: context.dir,
      })
    })()

    const modelText =
      modelInfo.type === 'none' ? '' : `\nModel: *${modelInfo.model}*`

    if (context.isThread && context.sessionId) {
      await command.editReply({
        content: `Switched to **${resolvedAgentName}** agent for this session${previousText}${modelText}\nThe agent will change on the next message.`,
      })
    } else {
      await command.editReply({
        content: `Switched to **${resolvedAgentName}** agent for this channel${previousText}${modelText}\nAll new sessions will use this agent.`,
      })
    }
  } catch (error) {
    agentLogger.error('Error in quick agent command:', error)
    await command.editReply({
      content: `Failed to switch agent: ${error instanceof Error ? error.message : 'Unknown error'}`,
    })
  }
}

/**
 * Handle prompt mode: send a prompt with the requested agent.
 * In a thread: enqueue the prompt on the existing session and switch that session.
 * In a channel: create a new thread whose session starts with the requested agent.
 * Channel-level preferences are not changed.
 */
async function handleQuickAgentWithPrompt({
  command,
  appId,
  fallbackAgentName,
  prompt,
}: {
  command: ChatInputCommandInteraction
  appId: string
  fallbackAgentName: string
  prompt: string
}): Promise<void> {
  const channel = command.channel
  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel',
      flags: MessageFlags.Ephemeral,
    })
    return
  }

  const resolvedAgentName =
    (await resolveQuickAgentNameFromInteraction({ command })) ||
    fallbackAgentName

  const isThread = [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel.type)

  const displayText = `${prompt.slice(0, 1000)}${prompt.length > 1000 ? '...' : ''}`

  if (isThread) {
    // In a thread: enqueue the prompt and switch the existing session to this agent.
    const thread = channel as ThreadChannel
    const resolved = await resolveWorkingDirectory({ channel: thread })
    if (!resolved) {
      await command.reply({
        content: 'Could not determine project directory for this channel',
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    const runtime = getOrCreateRuntime({
      threadId: thread.id,
      thread,
      projectDirectory: resolved.projectDirectory,
      sdkDirectory: resolved.workingDirectory,
      channelId: thread.parentId || thread.id,
      appId,
    })

    // Visible reply showing the one-shot prompt (not ephemeral, so it appears in thread).
    await command.reply({
      content: `» **${command.user.displayName}** (${resolvedAgentName}): ${displayText}`,
      flags: SILENT_MESSAGE_FLAGS,
    })

    await runtime.enqueueIncoming({
      prompt,
      userId: command.user.id,
      username: command.user.displayName,
      agent: resolvedAgentName,
      appId,
      mode: 'opencode',
    })
  } else if (channel.type === ChannelType.GuildText) {
    // In a channel: create a new thread and enqueue with the requested agent.
    const metadata = await getKimakiMetadata(channel)
    const projectDirectory = metadata.projectDirectory

    if (!projectDirectory) {
      await command.reply({
        content: 'This channel is not configured with a project directory',
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    await command.deferReply()

    // Check if worktrees should be enabled (CLI flag OR channel setting),
    // mirroring the logic in discord-bot.ts message handler.
    const wantsWorktrees =
      store.getState().useWorktrees ||
      (await getChannelWorktreesEnabled(channel.id))
    const shouldUseWorktrees =
      wantsWorktrees && (await isGitRepositoryRoot(projectDirectory))

    if (wantsWorktrees && !shouldUseWorktrees) {
      agentLogger.warn(
        `[WORKTREE] Skipping automatic worktree for non-git project directory: ${projectDirectory}`,
      )
    }

    const baseThreadName = prompt.slice(0, 80)
    const threadName = shouldUseWorktrees
      ? `${WORKTREE_PREFIX}${baseThreadName}`
      : baseThreadName

    const starterMessage = await channel.send({
      content: `» **${command.user.displayName}** (${resolvedAgentName}): ${displayText}`,
      flags: SILENT_MESSAGE_FLAGS,
    })

    const thread = await starterMessage.startThread({
      name: threadName.slice(0, 80),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      reason: `${resolvedAgentName} agent prompt`,
    })

    await thread.members.add(command.user.id)

    // Create worktree in background if enabled, same as discord-bot.ts
    let worktreePromise: Promise<string | Error> | undefined
    if (shouldUseWorktrees) {
      const worktreeName = formatAutoWorktreeName(baseThreadName.slice(0, 50))
      agentLogger.log(`[WORKTREE] Creating worktree: ${worktreeName}`)

      const worktreeStatusMessage = await thread
        .send({
          content: worktreeCreatingMessage(worktreeName),
          flags: SILENT_MESSAGE_FLAGS,
        })
        .catch(() => undefined)

      worktreePromise = createWorktreeInBackground({
        thread,
        starterMessage: worktreeStatusMessage,
        worktreeName,
        projectDirectory,
        rest: command.client.rest,
      })
    }

    const sessionDirectory = await (async () => {
      if (!worktreePromise) return projectDirectory
      const result = await worktreePromise
      if (result instanceof Error) return projectDirectory
      return result
    })()

    await command
      .editReply(`Sent with **${resolvedAgentName}** agent in ${thread.toString()}`)
      .catch(() => {
        agentLogger.warn('[AGENT] Failed to edit quick-agent reply, continuing session')
      })

    const runtime = getOrCreateRuntime({
      threadId: thread.id,
      thread,
      projectDirectory,
      sdkDirectory: sessionDirectory,
      channelId: channel.id,
      appId,
    })

    await runtime.enqueueIncoming({
      prompt,
      userId: command.user.id,
      username: command.user.displayName,
      agent: resolvedAgentName,
      appId,
      mode: 'opencode',
    })
  } else {
    await command.reply({
      content: 'This command can only be used in text channels or threads',
      flags: MessageFlags.Ephemeral,
    })
  }
}
