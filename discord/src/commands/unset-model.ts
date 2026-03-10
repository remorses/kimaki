// /unset-model-override command - Remove model overrides and use default instead.

import { PLATFORM_MESSAGE_FLAGS } from '../platform/message-flags.js'
import {
  getChannelModel,
  getSessionModel,
  getThreadSession,
  clearSessionModel,
  getChannelDirectory,
} from '../database.js'
import { getPrisma } from '../db.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import { getRuntime } from '../session-handler/thread-session-runtime.js'
import { getCurrentModelInfo } from './model.js'
import { createLogger, LogPrefix } from '../logger.js'
import type { CommandEvent } from '../platform/types.js'
import { getRootChannelId, isTextChannel, isThreadChannel } from './channel-ref.js'

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
  interaction: CommandEvent
  appId: string
}): Promise<void> {
  unsetModelLogger.log('[UNSET-MODEL] handleUnsetModelCommand called')

  await interaction.deferReply({ flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL })

  const channel = interaction.channel

  if (!channel) {
    await interaction.editReply({
      content: 'This command can only be used in a channel',
    })
    return
  }

  const isThread = isThreadChannel(channel)

  let projectDirectory: string | undefined
  let targetChannelId: string
  let sessionId: string | undefined

  if (isThread) {
    targetChannelId = getRootChannelId(channel) || channel.id
    projectDirectory = (await getChannelDirectory(targetChannelId))?.directory
    sessionId = await getThreadSession(channel.id)
  } else if (isTextChannel(channel)) {
    projectDirectory = (await getChannelDirectory(channel.id))?.directory
    targetChannelId = channel.id
  } else {
    await interaction.editReply({
      content: 'This command can only be used in text channels or threads',
    })
    return
  }

  if (!projectDirectory) {
    await interaction.editReply({
      content: 'This channel is not configured with a project directory',
    })
    return
  }

  // Check what overrides exist
  const [sessionPref, channelPref] = await Promise.all([
    sessionId ? getSessionModel(sessionId) : Promise.resolve(undefined),
    getChannelModel(targetChannelId),
  ])

  let clearedType: 'session' | 'channel' | null = null
  let clearedModel: string | undefined

  if (isThread && sessionId && sessionPref) {
    // In thread with session override: clear session
    await clearSessionModel(sessionId)
    clearedType = 'session'
    clearedModel = sessionPref.modelId
    unsetModelLogger.log(`[UNSET-MODEL] Cleared session model for ${sessionId}`)
  } else if (channelPref) {
    // Clear channel override
    const prisma = await getPrisma()
    await prisma.channel_models.deleteMany({
      where: { channel_id: targetChannelId },
    })
    clearedType = 'channel'
    clearedModel = channelPref.modelId
    unsetModelLogger.log(
      `[UNSET-MODEL] Cleared channel model for ${targetChannelId}`,
    )
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
      appId,
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
    const runtime = getRuntime(channel.id)
    if (runtime) {
      retried = await runtime.retryLastUserPrompt()
    }
  }

  const clearedTypeText = clearedType === 'session' ? 'Session' : 'Channel'
  const retriedText = retried
    ? '\n_Restarting current request with new model..._'
    : ''

  await interaction.editReply({
    content: `${clearedTypeText} model override removed.\n**Was:** \`${clearedModel}\`\n**Now using:** ${newModelText}${retriedText}`,
  })
}
