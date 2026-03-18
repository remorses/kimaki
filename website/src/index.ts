// Cloudflare Worker entrypoint for the Kimaki website.
// Handles Discord OAuth bot install via better-auth and onboarding status polling.
//
// Uses Hyperdrive for pooled DB connections (env.HYPERDRIVE binding).
// Each request gets a fresh PrismaClient and betterAuth instance
// because CF Workers cannot reuse connections across requests.

import { Hono } from 'hono'
import { createPrisma } from 'db/src'
import { getTeamIdForWebhookEvent } from 'discord-slack-bridge/src/webhook-team-id'
import {
  deleteSlackInstallStateInKv,
  getSlackInstallStateFromKv,
  getTeamClientIdsFromKv,
  setSlackInstallStateInKv,
  setTeamClientIdsInKv,
  upsertGatewayClientAndRefreshKv,
} from './gateway-client-kv.js'
import { createAuth, parseAllowedCallbackUrl } from './auth.js'
import { renderSuccessPage } from './components/success-page.js'
import { SlackBridgeDO } from './slack-bridge-do.js'
import type { HonoBindings } from './env.js'

export type { HonoBindings }
export { SlackBridgeDO }

const app = new Hono<{ Bindings: HonoBindings }>()

const SLACK_OAUTH_CALLBACK_PATH = '/slack/oauth/callback'
const SLACK_INSTALL_SCOPES = [
  'commands',
  'chat:write',
  'chat:write.public',
  'channels:manage',
  'groups:write',
  'channels:read',
  'groups:read',
  'channels:history',
  'groups:history',
  'reactions:write',
  'files:write',
]

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
  const reachableUrl = c.req.query('reachableUrl')

  if (!clientId || !clientSecret) {
    return c.text('Missing clientId or clientSecret', 400)
  }

  // Validate reachableUrl: must be https to prevent SSRF / token exfiltration.
  // The gateway-proxy connects outbound to this URL with Authorization header,
  // so an attacker-controlled URL would receive the client secret.
  if (reachableUrl) {
    try {
      const parsed = new URL(reachableUrl)
      if (parsed.protocol !== 'https:') {
        return c.text('reachableUrl must use https', 400)
      }
    } catch {
      return c.text('reachableUrl is not a valid URL', 400)
    }
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
      additionalData: { clientId, clientSecret, kimakiCallbackUrl, reachableUrl },
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

app.get('/slack-install', async (c) => {
  const clientId = c.req.query('clientId')
  const clientSecret = c.req.query('clientSecret')
  const kimakiCallbackUrl = c.req.query('kimakiCallbackUrl')

  if (!clientId || !clientSecret) {
    return c.text('Missing clientId or clientSecret', 400)
  }

  if (kimakiCallbackUrl && !parseAllowedCallbackUrl(kimakiCallbackUrl)) {
    return c.text('kimakiCallbackUrl must use https (or http for localhost)', 400)
  }

  const oauthState = crypto.randomUUID()
  const persistStateResult = await setSlackInstallStateInKv({
    kv: c.env.GATEWAY_CLIENT_KV,
    state: oauthState,
    record: {
      kimaki_client_id: clientId,
      kimaki_client_secret: clientSecret,
      kimaki_callback_url: kimakiCallbackUrl ?? null,
    },
  }).catch((cause) => {
    return new Error('Failed to persist Slack install state', { cause })
  })
  if (persistStateResult instanceof Error) {
    return c.text(persistStateResult.message, 500)
  }

  const baseUrl = new URL(c.req.url).origin
  const authorizeUrl = new URL('https://slack.com/oauth/v2/authorize')
  authorizeUrl.searchParams.set('client_id', c.env.SLACK_CLIENT_ID)
  authorizeUrl.searchParams.set('scope', SLACK_INSTALL_SCOPES.join(','))
  authorizeUrl.searchParams.set('redirect_uri', new URL(SLACK_OAUTH_CALLBACK_PATH, baseUrl).toString())
  authorizeUrl.searchParams.set('state', oauthState)
  return c.redirect(authorizeUrl.toString(), 302)
})

app.get(SLACK_OAUTH_CALLBACK_PATH, async (c) => {
  const error = c.req.query('error')
  if (error) {
    return c.text(`Slack install failed: ${error}`, 400)
  }

  const code = c.req.query('code')
  const state = c.req.query('state')
  if (!code || !state) {
    return c.text('Missing Slack OAuth code or state', 400)
  }

  const installState = await getSlackInstallStateFromKv({
    kv: c.env.GATEWAY_CLIENT_KV,
    state,
  }).catch((cause) => {
    return new Error('Failed to read Slack install state', { cause })
  })
  if (installState instanceof Error) {
    return c.text(installState.message, 500)
  }
  if (!installState) {
    return c.text('Slack install state expired or was not found', 400)
  }

  await deleteSlackInstallStateInKv({
    kv: c.env.GATEWAY_CLIENT_KV,
    state,
  }).catch(() => {
    return undefined
  })

  const redirectUri = new URL(SLACK_OAUTH_CALLBACK_PATH, new URL(c.req.url).origin).toString()
  const slackAccessResponse = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${c.env.SLACK_CLIENT_ID}:${c.env.SLACK_CLIENT_SECRET}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      code,
      redirect_uri: redirectUri,
    }),
  }).catch((cause) => {
    return new Error('Failed to exchange Slack OAuth code', { cause })
  })
  if (slackAccessResponse instanceof Error) {
    return c.text(slackAccessResponse.message, 500)
  }

  const slackAccessPayload = await slackAccessResponse.json().catch((cause) => {
    return new Error('Failed to parse Slack OAuth response', { cause })
  })
  if (slackAccessPayload instanceof Error) {
    return c.text(slackAccessPayload.message, 500)
  }
  if (!isSlackOAuthAccessResponse(slackAccessPayload)) {
    return c.text('Slack OAuth response had an unexpected shape', 500)
  }
  if (!slackAccessPayload.ok) {
    return c.text(`Slack OAuth exchange failed: ${slackAccessPayload.error ?? 'unknown_error'}`, 400)
  }

  const teamId = slackAccessPayload.team?.id
  const botToken = slackAccessPayload.access_token
  if (!(teamId && botToken)) {
    return c.text('Slack OAuth response missing team.id or access_token', 500)
  }

  const prisma = createPrisma(c.env.HYPERDRIVE.connectionString)

  const upsertResult = await upsertGatewayClientAndRefreshKv({
    env: c.env,
    clientId: installState.kimaki_client_id,
    secret: installState.kimaki_client_secret,
    guildId: teamId,
    platform: 'slack',
    botToken,
  })
  if (upsertResult instanceof Error) {
    return c.text(upsertResult.message, 500)
  }

  const updateRowsResult = await prisma.gateway_clients.updateMany({
    where: {
      guild_id: teamId,
      platform: 'slack',
    },
    data: {
      bot_token: botToken,
    },
  }).catch((cause) => {
    return new Error('Failed to refresh Slack bot tokens for team', { cause })
  })
  if (updateRowsResult instanceof Error) {
    return c.text(updateRowsResult.message, 500)
  }

  const callbackUrl = parseAllowedCallbackUrl(installState.kimaki_callback_url)
  if (callbackUrl) {
    callbackUrl.searchParams.set('guild_id', teamId)
    callbackUrl.searchParams.set('team_id', teamId)
    callbackUrl.searchParams.set('client_id', installState.kimaki_client_id)
    return new Response(null, {
      status: 302,
      headers: { Location: callbackUrl.toString() },
    })
  }

  const successUrl = new URL('/install-success', new URL(c.req.url).origin)
  successUrl.searchParams.set('guild_id', teamId)
  successUrl.searchParams.set('team_id', teamId)
  return c.redirect(successUrl.toString(), 302)
})

// Success page after the OAuth callback completes.
// better-auth redirects here after processing the callback.
app.get('/install-success', (c) => {
  const guildId = c.req.query('guild_id') ?? c.req.query('team_id') ?? undefined
  return c.html(renderSuccessPage({ guildId }))
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
  const response = await stub.handleDiscordRest({
    clientId,
    url: c.req.url,
    path: c.req.path,
    method: c.req.method,
    headers: headersToPairs(c.req.raw.headers),
    body: await c.req.text(),
  })

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
      clientId,
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
    clientId,
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
    clientId,
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
              where: {
                providerId: {
                  in: ['discord', 'slack'],
                },
              },
              select: {
                accountId: true,
                providerId: true,
              },
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

  const discordUserId = row.user?.accounts.find((account) => {
    return account.providerId === 'discord'
  })?.accountId
  const slackUserId = row.user?.accounts.find((account) => {
    return account.providerId === 'slack'
  })?.accountId
  return c.json({
    guild_id: row.guild_id,
    team_id: row.platform === 'slack' ? row.guild_id : undefined,
    discord_user_id: discordUserId,
    slack_user_id: slackUserId,
  })
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
  clientId,
  stub,
}: {
  request: Request
  clientId: string
  stub: DurableObjectStub<SlackBridgeDO>
}): Promise<Response> {
  const url = new URL(request.url)
  const rewrittenPath = `${url.pathname}${url.search}`
  const durableObjectUrl = new URL(rewrittenPath, 'https://do.local')
  return stub.fetch(new Request(durableObjectUrl, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: request.redirect,
    signal: request.signal,
  }))
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

async function resolveClientIdsForTeamId({
  teamId,
  env,
}: {
  teamId: string
  env: HonoBindings
}): Promise<string[] | Error> {
  try {
    const cachedClientIds = await getTeamClientIdsFromKv({
      teamId,
      kv: env.GATEWAY_CLIENT_KV,
    })
    if (cachedClientIds) {
      return cachedClientIds
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
    await setTeamClientIdsInKv({
      kv: env.GATEWAY_CLIENT_KV,
      teamId,
      clientIds: uniqueClientIds,
    })
  } catch (error) {
    console.warn('[slack-team-client-cache-write-failed]', {
      teamId,
      reason: summarizeErrorReason(error),
    })
  }

  return uniqueClientIds
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

type SlackOAuthErrorResponse = {
  ok: false
  error?: string
}

type SlackOAuthSuccessResponse = {
  ok: true
  access_token: string
  team?: {
    id?: string
  }
  authed_user?: {
    id?: string
    access_token?: string
  }
}

type SlackOAuthAccessResponse = SlackOAuthErrorResponse | SlackOAuthSuccessResponse

function isSlackOAuthAccessResponse(value: unknown): value is SlackOAuthAccessResponse {
  if (!isRecord(value)) {
    return false
  }

  if (value.ok === false) {
    return value.error === undefined || typeof value.error === 'string'
  }
  if (value.ok !== true) {
    return false
  }

  if (typeof value.access_token !== 'string') {
    return false
  }

  const team = value.team
  if (team !== undefined && !isOptionalIdRecord(team)) {
    return false
  }

  const authedUser = value.authed_user
  if (authedUser !== undefined && !isOptionalIdRecord(authedUser)) {
    return false
  }

  return true
}

function isOptionalIdRecord(value: unknown): value is { id?: string; access_token?: string } {
  if (!isRecord(value)) {
    return false
  }
  return (
    (value.id === undefined || typeof value.id === 'string')
    && (value.access_token === undefined || typeof value.access_token === 'string')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
