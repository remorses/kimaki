import crypto from 'node:crypto'
import { afterAll, beforeEach, describe, expect, test } from 'vitest'
import {
  appIdFromToken,
  getBotToken,
  hydrateBotTokenCache,
  isAuthModeEnabled,
} from './bot-token.js'

const ORIGINAL_BOT_TOKEN = process.env.KIMAKI_BOT_TOKEN
const ORIGINAL_GUILD_ID = process.env.KIMAKI_GUILD_ID
const ORIGINAL_PRIVATE_KEY = process.env.KIMAKI_PRIVATE_KEY
const ORIGINAL_APP_ID = process.env.KIMAKI_APP_ID

beforeEach(() => {
  delete process.env.KIMAKI_BOT_TOKEN
  delete process.env.KIMAKI_GUILD_ID
  delete process.env.KIMAKI_PRIVATE_KEY
  delete process.env.KIMAKI_APP_ID
  hydrateBotTokenCache(null)
})

afterAll(() => {
  process.env.KIMAKI_BOT_TOKEN = ORIGINAL_BOT_TOKEN
  process.env.KIMAKI_GUILD_ID = ORIGINAL_GUILD_ID
  process.env.KIMAKI_PRIVATE_KEY = ORIGINAL_PRIVATE_KEY
  process.env.KIMAKI_APP_ID = ORIGINAL_APP_ID
})

describe('appIdFromToken', () => {
  test('derives app id from valid token format', () => {
    const token = 'MTQ3Njc0NTc2MzAwOTU5MzM2NQ.anything.anything'
    expect(appIdFromToken(token)).toBe('1476745763009593365')
  })

  test('returns undefined for malformed tokens', () => {
    expect(appIdFromToken('not-a-token')).toBeUndefined()
    expect(appIdFromToken('')).toBeUndefined()
  })
})

describe('getBotToken', () => {
  test('prefers env token over db by default', () => {
    process.env.KIMAKI_BOT_TOKEN =
      'MTQ3Njc0NTc2MzAwOTU5MzM2NQ.env.payload'
    hydrateBotTokenCache({ app_id: 'db-app', token: 'db-token' })

    const resolved = getBotToken()

    expect(resolved).toEqual({
      token: 'MTQ3Njc0NTc2MzAwOTU5MzM2NQ.env.payload',
      appId: '1476745763009593365',
      source: 'env',
    })
  })

  test('uses db token when env is absent', () => {
    delete process.env.KIMAKI_BOT_TOKEN
    hydrateBotTokenCache({
      app_id: '1476745763009593365',
      token: 'db-token',
    })

    const resolved = getBotToken()

    expect(resolved).toEqual({
      token: 'db-token',
      appId: '1476745763009593365',
      source: 'db',
    })
  })

  test('supports db-only lookup when preferEnv is false', () => {
    process.env.KIMAKI_BOT_TOKEN = 'env-token'
    hydrateBotTokenCache({
      app_id: '1476745763009593365',
      token: 'db-token',
    })

    const resolved = getBotToken({ preferEnv: false })

    expect(resolved).toEqual({
      token: 'db-token',
      appId: '1476745763009593365',
      source: 'db',
    })
  })

  test('can skip db lookup entirely', () => {
    delete process.env.KIMAKI_BOT_TOKEN
    hydrateBotTokenCache({ app_id: 'x', token: 'y' })

    const resolved = getBotToken({ allowDatabase: false })

    expect(resolved).toBeUndefined()
  })

  test('applies appId override consistently', () => {
    process.env.KIMAKI_BOT_TOKEN = 'env-token'
    const fromEnv = getBotToken({
      appIdOverride: 'override-app-id',
      allowDatabase: false,
    })
    expect(fromEnv?.appId).toBe('override-app-id')

    delete process.env.KIMAKI_BOT_TOKEN
    hydrateBotTokenCache({
      app_id: 'db-app',
      token: 'db-token',
    })
    const fromDb = getBotToken({
      appIdOverride: 'override-app-id',
    })
    expect(fromDb?.appId).toBe('override-app-id')
  })

  test('auth mode takes precedence over env and db token', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
    process.env.KIMAKI_GUILD_ID = '1477130736841658398'
    process.env.KIMAKI_APP_ID = '1476745763009593365'
    process.env.KIMAKI_PRIVATE_KEY = privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString()
    process.env.KIMAKI_BOT_TOKEN = 'env-token'
    hydrateBotTokenCache({
      app_id: 'db-app',
      token: 'db-token',
    })

    const resolved = getBotToken()

    expect(isAuthModeEnabled()).toBe(true)
    expect(resolved?.source).toBe('auth')
    expect(resolved?.appId).toBe('1476745763009593365')
    expect(resolved?.token.split('.')).toHaveLength(3)

    const tokenParts = resolved!.token.split('.')
    expect(tokenParts).toHaveLength(3)
    const guildPart = tokenParts[0]!
    const timestamp = tokenParts[1]!
    const signaturePart = tokenParts[2]!
    const decodedGuildId = Buffer.from(guildPart, 'base64').toString('utf8')
    expect(decodedGuildId).toBe('1477130736841658398')
    expect(Number.isNaN(Number.parseInt(timestamp, 10))).toBe(false)

    const signature = Buffer.from(signaturePart, 'base64url')
    const verified = crypto.verify(
      null,
      Buffer.from(`${decodedGuildId}\n${timestamp}`, 'utf8'),
      publicKey,
      signature,
    )
    expect(verified).toBe(true)
  })

  test('auth mode requires all env vars', () => {
    process.env.KIMAKI_GUILD_ID = '1477130736841658398'
    delete process.env.KIMAKI_PRIVATE_KEY
    process.env.KIMAKI_APP_ID = '1476745763009593365'
    process.env.KIMAKI_BOT_TOKEN = 'env-token'

    const resolved = getBotToken()

    expect(isAuthModeEnabled()).toBe(false)
    expect(resolved).toEqual({
      token: 'env-token',
      appId: undefined,
      source: 'env',
    })
  })
})
