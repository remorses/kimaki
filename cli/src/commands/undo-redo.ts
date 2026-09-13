// Undo/Redo commands - /undo, /redo

import {
  ChannelType,
  MessageFlags,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import type { SessionMessageUser } from '@opencode/client'
import type { OpencodeClient } from '../opencode.js'
import type { CommandContext } from './types.js'
import { getThreadSession } from '../database.js'
import { getOpencodeClient, initializeOpencodeForDirectory } from '../opencode.js'
import {
  resolveWorkingDirectory,
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'
import { listAllMessages } from '../opencode-pagination.js'

const logger = createLogger(LogPrefix.UNDO_REDO)

type UserMessageBoundary = { id: string }

export async function listAllUserMessages({
  client,
  sessionId,
}: {
  client: OpencodeClient
  sessionId: string
}) {
  const messages = await listAllMessages({
    client,
    sessionId,
    order: 'asc',
    type: 'user',
  })
  if (messages instanceof Error) return messages
  return messages.filter((message): message is SessionMessageUser => {
    return message.type === 'user'
  })
}

export function getUndoBoundary<T extends UserMessageBoundary>({
  messages,
  revertMessageId,
}: {
  messages: T[]
  revertMessageId?: string
}): T | undefined {
  const boundary = revertMessageId
    ? messages.findIndex((message) => message.id === revertMessageId)
    : messages.length
  return messages[boundary - 1]
}

export function getRedoBoundary<T extends UserMessageBoundary>({
  messages,
  revertMessageId,
}: {
  messages: T[]
  revertMessageId: string
}): T | undefined {
  const boundary = messages.findIndex((message) => message.id === revertMessageId)
  return boundary >= 0 ? messages[boundary + 1] : undefined
}

async function waitForSessionIdle({
  client,
  sessionId,
  timeoutMs = 2_000,
}: {
  client: OpencodeClient
  sessionId: string
  timeoutMs?: number
}): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const statusResponse = await client.session.active()
    const sessionStatus = statusResponse[sessionId]
    if (!sessionStatus) {
      return
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50)
    })
  }
}

export async function handleUndoCommand({
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

  await command.deferReply()

  const serverResult = await initializeOpencodeForDirectory(projectDirectory)
  if (serverResult instanceof Error) {
    await command.editReply(`Failed to undo: ${serverResult.message}`)
    return
  }

  try {
    const client = getOpencodeClient(workingDirectory)
    if (!client) {
      await command.editReply('Failed to get OpenCode client')
      return
    }
    // Fetch session to check existing revert state
    const sessionResponse = await client.session.get({
      sessionID: sessionId,
    }).catch((error: unknown) => {
      return new Error(`Failed to undo: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    })
    if (sessionResponse instanceof Error) {
      await command.editReply(sessionResponse.message)
      return
    }

    // Abort if session is busy before reverting, matching TUI behavior.
    // session.active() returns a sparse map — only running sessions have entries.
    const statusResponse = await client.session.active()
    const sessionStatus = statusResponse[sessionId]
    if (sessionStatus) {
      await client.session.interrupt({
        sessionID: sessionId,
      }).catch((error: unknown) => {
        logger.warn(`[UNDO] abort failed for ${sessionId}`, error)
      })
      await waitForSessionIdle({
        client,
        sessionId,
      })
    }

    const userMessages = await listAllUserMessages({
      client,
      sessionId,
    }).catch((error: unknown) => {
      return new Error(`Failed to undo: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    })
    if (userMessages instanceof Error) {
      await command.editReply(userMessages.message)
      return
    }

    if (userMessages.length === 0) {
      await command.editReply('No messages to undo')
      return
    }

    // Revert boundaries are user messages. Use history order instead of ID
    // ordering because IDs are opaque protocol values.
    const currentRevert = sessionResponse.revert?.messageID
    const targetUserMessage = getUndoBoundary({
      messages: userMessages,
      revertMessageId: currentRevert,
    })

    if (!targetUserMessage) {
      await command.editReply('No messages to undo')
      return
    }

    const revertMessageId = targetUserMessage.id

    // session.revert.stage() reverts filesystem patches and marks the session
    // with revert.messageID. Messages are NOT deleted.
    logger.log(`[UNDO] session.revert start messageId=${revertMessageId}`)
    let response = await client.session.revert.stage({
      sessionID: sessionId,
      messageID: revertMessageId,
    }).catch((error: unknown) => new Error('Failed to undo', { cause: error }))
    logger.log(`[UNDO] session.revert done error=${response instanceof Error}`)

    if (response instanceof Error) {
      logger.log('[UNDO] retry wait idle before revert retry')
      await waitForSessionIdle({
        client,
        sessionId,
      })
      logger.log('[UNDO] retry revert start')
      response = await client.session.revert.stage({
        sessionID: sessionId,
        messageID: revertMessageId,
      }).catch((error: unknown) => new Error('Failed to undo', { cause: error }))
      logger.log(`[UNDO] retry revert done error=${response instanceof Error}`)
      if (response instanceof Error) {
        await command.editReply(
          `Failed to undo: ${response.message}`,
        )
        return
      }
    }

    const diffInfo = response.files?.length
      ? `\nReverted ${response.files.length} file(s)`
      : ''

    await command.editReply(`Undone - reverted last assistant message${diffInfo}`)
    logger.log(
      `Session ${sessionId} reverted at message ${revertMessageId}`,
    )
  } catch (error) {
    logger.error('[UNDO] Error:', error)
    await command.editReply(
      `Failed to undo: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}

export async function handleRedoCommand({
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

  await command.deferReply()

  const serverResult = await initializeOpencodeForDirectory(projectDirectory)
  if (serverResult instanceof Error) {
    await command.editReply(`Failed to redo: ${serverResult.message}`)
    return
  }

  try {
    const client = getOpencodeClient(workingDirectory)
    if (!client) {
      await command.editReply('Failed to get OpenCode client')
      return
    }

    // Fetch session to check existing revert state
    const sessionResponse = await client.session.get({
      sessionID: sessionId,
    }).catch((error: unknown) => {
      return new Error(`Failed to redo: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    })
    if (sessionResponse instanceof Error) {
      await command.editReply(sessionResponse.message)
      return
    }

    const revertMessageID = sessionResponse.revert?.messageID
    if (!revertMessageID) {
      await command.editReply('Nothing to redo - no previous undo found')
      return
    }

    // Abort if session is busy before reverting/unreverting
    const redoStatusResponse = await client.session.active()
    const redoSessionStatus = redoStatusResponse[sessionId]
    if (redoSessionStatus) {
      await client.session.interrupt({
        sessionID: sessionId,
      }).catch((error: unknown) => {
        logger.warn(`[REDO] abort failed for ${sessionId}`, error)
      })
      await waitForSessionIdle({
        client,
        sessionId,
      })
    }
    // Follow the same approach as the OpenCode TUI (use-session-commands.tsx):
    // find the next user message after the current revert point. If one exists,
    // move the revert cursor forward to it (one step redo). If none exists,
    // fully unrevert — we're at the end of the message history.
    const userMessages = await listAllUserMessages({
      client,
      sessionId,
    }).catch((error: unknown) => {
      return new Error(`Failed to redo: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    })
    if (userMessages instanceof Error) {
      await command.editReply(userMessages.message)
      return
    }
    const nextMessage = getRedoBoundary({
      messages: userMessages,
      revertMessageId: revertMessageID,
    })

    if (!nextMessage) {
      const response = await client.session.revert.clear({
        sessionID: sessionId,
      }).catch((error: unknown) => error)
      if (response instanceof Error) {
        await command.editReply(
          `Failed to redo: ${response.message}`,
        )
        return
      }
      await command.editReply('Restored - session fully back to previous state')
      logger.log(`Session ${sessionId} unrevert completed`)
      return
    }

    const response = await client.session.revert.stage({
      sessionID: sessionId,
      messageID: nextMessage.id,
    }).catch((error: unknown) => error)

    if (response instanceof Error) {
      await command.editReply(
        `Failed to redo: ${response.message}`,
      )
      return
    }

    await command.editReply('Restored one step forward')
    logger.log(`Session ${sessionId} redo: moved revert to ${nextMessage.id}`)
  } catch (error) {
    logger.error('[REDO] Error:', error)
    await command.editReply(
      `Failed to redo: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}
