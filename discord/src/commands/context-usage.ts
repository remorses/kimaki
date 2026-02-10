// /context-usage command - Show token usage and context window percentage for the current session.

import { ChannelType, type TextChannel, type ThreadChannel } from 'discord.js'
import type { CommandContext } from './types.js'
import { getThreadSession } from '../database.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import { resolveWorkingDirectory, SILENT_MESSAGE_FLAGS } from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import * as errore from 'errore'

const logger = createLogger(LogPrefix.SESSION)

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

    const lastAssistant = assistantMessages[assistantMessages.length - 1]!
    if (lastAssistant.info.role !== 'assistant') {
      await command.editReply({
        content: 'No assistant messages in this session yet',
      })
      return
    }

    // Defensive check: tokens field may be missing on old/malformed messages
    // (same guard as session-handler.ts:1484)
    if (!('tokens' in lastAssistant.info) || !lastAssistant.info.tokens) {
      await command.editReply({
        content: 'Token usage not available for this session yet',
      })
      return
    }

    const { tokens, modelID, providerID } = lastAssistant.info
    const totalTokens =
      tokens.input +
      tokens.output +
      tokens.reasoning +
      tokens.cache.read +
      tokens.cache.write

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
    lines.push(`**Session cost:** ${formattedCost}`)

    // Token breakdown
    lines.push(
      `**Breakdown:** input ${tokens.input.toLocaleString('en-US')}` +
      ` / output ${tokens.output.toLocaleString('en-US')}` +
      (tokens.reasoning > 0 ? ` / reasoning ${tokens.reasoning.toLocaleString('en-US')}` : '') +
      (tokens.cache.read > 0 ? ` / cache read ${tokens.cache.read.toLocaleString('en-US')}` : '') +
      (tokens.cache.write > 0 ? ` / cache write ${tokens.cache.write.toLocaleString('en-US')}` : ''),
    )

    await command.editReply({ content: lines.join('\n') })
    logger.log(`Context usage shown for session ${sessionId}: ${totalTokens} tokens`)
  } catch (error) {
    logger.error('[CONTEXT-USAGE] Error:', error)
    await command.editReply({
      content: `Failed to get context usage: ${error instanceof Error ? error.message : 'Unknown error'}`,
    })
  }
}
