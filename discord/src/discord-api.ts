import { REST } from 'discord.js'

const DISCORD_API_BASE_URL = 'https://discord.com/api'

function normalizeApiBaseUrl(rawValue: string | undefined): string {
  const trimmed = rawValue?.trim()
  if (!trimmed) {
    return DISCORD_API_BASE_URL
  }

  const withoutTrailingSlash = trimmed.replace(/\/+$/, '')
  if (withoutTrailingSlash.endsWith('/api')) {
    return withoutTrailingSlash
  }

  return `${withoutTrailingSlash}/api`
}

export function getDiscordApiBaseUrl(): string {
  return normalizeApiBaseUrl(process.env.KIMAKI_DISCORD_HTTP_URL)
}

export function getDiscordApiV10BaseUrl(): string {
  return `${getDiscordApiBaseUrl()}/v10`
}

export function createDiscordRest(token?: string): REST {
  const rest = new REST({
    api: getDiscordApiBaseUrl(),
  })
  if (token) {
    rest.setToken(token)
  }
  return rest
}
