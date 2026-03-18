// Configurable Discord API endpoint URLs.
// Base URL for REST calls lives in the centralized zustand store (store.ts),
// replacing the old process.env['DISCORD_REST_BASE_URL'] mutation.
//
// DISCORD_GATEWAY_URL: WebSocket gateway URL (default: undefined, auto-discovered via /gateway/bot)
//   discord.js has no direct ws.gateway option — the gateway URL comes from the
//   GET /gateway/bot REST response. If using a proxy, the proxy's /gateway/bot
//   endpoint should return the desired gateway URL. This constant is provided
//   for non-discord.js consumers (e.g. the Rust gateway-proxy config).

import { REST } from 'discord.js'
import { store } from './store.js'

/**
 * Base URL for Discord (default: https://discord.com).
 * All REST API and raw fetch calls derive their URLs from this.
 * Reads from the centralized store so gateway mode can set it via
 * store.setState({ discordBaseUrl }) after startup.
 */
export function getDiscordRestBaseUrl(): string {
  return store.getState().discordBaseUrl
}

/**
 * The REST api path that discord.js expects (base + /api).
 * discord.js appends /v10/... to this internally.
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
 */
export function createDiscordRest(token: string): REST {
  return new REST({ api: getDiscordRestApiUrl() }).setToken(token)
}

/**
 * Returns the internet-reachable base URL for this kimaki instance.
 * When KIMAKI_INTERNET_REACHABLE_URL is set (e.g. "https://my-kimaki.fly.dev"),
 * kimaki should bind to 0.0.0.0 and route Discord traffic through the local
 * WS+REST proxy on the hrana server.
 * Returns null when not set (kimaki only reachable on localhost).
 */
export function getInternetReachableBaseUrl(): string | null {
  return process.env['KIMAKI_INTERNET_REACHABLE_URL'] || null
}

/**
 * Derive an HTTPS REST base URL from a WebSocket gateway URL.
 * Swaps wss→https and ws→http. Used for gateway mode where the
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
