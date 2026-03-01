// Cloudflare Worker entrypoint for the Kimaki website.
// Handles OAuth callback and onboarding status polling.
// All routes that interact with gateway_clients use the shared db/ Prisma client.
//
// With nodejs_compat + compatibility_date >= 2025-04-01, CF Workers automatically
// populate process.env with secrets and env vars. No manual bridging needed.

import { Hono } from 'hono'
import { prisma } from 'db/src/prisma.js'
import { handleOAuthCallback } from './routes/oauth-callback.js'
import { handleOnboardingStatus } from './routes/onboarding-status.js'

const app = new Hono()

// Root -- redirect to GitHub
app.get('/', (c) => {
  return c.redirect('https://github.com/remorses/kimaki', 302)
})

// Health check with DB ping
app.get('/health', async (c) => {
  const result = await prisma.$queryRaw<[{ result: number }]>`SELECT 1 as result`
  return c.json({ status: 'ok', db: result[0].result })
})

// OAuth callback -- Discord redirects here after bot authorization
app.get('/oauth/callback', handleOAuthCallback)

// CLI polling -- kimaki polls this to check if bot install completed
app.get('/api/onboarding/status', handleOnboardingStatus)

export default app
