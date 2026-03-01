// Bun server entrypoint for the Kimaki website.
// Handles OAuth callback and onboarding status polling.
// All routes that interact with gateway_clients use the shared db/ Prisma client.

import { Hono } from 'hono'
import { handleOAuthCallback } from './routes/oauth-callback.js'
import { handleOnboardingStatus } from './routes/onboarding-status.js'

const app = new Hono()

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok' })
})

// OAuth callback -- Discord redirects here after bot authorization
app.get('/oauth/callback', handleOAuthCallback)

// CLI polling -- kimaki polls this to check if bot install completed
app.get('/api/onboarding/status', handleOnboardingStatus)

const port = parseInt(process.env.PORT || '3000', 10)

export default {
  port,
  fetch: app.fetch,
}

console.log(`Kimaki website listening on port ${port}`)
