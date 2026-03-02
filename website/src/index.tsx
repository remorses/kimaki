// Cloudflare Worker entrypoint for the Kimaki website.
// Handles Discord OAuth bot install callback and onboarding status polling.
//
// Uses Hyperdrive for pooled DB connections (env.HYPERDRIVE binding).
// Each request gets a fresh PrismaClient with the Hyperdrive connection string.

import { Hono } from 'hono'
import { renderToString } from 'react-dom/server'
import React from 'react'
import * as errore from 'errore'
import { createPrisma } from 'db/src/prisma.js'
import { decodeGatewayOAuthState } from 'db/src/gateway-state.js'
import { SuccessPage } from './components/success-page.js'
import { exchangeCodeWithDiscord, fetchDiscordUser } from './discord.js'
import type { HonoBindings } from './env.js'

export type { HonoBindings }

const app = new Hono<{ Bindings: HonoBindings }>()

app.get('/', (c) => {
  return c.redirect('https://github.com/remorses/kimaki', 302)
})

app.get('/health', async (c) => {
  const prisma = createPrisma(c.env.HYPERDRIVE.connectionString)
  const result = await prisma.$queryRaw<[{ result: number }]>`SELECT 1 as result`
  return c.json({ status: 'ok', db: result[0].result })
})

// Discord OAuth callback. Discord redirects here after the user authorizes
// the bot with an authorization code. We exchange the code with Discord to
// verify the authorization and get a verified guild_id (not from query params,
// which Discord says can be faked). Then fetch /users/@me to store user data.
app.get('/api/auth/callback/discord', async (c) => {
  const code = c.req.query('code')
  const stateParam = c.req.query('state')

  if (!code || !stateParam) {
    return c.text('Missing code or state parameter', 400)
  }

  // Parse kimaki client credentials from the OAuth state parameter
  const parsed = errore.try({
    try: () => {
      return decodeGatewayOAuthState(stateParam)
    },
    catch: (cause) => {
      return new Error('Failed to decode state', { cause })
    },
  })
  if (parsed instanceof Error) return c.text('Failed to decode state parameter', 400)
  if (!parsed) return c.text('Invalid state parameter format', 400)

  const kimakiCredentials = { clientId: parsed.clientId, secret: parsed.clientSecret }

  // Exchange the code with Discord to get the verified guild_id.
  // This is the critical security step: we don't trust query param guild_id,
  // we get it from Discord's token exchange response instead.
  const redirectUri = `${new URL(c.req.url).origin}/api/auth/callback/discord`

  const exchangeResult = await exchangeCodeWithDiscord({
    code,
    clientId: c.env.DISCORD_CLIENT_ID,
    clientSecret: c.env.DISCORD_CLIENT_SECRET,
    redirectUri,
  })
  if (exchangeResult instanceof Error) {
    return c.text(`Code exchange failed: ${exchangeResult.message}`, 500)
  }

  const { guildId, accessToken } = exchangeResult
  const prisma = createPrisma(c.env.HYPERDRIVE.connectionString)

  // Fetch and store the Discord user profile BEFORE gateway_clients,
  // because gateway_clients has a FK to discord_users.client_id.
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

  // Upsert gateway client with the verified guild_id
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
      return new Error('Failed to upsert gateway client', { cause })
    })
  if (upsertResult instanceof Error) {
    return c.text(`Gateway client upsert failed: ${upsertResult.message}`, 500)
  }

  const html = renderToString(<SuccessPage guildId={guildId} />)
  return c.html(`<!DOCTYPE html>${html}`)
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

  return c.json({ guild_id: row.guild_id })
})

export default app
