// Message pre-processing pipeline for incoming Discord messages.
// Extracts prompt text, voice transcription, file/text attachments, and
// session context from a Discord Message before handing off to the runtime.
//
// This module exists so discord-bot.ts stays a thin event router and the
// expensive async work (voice transcription, context fetch, attachment
// download) runs inside the runtime's serialized preprocessChain —
// preserving arrival order without a separate threadIngressQueue.

import type { Message, ThreadChannel } from 'discord.js'
import type { DiscordFileAttachment } from './message-formatting.js'
import type { PreprocessResult } from './session-handler/thread-session-runtime.js'
import {
  resolveMentions,
  getFileAttachments,
  getTextAttachments,
} from './message-formatting.js'
import { processVoiceAttachment } from './voice-handler.js'
import { initializeOpencodeForDirectory } from './opencode.js'
import { getCompactSessionContext, getLastSessionId } from './markdown.js'
import { getThreadSession } from './database.js'
import * as errore from 'errore'
import { createLogger, LogPrefix } from './logger.js'
import { notifyError } from './sentry.js'

const logger = createLogger(LogPrefix.SESSION)
const voiceLogger = createLogger(LogPrefix.VOICE)

export type { PreprocessResult }

/**
 * Pre-process a message in an existing thread (thread already has a session or
 * needs a new one). Handles voice transcription, text/file attachments, and
 * session context fetching for voice messages.
 *
 * For threads with an existing session, voice transcription is enriched with
 * current + last session context (used by the transcription model to better
 * understand domain-specific terms).
 */
export async function preprocessExistingThreadMessage({
  message,
  thread,
  projectDirectory,
  channelId,
  isCliInjected,
  hasVoiceAttachment,
  appId,
}: {
  message: Message
  thread: ThreadChannel
  projectDirectory: string
  channelId: string | undefined
  isCliInjected: boolean
  hasVoiceAttachment: boolean
  appId: string | undefined
}): Promise<PreprocessResult> {
  const sessionId = await getThreadSession(thread.id)

  // ── No existing session: new session in an existing thread ──
  if (!sessionId) {
    return preprocessNewSessionMessage({
      message,
      thread,
      projectDirectory,
      hasVoiceAttachment,
      appId,
    })
  }

  // ── Existing session path ──
  voiceLogger.log(`[SESSION] Found session ${sessionId} for thread ${thread.id}`)

  let messageContent = isCliInjected
    ? (message.content || '')
    : resolveMentions(message)

  // Fetch session context for voice transcription enrichment
  let currentSessionContext: string | undefined
  let lastSessionContext: string | undefined

  if (projectDirectory) {
    try {
      const getClient = await initializeOpencodeForDirectory(
        projectDirectory,
        { channelId },
      )
      if (getClient instanceof Error) {
        voiceLogger.error(
          `[SESSION] Failed to initialize OpenCode client:`,
          getClient.message,
        )
        throw new Error(getClient.message)
      }
      const client = getClient()

      const result = await getCompactSessionContext({
        client,
        sessionId,
        includeSystemPrompt: false,
        maxMessages: 15,
      })
      if (errore.isOk(result)) {
        currentSessionContext = result
      }

      const lastSessionResult = await getLastSessionId({
        client,
        excludeSessionId: sessionId,
      })
      const lastSessionId = errore.unwrapOr(lastSessionResult, null)
      if (lastSessionId) {
        const result = await getCompactSessionContext({
          client,
          sessionId: lastSessionId,
          includeSystemPrompt: true,
          maxMessages: 10,
        })
        if (errore.isOk(result)) {
          lastSessionContext = result
        }
      }
    } catch (e) {
      voiceLogger.error(`Could not get session context:`, e)
      void notifyError(e, 'Failed to get session context')
    }
  }

  const voiceResult = await processVoiceAttachment({
    message,
    thread,
    projectDirectory,
    appId,
    currentSessionContext,
    lastSessionContext,
  })
  if (voiceResult) {
    messageContent = `Voice message transcription from Discord user:\n\n${voiceResult.transcription}`
  }

  // Voice transcription failed and no text — drop silently
  if (hasVoiceAttachment && !voiceResult && !messageContent.trim()) {
    return { prompt: '', mode: 'opencode', skip: true }
  }

  const fileAttachments = await getFileAttachments(message)
  const textAttachmentsContent = await getTextAttachments(message)
  const promptWithAttachments = textAttachmentsContent
    ? `${messageContent}\n\n${textAttachmentsContent}`
    : messageContent

  return {
    prompt: promptWithAttachments,
    images: fileAttachments.length > 0 ? fileAttachments : undefined,
    mode: voiceResult?.queueMessage ? 'local-queue' : 'opencode',
  }
}

/**
 * Pre-process a message that starts a new session in a thread (no existing
 * session). Handles starter message context, voice transcription, and
 * text/file attachments.
 */
export async function preprocessNewSessionMessage({
  message,
  thread,
  projectDirectory,
  hasVoiceAttachment,
  appId,
}: {
  message: Message
  thread: ThreadChannel
  projectDirectory: string
  hasVoiceAttachment: boolean
  appId?: string
}): Promise<PreprocessResult> {
  logger.log(`No session for thread ${thread.id}, starting new session`)

  let prompt = resolveMentions(message)
  const voiceResult = await processVoiceAttachment({
    message,
    thread,
    projectDirectory,
    appId,
  })
  if (voiceResult) {
    prompt = `Voice message transcription from Discord user:\n\n${voiceResult.transcription}`
  }

  // Voice transcription failed and no text — drop silently
  if (hasVoiceAttachment && !voiceResult && !prompt.trim()) {
    return { prompt: '', mode: 'opencode', skip: true }
  }

  // Fetch starter message for thread context
  const starterMessage = await thread
    .fetchStarterMessage()
    .catch((error) => {
      logger.warn(
        `[SESSION] Failed to fetch starter message for thread ${thread.id}:`,
        error instanceof Error ? error.message : String(error),
      )
      return null
    })
  if (starterMessage && starterMessage.content !== message.content) {
    const starterTextAttachments = await getTextAttachments(starterMessage)
    const starterContent = resolveMentions(starterMessage)
    const starterText = starterTextAttachments
      ? `${starterContent}\n\n${starterTextAttachments}`
      : starterContent
    if (starterText) {
      prompt = `Context from thread:\n${starterText}\n\nUser request:\n${prompt}`
    }
  }

  return {
    prompt,
    mode: voiceResult?.queueMessage ? 'local-queue' : 'opencode',
  }
}

/**
 * Pre-process a message from a text channel (creates a new thread).
 * Handles voice transcription and file/text attachments.
 */
export async function preprocessNewThreadMessage({
  message,
  thread,
  projectDirectory,
  hasVoiceAttachment,
  appId,
}: {
  message: Message
  thread: ThreadChannel
  projectDirectory: string
  hasVoiceAttachment: boolean
  appId?: string
}): Promise<PreprocessResult> {
  let messageContent = resolveMentions(message)
  const voiceResult = await processVoiceAttachment({
    message,
    thread,
    projectDirectory,
    isNewThread: true,
    appId,
  })
  if (voiceResult) {
    messageContent = `Voice message transcription from Discord user:\n\n${voiceResult.transcription}`
  }

  // Voice transcription failed and no text — drop silently
  if (hasVoiceAttachment && !voiceResult && !messageContent.trim()) {
    return { prompt: '', mode: 'opencode', skip: true }
  }

  const fileAttachments = await getFileAttachments(message)
  const textAttachmentsContent = await getTextAttachments(message)
  const promptWithAttachments = textAttachmentsContent
    ? `${messageContent}\n\n${textAttachmentsContent}`
    : messageContent

  return {
    prompt: promptWithAttachments,
    images: fileAttachments.length > 0 ? fileAttachments : undefined,
    mode: voiceResult?.queueMessage ? 'local-queue' : 'opencode',
  }
}
