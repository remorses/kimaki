// IPC polling bridge between the opencode plugin and the Discord bot.
// The plugin inserts rows into ipc_requests (via Prisma). This module polls
// that table, claims pending rows atomically, and dispatches them by type.
// Replaces the old HTTP lock-server approach with DB-based IPC.

import * as errore from 'errore'
import { createTaggedError } from 'errore'
import { getDefaultRuntimeAdapter } from './session-handler/thread-session-runtime.js'
import {
  claimPendingIpcRequests,
  completeIpcRequest,
  cancelAllPendingIpcRequests,
  cancelStaleProcessingRequests,
} from './database.js'
import { showFileUploadButton } from './commands/file-upload.js'
import { queueActionButtonsRequest } from './commands/action-buttons.js'
import type { ActionButtonColor } from './commands/action-buttons.js'
import { createLogger, LogPrefix } from './logger.js'
import { notifyError } from './sentry.js'

const ipcLogger = createLogger(LogPrefix.IPC)

// ── Tagged errors ────────────────────────────────────────────────────────

class IpcDispatchError extends createTaggedError({
  name: 'IpcDispatchError',
  message: 'IPC dispatch failed for request $requestId: $reason',
}) {}

// ── Button parsing ───────────────────────────────────────────────────────

const VALID_COLORS = new Set<ActionButtonColor>([
  'white',
  'blue',
  'green',
  'red',
])

type ParsedButton = { label: string; color?: ActionButtonColor }

function parseButtons(raw: unknown): ParsedButton[] {
  if (!Array.isArray(raw)) return []
  const results: ParsedButton[] = []
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue
    const label = (typeof value.label === 'string' ? value.label : '')
      .trim()
      .slice(0, 80)
    if (!label) continue
    const color =
      typeof value.color === 'string' &&
      VALID_COLORS.has(value.color as ActionButtonColor)
        ? (value.color as ActionButtonColor)
        : undefined
    results.push({ label, color })
    if (results.length >= 3) break
  }
  return results
}

// ── Request dispatch ─────────────────────────────────────────────────────

type ClaimedRequest = {
  id: string
  type: string
  session_id: string
  thread_id: string
  payload: string
}

async function dispatchRequest({
  req,
}: {
  req: ClaimedRequest
}) {
  const adapter = getDefaultRuntimeAdapter()
  if (!adapter) {
    await completeIpcRequest({
      id: req.id,
      response: JSON.stringify({ error: 'Adapter not ready' }),
    })
    return
  }
  switch (req.type) {
    case 'file_upload': {
      const parsed = errore.try({
        try: () =>
          JSON.parse(req.payload) as {
            prompt?: string
            maxFiles?: number
            directory?: string
          },
        catch: (e) =>
          new IpcDispatchError({
            requestId: req.id,
            reason: 'Invalid payload JSON',
            cause: e,
          }),
      })
      if (parsed instanceof Error) {
        await completeIpcRequest({
          id: req.id,
          response: JSON.stringify({ error: parsed.message }),
        })
        return parsed
      }

      const threadHandle = await adapter
        .thread({ threadId: req.thread_id })
        .catch(
          (e) =>
            new IpcDispatchError({
              requestId: req.id,
              reason: 'Thread fetch failed',
              cause: e,
            }),
        )
      if (threadHandle instanceof Error) {
        await completeIpcRequest({
          id: req.id,
          response: JSON.stringify({ error: 'Thread not found' }),
        })
        return threadHandle
      }
      if (!threadHandle) {
        await completeIpcRequest({
          id: req.id,
          response: JSON.stringify({ error: 'Thread not found' }),
        })
        return new IpcDispatchError({
          requestId: req.id,
          reason: 'Channel is not a thread',
        })
      }

      // Fire-and-forget: showFileUploadButton waits for user interaction
      // (button click + modal + file download) which can take minutes.
      // Don't block the dispatch loop — complete the IPC request asynchronously.
      showFileUploadButton({
        threadId: threadHandle.data.id,
        parentId: threadHandle.data.parentId,
        sessionId: req.session_id,
        directory: parsed.directory || '',
        prompt: parsed.prompt || 'Please upload files',
        maxFiles: Math.min(10, Math.max(1, parsed.maxFiles || 5)),
      })
        .then((filePaths) => {
          return completeIpcRequest({
            id: req.id,
            response: JSON.stringify({ filePaths }),
          })
        })
        .catch((e) => {
          ipcLogger.error(
            '[IPC] File upload error:',
            e instanceof Error ? e.message : String(e),
          )
          return completeIpcRequest({
            id: req.id,
            response: JSON.stringify({
              error: e instanceof Error ? e.message : 'File upload failed',
            }),
          })
        })
        .catch((e) => {
          void notifyError(e, 'IPC file upload completion update failed')
        })
      return
    }

    case 'action_buttons': {
      const parsed = errore.try({
        try: () =>
          JSON.parse(req.payload) as { buttons?: unknown; directory?: string },
        catch: (e) =>
          new IpcDispatchError({
            requestId: req.id,
            reason: 'Invalid payload JSON',
            cause: e,
          }),
      })
      if (parsed instanceof Error) {
        await completeIpcRequest({
          id: req.id,
          response: JSON.stringify({ error: parsed.message }),
        })
        return parsed
      }

      const buttons = parseButtons(parsed.buttons)
      if (buttons.length === 0) {
        await completeIpcRequest({
          id: req.id,
          response: JSON.stringify({ error: 'No valid buttons' }),
        })
        return
      }

      // Verify thread exists before queuing
      const actionThreadHandle = await adapter
        .thread({ threadId: req.thread_id })
        .catch(
          (e) =>
            new IpcDispatchError({
              requestId: req.id,
              reason: 'Thread fetch failed',
              cause: e,
            }),
        )
      if (actionThreadHandle instanceof Error) {
        await completeIpcRequest({
          id: req.id,
          response: JSON.stringify({ error: 'Thread not found' }),
        })
        return actionThreadHandle
      }
      if (!actionThreadHandle) {
        await completeIpcRequest({
          id: req.id,
          response: JSON.stringify({ error: 'Thread not found' }),
        })
        return new IpcDispatchError({
          requestId: req.id,
          reason: 'Channel is not a thread',
        })
      }

      queueActionButtonsRequest({
        sessionId: req.session_id,
        threadId: req.thread_id,
        directory: parsed.directory || '',
        buttons,
      })

      await completeIpcRequest({
        id: req.id,
        response: JSON.stringify({ ok: true }),
      })
      return
    }

    default: {
      await completeIpcRequest({
        id: req.id,
        response: JSON.stringify({ error: `Unknown IPC type: ${req.type}` }),
      })
      return
    }
  }
}

// ── Polling lifecycle ────────────────────────────────────────────────────

let pollingInterval: ReturnType<typeof setInterval> | null = null

// Cancel requests stuck in 'processing' longer than 5 minutes (e.g. hung
// file upload where the user never clicks). Checked every 30 seconds.
const STALE_TTL_MS = 5 * 60 * 1000
const STALE_CHECK_INTERVAL_MS = 30 * 1000
let lastStaleCheck = 0

/**
 * Start polling the ipc_requests table for pending requests from the plugin.
 * Claims rows atomically (pending -> processing) to prevent duplicate dispatch.
 * Uses an in-flight guard to prevent overlapping poll ticks.
 */
export async function startIpcPolling() {
  // Clean up stale requests from previous runs before first poll tick
  await cancelAllPendingIpcRequests().catch((e) => {
    ipcLogger.warn('Failed to cancel stale IPC requests:', (e as Error).message)
    void notifyError(e, 'Failed to cancel stale IPC requests')
  })

  let polling = false
  pollingInterval = setInterval(async () => {
    if (polling) return
    polling = true

    // Periodically sweep requests stuck in 'processing' past the TTL
    const now = Date.now()
    if (now - lastStaleCheck > STALE_CHECK_INTERVAL_MS) {
      lastStaleCheck = now
      await cancelStaleProcessingRequests({ ttlMs: STALE_TTL_MS }).catch(
        (e) => {
          ipcLogger.warn('Stale sweep failed:', (e as Error).message)
          void notifyError(e, 'IPC stale sweep failed')
        },
      )
    }

    const claimed = await claimPendingIpcRequests().catch(
      (e) =>
        new IpcDispatchError({
          requestId: 'poll',
          reason: 'Claim failed',
          cause: e,
        }),
    )
    if (claimed instanceof Error) {
      ipcLogger.error('IPC claim failed:', claimed.message)
      void notifyError(claimed, 'IPC claim failed')
      polling = false
      return
    }

    for (const req of claimed) {
      const result = await dispatchRequest({ req }).catch(
        (e) =>
          new IpcDispatchError({
            requestId: req.id,
            reason: 'Dispatch threw',
            cause: e,
          }),
      )
      if (result instanceof Error) {
        ipcLogger.error(`IPC dispatch error for ${req.type}:`, result.message)
        void notifyError(result, `IPC dispatch error for ${req.type}`)
      }
    }

    polling = false
  }, 200)
}

export function stopIpcPolling() {
  if (!pollingInterval) return
  clearInterval(pollingInterval)
  pollingInterval = null
}
