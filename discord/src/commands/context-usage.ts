// /context-usage command - Show token usage and context window percentage for the current session.

import { ChannelType, type TextChannel, type ThreadChannel } from 'discord.js'
import type { CommandContext } from './types.js'
import { getThreadSession } from '../database.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import { resolveWorkingDirectory, SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import * as errore from 'errore'

const logger = createLogger(LogPrefix.SESSION)

function getTokenTotal({
  input,
  output,
  reasoning,
  cache,
}: {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}): number {
  return input + output + reasoning + cache.read + cache.write
}

export async function handleContextUsageCommand({ command }: CommandContext): Promise<void> {
  const channel = command.channel

  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const isThread = [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(channel.type)

  if (!isThread) {
    await command.reply({
      content: 'This command can only be used in a thread with an active session',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const resolved = await resolveWorkingDirectory({ channel: channel as TextChannel | ThreadChannel })

  if (!resolved) {
    await command.reply({
      content: 'Could not determine project directory for this channel',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const { projectDirectory, workingDirectory } = resolved

  const sessionId = await getThreadSession(channel.id)

  if (!sessionId) {
    await command.reply({
      content: 'No active session in this thread',
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const getClient = await initializeOpencodeForDirectory(projectDirectory)
  if (getClient instanceof Error) {
    await command.reply({
      content: `Failed to get context usage: ${getClient.message}`,
      ephemeral: true,
      flags: SILENT_MESSAGE_FLAGS,
    })
    return
  }

  await command.deferReply({ flags: SILENT_MESSAGE_FLAGS })

  try {
    const messagesResponse = await getClient().session.messages({
      path: { id: sessionId },
      query: { directory: workingDirectory },
    })

    const messages = messagesResponse.data || []
    const assistantMessages = messages.filter((m) => m.info.role === 'assistant')

    if (assistantMessages.length === 0) {
      await command.editReply({
        content: 'No assistant messages in this session yet',
      })
      return
    }

    const lastAssistant = [...assistantMessages]
      .reverse()
      .find((m) => {
        if (m.info.role !== 'assistant') {
          return false
        }
        if (!('tokens' in m.info) || !m.info.tokens) {
          return false
        }
        return getTokenTotal(m.info.tokens) > 0
      })

    if (!lastAssistant || lastAssistant.info.role !== 'assistant') {
      await command.editReply({
        content: 'Token usage not available for this session yet',
      })
      return
    }

    const { tokens, modelID, providerID } = lastAssistant.info
    const totalTokens = getTokenTotal(tokens)

    // Sum cost across all assistant messages for accurate session total
    // (AssistantMessage.cost is per-message, not cumulative)
    const totalCost = assistantMessages.reduce((sum, m) => {
      if (m.info.role === 'assistant' && 'cost' in m.info) {
        return sum + (m.info.cost || 0)
      }
      return sum
    }, 0)

    // Fetch model context limit from provider API
    let contextLimit: number | undefined
    const providersResult = await errore.tryAsync(() => {
      return getClient().provider.list({ query: { directory: workingDirectory } })
    })
    if (providersResult instanceof Error) {
      logger.error('[CONTEXT-USAGE] Failed to fetch provider info:', providersResult)
    } else {
      const provider = providersResult.data?.all?.find((p) => p.id === providerID)
      const model = provider?.models?.[modelID]
      if (model?.limit?.context) {
        contextLimit = model.limit.context
      }
    }

    const formattedTokens = totalTokens.toLocaleString('en-US')
    const formattedCost = totalCost > 0 ? `$${totalCost.toFixed(4)}` : '$0.00'

    const lines: string[] = []

    if (contextLimit) {
      const percentage = Math.round((totalTokens / contextLimit) * 100)
      const formattedLimit = contextLimit.toLocaleString('en-US')
      lines.push(`**Context usage:** ${formattedTokens} / ${formattedLimit} tokens (${percentage}%)`)
    } else {
      lines.push(`**Context usage:** ${formattedTokens} tokens (context limit unavailable)`)
    }

    if (modelID) {
      lines.push(`**Model:** ${modelID}`)
    }
    if (totalCost > 0) {
      lines.push(`**Session cost:** ${formattedCost}`)
    }

    await command.editReply({ content: lines.join('\n') })
    logger.log(`Context usage shown for session ${sessionId}: ${totalTokens} tokens`)
  } catch (error) {
    logger.error('[CONTEXT-USAGE] Error:', error)
    await command.editReply({
      content: `Failed to get context usage: ${error instanceof Error ? error.message : 'Unknown error'}`,
    })
  }
}
