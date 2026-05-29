/**
 * OpenAI OAuth rotation plugin for OpenCode.
 *
 * This plugin piggybacks on opencode's built-in CodexAuthPlugin (which owns
 * the auth: { provider: "openai" } hook). We cannot register our own auth
 * provider for openai without overriding the built-in, which handles URL
 * rewriting, model filtering, and token refresh.
 *
 * Instead, this plugin uses the event hook to:
 * 1. Detect new OpenAI logins by checking auth.json on session events
 * 2. Rotate accounts on rate-limit retry events
 * 3. Show toast notifications when rotating
 *
 * Account management is done via `kimaki multioauth openai` CLI commands.
 */

import type { Hooks, Plugin } from '@opencode-ai/plugin'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { createPluginLogger, appendToastSessionMarker } from './plugin-logger.js'
import { createPluginClient } from './plugin-opencode-client.js'
import { isRateLimitRetryMessage, isTokenRefreshError, isOAuthStored, readJson, authFilePath } from './oauth-rotation-shared.js'
import {
  detectAndRememberNewOpenAIAccount,
  loadOpenAIAccountStore,
  rotateOpenAIAccount,
} from './openai-auth-state.js'

const log = createPluginLogger('openai-rotation')
const TOAST_SESSION_HEADER = 'x-kimaki-session-id'

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

function isRetryStatusEvent(event: Parameters<NonNullable<Hooks['event']>>[0]['event']): event is RetryStatusEvent {
  if (event.type !== 'session.status') return false
  const status = event.properties.status
  return status.type === 'retry' && typeof status.message === 'string'
}

// --- Model detection ---

// We need to determine if the retrying session uses an openai model.
// The retry event doesn't include model info directly, so we check
// the last message in the session to find the model.
async function isOpenAISession(
  client: OpencodeClient,
  sessionID: string,
): Promise<boolean> {
  try {
    const res = await client.session.messages({ sessionID })
    const lastMessage = res.data?.filter((m) => m.info).at(-1)?.info
    if (!lastMessage) return false
    const providerID =
      lastMessage.role === 'assistant' ? lastMessage.providerID : lastMessage.model.providerID
    return providerID === 'openai'
  } catch {
    return false
  }
}

// --- Plugin export ---

// Throttle login detection to avoid spamming auth.json reads
let lastLoginCheckMs = 0
const LOGIN_CHECK_INTERVAL_MS = 30_000

const openaiRotationPlugin: Plugin = async ({ serverUrl, directory }) => {
  log.info('OpenAI rotation plugin loaded')
  // Build our own v2 client. The plugin-provided ctx.client (v1) does not
  // reliably make REST calls from inside the plugin process.
  const client = createPluginClient({ serverUrl, directory })
  return {
    'chat.headers': async (input, output) => {
      if (input.model.providerID !== 'openai') return
      output.headers[TOAST_SESSION_HEADER] = input.sessionID
    },

    event: async ({ event }) => {
      if (event.type === 'session.status') {
        log.info('session.status event', event.properties.status.type)
      }
      // 1. Detect new logins on idle events (session just became ready)
      if (event.type === 'session.status' && event.properties.status.type === 'idle') {
        const now = Date.now()
        if (now - lastLoginCheckMs >= LOGIN_CHECK_INTERVAL_MS) {
          lastLoginCheckMs = now
          const identity = await detectAndRememberNewOpenAIAccount().catch(() => undefined)
          if (identity) {
            const label = identity.email || identity.accountId || 'unknown'
            const store = await loadOpenAIAccountStore().catch(() => undefined)
            const count = store?.accounts.length ?? 1
            client.tui
              .showToast({
                message: appendToastSessionMarker({
                  message: `OpenAI account ${label} added to rotation pool (${count} account${count === 1 ? '' : 's'})`,
                  sessionId: event.properties.sessionID,
                }),
                variant: 'info',
              })
              .catch(() => {})
          }
        }
      }

      // 2. Rotate on rate-limit retry for openai models
      if (isRetryStatusEvent(event)) {
        const sessionID = event.properties.sessionID
        const message = event.properties.status.message
        log.info('retry event', message.slice(0, 100))
        const isRateLimit = isRateLimitRetryMessage(message)
        const isAuthError = isTokenRefreshError(message)

        if (!isRateLimit && !isAuthError) return

        // Verify this is an openai session
        const isOpenAI = await isOpenAISession(client, sessionID)
        if (!isOpenAI) return

        // Read current auth to know what to rotate from
        const authJson = await readJson<Record<string, unknown>>(authFilePath(), {})
        const currentAuth = authJson.openai
        if (!isOAuthStored(currentAuth)) return

        const store = await loadOpenAIAccountStore().catch(() => undefined)
        if (!store || store.accounts.length < 2) return

        const result = await rotateOpenAIAccount(currentAuth, client)
        if (result) {
          client.tui
            .showToast({
              message: appendToastSessionMarker({
                message: `Switching OpenAI from ${result.fromLabel} to ${result.toLabel}`,
                sessionId: sessionID,
              }),
              variant: 'info',
            })
            .catch(() => {})
        }
      }
    },
  }
}

export { openaiRotationPlugin }
