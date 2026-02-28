import crypto from 'node:crypto'

export type ResolvedBotToken = {
  token: string
  appId: string | undefined
  source: 'auth' | 'env' | 'db'
}

export type StoredBotToken = { app_id: string; token: string }

type GetBotTokenOptions = {
  appIdOverride?: string
  preferEnv?: boolean
  allowDatabase?: boolean
}

let dbBotToken: StoredBotToken | null = null

type AuthModeConfig = {
  guildId: string
  privateKey: string
  appId: string
}

function toBase64(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4)
  return `${normalized}${padding}`
}

function resolveAuthModeConfig(): AuthModeConfig | null {
  const guildId = process.env.KIMAKI_GUILD_ID?.trim()
  const privateKey = process.env.KIMAKI_PRIVATE_KEY?.trim()
  const appId = process.env.KIMAKI_APP_ID?.trim()
  if (!guildId || !privateKey || !appId) {
    return null
  }
  return {
    guildId,
    privateKey,
    appId,
  }
}

function parsePrivateKey(privateKeyValue: string): crypto.KeyObject {
  if (privateKeyValue.includes('BEGIN PRIVATE KEY')) {
    return crypto.createPrivateKey(privateKeyValue)
  }

  const candidates: Array<{ key: Buffer; format: 'der'; type: 'pkcs8' }> = []

  try {
    candidates.push({
      key: Buffer.from(toBase64(privateKeyValue), 'base64'),
      format: 'der',
      type: 'pkcs8',
    })
  } catch {
    // Ignore and continue to hex fallback.
  }

  try {
    candidates.push({
      key: Buffer.from(privateKeyValue, 'hex'),
      format: 'der',
      type: 'pkcs8',
    })
  } catch {
    // Ignore and continue.
  }

  for (const candidate of candidates) {
    try {
      return crypto.createPrivateKey(candidate)
    } catch {
      // Try next candidate.
    }
  }

  throw new Error('Invalid KIMAKI_PRIVATE_KEY for auth mode')
}

function createAuthModeToken(config: AuthModeConfig): string {
  const timestamp = Date.now()
  const key = parsePrivateKey(config.privateKey)
  const message = `${config.guildId}\n${timestamp}`
  const signature = crypto
    .sign(null, Buffer.from(message, 'utf8'), key)
    .toString('base64url')
  const guildPart = Buffer.from(config.guildId, 'utf8').toString('base64')
  return `${guildPart}.${timestamp}.${signature}`
}

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

export function isAuthModeEnabled(): boolean {
  return resolveAuthModeConfig() !== null
}

export function getBotToken(
  options: GetBotTokenOptions = {},
): ResolvedBotToken | undefined {
  const { appIdOverride, preferEnv = true, allowDatabase = true } = options
  const authMode = resolveAuthModeConfig()

  if (authMode) {
    return {
      token: createAuthModeToken(authMode),
      appId: appIdOverride || authMode.appId,
      source: 'auth',
    }
  }

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
