// Cloudflare Worker entrypoint for the Kimaki website.
// Handles Discord OAuth bot install via better-auth and onboarding status polling.
//
// Uses Hyperdrive for pooled DB connections (env.HYPERDRIVE binding).
// Each request gets a fresh PrismaClient and betterAuth instance
// because CF Workers cannot reuse connections across requests.

import { Hono } from 'hono'
import { createPrisma } from 'db/src/prisma.js'
import { createAuth } from './auth.js'
import { renderSuccessPage } from './components/success-page.js'
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

// Initiates the Discord bot install flow via better-auth.
// The CLI opens the browser to this URL with clientId and clientSecret
// as query params. We call better-auth's signInSocial server-side with
// these as additionalData, which stores them in the verification table
// and generates a Discord OAuth URL. The browser is redirected to Discord.
app.get('/discord-install', async (c) => {
  const clientId = c.req.query('clientId')
  const clientSecret = c.req.query('clientSecret')

  if (!clientId || !clientSecret) {
    return c.text('Missing clientId or clientSecret', 400)
  }

  const baseURL = new URL(c.req.url).origin
  const auth = createAuth({ env: c.env, baseURL })

  // signInSocial returns JSON data on server calls; use returnHeaders so we can
  // forward Set-Cookie and still issue a real browser redirect.
  const { response: result, headers } = await auth.api.signInSocial({
    body: {
      provider: 'discord',
      additionalData: { clientId, clientSecret },
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
