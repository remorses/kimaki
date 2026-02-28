export type ResolvedBotToken = {
  token: string
  appId: string | undefined
  source: 'env' | 'db'
}

export type StoredBotToken = { app_id: string; token: string }

type GetBotTokenOptions = {
  appIdOverride?: string
  preferEnv?: boolean
  allowDatabase?: boolean
}

let dbBotToken: StoredBotToken | null = null

// Derive the Discord Application ID from a bot token.
// Discord bot tokens have the format: base64(userId).timestamp.hmac
// The first segment is the bot's user ID (= Application ID) base64-encoded.
export function appIdFromToken(token: string): string | undefined {
  const segment = token.split('.')[0]
  if (!segment) {
    return undefined
  }
  try {
    const decoded = Buffer.from(segment, 'base64').toString('utf8')
    if (/^\d{17,20}$/.test(decoded)) {
      return decoded
    }
    return undefined
  } catch {
    return undefined
  }
}

export function hydrateBotTokenCache(botToken: StoredBotToken | null): void {
  dbBotToken = botToken
}

export function getBotToken(
  options: GetBotTokenOptions = {},
): ResolvedBotToken | undefined {
  const { appIdOverride, preferEnv = true, allowDatabase = true } = options

  const envToken = process.env.KIMAKI_BOT_TOKEN

  if (preferEnv && envToken) {
    return {
      token: envToken,
      appId: appIdOverride || appIdFromToken(envToken),
      source: 'env',
    }
  }

  if (!allowDatabase) {
    return undefined
  }

  const botRow = dbBotToken
  if (!botRow) {
    return undefined
  }

  return {
    token: botRow.token,
    appId: appIdOverride || botRow.app_id,
    source: 'db',
  }
}
