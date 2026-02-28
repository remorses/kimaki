import { afterEach, describe, expect, test } from 'vitest'
import {
  appIdFromToken,
  getBotToken,
  hydrateBotTokenCache,
} from './bot-token.js'

const ORIGINAL_BOT_TOKEN = process.env.KIMAKI_BOT_TOKEN

afterEach(() => {
  process.env.KIMAKI_BOT_TOKEN = ORIGINAL_BOT_TOKEN
  hydrateBotTokenCache(null)
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
})
