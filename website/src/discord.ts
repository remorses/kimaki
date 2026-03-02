// Discord OAuth2 API utilities for the bot install flow.
// exchangeCodeWithDiscord: exchanges an authorization code for a verified guild_id.
// fetchDiscordUser: fetches the authorizing user's profile with their access token.

import * as errore from 'errore'

export class DiscordCodeExchangeError extends errore.createTaggedError({
  name: 'DiscordCodeExchangeError',
  message: 'Failed to exchange authorization code with Discord: $reason',
}) {}

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
export type DiscordUser = {
  id: string
  username: string
  global_name: string | null
  avatar: string | null
  email: string | null
  verified: boolean
}

// Exchange the authorization code with Discord's token endpoint.
// Returns the verified guild_id and access_token from Discord's response.
// Discord docs: https://discord.com/developers/docs/topics/oauth2#authorization-code-grant
export async function exchangeCodeWithDiscord({
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
export async function fetchDiscordUser({
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
