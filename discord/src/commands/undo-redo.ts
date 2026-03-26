// Undo/Redo commands - /undo, /redo

import {
  ChannelType,
  MessageFlags,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { CommandContext } from './types.js'
import { getThreadSession } from '../database.js'
import { initializeOpencodeForDirectory } from '../opencode.js'
import {
  resolveWorkingDirectory,
  SILENT_MESSAGE_FLAGS,
} from '../discord-utils.js'
import { createLogger, LogPrefix } from '../logger.js'

const logger = createLogger(LogPrefix.UNDO_REDO)

async function waitForSessionIdle({
  client,
  sessionId,
  directory,
  timeoutMs = 2_000,
}: {
  client: OpencodeClient
  sessionId: string
  directory: string
  timeoutMs?: number
}): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const statusResponse = await client.session.status({ directory })
    const sessionStatus = statusResponse.data?.[sessionId]
    if (!sessionStatus || sessionStatus.type === 'idle') {
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

  await command.deferReply({ flags: SILENT_MESSAGE_FLAGS })

  const getClient = await initializeOpencodeForDirectory(projectDirectory)
  if (getClient instanceof Error) {
    await command.editReply(`Failed to undo: ${getClient.message}`)
    return
  }

  try {
    const client = getClient()
    // Fetch session to check existing revert state
    const sessionResponse = await client.session.get({
      sessionID: sessionId,
      directory: workingDirectory,
    })
    if (sessionResponse.error) {
      await command.editReply(`Failed to undo: ${JSON.stringify(sessionResponse.error)}`)
      return
    }

    // Abort if session is busy before reverting, matching TUI behavior
    // (use-session-commands.tsx always aborts non-idle sessions before revert).
    // session.status() returns a sparse map — only non-idle sessions have entries,
    // so a missing key means idle.
    const statusResponse = await client.session.status({
      directory: workingDirectory,
    })
    const sessionStatus = statusResponse.data?.[sessionId]
    if (sessionStatus && sessionStatus.type !== 'idle') {
      await client.session.abort({
        sessionID: sessionId,
        directory: workingDirectory,
      }).catch((error) => {
        logger.warn(`[UNDO] abort failed for ${sessionId}`, error)
      })
      await waitForSessionIdle({
        client,
        sessionId,
        directory: workingDirectory,
      })
    }

    const messagesResponse = await client.session.messages({
      sessionID: sessionId,
      directory: workingDirectory,
    })
    if (messagesResponse.error) {
      await command.editReply(`Failed to undo: ${JSON.stringify(messagesResponse.error)}`)
      return
    }

    if (!messagesResponse.data || messagesResponse.data.length === 0) {
      await command.editReply('No messages to undo')
      return
    }

    // Follow the same approach as the OpenCode TUI (use-session-commands.tsx):
    // find the last user message that is before the current revert point
    // (or the last user message if no revert is active). This matches the
    // TUI's `findLast(userMessages(), (x) => !revert || x.id < revert)`.
    const currentRevert = sessionResponse.data?.revert?.messageID
    const userMessages = messagesResponse.data.filter((m) => {
      return m.info.role === 'user'
    })
    const targetUserMessage = [...userMessages].reverse().find((m) => {
      return !currentRevert || m.info.id < currentRevert
    })

    if (!targetUserMessage) {
      await command.editReply('No messages to undo')
      return
    }

    const targetAssistantMessage = [...messagesResponse.data].reverse().find((m) => {
      return m.info.role === 'assistant' && m.info.parentID === targetUserMessage.info.id
    })
    const revertMessageId = targetAssistantMessage?.info.id || targetUserMessage.info.id

    // session.revert() reverts filesystem patches (file edits, writes) and
    // marks the session with revert.messageID. Messages are NOT deleted — they
    // get cleaned up automatically on the next promptAsync() call via
    // SessionRevert.cleanup(). The model only sees messages before the revert
    // point when processing the next prompt.
    logger.log(`[UNDO] session.revert start messageId=${revertMessageId}`)
    let response = await client.session.revert({
      sessionID: sessionId,
      directory: workingDirectory,
      messageID: revertMessageId,
    })
    logger.log(`[UNDO] session.revert done error=${Boolean(response.error)}`)

    if (response.error) {
      logger.log('[UNDO] retry wait idle before revert retry')
      await waitForSessionIdle({
        client,
        sessionId,
        directory: workingDirectory,
      })
      logger.log('[UNDO] retry revert start')
      response = await client.session.revert({
        sessionID: sessionId,
        directory: workingDirectory,
        messageID: revertMessageId,
      })
      logger.log(`[UNDO] retry revert done error=${Boolean(response.error)}`)
      if (response.error) {
        await command.editReply(
          `Failed to undo: ${JSON.stringify(response.error)}`,
        )
        return
      }
    }

    const diffInfo = response.data?.revert?.diff
      ? `\n\`\`\`diff\n${response.data.revert.diff.slice(0, 1500)}\n\`\`\``
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

  await command.deferReply({ flags: SILENT_MESSAGE_FLAGS })

  const getClient = await initializeOpencodeForDirectory(projectDirectory)
  if (getClient instanceof Error) {
    await command.editReply(`Failed to redo: ${getClient.message}`)
    return
  }

  try {
    const client = getClient()

    // Fetch session to check existing revert state
    const sessionResponse = await client.session.get({
      sessionID: sessionId,
      directory: workingDirectory,
    })
    if (sessionResponse.error) {
      await command.editReply(`Failed to redo: ${JSON.stringify(sessionResponse.error)}`)
      return
    }

    const revertMessageID = sessionResponse.data?.revert?.messageID
    if (!revertMessageID) {
      await command.editReply('Nothing to redo - no previous undo found')
      return
    }

    // Abort if session is busy before reverting/unreverting — both enforce
    // assertNotBusy in OpenCode and would fail with "Session is busy"
    const redoStatusResponse = await client.session.status({
      directory: workingDirectory,
    })
    const redoSessionStatus = redoStatusResponse.data?.[sessionId]
    if (redoSessionStatus && redoSessionStatus.type !== 'idle') {
      await client.session.abort({
        sessionID: sessionId,
        directory: workingDirectory,
      }).catch((error) => {
        logger.warn(`[REDO] abort failed for ${sessionId}`, error)
      })
      await waitForSessionIdle({
        client,
        sessionId,
        directory: workingDirectory,
      })
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 500)
    })

    // Follow the same approach as the OpenCode TUI (use-session-commands.tsx):
    // find the next user message after the current revert point. If one exists,
    // move the revert cursor forward to it (one step redo). If none exists,
    // fully unrevert — we're at the end of the message history.
    const messagesResponse = await client.session.messages({
      sessionID: sessionId,
      directory: workingDirectory,
    })
    if (messagesResponse.error) {
      await command.editReply(`Failed to redo: ${JSON.stringify(messagesResponse.error)}`)
      return
    }
    const userMessages = (messagesResponse.data ?? []).filter((m) => {
      return m.info.role === 'user'
    })
    const nextMessage = userMessages.find((m) => {
      return m.info.id > revertMessageID
    })

    if (!nextMessage) {
      // No more messages after revert point — fully unrevert
      const response = await client.session.unrevert({
        sessionID: sessionId,
        directory: workingDirectory,
      })
      if (response.error) {
        await command.editReply(
          `Failed to redo: ${JSON.stringify(response.error)}`,
        )
        return
      }
      await command.editReply('Restored - session fully back to previous state')
      logger.log(`Session ${sessionId} unrevert completed`)
      return
    }

    // Move revert cursor forward one step to the next user message
    const response = await client.session.revert({
      sessionID: sessionId,
      directory: workingDirectory,
      messageID: nextMessage.info.id,
    })

    if (response.error) {
      await command.editReply(
        `Failed to redo: ${JSON.stringify(response.error)}`,
      )
      return
    }

    await command.editReply('Restored one step forward')
    logger.log(`Session ${sessionId} redo: moved revert to ${nextMessage.info.id}`)
  } catch (error) {
    logger.error('[REDO] Error:', error)
    await command.editReply(
      `Failed to redo: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}
