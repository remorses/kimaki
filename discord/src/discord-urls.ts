// Configurable Discord API endpoint URLs.
// Override via environment variables to point at a self-hosted gateway proxy.
//
// DISCORD_REST_BASE_URL: base URL for Discord REST API calls (default: https://discord.com)
//   Used by both discord.js REST client (which appends /api/v10/...) and raw fetch calls.
//   Read lazily from process.env so that built-in bot mode can set the env var
//   after module import but before createDiscordClient() is called.
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
 * Read lazily so built-in mode can set DISCORD_REST_BASE_URL after import.
 */
export function getDiscordRestBaseUrl(): string {
  return process.env['DISCORD_REST_BASE_URL'] || 'https://discord.com'
}

/**
 * The REST api path that discord.js expects (base + /api).
 * discord.js appends /v10/... to this internally.
 * Reads env var lazily for built-in mode support.
 */
export function getDiscordRestApiUrl(): string {
  return new URL('/api', getDiscordRestBaseUrl()).toString()
}

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
 * Reads base URL lazily for built-in mode support.
 *
 * Example: discordApiUrl(`/channels/${id}/messages`) →
 *   "https://discord.com/api/v10/channels/123/messages"
 */
export function discordApiUrl(path: string): string {
  return new URL(`/api/v10${path}`, getDiscordRestBaseUrl()).toString()
}

/**
 * Create a discord.js REST client pointed at the configured base URL.
 * Centralizes the REST instantiation so all call sites use the override.
 * Reads URL lazily for built-in mode support.
 */
export function createDiscordRest(token: string): REST {
  return new REST({ api: getDiscordRestApiUrl() }).setToken(token)
}

/**
 * Derive an HTTPS REST base URL from a WebSocket gateway URL.
 * Swaps wss→https and ws→http. Used for built-in mode where the
 * gateway proxy URL doubles as the REST proxy base.
 */
export function getGatewayProxyRestBaseUrl({ gatewayUrl }: { gatewayUrl: string }): string {
  try {
    const parsedUrl = new URL(gatewayUrl)
    if (parsedUrl.protocol === 'wss:') {
      parsedUrl.protocol = 'https:'
    } else if (parsedUrl.protocol === 'ws:') {
      parsedUrl.protocol = 'http:'
    }
    return parsedUrl.toString()
  } catch {
    return gatewayUrl
  }
}

/**
 * Set DISCORD_REST_BASE_URL env var so all REST calls route through
 * the gateway proxy. Called in built-in bot mode paths.
 */
export function enableBuiltInModeRouting({ restBaseUrl }: { restBaseUrl: string }): void {
  process.env['DISCORD_REST_BASE_URL'] = restBaseUrl
}
