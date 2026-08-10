// Tests xAI OAuth account persistence, deduplication, rotation, and removal.

import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  accountLabel,
  loadXAIAccountStore,
  rememberXAIOAuth,
  removeXAIAccount,
  rotateXAIAccount,
  saveXAIAccountStore,
  extractXAIIdentity,
} from './xai-auth-state.js'
import { authFilePath, shouldRotateAuth } from './oauth-rotation-shared.js'

const firstAccount = {
  type: 'oauth' as const,
  refresh: 'refresh-first',
  access: 'access-first',
  expires: 1,
}

const secondAccount = {
  type: 'oauth' as const,
  refresh: 'refresh-second',
  access: 'access-second',
  expires: 2,
}

let originalXdgDataHome: string | undefined
let tempDir = ''

beforeEach(async () => {
  originalXdgDataHome = process.env.XDG_DATA_HOME
  tempDir = await mkdtemp(path.join(tmpdir(), 'xai-auth-state-'))
  process.env.XDG_DATA_HOME = tempDir
})

afterEach(async () => {
  if (originalXdgDataHome === undefined) {
    delete process.env.XDG_DATA_HOME
  } else {
    process.env.XDG_DATA_HOME = originalXdgDataHome
  }
  await rm(tempDir, { force: true, recursive: true })
})

describe('rememberXAIOAuth', () => {
  test('stores accounts and updates existing entries by refresh token', async () => {
    await rememberXAIOAuth(firstAccount)
    await rememberXAIOAuth({ ...firstAccount, access: 'access-first-new', expires: 3 })

    const store = await loadXAIAccountStore()
    expect(store.activeIndex).toBe(0)
    expect(store.accounts).toHaveLength(1)
    expect(store.accounts[0]).toMatchObject({
      refresh: 'refresh-first',
      access: 'access-first-new',
      expires: 3,
    })
  })

  test('deduplicates new tokens by email or account ID', async () => {
    await rememberXAIOAuth(firstAccount, {
      email: 'user@example.com',
      accountId: 'usr_123',
    })
    await rememberXAIOAuth(secondAccount, {
      email: 'User@example.com',
      accountId: 'usr_123',
    })

    const store = await loadXAIAccountStore()
    expect(store.accounts).toHaveLength(1)
    expect(store.accounts[0]).toMatchObject({
      refresh: 'refresh-second',
      access: 'access-second',
      email: 'user@example.com',
      accountId: 'usr_123',
    })
    expect(accountLabel(store.accounts[0]!)).toBe('user@example.com')
  })
})

describe('rotateXAIAccount', () => {
  test('rotates to the next stored account and syncs auth state', async () => {
    await saveXAIAccountStore({
      version: 1,
      activeIndex: 0,
      accounts: [
        { ...firstAccount, addedAt: 1, lastUsed: 1 },
        { ...secondAccount, addedAt: 2, lastUsed: 2 },
      ],
    })

    const authSetCalls: unknown[] = []
    const client = {
      auth: {
        set: async (input: unknown) => {
          authSetCalls.push(input)
        },
      },
    }

    const rotated = await rotateXAIAccount(firstAccount, client as never)
    const store = await loadXAIAccountStore()
    const authJson = JSON.parse(await readFile(authFilePath(), 'utf8')) as {
      xai?: { refresh?: string }
    }

    expect(rotated).toMatchObject({
      auth: { refresh: 'refresh-second' },
      fromLabel: '#1 (refresh-...irst)',
      toLabel: '#2 (refresh-...cond)',
      fromIndex: 0,
      toIndex: 1,
    })
    expect(store.activeIndex).toBe(1)
    expect(authJson.xai?.refresh).toBe('refresh-second')
    expect(authSetCalls).toEqual([
      {
        providerID: 'xai',
        auth: {
          type: 'oauth',
          refresh: 'refresh-second',
          access: 'access-second',
          expires: 2,
        },
      },
    ])
  })
})

describe('removeXAIAccount', () => {
  test('removing the active account promotes the next stored account', async () => {
    await saveXAIAccountStore({
      version: 1,
      activeIndex: 1,
      accounts: [
        { ...firstAccount, addedAt: 1, lastUsed: 1 },
        { ...secondAccount, addedAt: 2, lastUsed: 2 },
      ],
    })

    await removeXAIAccount(1)

    const store = await loadXAIAccountStore()
    const authJson = JSON.parse(await readFile(authFilePath(), 'utf8')) as {
      xai?: { refresh?: string }
    }

    expect(store.activeIndex).toBe(0)
    expect(store.accounts).toHaveLength(1)
    expect(store.accounts[0]?.refresh).toBe('refresh-first')
    expect(authJson.xai?.refresh).toBe('refresh-first')
  })

  test('removing the last account clears active xAI auth', async () => {
    await saveXAIAccountStore({
      version: 1,
      activeIndex: 0,
      accounts: [{ ...firstAccount, addedAt: 1, lastUsed: 1 }],
    })
    await mkdir(path.dirname(authFilePath()), { recursive: true })
    await writeFile(authFilePath(), JSON.stringify({ xai: firstAccount }, null, 2))

    await removeXAIAccount(0)

    const store = await loadXAIAccountStore()
    const authJson = JSON.parse(await readFile(authFilePath(), 'utf8')) as {
      xai?: unknown
    }

    expect(store.accounts).toHaveLength(0)
    expect(authJson.xai).toBeUndefined()
  })
})

describe('extractXAIIdentity', () => {
  test('extracts email and sub from JWT access token', () => {
    // Build a fake JWT with email and sub claims
    const payload = { email: 'grok@x.ai', sub: 'user_abc123' }
    const fakeJwt = `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`
    const identity = extractXAIIdentity({
      type: 'oauth',
      refresh: 'r',
      access: fakeJwt,
      expires: 0,
    })
    expect(identity).toEqual({ email: 'grok@x.ai', accountId: 'user_abc123' })
  })

  test('falls back to direct fields when JWT decode fails', () => {
    const identity = extractXAIIdentity({
      type: 'oauth',
      refresh: 'r',
      access: 'not-a-jwt',
      expires: 0,
      email: 'fallback@x.ai',
      accountId: 'fb_123',
    })
    expect(identity).toEqual({ email: 'fallback@x.ai', accountId: 'fb_123' })
  })
})

describe('shouldRotateAuth with xAI errors', () => {
  test('rotates on 402 Payment Required (balance exhausted)', () => {
    expect(shouldRotateAuth(402, 'Grok Build usage balance exhausted')).toBe(true)
  })

  test('rotates on 429 rate limit', () => {
    expect(shouldRotateAuth(429, '')).toBe(true)
  })

  test('rotates on balance exhausted text regardless of status', () => {
    expect(shouldRotateAuth(200, 'balance exhausted')).toBe(true)
  })

  test('does not rotate on normal 400 errors', () => {
    expect(shouldRotateAuth(400, 'bad request')).toBe(false)
  })
})
