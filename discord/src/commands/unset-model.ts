// /unset-model-override command - Remove model overrides and use default instead.

import {
  ChatInputCommandInteraction,
  ChannelType,
  type ThreadChannel,
  type TextChannel,
} from 'discord.js'
import {
  getChannelModel,
  getSessionModel,
  getThreadSession,
  clearSessionModel,
} from '../database.js'
import { getPrisma } from '../db.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import { resolveTextChannel, getKimakiMetadata } from '../discord-utils.js'
import { abortAndRetrySession } from '../session-handler.js'
import { getCurrentModelInfo } from './model.js'
import { createLogger, LogPrefix } from '../logger.js'

const unsetModelLogger = createLogger(LogPrefix.MODEL)

function formatModelSource(type: string, agentName?: string): string {
  switch (type) {
    case 'session':
      return 'session override'
    case 'agent':
      return `agent "${agentName}"`
    case 'channel':
      return 'channel override'
    case 'global':
      return 'global default'
    case 'opencode-config':
    case 'opencode-recent':
    case 'opencode-provider-default':
      return 'opencode default'
    default:
      return 'none'
  }
}

/**
 * Handle the /unset-model-override slash command.
 * In thread: clears session override if exists, otherwise channel override.
 * In channel: clears channel override.
 */
export async function handleUnsetModelCommand({
  interaction,
  appId,
}: {
  interaction: ChatInputCommandInteraction
  appId: string
}): Promise<void> {
  unsetModelLogger.log('[UNSET-MODEL] handleUnsetModelCommand called')

  await interaction.deferReply({ ephemeral: true })

  const channel = interaction.channel

  if (!channel) {
    await interaction.editReply({
      content: 'This command can only be used in a channel',
    })
    return
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
    return
  }

  if (channelAppId && channelAppId !== appId) {
    await interaction.editReply({
      content: 'This channel is not configured for this bot',
    })
    return
  }

  if (!projectDirectory) {
    await interaction.editReply({
      content: 'This channel is not configured with a project directory',
    })
    return
  }

  const effectiveAppId = channelAppId || appId

  // Check what overrides exist
  const [sessionModel, channelModel] = await Promise.all([
    sessionId ? getSessionModel(sessionId) : Promise.resolve(undefined),
    getChannelModel(targetChannelId),
  ])

  let clearedType: 'session' | 'channel' | null = null
  let clearedModel: string | undefined

  if (isThread && sessionId && sessionModel) {
    // In thread with session override: clear session
    await clearSessionModel(sessionId)
    clearedType = 'session'
    clearedModel = sessionModel
    unsetModelLogger.log(`[UNSET-MODEL] Cleared session model for ${sessionId}`)
  } else if (channelModel) {
    // Clear channel override
    const prisma = await getPrisma()
    await prisma.channel_models.deleteMany({
      where: { channel_id: targetChannelId },
    })
    clearedType = 'channel'
    clearedModel = channelModel
    unsetModelLogger.log(`[UNSET-MODEL] Cleared channel model for ${targetChannelId}`)
  } else {
    await interaction.editReply({
      content: 'No model override to clear.',
    })
    return
  }

  // Get the new model that will be used
  const getClient = await initializeOpencodeForDirectory(projectDirectory)
  let newModelText = 'unknown'

  if (!(getClient instanceof Error)) {
    const newModelInfo = await getCurrentModelInfo({
      sessionId,
      channelId: targetChannelId,
      appId: effectiveAppId,
      getClient,
    })

    newModelText =
      newModelInfo.type === 'none'
        ? 'none'
        : `\`${newModelInfo.model}\` (${formatModelSource(newModelInfo.type, 'agentName' in newModelInfo ? newModelInfo.agentName : undefined)})`
  }

  // Check if there's a running request and abort+retry with new model (only for session changes in threads)
  let retried = false
  if (isThread && clearedType === 'session' && sessionId) {
    const thread = channel as ThreadChannel
    retried = await abortAndRetrySession({
      sessionId,
      thread,
      projectDirectory,
      appId: effectiveAppId,
    })
  }

  const clearedTypeText = clearedType === 'session' ? 'Session' : 'Channel'
  const retriedText = retried ? '\n_Retrying current request with new model..._' : ''

  await interaction.editReply({
    content: `${clearedTypeText} model override removed.\n**Was:** \`${clearedModel}\`\n**Now using:** ${newModelText}${retriedText}`,
  })
}
