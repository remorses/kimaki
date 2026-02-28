// Configurable Discord API endpoint URLs.
// Override via environment variables to point at a self-hosted gateway proxy.
//
// DISCORD_REST_BASE_URL: base URL for Discord REST API calls (default: https://discord.com)
//   Used by both discord.js REST client (which appends /api/v10/...) and raw fetch calls.
//
// DISCORD_GATEWAY_URL: WebSocket gateway URL (default: undefined, auto-discovered via /gateway/bot)
//   discord.js has no direct ws.gateway option — the gateway URL comes from the
//   GET /gateway/bot REST response. If using a proxy, the proxy's /gateway/bot
//   endpoint should return the desired gateway URL. This constant is provided
//   for non-discord.js consumers (e.g. the Rust gateway-proxy config).

import { REST } from 'discord.js'

/**
 * Base URL for Discord (default: https://discord.com).
 * All REST API and raw fetch calls derive their URLs from this.
 */
export const DISCORD_REST_BASE_URL =
  process.env['DISCORD_REST_BASE_URL'] || 'https://discord.com'

/**
 * The REST api path that discord.js expects (base + /api).
 * discord.js appends /v10/... to this internally.
 */
export const DISCORD_REST_API_URL = new URL(
  '/api',
  DISCORD_REST_BASE_URL,
).toString()

/**
 * WebSocket gateway URL override (default: undefined = auto-discover).
 * When undefined, discord.js fetches it from GET /gateway/bot via REST.
 * Provided as a constant for external consumers like the Rust gateway-proxy.
 */
export const DISCORD_GATEWAY_URL =
  process.env['DISCORD_GATEWAY_URL'] || undefined

/**
 * Build a full Discord REST API URL for raw fetch() calls.
 * Uses new URL() for safe path concatenation.
 *
 * Example: discordApiUrl(`/channels/${id}/messages`) →
 *   "https://discord.com/api/v10/channels/123/messages"
 */
export function discordApiUrl(path: string): string {
  return new URL(`/api/v10${path}`, DISCORD_REST_BASE_URL).toString()
}

/**
 * Create a discord.js REST client pointed at the configured base URL.
 * Centralizes the REST instantiation so all call sites use the override.
 */
export function createDiscordRest(token: string): REST {
  return new REST({ api: DISCORD_REST_API_URL }).setToken(token)
}
