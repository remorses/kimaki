// /recover command - Recover a lost session by restoring conversation from Discord thread.

import {
  ChannelType,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import type { CommandContext } from './types.js'
import {
  getChannelDirectory,
  setThreadSession,
  setPartMessagesBatch,
} from '../database.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import {
  resolveWorkingDirectory,
  sendThreadMessage,
  NOTIFY_MESSAGE_FLAGS,
} from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import * as errore from 'errore'

const logger = createLogger(LogPrefix.RECOVER)

const BOT_MESSAGE_PREFIXES = ['⬥', '┣', '◼︎', '⬦']

function stripBotPrefix(content: string): string {
  let stripped = content
  for (const prefix of BOT_MESSAGE_PREFIXES) {
    if (stripped.startsWith(prefix)) {
      stripped = stripped.slice(prefix.length).trim()
      break
    }
  }
  return stripped
}

function extractSessionFooter(content: string): { model?: string; branch?: string; time?: string; context?: string } | null {
  const lines = content.split('\n')
  const lastLine = lines[lines.length - 1]
  if (!lastLine) return null

  const match = lastLine.match(/^(.+?)\s*⋅\s*(.+?)\s*⋅\s*(\d+m\s*\d+s|\d+m|\d+s)\s*⋅\s*(\d+%)\s*⋅\s*(.+)$/)
  if (match) {
    return {
      model: match[5] || undefined,
      branch: match[1] || undefined,
      time: match[2] || undefined,
      context: match[4] || undefined,
    }
  }
  return null
}

interface ParsedMessage {
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
  authorName?: string
}

async function fetchAllThreadMessages(thread: ThreadChannel, botUserId: string): Promise<ParsedMessage[]> {
  const messages: ParsedMessage[] = []
  let lastMessageId: string | undefined

  while (true) {
    const fetchOptions: { limit: number; before?: string } = { limit: 100 }
    if (lastMessageId) {
      fetchOptions.before = lastMessageId
    }

    const fetched = await thread.messages.fetch(fetchOptions)
    if (fetched.size === 0) break

    for (const [_, message] of fetched) {
      const isBotMessage = message.author.id === botUserId

      if (isBotMessage) {
        const content = message.content || ''
        const cleanedContent = stripBotPrefix(content)

        if (cleanedContent) {
          messages.push({
            role: 'assistant',
            content: cleanedContent,
            timestamp: message.createdAt,
            authorName: message.author.username,
          })
        }
      } else {
        const content = message.content || ''
        if (content) {
          messages.push({
            role: 'user',
            content: content,
            timestamp: message.createdAt,
            authorName: message.author.username,
          })
        }
      }
    }

    lastMessageId = fetched.last()?.id
    if (!lastMessageId) break
  }

  return messages.reverse()
}

function buildContextFromMessages(messages: ParsedMessage[]): string {
  const parts: string[] = []

  parts.push('# Recovered Session Context')
  parts.push('')
  parts.push('This session was recovered from Discord thread messages.')
  parts.push('')
  parts.push('## Conversation History')
  parts.push('')

  for (const msg of messages) {
    const timeStr = msg.timestamp.toLocaleString()
    const roleStr = msg.role === 'user' ? '**User**' : '**Assistant**'
    parts.push(`### ${roleStr} (${timeStr})`)
    parts.push('')
    parts.push(msg.content)
    parts.push('')
  }

  return parts.join('\n')
}

function extractProjectDirectoryFromThreadLink(link: string): string | null {
  const match = link.match(/discord\.com\/channels\/\d+\/(\d+)/)
  return match ? match[1] ?? null : null
}

export async function handleRecoverCommand({
  command,
}: CommandContext): Promise<void> {
  await command.deferReply()

  const threadOption = command.options.getString('thread')
  const channel = command.channel

  const botUserId = command.client.user?.id

  if (!botUserId) {
    await command.editReply('Failed to get bot user ID')
    return
  }

  let targetThread: ThreadChannel | null = null

  if (threadOption) {
    const threadIdOrLink = threadOption.trim()

    if (threadIdOrLink.includes('discord.com/channels')) {
      const threadId = extractProjectDirectoryFromThreadLink(threadIdOrLink)
      if (!threadId) {
        await command.editReply('Invalid Discord thread link')
        return
      }
      try {
        const fetched = await command.client.channels.fetch(threadId)
        if (!fetched || !['PublicThread', 'PrivateThread', 'AnnouncementThread'].includes(fetched.type.toString())) {
          await command.editReply('Thread not found or invalid')
          return
        }
        targetThread = fetched as ThreadChannel
      } catch {
        await command.editReply('Failed to fetch thread from link')
        return
      }
    } else {
      try {
        const fetched = await command.client.channels.fetch(threadIdOrLink)
        if (!fetched || !['PublicThread', 'PrivateThread', 'AnnouncementThread'].includes(fetched.type.toString())) {
          await command.editReply('Thread not found')
          return
        }
        targetThread = fetched as ThreadChannel
      } catch {
        await command.editReply('Invalid thread ID')
        return
      }
    }
  } else if (channel) {
    if (
      channel.type === ChannelType.PublicThread ||
      channel.type === ChannelType.PrivateThread ||
      channel.type === ChannelType.AnnouncementThread
    ) {
      targetThread = channel
    }
  }

  if (!targetThread) {
    await command.editReply(
      'This command must be used in a thread, or provide a thread ID/link',
    )
    return
  }

  try {
    logger.log(`[RECOVER] Fetching messages from thread ${targetThread.id}`)

    await command.editReply('Fetching thread messages...')

    const messages = await fetchAllThreadMessages(targetThread, botUserId)

    if (messages.length === 0) {
      await command.editReply('No messages found in this thread')
      return
    }

    const userMessages = messages.filter(m => m.role === 'user')
    const assistantMessages = messages.filter(m => m.role === 'assistant')

    logger.log(
      `[RECOVER] Found ${messages.length} messages (${userMessages.length} user, ${assistantMessages.length} assistant)`,
    )

    const parentChannel = targetThread.parent
    if (!parentChannel || parentChannel.type !== ChannelType.GuildText) {
      await command.editReply('Could not find parent channel for this thread')
      return
    }

    const channelConfig = await getChannelDirectory(parentChannel.id)
    const projectDirectory = channelConfig?.directory

    if (!projectDirectory) {
      await command.editReply(
        'The parent channel of this thread is not configured as a project channel',
      )
      return
    }

    const getClient = await initializeOpencodeForDirectory(projectDirectory)
    if (getClient instanceof Error) {
      await command.editReply(getClient.message)
      return
    }

    await command.editReply('Creating new session...')

    const contextContent = buildContextFromMessages(messages)

    const createResponse = await getClient().session.create({
      title: `Recovered: ${targetThread.name}`,
    })

    if (!createResponse.data) {
      throw new Error('Failed to create session')
    }

    const sessionId = createResponse.data.id

    await setThreadSession(targetThread.id, sessionId)

    logger.log(`[RECOVER] Created session ${sessionId} for thread ${targetThread.id}`)

    await sendThreadMessage(
      targetThread,
      `**Session recovered!**\n\nFound ${messages.length} messages in this thread.\n- User messages: ${userMessages.length}\n- Assistant messages: ${assistantMessages.length}\n\nLoading conversation context...`,
    )

    await getClient().session.promptAsync({
      sessionID: sessionId,
      parts: [
        {
          type: 'text',
          text: contextContent,
        },
      ],
    })

    await sendThreadMessage(
      targetThread,
      `**Session ready!**\n\nThe conversation has been recovered and injected as context.\nYou can continue from where it left off.`,
      { flags: NOTIFY_MESSAGE_FLAGS },
    )

    await command.editReply(
      `Recovered session in ${targetThread.toString()}`,
    )
  } catch (error) {
    logger.error('[RECOVER] Error:', error)
    await command.editReply(
      `Failed to recover session: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}
