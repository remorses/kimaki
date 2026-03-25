// Typed environment variables for the Cloudflare Worker.
// DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET are the shared Kimaki bot's
// OAuth2 credentials, used by better-auth's Discord provider.
// AUTH_SECRET is the secret key for better-auth session encryption.

import type { SlackBridgeDO } from './slack-bridge-do.js'


export type Env = {
  HYPERDRIVE: { connectionString: string }
  GATEWAY_CLIENT_KV: KVNamespace
  DISCORD_CLIENT_ID: string
  DISCORD_CLIENT_SECRET: string
  SLACK_CLIENT_ID: string
  SLACK_CLIENT_SECRET: string
  AUTH_SECRET: string
  SLACK_BOT_TOKEN: string
  SLACK_SIGNING_SECRET: string
  SLACK_WORKSPACE_ID: string
  SLACK_GATEWAY: DurableObjectNamespace<SlackBridgeDO>
}
