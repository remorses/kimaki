// /context-usage command - Show token usage and context window percentage for the current session.

import {
  ChannelType,
  MessageFlags,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import type { CommandContext } from './types.js'
import { OpenCodeSdkError } from '../errors.js'
import { getThreadSession } from '../database.js'
import { getOpencodeClient, initializeOpencodeForDirectory } from '../opencode.js'
import {
  resolveWorkingDirectory,
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import { listAllMessages } from '../opencode-pagination.js'


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

export async function handleContextUsageCommand({
  command,
}: CommandContext): Promise<void> {
  const channel = command.channel

  if (!channel) {
    await command.reply({
      content: 'This command can only be used in a channel',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
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
      content:
        'This command can only be used in a thread with an active session',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const resolved = await resolveWorkingDirectory({
    channel: channel as TextChannel | ThreadChannel,
  })

  if (!resolved) {
    await command.reply({
      content: 'Could not determine project directory for this channel',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const { projectDirectory, workingDirectory } = resolved

  const sessionId = await getThreadSession(channel.id)

  if (!sessionId) {
    await command.reply({
      content: 'No active session in this thread',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const serverResult = await initializeOpencodeForDirectory(projectDirectory)
  if (serverResult instanceof Error) {
    await command.reply({
      content: `Failed to get context usage: ${serverResult.message}`,
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  const client = getOpencodeClient(workingDirectory)
  if (!client) {
    await command.reply({
      content: 'Failed to get OpenCode client',
      flags: MessageFlags.Ephemeral | SILENT_MESSAGE_FLAGS,
    })
    return
  }

  await command.deferReply({ flags: SILENT_MESSAGE_FLAGS })

  try {
    const messagesResult = await listAllMessages({
      client,
      sessionId,
      order: 'asc',
    })
    if (messagesResult instanceof Error) throw messagesResult

    const messages = messagesResult
    const assistantMessages = messages.filter(
      (m) => m.type === 'assistant',
    )

    if (assistantMessages.length === 0) {
      await command.editReply({
        content: 'No assistant messages in this session yet',
      })
      return
    }

    const lastAssistant = [...assistantMessages].reverse().find((m) => {
      if (m.type !== 'assistant') {
        return false
      }
      if (!m.tokens) {
        return false
      }
      return getTokenTotal(m.tokens) > 0
    })

    if (!lastAssistant || lastAssistant.type !== 'assistant') {
      await command.editReply({
        content: 'Token usage not available for this session yet',
      })
      return
    }

    const { tokens, model } = lastAssistant
    const modelID = model.id
    const providerID = model.providerID
    const totalTokens = tokens ? getTokenTotal(tokens) : 0

    const totalCost = assistantMessages.reduce((sum, m) => {
      if (m.type === 'assistant') {
        return sum + (m.cost || 0)
      }
      return sum
    }, 0)

    let contextLimit: number | undefined
    const modelsResult = await client.model.list({ location: { directory: workingDirectory } })
      .catch((e: unknown) => new OpenCodeSdkError({ operation: 'model.list', cause: e }))
    if (modelsResult instanceof Error) {
      logger.error(
        '[CONTEXT-USAGE] Failed to fetch provider info:',
        modelsResult,
      )
    } else {
      const listed = modelsResult.data.find((candidate) => {
        return candidate.providerID === providerID && candidate.modelID === modelID
      })
      if (listed?.limit?.context) {
        contextLimit = listed.limit.context
      }
    }

    const formattedTokens = totalTokens.toLocaleString('en-US')
    const formattedCost = totalCost > 0 ? `$${totalCost.toFixed(4)}` : '$0.00'

    const lines: string[] = []

    if (contextLimit) {
      const percentage = Math.round((totalTokens / contextLimit) * 100)
      const formattedLimit = contextLimit.toLocaleString('en-US')
      lines.push(
        `**Context usage:** ${percentage}%, ${formattedTokens} / ${formattedLimit} tokens`,
      )
    } else {
      lines.push(
        `**Context usage:** ${formattedTokens} tokens (context limit unavailable)`,
      )
    }

    if (modelID) {
      lines.push(`**Model:** ${modelID}`)
    }
    if (totalCost > 0) {
      lines.push(`**Session cost:** ${formattedCost}`)
    }

    await command.editReply({ content: lines.join('\n') })
    logger.log(
      `Context usage shown for session ${sessionId}: ${totalTokens} tokens`,
    )
  } catch (error) {
    logger.error('[CONTEXT-USAGE] Error:', error)
    await command.editReply({
      content: `Failed to get context usage: ${error instanceof Error ? error.message : 'Unknown error'}`,
    })
  }
}
