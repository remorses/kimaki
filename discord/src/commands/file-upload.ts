// File upload tool handler - Shows Discord modal with FileUploadBuilder.
// When the AI uses the kimaki_file_upload tool, the plugin POSTs to the bot's
// lock server HTTP endpoint. The bot shows a button in the thread, user clicks
// it to open a modal with a native file picker. Uploaded files are downloaded
// to the project directory and paths returned to the AI.
//
// Architecture: The plugin tool (running in OpenCode's process) communicates
// with the Discord bot via HTTP. The bot holds the HTTP response open until
// the user completes the upload or the request is cancelled. This bridges the
// gap between the plugin process and Discord's interaction-based UI.

import {
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ModalBuilder,
  FileUploadBuilder,
  LabelBuilder,
  ComponentType,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type ThreadChannel,
} from 'discord.js'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createLogger, LogPrefix } from '../logger.js'
import { NOTIFY_MESSAGE_FLAGS } from '../discord-utils.js'

const logger = createLogger(LogPrefix.FILE_UPLOAD)

// 5 minute TTL for pending contexts - if user doesn't click within this time,
// clean up the context and resolve with empty array to unblock the plugin tool
const PENDING_TTL_MS = 5 * 60 * 1000

export type FileUploadRequest = {
  sessionId: string
  threadId: string
  directory: string
  prompt: string
  maxFiles: number
}

type PendingFileUploadContext = {
  sessionId: string
  directory: string
  thread: ThreadChannel
  prompt: string
  maxFiles: number
  contextHash: string
  resolve: (filePaths: string[]) => void
  reject: (error: Error) => void
  messageId?: string
  resolved: boolean
  timer: ReturnType<typeof setTimeout>
}

export const pendingFileUploadContexts = new Map<string, PendingFileUploadContext>()

/**
 * Sanitize an attachment filename to prevent path traversal.
 * Strips directory separators, .., and null bytes from the name.
 * Prepends a short random prefix to avoid collisions between uploads.
 */
function sanitizeFilename(name: string): string {
  // Extract just the base name (strips any directory components)
  let sanitized = path.basename(name)
  // Remove null bytes and other dangerous characters
  sanitized = sanitized.replace(/[\x00]/g, '')
  // If somehow still empty or just dots, give it a safe name
  if (!sanitized || sanitized === '.' || sanitized === '..') {
    sanitized = 'upload'
  }
  // Prefix with short random id to avoid collisions
  const prefix = crypto.randomBytes(4).toString('hex')
  return `${prefix}-${sanitized}`
}

/**
 * Safely resolve a pending context exactly once. Prevents double-resolve from
 * cancel/submit races by checking the `resolved` flag.
 */
function resolveContext(context: PendingFileUploadContext, filePaths: string[]): boolean {
  if (context.resolved) {
    return false
  }
  context.resolved = true
  clearTimeout(context.timer)
  pendingFileUploadContexts.delete(context.contextHash)
  context.resolve(filePaths)
  return true
}

/**
 * Show a button in the thread that opens a file upload modal when clicked.
 * Returns a promise that resolves with the downloaded file paths.
 */
export function showFileUploadButton({
  thread,
  sessionId,
  directory,
  prompt,
  maxFiles,
}: {
  thread: ThreadChannel
  sessionId: string
  directory: string
  prompt: string
  maxFiles: number
}): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const contextHash = crypto.randomBytes(8).toString('hex')

    // TTL timer: auto-cleanup if user never clicks the button
    const timer = setTimeout(() => {
      const ctx = pendingFileUploadContexts.get(contextHash)
      if (ctx && !ctx.resolved) {
        logger.log(`File upload timed out for session ${sessionId}, hash=${contextHash}`)
        resolveContext(ctx, [])
        // Remove button from message
        if (ctx.messageId) {
          ctx.thread.messages
            .fetch(ctx.messageId)
            .then((msg) => {
              return msg.edit({
                content: `**File Upload Requested**\n${prompt}\n_Timed out_`,
                components: [],
              })
            })
            .catch(() => {})
        }
      }
    }, PENDING_TTL_MS)

    const context: PendingFileUploadContext = {
      sessionId,
      directory,
      thread,
      prompt,
      maxFiles,
      contextHash,
      resolve,
      reject,
      resolved: false,
      timer,
    }

    pendingFileUploadContexts.set(contextHash, context)

    const uploadButton = new ButtonBuilder()
      .setCustomId(`file_upload_btn:${contextHash}`)
      .setLabel('Upload Files')
      .setStyle(ButtonStyle.Primary)

    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(uploadButton)

    thread
      .send({
        content: `**File Upload Requested**\n${prompt}`,
        components: [actionRow],
        flags: NOTIFY_MESSAGE_FLAGS,
      })
      .then((msg) => {
        context.messageId = msg.id
        logger.log(`Showed file upload button for session ${sessionId}, hash=${contextHash}`)
      })
      .catch((err) => {
        clearTimeout(timer)
        pendingFileUploadContexts.delete(contextHash)
        reject(new Error('Failed to send file upload button', { cause: err }))
      })
  })
}

/**
 * Handle the file upload button click - opens a modal with FileUploadBuilder.
 */
export async function handleFileUploadButton(interaction: ButtonInteraction): Promise<void> {
  const customId = interaction.customId
  if (!customId.startsWith('file_upload_btn:')) {
    return
  }

  const contextHash = customId.replace('file_upload_btn:', '')
  const context = pendingFileUploadContexts.get(contextHash)

  if (!context || context.resolved) {
    await interaction.reply({
      content: 'This file upload request has expired.',
      ephemeral: true,
    })
    return
  }

  const fileUpload = new FileUploadBuilder()
    .setCustomId('uploaded_files')
    .setMinValues(1)
    .setMaxValues(context.maxFiles)

  const label = new LabelBuilder()
    .setLabel('Files')
    .setDescription(context.prompt.slice(0, 100))
    .setFileUploadComponent(fileUpload)

  const modal = new ModalBuilder()
    .setCustomId(`file_upload_modal:${contextHash}`)
    .setTitle('Upload Files')
    .addLabelComponents(label)

  await interaction.showModal(modal)
}

/**
 * Handle the modal submission - download files and resolve the pending promise.
 */
export async function handleFileUploadModalSubmit(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  const customId = interaction.customId
  if (!customId.startsWith('file_upload_modal:')) {
    return
  }

  const contextHash = customId.replace('file_upload_modal:', '')
  const context = pendingFileUploadContexts.get(contextHash)

  if (!context || context.resolved) {
    await interaction.reply({
      content: 'This file upload request has expired.',
      ephemeral: true,
    })
    return
  }

  try {
    await interaction.deferReply({ ephemeral: true })

    // File upload data is nested in the LabelModalData -> FileUploadModalData
    const fileField = interaction.fields.getField('uploaded_files', ComponentType.FileUpload)
    const attachments = fileField.attachments
    if (!attachments || attachments.size === 0) {
      await interaction.editReply({ content: 'No files were uploaded.' })
      updateButtonMessage(context, '_No files uploaded_')
      resolveContext(context, [])
      return
    }

    const uploadsDir = path.join(context.directory, 'uploads')
    fs.mkdirSync(uploadsDir, { recursive: true })

    const downloadedPaths: string[] = []
    const errors: string[] = []

    for (const [, attachment] of attachments) {
      // Check if context was cancelled (e.g. user sent new message) while
      // we were downloading previous files - stop downloading more
      if (context.resolved) {
        break
      }
      try {
        const response = await fetch(attachment.url)
        if (!response.ok) {
          errors.push(`Failed to download ${attachment.name}: HTTP ${response.status}`)
          continue
        }
        const buffer = Buffer.from(await response.arrayBuffer())
        const safeName = sanitizeFilename(attachment.name)
        const filePath = path.join(uploadsDir, safeName)
        fs.writeFileSync(filePath, buffer)
        downloadedPaths.push(filePath)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        errors.push(`Failed to download ${attachment.name}: ${msg}`)
      }
    }

    // If context was resolved by cancel/timeout during download, don't try to
    // resolve again - just update the ephemeral reply
    if (context.resolved) {
      await interaction.editReply({ content: 'Upload was cancelled.' })
      return
    }

    const fileNames = downloadedPaths.map((p) => {
      return path.basename(p)
    })
    updateButtonMessage(
      context,
      downloadedPaths.length > 0 ? `Uploaded: ${fileNames.join(', ')}` : '_Upload failed_',
    )

    const summary = (() => {
      if (downloadedPaths.length > 0 && errors.length === 0) {
        return `Uploaded ${downloadedPaths.length} file(s) successfully.`
      }
      if (downloadedPaths.length > 0 && errors.length > 0) {
        return `Uploaded ${downloadedPaths.length} file(s). Errors: ${errors.join('; ')}`
      }
      return `Upload failed: ${errors.join('; ')}`
    })()

    await interaction.editReply({ content: summary })

    resolveContext(context, downloadedPaths)

    logger.log(
      `File upload completed for session ${context.sessionId}: ${downloadedPaths.length} files`,
    )
  } catch (err) {
    // Ensure context is always resolved even on unexpected errors
    // so the plugin tool doesn't hang indefinitely
    logger.error('Error in file upload modal submit:', err)
    resolveContext(context, [])
  }
}

/**
 * Best-effort update of the original button message (remove button, append status).
 */
function updateButtonMessage(context: PendingFileUploadContext, status: string): void {
  if (!context.messageId) {
    return
  }
  context.thread.messages
    .fetch(context.messageId)
    .then((msg) => {
      return msg.edit({
        content: `**File Upload Requested**\n${context.prompt}\n${status}`,
        components: [],
      })
    })
    .catch(() => {})
}

/**
 * Cancel ALL pending file uploads for a thread (e.g. when user sends a new message).
 */
export async function cancelPendingFileUpload(threadId: string): Promise<boolean> {
  const toCancel: PendingFileUploadContext[] = []
  for (const [, ctx] of pendingFileUploadContexts) {
    if (ctx.thread.id === threadId) {
      toCancel.push(ctx)
    }
  }

  if (toCancel.length === 0) {
    return false
  }

  let cancelled = 0
  for (const context of toCancel) {
    const didResolve = resolveContext(context, [])
    if (didResolve) {
      updateButtonMessage(context, '_Cancelled - user sent a new message_')
      cancelled++
    }
  }

  if (cancelled > 0) {
    logger.log(`Cancelled ${cancelled} file upload(s) for thread ${threadId}`)
  }
  return cancelled > 0
}
