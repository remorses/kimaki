// Cloudflare Worker entrypoint for the Kimaki website.
// Handles OAuth callback and onboarding status polling.
//
// Uses Hyperdrive for pooled DB connections (env.HYPERDRIVE binding).
// Each request gets a fresh PrismaClient with the Hyperdrive connection string.

import { Hono } from 'hono'
import { createPrisma } from 'db/src/prisma.js'
import { handleOAuthCallback } from './routes/oauth-callback.js'
import { handleOnboardingStatus } from './routes/onboarding-status.js'
import type { HonoBindings } from './env.js'

export type { HonoBindings }

const app = new Hono<{ Bindings: HonoBindings }>()

// Root -- redirect to GitHub
app.get('/', (c) => {
  return c.redirect('https://github.com/remorses/kimaki', 302)
})

// Health check with DB ping
app.get('/health', async (c) => {
  const prisma = createPrisma(c.env.HYPERDRIVE.connectionString)
  const result = await prisma.$queryRaw<[{ result: number }]>`SELECT 1 as result`
  return c.json({ status: 'ok', db: result[0].result })
})

// OAuth callback -- Discord redirects here after bot authorization
app.get('/api/auth/callback/discord', handleOAuthCallback)

// CLI polling -- kimaki polls this to check if bot install completed
app.get('/api/onboarding/status', handleOnboardingStatus)

export default app
