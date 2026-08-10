/**
 * xAI OAuth rotation plugin for OpenCode.
 *
 * This plugin piggybacks on opencode's built-in XaiAuthPlugin (which owns
 * the auth: { provider: "xai" } hook). We cannot register our own auth
 * provider for xai without overriding the built-in, which handles OAuth
 * PKCE login, token refresh, and request rewriting.
 *
 * Instead, this plugin uses the event hook to:
 * 1. Detect new xAI logins by checking auth.json on session events
 * 2. Rotate accounts on usage-limit errors (terminal or retry)
 * 3. Resume the session after rotation so the model can retry
 *
 * xAI usage errors are TERMINAL, not retried by the AI SDK:
 * - 402 Payment Required: "Grok Build usage balance exhausted"
 * - 403 Forbidden: "personal-team-blocked:spending-limit"
 * These arrive as session.error or message.updated with APIError,
 * not as session.status retry events. The plugin must handle both
 * terminal errors and (less likely) retry events.
 *
 * Account management is done via `kimaki multioauth xai` CLI commands.
 */

import type { Hooks, Plugin } from '@opencode-ai/plugin'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { createPluginLogger, appendToastSessionMarker } from './plugin-logger.js'
import { createPluginClient } from './plugin-opencode-client.js'
import { isRateLimitRetryMessage, isTokenRefreshError, isOAuthStored, readJson, authFilePath } from './oauth-rotation-shared.js'
import {
  detectAndRememberNewXAIAccount,
  loadXAIAccountStore,
  rotateXAIAccount,
} from './xai-auth-state.js'

const log = createPluginLogger('xai-rotation')
const TOAST_SESSION_HEADER = 'x-kimaki-session-id'

// xAI-specific error patterns that indicate usage exhaustion.
// These appear in response bodies and error messages.
const XAI_USAGE_PATTERNS = [
  'balance exhausted',
  'spending-limit',
  'run out of credits',
  'usage balance',
] as const

type PluginEvent = Parameters<NonNullable<Hooks['event']>>[0]['event']

// --- Event shape guards ---

type RetryStatusEvent = {
  type: 'session.status'
  properties: {
    sessionID: string
    status: {
      type: 'retry'
      attempt: number
      message: string
      next: number
    }
  }
}

function isRetryStatusEvent(event: PluginEvent): event is RetryStatusEvent {
  if (event.type !== 'session.status') return false
  const status = event.properties.status
  return status.type === 'retry' && typeof status.message === 'string'
}

/** Check if text contains xAI-specific usage exhaustion patterns */
function isXAIUsageLimitText(text: string | undefined): boolean {
  if (!text) return false
  const haystack = text.toLowerCase()
  return XAI_USAGE_PATTERNS.some((pattern) => haystack.includes(pattern))
}

// --- Terminal error extraction ---

type APIErrorData = {
  statusCode?: number
  message?: string
  responseBody?: string
}

/**
 * Extract xAI usage-limit error info from terminal events.
 * Returns the session ID and error message if it's an xAI usage error.
 * xAI errors are terminal (402/403), not retried by the AI SDK.
 */
function extractXAITerminalError(event: PluginEvent): {
  sessionID: string
  providerID: string | undefined
  message: string
} | undefined {
  const apiError = (() => {
    if (event.type === 'session.error' && event.properties.error?.name === 'APIError') {
      return {
        sessionID: event.properties.sessionID as string | undefined,
        providerID: undefined as string | undefined,
        data: event.properties.error.data as APIErrorData | undefined,
      }
    }
    if (
      event.type === 'message.updated'
      && event.properties.info.role === 'assistant'
      && event.properties.info.error?.name === 'APIError'
    ) {
      return {
        sessionID: event.properties.info.sessionID as string | undefined,
        providerID: event.properties.info.providerID as string | undefined,
        data: event.properties.info.error.data as APIErrorData | undefined,
      }
    }
    return undefined
  })()

  if (!apiError?.data || !apiError.sessionID) return undefined

  const { statusCode, message, responseBody } = apiError.data
  const errorText = [message, responseBody].filter(Boolean).join(' ')

  // 402 or 403 with xAI-specific usage text
  if ((statusCode === 402 || statusCode === 403) && isXAIUsageLimitText(errorText)) {
    return {
      sessionID: apiError.sessionID,
      providerID: apiError.providerID,
      message: message || responseBody || `HTTP ${statusCode}`,
    }
  }

  return undefined
}

// --- Model detection ---

async function isXAISession(
  client: OpencodeClient,
  sessionID: string,
): Promise<boolean> {
  try {
    const res = await client.session.messages({ sessionID })
    const lastMessage = res.data?.filter((m) => m.info).at(-1)?.info
    if (!lastMessage) return false
    const providerID =
      lastMessage.role === 'assistant' ? lastMessage.providerID : lastMessage.model.providerID
    return providerID === 'xai'
  } catch {
    return false
  }
}

// --- Rotation + resume logic ---

/**
 * Attempt rotation and resume the session if successful.
 * After a terminal error, the session is dead. We rotate credentials
 * and send an empty promptAsync to wake the session back up so the
 * model can retry with the new account.
 */
async function rotateAndResume(
  client: OpencodeClient,
  directory: string,
  sessionID: string,
  errorMessage: string,
): Promise<boolean> {
  const authJson = await readJson<Record<string, unknown>>(authFilePath(), {})
  const currentAuth = authJson.xai
  if (!isOAuthStored(currentAuth)) return false

  const store = await loadXAIAccountStore().catch(() => undefined)
  if (!store || store.accounts.length < 2) return false

  const result = await rotateXAIAccount(currentAuth, client)
  if (!result) return false

  log.info(`Rotated xAI from ${result.fromLabel} to ${result.toLabel} after: ${errorMessage.slice(0, 100)}`)

  client.tui
    .showToast({
      message: appendToastSessionMarker({
        message: `Switching xAI from ${result.fromLabel} to ${result.toLabel}`,
        sessionId: sessionID,
      }),
      variant: 'info',
    })
    .catch(() => {})

  // Resume the session so the model retries with the new account
  await client.session.promptAsync({ sessionID, directory, parts: [] }).catch((err) => {
    log.warn(`Failed to resume session ${sessionID} after xAI rotation: ${err}`)
  })

  return true
}

// --- Plugin export ---

let lastLoginCheckMs = 0
const LOGIN_CHECK_INTERVAL_MS = 30_000

// Track sessions we already rotated for to avoid duplicate handling.
// Terminal errors can emit both session.error and message.updated for
// the same failure.
const rotatedSessions = new Map<string, number>()
const ROTATION_DEDUP_MS = 10_000

function wasRecentlyRotated(sessionID: string): boolean {
  const ts = rotatedSessions.get(sessionID)
  if (!ts) return false
  if (Date.now() - ts > ROTATION_DEDUP_MS) {
    rotatedSessions.delete(sessionID)
    return false
  }
  return true
}

function markRotated(sessionID: string) {
  rotatedSessions.set(sessionID, Date.now())
  // Prevent unbounded growth
  if (rotatedSessions.size > 100) {
    const oldest = [...rotatedSessions.entries()].sort((a, b) => a[1] - b[1])
    for (let i = 0; i < 50; i++) {
      const entry = oldest[i]
      if (entry) rotatedSessions.delete(entry[0])
    }
  }
}

const xaiRotationPlugin: Plugin = async ({ serverUrl, directory }) => {
  log.info('xAI rotation plugin loaded')
  const client = createPluginClient({ serverUrl, directory })
  log.bindClient(client)
  return {
    'chat.headers': async (input, output) => {
      if (input.model.providerID !== 'xai') return
      output.headers[TOAST_SESSION_HEADER] = input.sessionID
    },

    event: async ({ event }) => {
      // 1. Detect new logins on idle events
      if (event.type === 'session.status' && event.properties.status.type === 'idle') {
        const now = Date.now()
        if (now - lastLoginCheckMs >= LOGIN_CHECK_INTERVAL_MS) {
          lastLoginCheckMs = now
          const identity = await detectAndRememberNewXAIAccount().catch(() => undefined)
          if (identity) {
            const label = identity.email || identity.accountId || 'unknown'
            const store = await loadXAIAccountStore().catch(() => undefined)
            const count = store?.accounts.length ?? 1
            client.tui
              .showToast({
                message: appendToastSessionMarker({
                  message: `xAI account ${label} added to rotation pool (${count} account${count === 1 ? '' : 's'})`,
                  sessionId: event.properties.sessionID,
                }),
                variant: 'info',
              })
              .catch(() => {})
          }
        }
      }

      // 2a. Handle TERMINAL xAI usage errors (402/403)
      // These are not retried by the AI SDK. The session dies.
      // We rotate and resume with promptAsync.
      const terminalError = extractXAITerminalError(event)
      if (terminalError) {
        const { sessionID, providerID, message } = terminalError
        if (wasRecentlyRotated(sessionID)) return

        // If the event carries providerID, use it directly.
        // Otherwise fall back to session message inspection.
        const isXAI = providerID
          ? providerID === 'xai'
          : await isXAISession(client, sessionID)
        if (!isXAI) return

        markRotated(sessionID)
        await rotateAndResume(client, directory, sessionID, message)
        return
      }

      // 2b. Handle RETRY events (429 rate limits, if they happen)
      if (isRetryStatusEvent(event)) {
        const sessionID = event.properties.sessionID
        const message = event.properties.status.message
        log.info('retry event', message.slice(0, 100))

        if (!isRateLimitRetryMessage(message) && !isTokenRefreshError(message)) return
        if (wasRecentlyRotated(sessionID)) return

        const isXAI = await isXAISession(client, sessionID)
        if (!isXAI) return

        markRotated(sessionID)
        await rotateAndResume(client, directory, sessionID, message)
      }
    },
  }
}

export { xaiRotationPlugin }
