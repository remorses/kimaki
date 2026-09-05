// Tests Anthropic OAuth account persistence, deduplication, rotation, and
// permanent refresh-failure removal.

import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  accountLabel,
  authFilePath,
  isPermanentOAuthRefreshFailure,
  loadAccountStore,
  rememberAnthropicOAuth,
  removeAccount,
  removeAccountByAuth,
  rotateAnthropicAccount,
  saveAccountStore,
  shouldRotateAuth,
} from './anthropic-auth-state.js'

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
  tempDir = await mkdtemp(path.join(tmpdir(), 'anthropic-auth-plugin-'))
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

describe('rememberAnthropicOAuth', () => {
  test('stores accounts and updates existing entries by refresh token', async () => {
    await rememberAnthropicOAuth(firstAccount)
    await rememberAnthropicOAuth({ ...firstAccount, access: 'access-first-new', expires: 3 })

    const store = await loadAccountStore()
    expect(store.activeIndex).toBe(0)
    expect(store.accounts).toHaveLength(1)
    expect(store.accounts[0]).toMatchObject({
      refresh: 'refresh-first',
      access: 'access-first-new',
      expires: 3,
    })
  })

  test('deduplicates new tokens by email or account ID', async () => {
    await rememberAnthropicOAuth(firstAccount, {
      email: 'user@example.com',
      accountId: 'usr_123',
    })
    await rememberAnthropicOAuth(secondAccount, {
      email: 'User@example.com',
      accountId: 'usr_123',
    })

    const store = await loadAccountStore()
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

describe('rotateAnthropicAccount', () => {
  test('rotates to the next stored account and syncs auth state', async () => {
    await saveAccountStore({
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

    const rotated = await rotateAnthropicAccount(firstAccount, client as never)
    const store = await loadAccountStore()
    const authJson = JSON.parse(await readFile(authFilePath(), 'utf8')) as {
      anthropic?: { refresh?: string }
    }

    expect(rotated).toMatchObject({
      auth: { refresh: 'refresh-second' },
      fromLabel: '#1 (refresh-...irst)',
      toLabel: '#2 (refresh-...cond)',
      fromIndex: 0,
      toIndex: 1,
    })
    expect(store.activeIndex).toBe(1)
    expect(authJson.anthropic?.refresh).toBe('refresh-second')
    expect(authSetCalls).toEqual([
      {
        providerID: 'anthropic',
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

describe('removeAccount', () => {
  test('removing the active account promotes the next stored account', async () => {
    await saveAccountStore({
      version: 1,
      activeIndex: 1,
      accounts: [
        { ...firstAccount, addedAt: 1, lastUsed: 1 },
        { ...secondAccount, addedAt: 2, lastUsed: 2 },
      ],
    })

    await removeAccount(1)

    const store = await loadAccountStore()
    const authJson = JSON.parse(await readFile(authFilePath(), 'utf8')) as {
      anthropic?: { refresh?: string }
    }

    expect(store.activeIndex).toBe(0)
    expect(store.accounts).toHaveLength(1)
    expect(store.accounts[0]?.refresh).toBe('refresh-first')
    expect(authJson.anthropic?.refresh).toBe('refresh-first')
  })

  test('removing the last account clears active Anthropic auth', async () => {
    await saveAccountStore({
      version: 1,
      activeIndex: 0,
      accounts: [{ ...firstAccount, addedAt: 1, lastUsed: 1 }],
    })
    await mkdir(path.dirname(authFilePath()), { recursive: true })
    await writeFile(authFilePath(), JSON.stringify({ anthropic: firstAccount }, null, 2))

    await removeAccount(0)

    const store = await loadAccountStore()
    const authJson = JSON.parse(await readFile(authFilePath(), 'utf8')) as {
      anthropic?: unknown
    }

    expect(store.accounts).toHaveLength(0)
    expect(authJson.anthropic).toBeUndefined()
  })
})

describe('removeAccountByAuth', () => {
  test('removes matched account, promotes next, and syncs auth.set', async () => {
    await saveAccountStore({
      version: 1,
      activeIndex: 0,
      accounts: [
        { ...firstAccount, email: 'dead@example.com', addedAt: 1, lastUsed: 1 },
        { ...secondAccount, email: 'live@example.com', addedAt: 2, lastUsed: 2 },
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

    const removed = await removeAccountByAuth(firstAccount, client as never)
    const store = await loadAccountStore()

    expect(removed).toMatchObject({
      removedLabel: '#1 (dead@example.com)',
      activeLabel: '#1 (live@example.com)',
      active: { refresh: 'refresh-second' },
    })
    expect(store.accounts).toHaveLength(1)
    expect(store.accounts[0]?.refresh).toBe('refresh-second')
    expect(authSetCalls).toHaveLength(1)
  })

  test('returns undefined when auth is not in the pool', async () => {
    await saveAccountStore({
      version: 1,
      activeIndex: 0,
      accounts: [{ ...firstAccount, addedAt: 1, lastUsed: 1 }],
    })

    const removed = await removeAccountByAuth(
      {
        type: 'oauth',
        refresh: 'unknown-refresh',
        access: 'unknown-access',
        expires: 1,
      },
      { auth: { set: async () => {} } } as never,
    )

    expect(removed).toBeUndefined()
    expect((await loadAccountStore()).accounts).toHaveLength(1)
  })
})

describe('shouldRotateAuth', () => {
  test('only rotates on rate limit or auth failures', () => {
    expect(shouldRotateAuth(429, '')).toBe(true)
    expect(shouldRotateAuth(401, 'permission_error')).toBe(true)
    expect(shouldRotateAuth(400, 'bad request')).toBe(false)
  })
})

describe('isPermanentOAuthRefreshFailure', () => {
  test('detects invalid_grant and expired refresh tokens', () => {
    expect(
      isPermanentOAuthRefreshFailure(
        new Error(
          'HTTP 400 from https://platform.claude.com/v1/oauth/token: {"error": "invalid_grant", "error_description": "Refresh token expired"}',
        ),
      ),
    ).toBe(true)
    expect(isPermanentOAuthRefreshFailure(new Error('ECONNRESET'))).toBe(false)
    expect(isPermanentOAuthRefreshFailure(new Error('rate_limit_error'))).toBe(false)
  })
})
