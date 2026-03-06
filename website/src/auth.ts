// Per-request better-auth factory for the Cloudflare Worker.
//
// Creates a new betterAuth instance per request because CF Workers cannot
// reuse database connections across requests (Hyperdrive per-request pooling).
//
// The Discord provider is configured with a custom getUserInfo that extracts
// guild_id from the token exchange response (tokens.raw.guild). Discord
// includes guild info when the `bot` scope is used, but better-auth's
// built-in Discord provider ignores it. We capture it in a closure variable
// and read it in the after hook to upsert gateway_clients.
//
// The after hook also reads additionalData (clientId, clientSecret) via
// getOAuthState() — these are the Kimaki CLI gateway credentials passed
// through the OAuth flow via the /start-install route.

// better-auth/minimal excludes kysely (~182 KiB minified) from the bundle.
// Safe because we use the prisma adapter, not direct DB connections.
// See: https://better-auth.com/docs/guides/optimizing-for-performance#bundle-size-optimization
import { betterAuth } from 'better-auth/minimal'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { createAuthMiddleware, getOAuthState } from 'better-auth/api'
import { createPrisma } from 'db/src/prisma.js'
import type { HonoBindings } from './env.js'

// Same permissions list used in discord/src/utils.ts generateBotInstallUrl.
// Hardcoded to avoid importing discord-api-types/v10 barrel which adds ~204 KiB
// to the CF Worker bundle (pulls in gateway, payloads, rest, rpc modules).
// Computed from PermissionFlagsBits: ViewChannel | ManageChannels | SendMessages |
// SendMessagesInThreads | CreatePublicThreads | ManageThreads | ReadMessageHistory |
// AddReactions | ManageMessages | UseExternalEmojis | AttachFiles | Connect | Speak |
// ManageRoles | ManageEvents | CreateEvents
const DISCORD_BOT_PERMISSIONS = 17927465446480

type DiscordTokenRaw = {
  guild?: { id: string; name: string }
  [key: string]: unknown
}

export function createAuth({ env, baseURL }: { env: HonoBindings; baseURL: string }) {
  // Closure variable to bridge guild_id between getUserInfo and the after hook.
  // Safe because getUserInfo and the hook run in the same request on CF Workers.
  let capturedGuildId: string | undefined
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
          // Extract guild_id from the token exchange response.
          // Discord includes { guild: { id, name } } when the `bot` scope is used.
          const raw = token.raw as DiscordTokenRaw | undefined
          capturedGuildId = raw?.guild?.id
          console.log('[auth] getUserInfo called, guild_id:', capturedGuildId, 'raw keys:', raw ? Object.keys(raw) : 'none')

          const accessToken = token.accessToken
          if (!accessToken) {
            console.warn('[auth] getUserInfo: no accessToken')
            return null
          }

          const res = await fetch('https://discord.com/api/v10/users/@me', {
            headers: { Authorization: `Bearer ${accessToken}` },
          })
          if (!res.ok) {
            return null
          }
          const profile = (await res.json()) as {
            id: string
            username: string
            global_name: string | null
            avatar: string | null
            email: string | null
            verified: boolean
          }

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
        // Skip non-callback routes. capturedGuildId is only set during Discord
        // OAuth token exchange (getUserInfo), so it acts as the discriminator
        // instead of matching ctx.path (which is the route pattern "/callback/:id",
        // not the resolved "/callback/discord").
        if (!capturedGuildId) {
          console.warn('better-auth callback: no guild_id captured from token exchange')
          return
        }

        // getOAuthState returns OAuthState which has [key: string]: any
        // for additionalData fields passed during signInSocial.
        const state = await getOAuthState()
        const kimakiClientId = state?.clientId as string | undefined
        const kimakiClientSecret = state?.clientSecret as string | undefined
        if (!kimakiClientId || !kimakiClientSecret) {
          console.warn('better-auth callback: no clientId/clientSecret in OAuth state')
          return
        }

        // Get the user ID from the newly created session.
        const userId = ctx.context.newSession?.user?.id
        if (!userId) {
          console.warn('better-auth callback: no user session created')
          return
        }

        // Upsert gateway_clients with the verified guild_id from Discord
        // and the kimaki CLI credentials from the OAuth state.
        await prisma.gateway_clients
          .upsert({
            where: {
              client_id_guild_id: {
                client_id: kimakiClientId,
                guild_id: capturedGuildId,
              },
            },
            create: {
              client_id: kimakiClientId,
              secret: kimakiClientSecret,
              guild_id: capturedGuildId,
              user_id: userId,
            },
            update: {
              secret: kimakiClientSecret,
              user_id: userId,
            },
          })
          .catch((cause) => {
            console.error('Failed to upsert gateway_clients:', cause)
          })
      }),
    },
  })

  return auth
}
