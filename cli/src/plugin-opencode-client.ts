// Builds a working OpenCode v2 client for plugin code.
//
// Plugins run inside the OpenCode server process and receive a `client` in
// their PluginInput, but that plugin-provided client (v1 SDK) does not reliably
// make REST calls from inside the plugin process: calls like session.abort /
// session.status silently no-op. Constructing a fresh @opencode-ai/sdk/v2
// client pointed at the same server URL (the same client the rest of kimaki
// uses) makes all REST + log calls work.
//
// Use createPluginClient({ serverUrl, directory }) in any plugin that performs
// REST operations (abort, status, messages, prompt, etc.) instead of ctx.client.
//
// createPluginAppLogger wraps client.app.log so plugins can emit structured
// logs into OpenCode's own logger (the AGENTS rule forbids console.* and
// importing cli/src/logger.ts inside plugins). All logging is fire-and-forget:
// a logging failure must never break plugin logic.

import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2'

// Inline auth header construction instead of importing from opencode.ts,
// because opencode.ts pulls in the full server manager (spawn, store, etc.)
// which is too heavy for plugin code running inside the opencode server process.
function getAuthHeaders(): Record<string, string> {
  const serverPassword = process.env.OPENCODE_SERVER_PASSWORD
  if (!serverPassword) return {}
  const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode'
  return { Authorization: `Basic ${Buffer.from(`${username}:${serverPassword}`).toString('base64')}` }
}

export function createPluginClient({
  serverUrl,
  directory,
}: {
  serverUrl: URL
  directory: string
}): OpencodeClient {
  return createOpencodeClient({
    baseUrl: serverUrl.toString().replace(/\/$/, ''),
    directory,
    headers: getAuthHeaders(),
  })
}

type PluginLogLevel = 'debug' | 'info' | 'warn' | 'error'
type PluginLogExtra = Record<string, string | number | boolean | null | undefined>

// Returns a logger that forwards to OpenCode's structured logger via
// client.app.log. The service name groups all entries from one plugin.
export function createPluginAppLogger({
  client,
  service,
}: {
  client: OpencodeClient
  service: string
}): (level: PluginLogLevel, message: string, extra?: PluginLogExtra) => void {
  return (level, message, extra) => {
    // Drop null/undefined so the extra payload stays clean.
    const cleanExtra: Record<string, string | number | boolean> = {}
    if (extra) {
      for (const [key, value] of Object.entries(extra)) {
        if (value == null) continue
        cleanExtra[key] = value
      }
    }
    void client.app
      .log({ service, level, message, extra: cleanExtra })
      .catch(() => {
        // Logging must never break plugin logic.
      })
  }
}
