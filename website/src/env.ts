// Typed environment variables for the Cloudflare Worker.
// DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET are the shared Kimaki bot's
// OAuth2 credentials, used by better-auth's Discord provider.
// AUTH_SECRET is the secret key for better-auth session encryption.

export type HonoBindings = {
  HYPERDRIVE: { connectionString: string }
  DISCORD_CLIENT_ID: string
  DISCORD_CLIENT_SECRET: string
  AUTH_SECRET: string
}
