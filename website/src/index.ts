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
app.get('/start-install', async (c) => {
  const clientId = c.req.query('clientId')
  const clientSecret = c.req.query('clientSecret')

  if (!clientId || !clientSecret) {
    return c.text('Missing clientId or clientSecret', 400)
  }

  const baseURL = new URL(c.req.url).origin
  const auth = createAuth({ env: c.env, baseURL })

  // signInSocial returns { url, redirect } JSON with a Location header, but
  // status 200 — browsers ignore Location on non-3xx responses. We need to:
  // 1. Call with asResponse to get the Set-Cookie headers (OAuth state cookie)
  // 2. Build a real 302 redirect that carries those cookies
  const response = await auth.api.signInSocial({
    body: {
      provider: 'discord',
      additionalData: { clientId, clientSecret },
      callbackURL: '/install-success',
    },
    headers: c.req.raw.headers,
    asResponse: true,
  })

  const redirectUrl = response.headers.get('Location')
  if (!redirectUrl) {
    // Fallback: parse URL from JSON body
    const body = await response.json() as { url?: string }
    if (!body.url) {
      return c.text('Failed to get Discord OAuth URL', 500)
    }
    return c.redirect(body.url, 302)
  }

  // Build a 302 redirect preserving Set-Cookie headers from better-auth
  const redirect = new Response(null, {
    status: 302,
    headers: { Location: redirectUrl },
  })
  for (const cookie of response.headers.getSetCookie()) {
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
