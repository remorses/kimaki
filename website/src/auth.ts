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
import type { HonoBindings } from './env.js'
import { upsertGatewayClientAndRefreshKv } from './gateway-client-kv.js'

// Same permissions list used in discord/src/utils.ts generateBotInstallUrl.
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

export function createAuth({ env, baseURL }: { env: HonoBindings; baseURL: string }) {
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

        const guildId = getGuildIdFromRequestUrl({ context: ctx })
        if (!guildId) {
          console.warn('better-auth callback: missing guild_id callback parameter')
          return
        }

        const state = await getOAuthState()
        const kimakiClientId = state?.clientId as string | undefined
        const kimakiClientSecret = state?.clientSecret as string | undefined
        if (!kimakiClientId || !kimakiClientSecret) {
          console.warn('better-auth callback: no clientId/clientSecret in OAuth state')
          return
        }
        const reachableUrl = state?.reachableUrl as string | undefined

        const userId = ctx.context.newSession?.user?.id
        if (!userId) {
          console.warn('better-auth callback: missing user in new session')
          return
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
          console.error(upsertResult)
          return
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
