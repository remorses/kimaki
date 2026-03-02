// GET /api/auth/callback/discord -- OAuth completion handler.
// Discord redirects here after the user authorizes the bot with an authorization
// code. We exchange the code with Discord's token endpoint to verify the
// authorization is real and get the verified guild_id from Discord's response.
// Then we fetch the user's profile from /users/@me to store their Discord data.
// This prevents forged callbacks where an attacker could supply a fake guild_id.

import type { Context } from 'hono'
import { renderToString } from 'react-dom/server'
import React from 'react'
import * as errore from 'errore'
import { createPrisma } from 'db/src/prisma.js'
import { decodeGatewayOAuthState } from 'db/src/gateway-state.js'
import { SuccessPage } from '../components/success-page.js'
import {
  DiscordCodeExchangeError,
  GatewayClientUpsertError,
  InvalidStateFormatError,
  StateDecodeError,
} from '../errors.js'
import type { HonoBindings } from '../env.js'

// Discord token exchange response shape when bot scope is used.
// The guild object contains the verified guild the bot was added to.
type DiscordTokenResponse = {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token: string
  scope: string
  guild: {
    id: string
    name: string
  }
}

// Discord /users/@me response shape with identify + email scopes.
type DiscordUser = {
  id: string
  username: string
  global_name: string | null
  avatar: string | null
  email: string | null
  verified: boolean
}

function parseCredentialsFromState({ stateParam }: { stateParam: string }) {
  const parsed = errore.try({
    try: () => {
      return decodeGatewayOAuthState(stateParam)
    },
    catch: (cause) => {
      return new StateDecodeError({ cause })
    },
  })
  if (parsed instanceof Error) return parsed

  if (!parsed) return new InvalidStateFormatError()

  return { clientId: parsed.clientId, secret: parsed.clientSecret }
}

// Exchange the authorization code with Discord's token endpoint.
// Returns the verified guild_id and access_token from Discord's response.
// Discord docs: https://discord.com/developers/docs/topics/oauth2#authorization-code-grant
async function exchangeCodeWithDiscord({
  code,
  clientId,
  clientSecret,
  redirectUri,
}: {
  code: string
  clientId: string
  clientSecret: string
  redirectUri: string
}) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  })

  // Discord requires HTTP Basic auth with client_id:client_secret
  const credentials = btoa(`${clientId}:${clientSecret}`)

  const response = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${credentials}`,
    },
    body: body.toString(),
  }).catch((cause) => {
    return new DiscordCodeExchangeError({ reason: 'network error', cause })
  })
  if (response instanceof Error) return response

  if (!response.ok) {
    const text = await response.text().catch(() => 'unknown')
    return new DiscordCodeExchangeError({
      reason: `HTTP ${response.status}: ${text}`,
    })
  }

  const data = (await response.json()) as DiscordTokenResponse

  if (!data.guild?.id) {
    return new DiscordCodeExchangeError({
      reason: 'response missing guild.id',
    })
  }

  return { guildId: data.guild.id, accessToken: data.access_token }
}

// Fetch the authorizing user's profile from Discord using their access token.
// Requires identify + email scopes granted during the OAuth flow.
async function fetchDiscordUser({
  accessToken,
}: {
  accessToken: string
}) {
  const response = await fetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  }).catch((cause) => {
    return new DiscordCodeExchangeError({
      reason: 'failed to fetch user profile',
      cause,
    })
  })
  if (response instanceof Error) return response

  if (!response.ok) {
    return new DiscordCodeExchangeError({
      reason: `user profile fetch HTTP ${response.status}`,
    })
  }

  const user = (await response.json()) as DiscordUser
  if (!user.id) {
    return new DiscordCodeExchangeError({
      reason: 'user profile response missing id',
    })
  }

  return user
}

export async function handleOAuthCallback(
  c: Context<{ Bindings: HonoBindings }>,
) {
  const code = c.req.query('code')
  const stateParam = c.req.query('state')

  if (!code || !stateParam) {
    return c.text('Missing code or state parameter', 400)
  }

  const kimakiCredentials = parseCredentialsFromState({ stateParam })
  if (kimakiCredentials instanceof Error) {
    if (StateDecodeError.is(kimakiCredentials)) {
      return c.text('Failed to decode state parameter', 400)
    }
    if (InvalidStateFormatError.is(kimakiCredentials)) {
      return c.text('Invalid state parameter format', 400)
    }
    return c.text('Internal server error', 500)
  }

  // Exchange the code with Discord to get the verified guild_id.
  // This is the critical security step: we don't trust query param guild_id,
  // we get it from Discord's token exchange response instead.
  const callbackUrl = new URL(c.req.url)
  const redirectUri = `${callbackUrl.origin}/api/auth/callback/discord`

  const exchangeResult = await exchangeCodeWithDiscord({
    code,
    clientId: c.env.DISCORD_CLIENT_ID,
    clientSecret: c.env.DISCORD_CLIENT_SECRET,
    redirectUri,
  })
  if (exchangeResult instanceof Error) {
    console.error('Discord code exchange failed:', exchangeResult.message)
    return c.text('Failed to verify authorization with Discord', 500)
  }

  const { guildId, accessToken } = exchangeResult

  const prisma = createPrisma(c.env.HYPERDRIVE.connectionString)

  const upsertResult = await prisma.gateway_clients
    .upsert({
      where: {
        client_id_guild_id: {
          client_id: kimakiCredentials.clientId,
          guild_id: guildId,
        },
      },
      create: {
        client_id: kimakiCredentials.clientId,
        secret: kimakiCredentials.secret,
        guild_id: guildId,
      },
      update: { secret: kimakiCredentials.secret },
    })
    .catch((cause) => {
      return new GatewayClientUpsertError({
        clientId: kimakiCredentials.clientId,
        guildId,
        cause,
      })
    })
  if (upsertResult instanceof Error) {
    return c.text('Internal server error', 500)
  }

  // Fetch and store the Discord user profile.
  // If this fails we still complete the flow -- user data is nice-to-have.
  const discordUser = await fetchDiscordUser({ accessToken })
  if (discordUser instanceof Error) {
    console.warn('Failed to fetch Discord user profile:', discordUser.message)
  } else {
    await prisma.discord_users
      .upsert({
        where: { discord_id: discordUser.id },
        create: {
          discord_id: discordUser.id,
          client_id: kimakiCredentials.clientId,
          username: discordUser.username,
          global_name: discordUser.global_name,
          avatar: discordUser.avatar,
          email: discordUser.email,
          email_verified: discordUser.verified ?? false,
        },
        update: {
          client_id: kimakiCredentials.clientId,
          username: discordUser.username,
          global_name: discordUser.global_name,
          avatar: discordUser.avatar,
          email: discordUser.email,
          email_verified: discordUser.verified ?? false,
          updated_at: new Date(),
        },
      })
      .catch((cause) => {
        console.error('Failed to upsert discord user:', cause)
      })
  }

  const html = renderToString(<SuccessPage guildId={guildId} />)
  return c.html(`<!DOCTYPE html>${html}`)
}
