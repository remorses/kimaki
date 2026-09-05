// Clear model overrides (session first, else channel).
// Invoked from the /model UI via a "Clear override" button.

import {
  ChannelType,
  type TextChannel,
  type ThreadChannel,
  type InteractionEditReplyOptions,
  type Message,
} from 'discord.js'
import {
  getChannelModel,
  getSessionModel,
  getThreadSession,
  clearSessionModel,
} from '../database.js'
import { getDb } from '../db.js'
import * as orm from 'drizzle-orm'
import * as schema from '../schema.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import { resolveTextChannel, getKimakiMetadata } from '../discord-utils.js'
import { getRuntime } from '../session-handler/thread-session-runtime.js'
import { formatModelSource, getCurrentModelInfo } from './model.js'
import { createLogger, LogPrefix } from '../logger.js'

const unsetModelLogger = createLogger(LogPrefix.MODEL)

/**
 * Clear the nearest model override for the current channel/thread.
 * In thread: clears session override if exists, otherwise channel override.
 * In channel: clears channel override.
 */
export async function clearModelOverride({
  channel,
  appId,
  editReply,
}: {
  channel: TextChannel | ThreadChannel
  appId: string
  editReply: (options: InteractionEditReplyOptions) => Promise<Message>
}): Promise<void> {
  unsetModelLogger.log('[UNSET-MODEL] clearModelOverride called')

  const isThread = channel.isThread()

  let projectDirectory: string | undefined
  let targetChannelId: string
  let sessionId: string | undefined

  if (isThread) {
    const textChannel = await resolveTextChannel(channel)
    const metadata = await getKimakiMetadata(textChannel)
    projectDirectory = metadata.projectDirectory
    targetChannelId = textChannel?.id || channel.id
    sessionId = await getThreadSession(channel.id)
  } else if (channel.type === ChannelType.GuildText) {
    const metadata = await getKimakiMetadata(channel)
    projectDirectory = metadata.projectDirectory
    targetChannelId = channel.id
  } else {
    await editReply({
      content: 'This command can only be used in text channels or threads',
      components: [],
    })
    return
  }

  if (!projectDirectory) {
    await editReply({
      content: 'This channel is not configured with a project directory',
      components: [],
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
    const db = await getDb()
    await db.delete(schema.channel_models).where(
      orm.eq(schema.channel_models.channel_id, targetChannelId),
    )
    clearedType = 'channel'
    clearedModel = channelPref.modelId
    unsetModelLogger.log(
      `[UNSET-MODEL] Cleared channel model for ${targetChannelId}`,
    )
  } else {
    await editReply({
      content: 'No model override to clear.',
      components: [],
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
      directory: projectDirectory,
    })

    const agentName =
      newModelInfo.type === 'agent' ? newModelInfo.agentName : undefined
    newModelText =
      newModelInfo.type === 'none'
        ? 'none'
        : `\`${newModelInfo.model}\` (${formatModelSource({
            type: newModelInfo.type,
            agentName,
          })})`
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

  await editReply({
    content: `${clearedTypeText} model override removed.\n**Was:** \`${clearedModel}\`\n**Now using:** ${newModelText}${retriedText}`,
    components: [],
  })
}
