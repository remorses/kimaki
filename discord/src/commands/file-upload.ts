// File upload tool handler - Shows Discord modal with FileUploadBuilder.
// When the AI uses the kimaki_file_upload tool, the plugin inserts a row into
// the ipc_requests DB table. The bot polls this table, picks up the request,
// and shows a button in the thread. User clicks it to open a modal with a
// native file picker. Uploaded files are downloaded to the project directory.
// The bot writes file paths back to ipc_requests.response, and the plugin
// polls until the response appears.


import { PLATFORM_MESSAGE_FLAGS } from '../platform/message-flags.js'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createLogger, LogPrefix } from '../logger.js'
import { notifyError } from '../sentry.js'
import { NOTIFY_MESSAGE_FLAGS } from '../discord-utils.js'
import type { ButtonEvent, ModalSubmitEvent } from '../platform/types.js'
import { getDefaultRuntimeAdapter } from '../session-handler/thread-session-runtime.js'

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
  threadId: string
  parentId: string | null
  prompt: string
  maxFiles: number
  contextHash: string
  resolve: (filePaths: string[]) => void
  reject: (error: Error) => void
  messageId?: string
  resolved: boolean
  timer: ReturnType<typeof setTimeout>
}

export const pendingFileUploadContexts = new Map<
  string,
  PendingFileUploadContext
>()

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
function resolveContext(
  context: PendingFileUploadContext,
  filePaths: string[],
): boolean {
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
  threadId,
  parentId,
  sessionId,
  directory,
  prompt,
  maxFiles,
}: {
  threadId: string
  parentId: string | null
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
        logger.log(
          `File upload timed out for session ${sessionId}, hash=${contextHash}`,
        )
        resolveContext(ctx, [])
        if (ctx.messageId) {
          updateButtonMessage(ctx, '_Timed out_')
        }
      }
    }, PENDING_TTL_MS)

    const context: PendingFileUploadContext = {
      sessionId,
      directory,
      threadId,
      parentId,
      prompt,
      maxFiles,
      contextHash,
      resolve,
      reject,
      resolved: false,
      timer,
    }

    pendingFileUploadContexts.set(contextHash, context)
    const adapter = getDefaultRuntimeAdapter()
    if (!adapter) {
      clearTimeout(timer)
      pendingFileUploadContexts.delete(contextHash)
      reject(new Error('No runtime adapter configured'))
      return
    }
    const threadTarget = {
      channelId: parentId || threadId,
      threadId,
    }

    adapter
      .conversation(threadTarget)
      .send({
        markdown: `**File Upload Requested**\n${prompt.slice(0, 1900)}`,
        buttons: [
          {
            id: `file_upload_btn:${contextHash}`,
            label: 'Upload Files',
            style: 'primary',
          },
        ],
        flags: NOTIFY_MESSAGE_FLAGS,
      })
      .then((msg: { id: string }) => {
        context.messageId = msg.id
        logger.log(
          `Showed file upload button for session ${sessionId}, hash=${contextHash}`,
        )
      })
      .catch((err: unknown) => {
        clearTimeout(timer)
        pendingFileUploadContexts.delete(contextHash)
        reject(new Error('Failed to send file upload button', { cause: err }))
      })
  })
}

/**
 * Handle the file upload button click - opens a modal with FileUploadBuilder.
 */
export async function handleFileUploadButton(
  interaction: ButtonEvent,
): Promise<void> {
  const customId = interaction.customId
  if (!customId.startsWith('file_upload_btn:')) {
    return
  }

  const contextHash = customId.replace('file_upload_btn:', '')
  const context = pendingFileUploadContexts.get(contextHash)

  if (!context || context.resolved) {
    await interaction.reply({
      content: 'This file upload request has expired.',
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL,
    })
    return
  }

  await interaction.showModal({
    id: `file_upload_modal:${contextHash}`,
    title: 'Upload Files',
    inputs: [
      {
        type: 'file',
        id: 'uploaded_files',
        label: 'Files',
        description: context.prompt.slice(0, 100),
        minFiles: 1,
        maxFiles: context.maxFiles,
      },
    ],
  })
}

/**
 * Handle the modal submission - download files and resolve the pending promise.
 */
export async function handleFileUploadModalSubmit(
  interaction: ModalSubmitEvent,
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
      flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL,
    })
    return
  }

  try {
    await interaction.deferReply({ flags: PLATFORM_MESSAGE_FLAGS.EPHEMERAL })

    // File upload data is nested in the LabelModalData -> FileUploadModalData
    const attachments = interaction.fields.getFiles('uploaded_files')
    if (attachments.length === 0) {
      await interaction.editReply({ content: 'No files were uploaded.' })
      updateButtonMessage(context, '_No files uploaded_')
      resolveContext(context, [])
      return
    }

    const uploadsDir = path.join(context.directory, 'uploads')
    fs.mkdirSync(uploadsDir, { recursive: true })

    const downloadedPaths: string[] = []
    const errors: string[] = []

    for (const attachment of attachments) {
      // Check if context was cancelled (e.g. user sent new message) while
      // we were downloading previous files - stop downloading more
      if (context.resolved) {
        break
      }
      try {
        const response = await fetch(attachment.url)
        if (!response.ok) {
          errors.push(
            `Failed to download ${attachment.name}: HTTP ${response.status}`,
          )
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
      downloadedPaths.length > 0
        ? `Uploaded: ${fileNames.join(', ')}`
        : '_Upload failed_',
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
    void notifyError(err, 'File upload modal submit error')
    resolveContext(context, [])
  }
}

/**
 * Best-effort update of the original button message (remove button, append status).
 */
function updateButtonMessage(
  context: PendingFileUploadContext,
  status: string,
): void {
  if (!context.messageId) {
    return
  }
  const adapter = getDefaultRuntimeAdapter()
  if (!adapter) {
    return
  }
  void adapter.conversation({
    channelId: context.parentId || context.threadId,
    threadId: context.threadId,
  }).update(context.messageId, {
      markdown: `**File Upload Requested**\n${context.prompt.slice(0, 1900)}\n${status}`,
    }).catch(() => {})
}

/**
 * Cancel ALL pending file uploads for a thread (e.g. when user sends a new message).
 */
export async function cancelPendingFileUpload(
  threadId: string,
): Promise<boolean> {
  const toCancel: PendingFileUploadContext[] = []
  for (const [, ctx] of pendingFileUploadContexts) {
    if (ctx.threadId === threadId) {
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
