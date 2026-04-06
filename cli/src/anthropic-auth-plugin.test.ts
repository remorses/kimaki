// Tests for Anthropic OAuth multi-account persistence and rotation.

import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  authFilePath,
  loadAccountStore,
  rememberAnthropicOAuth,
  removeAccount,
  rotateAnthropicAccount,
  saveAccountStore,
  shouldRotateAuth,
} from './anthropic-auth-plugin.js'

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

    expect(rotated).toMatchObject({ refresh: 'refresh-second' })
    expect(store.activeIndex).toBe(1)
    expect(authJson.anthropic?.refresh).toBe('refresh-second')
    expect(authSetCalls).toEqual([
      {
        path: { id: 'anthropic' },
        body: {
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

describe('shouldRotateAuth', () => {
  test('only rotates on rate limit or auth failures', () => {
    expect(shouldRotateAuth(429, '')).toBe(true)
    expect(shouldRotateAuth(401, 'permission_error')).toBe(true)
    expect(shouldRotateAuth(400, 'bad request')).toBe(false)
  })
})
