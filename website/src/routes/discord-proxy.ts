// ALL /discord/v10/* -- REST reverse proxy for Discord API.
// Validates client_id:secret credentials from the Authorization header
// against the gateway_clients table, then swaps in the real bot token
// and forwards the request to Discord.
//
// GET /discord/v10/gateway/bot is a special case: it calls Discord's real
// endpoint then replaces the gateway URL with the proxy WebSocket URL so
// discord.js auto-discovers the gateway proxy.

import type { Context } from 'hono'
import { prisma } from 'db/src/prisma.js'
import {
  DiscordProxyFetchError,
  GatewayBotResponseDecodeError,
  GatewayClientLookupError,
} from '../errors.js'

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || ''
const GATEWAY_PROXY_URL =
  process.env.GATEWAY_PROXY_URL || 'wss://kimaki-gateway-production.fly.dev'

// Extract and validate client_id:secret from Authorization header.
// Expected format: "Bot client_id:secret"
async function authenticateClient(
  authHeader: string | undefined,
): Promise<
  GatewayClientLookupError | { clientId: string; secret: string } | null
> {
  if (!authHeader) {
    return null
  }

  const match = authHeader.match(/^Bot\s+(.+):(.+)$/i)
  if (!match || !match[1] || !match[2]) {
    return null
  }

  const clientId = match[1]
  const secret = match[2]

  const row = await prisma.gateway_clients
    .findFirst({
      where: { client_id: clientId, secret },
    })
    .catch((cause) => {
      return new GatewayClientLookupError({ clientId, cause })
    })
  if (row instanceof Error) {
    return row
  }

  if (!row) {
    return null
  }

  return { clientId, secret }
}

export async function handleDiscordProxy(c: Context) {
  const auth = await authenticateClient(c.req.header('authorization'))
  if (auth instanceof Error) {
    return c.json({ error: 'Internal server error' }, 500)
  }

  if (auth === null) {
    return c.json({ error: 'Invalid or missing credentials' }, 401)
  }

  // Extract the Discord API path from the request URL.
  // Both /discord/v10/channels/123 and /api/v10/channels/123 map to /api/v10/channels/123
  const url = new URL(c.req.url)
  const discordPath = url.pathname.replace(/^\/(?:discord|api)\//, '/api/')
  const discordUrl = new URL(discordPath, 'https://discord.com')
  discordUrl.search = url.search

  // Special case: /gateway/bot -- replace the gateway URL in the response
  const isGatewayBot = /\/v10\/gateway\/bot$/i.test(discordPath)

  // Build the forwarded request with the real bot token
  const headers = new Headers()
  c.req.raw.headers.forEach((value, key) => {
    // Skip hop-by-hop headers and the original authorization
    if (
      key === 'authorization' ||
      key === 'host' ||
      key === 'connection' ||
      key === 'transfer-encoding'
    ) {
      return
    }
    headers.set(key, value)
  })
  headers.set('Authorization', `Bot ${DISCORD_BOT_TOKEN}`)

  const response = await fetch(discordUrl.toString(), {
    method: c.req.method,
    headers,
    body:
      c.req.method !== 'GET' && c.req.method !== 'HEAD'
        ? c.req.raw.body
        : undefined,
  }).catch((cause) => {
    return new DiscordProxyFetchError({ url: discordUrl.toString(), cause })
  })
  if (response instanceof Error) {
    return c.json({ error: 'Failed to reach Discord API' }, 502)
  }

  if (isGatewayBot && response.ok) {
    const payload = await response.json().catch((cause) => {
      return new GatewayBotResponseDecodeError({ cause })
    })
    if (payload instanceof Error) {
      return c.json({ error: 'Invalid gateway response payload' }, 502)
    }

    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return c.json({ error: 'Invalid gateway response payload' }, 502)
    }

    const gatewayPayload: Record<string, unknown> = {
      ...payload,
      url: GATEWAY_PROXY_URL,
    }
    return c.json(gatewayPayload)
  }

  const responseHeaders = new Headers()
  response.headers.forEach((value, key) => {
    if (key === 'transfer-encoding' || key === 'content-encoding') {
      return
    }
    responseHeaders.set(key, value)
  })

  return new Response(response.body, {
    status: response.status,
    headers: responseHeaders,
  })
}
