// Per-request better-auth factory for the Cloudflare Worker.
//
// Creates a new betterAuth instance per request because CF Workers cannot
// reuse database connections across requests (Hyperdrive per-request pooling).
//
// Gateway onboarding persistence is handled in databaseHooks.account.create.after:
// - reads guild_id from Discord callback query params
// - reads clientId/clientSecret from getOAuthState() additionalData
// - upserts gateway_clients for CLI onboarding polling

// better-auth/minimal excludes kysely (~182 KiB minified) from the bundle.
// Safe because we use the prisma adapter, not direct DB connections.
// See: https://better-auth.com/docs/guides/optimizing-for-performance#bundle-size-optimization
import { betterAuth } from 'better-auth/minimal'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { getOAuthState } from 'better-auth/api'
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
    databaseHooks: {
      account: {
        create: {
          after: async (account, context) => {
            if (account.providerId !== 'discord') {
              return
            }
            if (context?.path !== '/callback/:id') {
              return
            }

            const guildId = getGuildIdFromRequestUrl({ context })
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

            await prisma.gateway_clients
              .upsert({
                where: {
                  client_id_guild_id: {
                    client_id: kimakiClientId,
                    guild_id: guildId,
                  },
                },
                create: {
                  client_id: kimakiClientId,
                  secret: kimakiClientSecret,
                  guild_id: guildId,
                  user_id: account.userId,
                },
                update: {
                  secret: kimakiClientSecret,
                  user_id: account.userId,
                },
              })
              .catch((cause) => {
                console.error('Failed to upsert gateway_clients:', cause)
              })
          },
        },
      },
    },
  })

  return auth
}
