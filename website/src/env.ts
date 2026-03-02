// Typed environment variables for the Cloudflare Worker.
// DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET are the shared Kimaki bot's
// OAuth2 credentials, used to exchange authorization codes with Discord
// during the bot install callback flow.

export type HonoBindings = {
  HYPERDRIVE: { connectionString: string }
  DISCORD_CLIENT_ID: string
  DISCORD_CLIENT_SECRET: string
}
