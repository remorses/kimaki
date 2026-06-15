// Per-request better-auth factory for the Cloudflare Worker.
//
// Creates a new betterAuth instance per request because CF Workers cannot
// reuse database connections across requests (Hyperdrive per-request pooling).
//
// Gateway onboarding persistence is handled in hooks.after:
// - reads guild_id from Discord callback query params
// - reads clientId/clientSecret from getOAuthState() additionalData
// - upserts gateway_clients for CLI onboarding polling

// better-auth/minimal excludes kysely (~182 KiB minified) from the bundle.
// Safe because we use the prisma adapter, not direct DB connections.
// See: https://better-auth.com/docs/guides/optimizing-for-performance#bundle-size-optimization
import { betterAuth } from 'better-auth/minimal'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { createAuthMiddleware, getOAuthState } from 'better-auth/api'
import { createPrisma } from 'db/src'
import type { Env } from './env.js'
import { upsertGatewayClientAndRefreshKv } from './gateway-client-kv.js'

// Same permissions list used in cli/src/utils.ts generateBotInstallUrl.
// Hardcoded to avoid importing discord-api-types/v10 barrel which adds ~204 KiB
// to the CF Worker bundle (pulls in gateway, payloads, rest, rpc modules).
// Computed from PermissionFlagsBits: ViewChannel | ManageChannels | SendMessages |
// SendMessagesInThreads | CreatePublicThreads | ManageThreads | ReadMessageHistory |
// AddReactions | ManageMessages | UseExternalEmojis | AttachFiles | Connect | Speak |
// ManageRoles | ManageEvents | CreateEvents
const DISCORD_BOT_PERMISSIONS = 17927465446480

// Validates and parses a callback URL, allowing only https: and http://localhost.
// Returns null for missing, malformed, or disallowed schemes (e.g. javascript:)
// to prevent open redirect attacks through the OAuth flow.
export function parseAllowedCallbackUrl(raw: string | null | undefined): URL | null {
  if (!raw) {
    return null
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol === 'https:') {
    return url
  }
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    return url
  }
  return null
}

function getGuildIdFromRequestUrl({
  context,
}: {
  context: { request?: Request } | null
}): string | undefined {
  const requestUrl = context?.request?.url
  if (!requestUrl) {
    return undefined
  }

  const guildId = new URL(requestUrl).searchParams.get('guild_id')
  if (!guildId) {
    return undefined
  }
  return guildId
}

// Request header used to pass guild_id from the route handler to the
// hooks.after callback within the same request. The route handler
// extracts guild_id from the Discord callback URL before better-auth
// processes it, and injects it as a header so hooks.after has a
// synchronous, in-request fallback (no KV eventual consistency risk).
export const GUILD_ID_HEADER = 'x-kimaki-discord-guild-id'

// KV key for storing onboarding errors so the CLI can show them
// instead of polling forever.
const ONBOARDING_ERROR_KV_PREFIX = 'onboarding-error:'
const ONBOARDING_KV_TTL_SECONDS = 600

export function onboardingErrorKvKey(clientId: string): string {
  return `${ONBOARDING_ERROR_KV_PREFIX}${clientId}`
}

export function createAuth({ env, baseURL }: { env: Env; baseURL: string }) {
  const prisma = createPrisma(env.HYPERDRIVE.connectionString)

  const auth = betterAuth({
    database: prismaAdapter(prisma, { provider: 'postgresql' }),
    secret: env.AUTH_SECRET,
    baseURL,
    socialProviders: {
      discord: {
        clientId: env.DISCORD_CLIENT_ID,
        clientSecret: env.DISCORD_CLIENT_SECRET,
        scope: ['bot', 'applications.commands'],
        permissions: DISCORD_BOT_PERMISSIONS,
        // Force consent screen every time. The default 'none' can cause
        // Discord to skip the bot authorization step for returning users,
        // omitting guild_id from the callback URL — which silently breaks
        // the gateway_clients upsert and leaves the CLI polling forever.
        prompt: 'consent',
        getUserInfo: async (token) => {
          const accessToken = token.accessToken
          if (!accessToken) {
            return null
          }

          const res = await fetch('https://discord.com/api/v10/users/@me', {
            headers: { Authorization: `Bearer ${accessToken}` },
          })
          if (!res.ok) {
            return null
          }
          const profile: {
            id: string
            username: string
            global_name: string | null
            avatar: string | null
            email: string | null
            verified: boolean
          } = await res.json()

          return {
            user: {
              id: profile.id,
              name: profile.global_name || profile.username,
              email: profile.email,
              emailVerified: profile.verified ?? false,
              image: profile.avatar
                ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
                : undefined,
            },
            data: profile,
          }
        },
      },
    },
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/callback/:id') {
          return
        }

        // Persist an error so the CLI polling endpoint can return it
        // instead of a bare 404, AND redirect the browser to the
        // install-success page with the error visible.
        async function failOnboarding(clientId: string, message: string) {
          await env.GATEWAY_CLIENT_KV.put(
            onboardingErrorKvKey(clientId),
            JSON.stringify({ error: message, timestamp: Date.now() }),
            { expirationTtl: ONBOARDING_KV_TTL_SECONDS },
          ).catch(() => {})
          const errorUrl = new URL('/install-success', baseURL)
          errorUrl.searchParams.set('error', message)
          return new Response(null, {
            status: 302,
            headers: { Location: errorUrl.toString() },
          })
        }

        // 1. Try guild_id from the callback URL query params (Discord
        //    includes it for advanced bot authorization flows).
        let guildId = getGuildIdFromRequestUrl({ context: ctx })

        // 2. Fallback: read guild_id from the request header injected
        //    by the route handler in server.tsx before better-auth
        //    processed the callback. Synchronous, no KV consistency risk.
        if (!guildId) {
          guildId = ctx.request?.headers?.get(GUILD_ID_HEADER) ?? undefined
        }

        const state = await getOAuthState()
        const kimakiClientId = state?.clientId as string | undefined
        const kimakiClientSecret = state?.clientSecret as string | undefined
        if (!kimakiClientId || !kimakiClientSecret) {
          // Not a gateway onboarding flow (regular login), skip silently.
          return
        }

        if (!guildId) {
          return failOnboarding(
            kimakiClientId,
            'Discord did not return guild_id in the callback. Try authorizing again and make sure to select a server.',
          )
        }

        const reachableUrl = state?.reachableUrl as string | undefined

        const userId = ctx.context.newSession?.user?.id
        if (!userId) {
          return failOnboarding(
            kimakiClientId,
            'User session was not created during authorization. Try again.',
          )
        }

        const upsertResult = await upsertGatewayClientAndRefreshKv({
          env,
          clientId: kimakiClientId,
          secret: kimakiClientSecret,
          guildId,
          platform: 'discord',
          userId,
          reachableUrl,
        })
        if (upsertResult instanceof Error) {
          console.error('gateway onboarding upsert failed:', upsertResult)
          return failOnboarding(
            kimakiClientId,
            'Kimaki could not save the bot installation. Please try again.',
          )
        }

        // If the CLI passed a custom callback URL (--gateway-callback-url),
        // redirect there with ?guild_id instead of showing /install-success.
        // The kimakiCallbackUrl was stored in additionalData during /discord-install.
        // Only https: (and http: for localhost dev) are allowed to prevent
        // open redirect / javascript: URI attacks. Invalid URLs fall through
        // to the default /install-success page.
        //
        // Return the Response directly (not wrapped in { response }) because
        // createAuthMiddleware's returnHeaders logic wraps the return value as
        // { headers, response: <return> }. If we returned { response: Response },
        // it would become { response: { response: Response } } and toResponse()
        // would serialize it as JSON instead of issuing a redirect.
        const parsedCallback = parseAllowedCallbackUrl(state?.kimakiCallbackUrl as string | undefined)
        if (parsedCallback) {
          parsedCallback.searchParams.set('guild_id', guildId)
          parsedCallback.searchParams.set('client_id', kimakiClientId)
          // Use new Response() instead of Response.redirect() because redirect()
          // creates an immutable response. better-call's toResponse() calls
          // data.headers.set() to merge headers, which throws on immutable
          // responses and causes a 500.
          return new Response(null, {
            status: 302,
            headers: { Location: parsedCallback.toString() },
          })
        }
      }),
    },
  })

  return auth
}
