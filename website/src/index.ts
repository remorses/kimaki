// Cloudflare Worker entrypoint for the Kimaki website.
// Handles Discord OAuth bot install via better-auth and onboarding status polling.
//
// Uses Hyperdrive for pooled DB connections (env.HYPERDRIVE binding).
// Each request gets a fresh PrismaClient and betterAuth instance
// because CF Workers cannot reuse connections across requests.

import { Spiceflow } from 'spiceflow'
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
import type { Env } from './env.js'

export { SlackBridgeDO }

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

const app = new Spiceflow()
  .state('env', {} as Env)

  .onError(({ error }) => {
    console.error(error)
    const message = error instanceof Error ? error.message : String(error)
    return new Response(message, { status: 500 })
  })

  .route({
    method: 'GET',
    path: '/',
    handler() {
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://github.com/remorses/kimaki' },
      })
    },
  })

  .route({
    method: 'GET',
    path: '/health',
    async handler({ state }) {
      const prisma = createPrisma(state.env.HYPERDRIVE.connectionString)
      const result = await prisma.$queryRaw<
        [{ result: number }]
      >`SELECT 1 as result`
      return { status: 'ok', db: result[0].result }
    },
  })

  // Initiates the Discord bot install flow via better-auth.
  // The CLI opens the browser to this URL with clientId and clientSecret
  // as query params. We call better-auth's signInSocial server-side with
  // these as additionalData, which stores them in the verification table
  // and generates a Discord OAuth URL. The browser is redirected to Discord.
  .route({
    method: 'GET',
    path: '/discord-install',
    async handler({ request, state }) {
      const url = new URL(request.url)

      const clientId = url.searchParams.get('clientId')
      const clientSecret = url.searchParams.get('clientSecret')
      const kimakiCallbackUrl = url.searchParams.get('kimakiCallbackUrl')
      const reachableUrl = url.searchParams.get('reachableUrl')

      if (!clientId || !clientSecret) {
        throw new Response('Missing clientId or clientSecret', { status: 400 })
      }

      // Validate reachableUrl: must be https to prevent SSRF / token exfiltration.
      // The gateway-proxy connects outbound to this URL with Authorization header,
      // so an attacker-controlled URL would receive the client secret.
      if (reachableUrl) {
        try {
          const parsed = new URL(reachableUrl)
          if (parsed.protocol !== 'https:') {
            throw new Response('reachableUrl must use https', { status: 400 })
          }
        } catch (e) {
          if (e instanceof Response) {
            throw e
          }
          throw new Response('reachableUrl is not a valid URL', { status: 400 })
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
            throw new Response(
              'kimakiCallbackUrl must use https (or http for localhost)',
              { status: 400 },
            )
          }
        } catch (e) {
          if (e instanceof Response) {
            throw e
          }
          throw new Response('kimakiCallbackUrl is not a valid URL', {
            status: 400,
          })
        }
      }

      const baseURL = new URL(request.url).origin
      const auth = createAuth({ env: state.env, baseURL })

      // signInSocial returns JSON data on server calls; use returnHeaders so we can
      // forward Set-Cookie and still issue a real browser redirect.
      // kimakiCallbackUrl is an optional external URL passed by the CLI
      // (--gateway-callback-url). It's stored in additionalData so the hooks.after callback can redirect there
      // (with ?guild_id=<id>) instead of showing the default /install-success page.
      const { response: result, headers } = await auth.api.signInSocial({
        body: {
          provider: 'discord',
          additionalData: {
            clientId,
            clientSecret,
            kimakiCallbackUrl,
            reachableUrl,
          },
          callbackURL: '/install-success',
        },
        headers: request.headers,
        returnHeaders: true,
      })

      if (!result?.url) {
        throw new Response('Failed to generate Discord OAuth URL', {
          status: 500,
        })
      }

      const redirect = new Response(null, {
        status: 302,
        headers: { Location: result.url },
      })
      for (const cookie of headers.getSetCookie()) {
        redirect.headers.append('Set-Cookie', cookie)
      }
      return redirect
    },
  })

  .route({
    method: 'GET',
    path: '/slack-install',
    async handler({ request, state }) {
      const url = new URL(request.url)
      const clientId = url.searchParams.get('clientId')
      const clientSecret = url.searchParams.get('clientSecret')
      const kimakiCallbackUrl = url.searchParams.get('kimakiCallbackUrl')

      if (!clientId || !clientSecret) {
        throw new Response('Missing clientId or clientSecret', { status: 400 })
      }

      if (kimakiCallbackUrl && !parseAllowedCallbackUrl(kimakiCallbackUrl)) {
        throw new Response(
          'kimakiCallbackUrl must use https (or http for localhost)',
          { status: 400 },
        )
      }

      const oauthState = crypto.randomUUID()
      const persistStateResult = await setSlackInstallStateInKv({
        kv: state.env.GATEWAY_CLIENT_KV,
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
        throw new Response(persistStateResult.message, { status: 500 })
      }

      const baseUrl = new URL(request.url).origin
      const authorizeUrl = new URL('https://slack.com/oauth/v2/authorize')
      authorizeUrl.searchParams.set('client_id', state.env.SLACK_CLIENT_ID)
      authorizeUrl.searchParams.set('scope', SLACK_INSTALL_SCOPES.join(','))
      authorizeUrl.searchParams.set(
        'redirect_uri',
        new URL(SLACK_OAUTH_CALLBACK_PATH, baseUrl).toString(),
      )
      authorizeUrl.searchParams.set('state', oauthState)
      return new Response(null, {
        status: 302,
        headers: { Location: authorizeUrl.toString() },
      })
    },
  })

  .route({
    method: 'GET',
    path: SLACK_OAUTH_CALLBACK_PATH,
    async handler({ request, state }) {
      const url = new URL(request.url)
      const error = url.searchParams.get('error')
      if (error) {
        throw new Response(`Slack install failed: ${error}`, { status: 400 })
      }

      const code = url.searchParams.get('code')
      const oauthState = url.searchParams.get('state')
      if (!code || !oauthState) {
        throw new Response('Missing Slack OAuth code or state', { status: 400 })
      }

      const installState = await getSlackInstallStateFromKv({
        kv: state.env.GATEWAY_CLIENT_KV,
        state: oauthState,
      }).catch((cause) => {
        return new Error('Failed to read Slack install state', { cause })
      })
      if (installState instanceof Error) {
        throw new Response(installState.message, { status: 500 })
      }
      if (!installState) {
        throw new Response('Slack install state expired or was not found', {
          status: 400,
        })
      }

      await deleteSlackInstallStateInKv({
        kv: state.env.GATEWAY_CLIENT_KV,
        state: oauthState,
      }).catch(() => {
        return undefined
      })

      const redirectUri = new URL(
        SLACK_OAUTH_CALLBACK_PATH,
        new URL(request.url).origin,
      ).toString()
      const slackAccessResponse = await fetch(
        'https://slack.com/api/oauth.v2.access',
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${btoa(`${state.env.SLACK_CLIENT_ID}:${state.env.SLACK_CLIENT_SECRET}`)}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            code,
            redirect_uri: redirectUri,
          }),
        },
      ).catch((cause) => {
        return new Error('Failed to exchange Slack OAuth code', { cause })
      })
      if (slackAccessResponse instanceof Error) {
        throw new Response(slackAccessResponse.message, { status: 500 })
      }

      const slackAccessPayload = await slackAccessResponse
        .json()
        .catch((cause) => {
          return new Error('Failed to parse Slack OAuth response', { cause })
        })
      if (slackAccessPayload instanceof Error) {
        throw new Response(slackAccessPayload.message, { status: 500 })
      }
      if (!isSlackOAuthAccessResponse(slackAccessPayload)) {
        throw new Response('Slack OAuth response had an unexpected shape', {
          status: 500,
        })
      }
      if (!slackAccessPayload.ok) {
        throw new Response(
          `Slack OAuth exchange failed: ${slackAccessPayload.error ?? 'unknown_error'}`,
          { status: 400 },
        )
      }

      const teamId = slackAccessPayload.team?.id
      const botToken = slackAccessPayload.access_token
      if (!(teamId && botToken)) {
        throw new Response(
          'Slack OAuth response missing team.id or access_token',
          { status: 500 },
        )
      }

      const prisma = createPrisma(state.env.HYPERDRIVE.connectionString)

      const upsertResult = await upsertGatewayClientAndRefreshKv({
        env: state.env,
        clientId: installState.kimaki_client_id,
        secret: installState.kimaki_client_secret,
        guildId: teamId,
        platform: 'slack',
        botToken,
      })
      if (upsertResult instanceof Error) {
        throw new Response(upsertResult.message, { status: 500 })
      }

      const updateRowsResult = await prisma.gateway_clients
        .updateMany({
          where: {
            guild_id: teamId,
            platform: 'slack',
          },
          data: {
            bot_token: botToken,
          },
        })
        .catch((cause) => {
          return new Error('Failed to refresh Slack bot tokens for team', {
            cause,
          })
        })
      if (updateRowsResult instanceof Error) {
        throw new Response(updateRowsResult.message, { status: 500 })
      }

      const callbackUrl = parseAllowedCallbackUrl(
        installState.kimaki_callback_url,
      )
      if (callbackUrl) {
        callbackUrl.searchParams.set('guild_id', teamId)
        callbackUrl.searchParams.set('team_id', teamId)
        callbackUrl.searchParams.set('client_id', installState.kimaki_client_id)
        return new Response(null, {
          status: 302,
          headers: { Location: callbackUrl.toString() },
        })
      }

      const successUrl = new URL(
        '/install-success',
        new URL(request.url).origin,
      )
      successUrl.searchParams.set('guild_id', teamId)
      successUrl.searchParams.set('team_id', teamId)
      return new Response(null, {
        status: 302,
        headers: { Location: successUrl.toString() },
      })
    },
  })

  // Success page after the OAuth callback completes.
  // better-auth redirects here after processing the callback.
  .route({
    method: 'GET',
    path: '/install-success',
    handler({ request }) {
      const url = new URL(request.url)
      const guildId =
        url.searchParams.get('guild_id') ??
        url.searchParams.get('team_id') ??
        undefined
      return new Response(renderSuccessPage({ guildId }), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    },
  })

  // Slack gateway: Discord REST proxy → Durable Object
  // Only active on slack-gateway.kimaki.xyz host.
  .route({
    method: '*',
    path: '/api/v10/*',
    async handler({ request, state }) {
      if (!isSlackGatewayHost(request.url)) {
        return new Response('Not Found', { status: 404 })
      }

      const clientIdResult = getClientIdFromAuthorizationHeader(request.headers)
      if (clientIdResult instanceof Error) {
        return new Response(JSON.stringify({ error: clientIdResult.message }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      const clientId = clientIdResult
      const stub = state.env.SLACK_GATEWAY.getByName(clientId)
      const url = new URL(request.url)
      const response = await stub.handleDiscordRest({
        clientId,
        url: request.url,
        path: url.pathname,
        method: request.method,
        headers: headersToPairs(request.headers),
        body: await request.text(),
      })

      return toResponse(response)
    },
  })

  .route({
    method: 'POST',
    path: '/slack/events',
    async handler({ request, state }) {
      if (!isSlackGatewayHost(request.url)) {
        return new Response('Not Found', { status: 404 })
      }
      const body = await request.text()
      const contentType = request.headers.get('content-type') || undefined
      const teamId = getTeamIdForWebhookEvent({
        body,
        contentType,
      })
      if (!teamId) {
        console.error('[slack-webhook-team-id-missing]', {
          path: new URL(request.url).pathname,
          contentType: contentType || '',
          bodySummary: summarizeSlackWebhookBodyForLogs({
            body,
            contentType,
          }),
        })
        return new Response(
          JSON.stringify({
            error: 'Could not resolve Slack team_id from webhook payload',
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        )
      }

      const clientIdsResult = await resolveClientIdsForTeamId({
        teamId,
        env: state.env,
      })
      if (clientIdsResult instanceof Error) {
        return new Response(
          JSON.stringify({ error: clientIdsResult.message }),
          { status: 500, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (clientIdsResult.length === 0) {
        return new Response(
          JSON.stringify({ error: 'No clients found for Slack team_id' }),
          { status: 404, headers: { 'Content-Type': 'application/json' } },
        )
      }

      const fanoutResults = await Promise.allSettled(
        clientIdsResult.map(async (clientId) => {
          const stub = state.env.SLACK_GATEWAY.getByName(clientId)
          const response = await stub.handleSlackWebhook({
            clientId,
            url: request.url,
            path: new URL(request.url).pathname,
            method: request.method,
            headers: headersToPairs(request.headers),
            body,
          })
          return {
            clientId,
            response,
          }
        }),
      )

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

      return new Response(
        JSON.stringify({
          error: 'Failed to fan out Slack webhook to client durable objects',
        }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      )
    },
  })

  .route({
    method: '*',
    path: '/slack/gateway',
    async handler({ request, state }) {
      if (!isSlackGatewayHost(request.url)) {
        return new Response('Not Found', { status: 404 })
      }

      const url = new URL(request.url)
      const clientId = url.searchParams.get('clientId')
      if (!clientId) {
        return new Response(
          JSON.stringify({ error: 'Missing clientId query parameter' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        )
      }

      return proxyGatewayToDurableObject({
        request,
        clientId,
        stub: state.env.SLACK_GATEWAY.getByName(clientId),
      })
    },
  })

  .route({
    method: '*',
    path: '/slack/gateway/*',
    async handler({ request, state }) {
      if (!isSlackGatewayHost(request.url)) {
        return new Response('Not Found', { status: 404 })
      }

      const url = new URL(request.url)
      const clientId = url.searchParams.get('clientId')
      if (!clientId) {
        return new Response(
          JSON.stringify({ error: 'Missing clientId query parameter' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        )
      }

      return proxyGatewayToDurableObject({
        request,
        clientId,
        stub: state.env.SLACK_GATEWAY.getByName(clientId),
      })
    },
  })

  // Mount better-auth handler for auth routes (GET and POST only).
  // Handles /api/auth/callback/discord (OAuth callback) and other
  // better-auth endpoints (session management, etc.).
  .route({
    method: 'GET',
    path: '/api/auth/*',
    async handler({ request, state }) {
      const baseURL = new URL(request.url).origin
      const auth = createAuth({ env: state.env, baseURL })
      return auth.handler(request)
    },
  })
  .route({
    method: 'POST',
    path: '/api/auth/*',
    async handler({ request, state }) {
      const baseURL = new URL(request.url).origin
      const auth = createAuth({ env: state.env, baseURL })
      return auth.handler(request)
    },
  })

  // CLI polling endpoint. The kimaki CLI polls this every 2s during onboarding
  // to check if the user has completed the bot authorization flow.
  // Returns 404 if not ready, 200 with guild_id if the client has been registered.
  .route({
    method: 'GET',
    path: '/api/onboarding/status',
    async handler({ request, state }) {
      const url = new URL(request.url)
      const clientId = url.searchParams.get('client_id')
      const secret = url.searchParams.get('secret')

      if (!clientId || !secret) {
        return new Response(
          JSON.stringify({ error: 'Missing client_id or secret' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        )
      }

      const prisma = createPrisma(state.env.HYPERDRIVE.connectionString)
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
                },
              },
            },
          },
        })
        .catch((cause) => {
          return new Error('Failed to lookup gateway client', { cause })
        })
      if (row instanceof Error) {
        return new Response(JSON.stringify({ error: row.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      if (!row) {
        return new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      const discordUserId = row.user?.accounts.find((account) => {
        return account.providerId === 'discord'
      })?.accountId
      const slackUserId = row.user?.accounts.find((account) => {
        return account.providerId === 'slack'
      })?.accountId
      return {
        guild_id: row.guild_id,
        team_id: row.platform === 'slack' ? row.guild_id : undefined,
        discord_user_id: discordUserId,
        slack_user_id: slackUserId,
      }
    },
  })

export default {
  fetch(request: Request, env: Env) {
    return app.handle(request, { state: { env } })
  },
}

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
  return stub.fetch(
    new Request(durableObjectUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: request.redirect,
      signal: request.signal,
    }),
  )
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
  env: Env
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
  const rows = await prisma.gateway_clients
    .findMany({
      // In Slack bridge mode, gateway_clients.guild_id stores Slack team_id.
      // We intentionally reuse the same column to avoid a separate mapping table.
      where: { guild_id: teamId },
      orderBy: [{ updated_at: 'desc' }, { created_at: 'desc' }],
    })
    .catch((cause) => {
      return new Error('Failed to resolve client IDs for Slack team_id', {
        cause,
      })
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
  const isGatewayHost =
    host === 'slack-gateway.kimaki.xyz' ||
    host === 'preview-slack-gateway.kimaki.xyz'
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

type SlackOAuthAccessResponse =
  | SlackOAuthErrorResponse
  | SlackOAuthSuccessResponse

function isSlackOAuthAccessResponse(
  value: unknown,
): value is SlackOAuthAccessResponse {
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

function isOptionalIdRecord(
  value: unknown,
): value is { id?: string; access_token?: string } {
  if (!isRecord(value)) {
    return false
  }
  return (
    (value.id === undefined || typeof value.id === 'string') &&
    (value.access_token === undefined || typeof value.access_token === 'string')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
