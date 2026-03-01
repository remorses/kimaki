// Bun server entrypoint for the Kimaki website.
// Handles OAuth callback, onboarding status polling, and the Discord REST proxy.
// All routes that interact with gateway_clients use the shared db/ Prisma client.

import { Hono } from 'hono'
import { handleOAuthCallback } from './routes/oauth-callback.js'
import { handleOnboardingStatus } from './routes/onboarding-status.js'
import { handleDiscordProxy } from './routes/discord-proxy.js'

const app = new Hono()

// Health check
app.get('/health', (c) => {
  return c.json({ status: 'ok' })
})

// OAuth callback -- Discord redirects here after bot authorization
app.get('/oauth/callback', handleOAuthCallback)

// CLI polling -- kimaki polls this to check if bot install completed
app.get('/api/onboarding/status', handleOnboardingStatus)

// Discord REST reverse proxy -- swaps client_id:secret for real bot token.
// discord.js calls /api/v10/* (since we set rest.api to WEBSITE_URL/api),
// so we serve both /api/v10/* and /discord/v10/* for compatibility.
// Must be registered last since they're catch-all wildcards.
app.all('/api/v10/*', handleDiscordProxy)
app.all('/discord/v10/*', handleDiscordProxy)

const port = parseInt(process.env.PORT || '3000', 10)

export default {
  port,
  fetch: app.fetch,
}

console.log(`Kimaki website listening on port ${port}`)
