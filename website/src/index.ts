// Cloudflare Worker entrypoint for the Kimaki website.
// Handles Discord OAuth bot install via better-auth and onboarding status polling.
//
// Uses Hyperdrive for pooled DB connections (env.HYPERDRIVE binding).
// Each request gets a fresh PrismaClient and betterAuth instance
// because CF Workers cannot reuse connections across requests.

import { Hono } from 'hono'
import { createPrisma } from 'db/src/prisma.js'
import { getTeamIdForWebhookEvent } from 'discord-slack-bridge/src/webhook-team-id'
import { createAuth } from './auth.js'
import { renderSuccessPage } from './components/success-page.js'
import { SlackBridgeDO } from './slack-bridge-do.js'
import type { HonoBindings } from './env.js'

export type { HonoBindings }
export { SlackBridgeDO }

const app = new Hono<{ Bindings: HonoBindings }>()

const TEAM_TO_CLIENT_IDS_CACHE_TTL_SECONDS = 30
const TEAM_TO_CLIENT_IDS_CACHE_NAME = 'kimaki-team-client-ids'

app.get('/', (c) => {
  return c.redirect('https://github.com/remorses/kimaki', 302)
})

app.get('/health', async (c) => {
  const prisma = createPrisma(c.env.HYPERDRIVE.connectionString)
  const result = await prisma.$queryRaw<[{ result: number }]>`SELECT 1 as result`
  return c.json({ status: 'ok', db: result[0].result })
})

// Initiates the Discord bot install flow via better-auth.
// The CLI opens the browser to this URL with clientId and clientSecret
// as query params. We call better-auth's signInSocial server-side with
// these as additionalData, which stores them in the verification table
// and generates a Discord OAuth URL. The browser is redirected to Discord.
app.get('/discord-install', async (c) => {
  const clientId = c.req.query('clientId')
  const clientSecret = c.req.query('clientSecret')
  const kimakiCallbackUrl = c.req.query('kimakiCallbackUrl')

  if (!clientId || !clientSecret) {
    return c.text('Missing clientId or clientSecret', 400)
  }

  // Early validation: reject non-https callback URLs (http://localhost allowed for dev).
  // Defense in depth — hooks.after also validates before redirecting.
  if (kimakiCallbackUrl) {
    try {
      const parsed = new URL(kimakiCallbackUrl)
      const isHttps = parsed.protocol === 'https:'
      const isLocalHttp =
        parsed.protocol === 'http:' &&
        (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
      if (!isHttps && !isLocalHttp) {
        return c.text('kimakiCallbackUrl must use https (or http for localhost)', 400)
      }
    } catch {
      return c.text('kimakiCallbackUrl is not a valid URL', 400)
    }
  }

  const baseURL = new URL(c.req.url).origin
  const auth = createAuth({ env: c.env, baseURL })

  // signInSocial returns JSON data on server calls; use returnHeaders so we can
  // forward Set-Cookie and still issue a real browser redirect.
  // kimakiCallbackUrl is an optional external URL passed by the CLI
  // (--gateway-callback-url). It's stored in additionalData so the hooks.after callback can redirect there
  // (with ?guild_id=<id>) instead of showing the default /install-success page.
  const { response: result, headers } = await auth.api.signInSocial({
    body: {
      provider: 'discord',
      additionalData: { clientId, clientSecret, kimakiCallbackUrl },
      callbackURL: '/install-success',
    },
    headers: c.req.raw.headers,
    returnHeaders: true,
  })

  if (!result?.url) {
    return c.text('Failed to generate Discord OAuth URL', 500)
  }

  const redirect = c.redirect(result.url, 302)
  for (const cookie of headers.getSetCookie()) {
    redirect.headers.append('Set-Cookie', cookie)
  }
  return redirect
})

// Success page after the OAuth callback completes.
// better-auth redirects here after processing the callback.
app.get('/install-success', (c) => {
  return c.html(renderSuccessPage())
})

app.all('/api/v10/*', async (c, next) => {
  if (!isSlackGatewayHost(c.req.url)) {
    return next()
  }

  const clientIdResult = getClientIdFromAuthorizationHeader(c.req.raw.headers)
  if (clientIdResult instanceof Error) {
    return c.json({ error: clientIdResult.message }, 401)
  }

  const clientId = clientIdResult
  const stub = c.env.SLACK_GATEWAY.getByName(clientId)
  const requestUrlWithClientId = appendClientIdQueryToGatewayUrl({
    requestUrl: c.req.url,
    clientId,
  })
  const response = await stub.handleDiscordRest({
    url: requestUrlWithClientId,
    path: c.req.path,
    method: c.req.method,
    headers: headersToPairs(c.req.raw.headers),
    body: await c.req.text(),
  })

  if (c.req.path === '/api/v10/gateway/bot') {
    return toResponse(appendClientIdToGatewayBotResponse({ response, clientId }))
  }

  return toResponse(response)
})

app.post('/slack/events', async (c, next) => {
  if (!isSlackGatewayHost(c.req.url)) {
    return next()
  }
  const body = await c.req.text()
  const teamId = getTeamIdForWebhookEvent({
    body,
    contentType: c.req.header('content-type') || undefined,
  })
  if (!teamId) {
    console.error('[slack-webhook-team-id-missing]', {
      path: c.req.path,
      contentType: c.req.header('content-type') || '',
      bodySummary: summarizeSlackWebhookBodyForLogs({
        body,
        contentType: c.req.header('content-type') || undefined,
      }),
    })
    return c.json({ error: 'Could not resolve Slack team_id from webhook payload' }, 400)
  }

  const clientIdsResult = await resolveClientIdsForTeamId({
    teamId,
    env: c.env,
    requestUrl: c.req.url,
  })
  if (clientIdsResult instanceof Error) {
    return c.json({ error: clientIdsResult.message }, 500)
  }
  if (clientIdsResult.length === 0) {
    return c.json({ error: 'No clients found for Slack team_id' }, 404)
  }

  const fanoutResults = await Promise.allSettled(clientIdsResult.map(async (clientId) => {
    const stub = c.env.SLACK_GATEWAY.getByName(clientId)
    const response = await stub.handleSlackWebhook({
      url: c.req.url,
      path: c.req.path,
      method: c.req.method,
      headers: headersToPairs(c.req.raw.headers),
      body,
    })
    return {
      clientId,
      response,
    }
  }))

  const rejectedResults = fanoutResults.filter((result) => {
    return result.status === 'rejected'
  })
  if (rejectedResults.length > 0) {
    console.error('[slack-webhook-fanout-rejected]', {
      teamId,
      rejectedCount: rejectedResults.length,
      totalClients: clientIdsResult.length,
      reasons: rejectedResults.map((result) => {
        return summarizeErrorReason(result.reason)
      }),
    })
  }

  const fulfilledResults = fanoutResults.flatMap((result) => {
    if (result.status !== 'fulfilled') {
      return []
    }
    return [result.value]
  })

  const successfulResult = fulfilledResults.find((result) => {
    return result.response.status < 400
  })
  if (successfulResult) {
    return toResponse(successfulResult.response)
  }

  const failedResponse = fulfilledResults.find((result) => {
    return result.response.status >= 400
  })
  if (failedResponse) {
    return toResponse(failedResponse.response)
  }

  return c.json({ error: 'Failed to fan out Slack webhook to client durable objects' }, 502)
})

app.all('/gateway', async (c, next) => {
  if (!isSlackGatewayHost(c.req.url)) {
    return next()
  }

  const clientId = c.req.query('clientId')
  if (!clientId) {
    return c.json({ error: 'Missing clientId query parameter' }, 400)
  }

  return proxyGatewayToDurableObject({
    request: c.req.raw,
    stub: c.env.SLACK_GATEWAY.getByName(clientId),
  })
})

app.all('/gateway/*', async (c, next) => {
  if (!isSlackGatewayHost(c.req.url)) {
    return next()
  }

  const clientId = c.req.query('clientId')
  if (!clientId) {
    return c.json({ error: 'Missing clientId query parameter' }, 400)
  }

  return proxyGatewayToDurableObject({
    request: c.req.raw,
    stub: c.env.SLACK_GATEWAY.getByName(clientId),
  })
})

// Mount better-auth handler for all auth routes.
// Handles /api/auth/callback/discord (OAuth callback) and other
// better-auth endpoints (session management, etc.).
app.on(['POST', 'GET'], '/api/auth/*', async (c) => {
  const baseURL = new URL(c.req.url).origin
  const auth = createAuth({ env: c.env, baseURL })
  return auth.handler(c.req.raw)
})

// CLI polling endpoint. The kimaki CLI polls this every 2s during onboarding
// to check if the user has completed the bot authorization flow.
// Returns 404 if not ready, 200 with guild_id if the client has been registered.
app.get('/api/onboarding/status', async (c) => {
  const clientId = c.req.query('client_id')
  const secret = c.req.query('secret')

  if (!clientId || !secret) {
    return c.json({ error: 'Missing client_id or secret' }, 400)
  }

  const prisma = createPrisma(c.env.HYPERDRIVE.connectionString)
  const row = await prisma.gateway_clients
    .findFirst({
      where: { client_id: clientId, secret },
      include: {
        user: {
          include: {
            accounts: {
              where: { providerId: 'discord' },
              select: { accountId: true },
              take: 1,
            },
          },
        },
      },
    })
    .catch((cause) => {
      return new Error('Failed to lookup gateway client', { cause })
    })
  if (row instanceof Error) {
    return c.json({ error: row.message }, 500)
  }

  if (!row) {
    return c.json({ error: 'Not found' }, 404)
  }

  // accountId is the Discord user ID from the OAuth provider
  const discordUserId = row.user?.accounts?.[0]?.accountId
  return c.json({ guild_id: row.guild_id, discord_user_id: discordUserId })
})

export default app

function toResponse(response: {
  status: number
  headers: string[][]
  body: string
}): Response {
  return new Response(response.body, {
    status: response.status,
    headers: new Headers(normalizeHeaderPairs(response.headers)),
  })
}

function proxyGatewayToDurableObject({
  request,
  stub,
}: {
  request: Request
  stub: DurableObjectStub<SlackBridgeDO>
}): Promise<Response> {
  const url = new URL(request.url)
  const rewrittenPath = `${url.pathname}${url.search}`
  const durableObjectUrl = new URL(rewrittenPath, 'https://do.local')
  return stub.fetch(new Request(durableObjectUrl, request))
}

function getClientIdFromAuthorizationHeader(headers: Headers): string | Error {
  const authorizationHeader = headers.get('authorization')
  if (!authorizationHeader) {
    return new Error('Missing authorization header')
  }

  const token = authorizationHeader.trim().split(/\s+/).at(-1)
  if (!token) {
    return new Error('Missing authorization token')
  }

  const tokenParts = token.split(':')
  if (tokenParts.length !== 2) {
    return new Error('Expected gateway token in clientId:secret format')
  }

  const clientId = tokenParts[0]
  if (!clientId) {
    return new Error('Malformed gateway token: missing clientId')
  }

  return clientId
}

function appendClientIdQueryToGatewayUrl({
  requestUrl,
  clientId,
}: {
  requestUrl: string
  clientId: string
}): string {
  const url = new URL(requestUrl)
  if (url.pathname === '/api/v10/gateway/bot') {
    url.searchParams.set('clientId', clientId)
  }
  return url.toString()
}

function appendClientIdToGatewayBotResponse({
  response,
  clientId,
}: {
  response: {
    status: number
    headers: string[][]
    body: string
  }
  clientId: string
}): {
  status: number
  headers: string[][]
  body: string
} {
  if (response.status !== 200) {
    return response
  }

  try {
    const parsedBody = JSON.parse(response.body) as { url?: string }
    const gatewayUrl = parsedBody.url
    if (!gatewayUrl) {
      return response
    }
    const parsedGatewayUrl = new URL(gatewayUrl)
    parsedGatewayUrl.searchParams.set('clientId', clientId)
    return {
      ...response,
      body: JSON.stringify({
        ...parsedBody,
        url: parsedGatewayUrl.toString(),
      }),
    }
  } catch {
    return response
  }
}

async function resolveClientIdsForTeamId({
  teamId,
  env,
  requestUrl,
}: {
  teamId: string
  env: HonoBindings
  requestUrl: string
}): Promise<string[] | Error> {
  const cache = await caches.open(TEAM_TO_CLIENT_IDS_CACHE_NAME)
  const cacheRequest = buildTeamIdToClientIdsCacheRequest({
    requestUrl,
    teamId,
  })

  try {
    const cachedResponse = await cache.match(cacheRequest)
    if (cachedResponse) {
      const cachedPayload = await cachedResponse.json().catch(() => {
        return null
      })
      if (
        cachedPayload
        && typeof cachedPayload === 'object'
        && 'clientIds' in cachedPayload
        && Array.isArray(cachedPayload.clientIds)
      ) {
        const cachedClientIds = cachedPayload.clientIds.filter((clientId) => {
          return typeof clientId === 'string'
        })
        return cachedClientIds
      }
    }
  } catch (error) {
    console.warn('[slack-team-client-cache-read-failed]', {
      teamId,
      reason: summarizeErrorReason(error),
    })
  }

  const prisma = createPrisma(env.HYPERDRIVE.connectionString)
  const rows = await prisma.gateway_clients.findMany({
    // In Slack bridge mode, gateway_clients.guild_id stores Slack team_id.
    // We intentionally reuse the same column to avoid a separate mapping table.
    where: { guild_id: teamId },
    select: { client_id: true },
    orderBy: [
      { updated_at: 'desc' },
      { created_at: 'desc' },
    ],
  }).catch((cause) => {
    return new Error('Failed to resolve client IDs for Slack team_id', { cause })
  })
  if (rows instanceof Error) {
    return rows
  }

  const seenClientIds = new Set<string>()
  const uniqueClientIds: string[] = []
  rows.forEach((row) => {
    if (seenClientIds.has(row.client_id)) {
      return
    }
    seenClientIds.add(row.client_id)
    uniqueClientIds.push(row.client_id)
  })

  try {
    const cacheResponse = new Response(
      JSON.stringify({ clientIds: uniqueClientIds }),
      {
        headers: {
          'content-type': 'application/json',
          'cache-control': `public, max-age=${TEAM_TO_CLIENT_IDS_CACHE_TTL_SECONDS}`,
        },
      },
    )
    await cache.put(cacheRequest, cacheResponse)
  } catch (error) {
    console.warn('[slack-team-client-cache-write-failed]', {
      teamId,
      reason: summarizeErrorReason(error),
    })
  }

  return uniqueClientIds
}

function buildTeamIdToClientIdsCacheRequest({
  requestUrl,
  teamId,
}: {
  requestUrl: string
  teamId: string
}): Request {
  const requestOrigin = new URL(requestUrl).origin
  const cacheUrl = new URL(
    `/__cache/slack-team-client-ids/${encodeURIComponent(teamId)}`,
    requestOrigin,
  )
  return new Request(cacheUrl.toString(), {
    method: 'GET',
  })
}

function summarizeSlackWebhookBodyForLogs({
  body,
  contentType,
}: {
  body: string
  contentType?: string
}): Record<string, unknown> {
  const normalizedContentType = contentType?.toLowerCase() ?? ''
  if (normalizedContentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(body)
    const paramKeys = [...new Set([...params.keys()])]
    if (params.has('payload')) {
      const payload = params.get('payload')
      if (payload) {
        try {
          const parsedPayload = JSON.parse(payload)
          if (parsedPayload && typeof parsedPayload === 'object') {
            return {
              format: 'form-urlencoded-payload-json',
              paramKeys,
              payloadKeys: Object.keys(parsedPayload),
            }
          }
        } catch {
          return {
            format: 'form-urlencoded-payload-invalid-json',
            paramKeys,
          }
        }
      }
    }
    return {
      format: 'form-urlencoded',
      paramKeys,
    }
  }

  try {
    const parsedBody = JSON.parse(body)
    if (parsedBody && typeof parsedBody === 'object') {
      return {
        format: 'json',
        payloadKeys: Object.keys(parsedBody),
      }
    }
    return {
      format: 'json-non-object',
      valueType: typeof parsedBody,
    }
  } catch {
    return {
      format: 'unknown',
      bodyLength: body.length,
    }
  }
}

function summarizeErrorReason(reason: unknown): string {
  if (reason instanceof Error) {
    return `${reason.name}: ${reason.message}`
  }
  return String(reason)
}

function isSlackGatewayHost(requestUrl: string): boolean {
  const host = new URL(requestUrl).host.toLowerCase()
  const isGatewayHost = (
    host === 'slack-gateway.kimaki.xyz'
    || host === 'preview-slack-gateway.kimaki.xyz'
  )
  console.log('[slack-gateway-host-check]', {
    host,
    requestUrl,
    isGatewayHost,
  })
  return isGatewayHost
}

function headersToPairs(headers: Headers): Array<[string, string]> {
  const result: Array<[string, string]> = []
  headers.forEach((value, key) => {
    result.push([key, value])
  })
  return result
}

function normalizeHeaderPairs(headers: string[][]): Array<[string, string]> {
  return headers
    .filter((pair): pair is [string, string] => {
      return pair.length === 2
    })
    .map(([key, value]) => {
      return [key, value]
    })
}
