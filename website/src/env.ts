// Typed environment variables for the Cloudflare Worker.
// DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET are the shared Kimaki bot's
// OAuth2 credentials, used by better-auth's Discord provider.
// AUTH_SECRET is the secret key for better-auth session encryption.

import type { SlackBridgeDO } from './slack-bridge-do.js'


export type Env = {
  HYPERDRIVE: { connectionString: string }
  GATEWAY_CLIENT_KV: KVNamespace
  /** Workers AI binding used by /api/transcribe (free Whisper for gateway-mode CLI users). */
  AI: Ai
  /** Per-client_id burst limiter for /api/transcribe. */
  TRANSCRIBE_RATE_LIMITER: RateLimit
  DISCORD_CLIENT_ID: string
  DISCORD_CLIENT_SECRET: string
  SLACK_CLIENT_ID: string
  SLACK_CLIENT_SECRET: string
  AUTH_SECRET: string
  SLACK_BOT_TOKEN: string
  SLACK_SIGNING_SECRET: string
  SLACK_WORKSPACE_ID: string
  SLACK_GATEWAY: DurableObjectNamespace<SlackBridgeDO>
  /** Strada project id for error tracking (optional in local dev). */
  STRADA_PROJECT_ID?: string
  /** Strada org-wide ingest token (server only, optional in local dev). */
  STRADA_TOKEN?: string
  /** deployment environment label for Strada (development/preview/production). */
  ENVIRONMENT?: string
}
