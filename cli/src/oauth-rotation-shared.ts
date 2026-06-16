/**
 * Shared utilities for multi-provider OAuth account rotation.
 * Used by both anthropic-auth-state.ts and openai-auth-state.ts to avoid
 * duplicating file locking, store I/O, account labeling, and rotation logic.
 */

import * as fs from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const AUTH_LOCK_STALE_MS = 30_000
const AUTH_LOCK_RETRY_MS = 100

// --- Types ---

export type OAuthStored = {
  type: 'oauth'
  refresh: string
  access: string
  expires: number
}

export type AccountRecord = OAuthStored & {
  email?: string
  accountId?: string
  addedAt: number
  lastUsed: number
}

export type AccountStore = {
  version: number
  activeIndex: number
  accounts: AccountRecord[]
}

export type RotationResult = {
  auth: OAuthStored
  fromLabel: string
  toLabel: string
  fromIndex: number
  toIndex: number
}

// --- File I/O ---

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T
  } catch {
    return fallback
  }
}

export async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8')
  await fs.chmod(filePath, 0o600)
}

// --- Auth file path ---

export function authFilePath() {
  if (process.env.XDG_DATA_HOME) {
    return path.join(process.env.XDG_DATA_HOME, 'opencode', 'auth.json')
  }
  return path.join(homedir(), '.local', 'share', 'opencode', 'auth.json')
}

// --- File-based locking ---

function getErrorCode(error: unknown) {
  if (!(error instanceof Error)) return undefined
  return (error as NodeJS.ErrnoException).code
}

async function sleep(ms: number) {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

export async function withAuthStateLock<T>(fn: () => Promise<T>) {
  const file = authFilePath()
  const lockDir = `${file}.lock`
  const deadline = Date.now() + AUTH_LOCK_STALE_MS

  await fs.mkdir(path.dirname(file), { recursive: true })

  while (true) {
    try {
      await fs.mkdir(lockDir)
      break
    } catch (error) {
      const code = getErrorCode(error)
      if (code !== 'EEXIST') {
        throw error
      }

      const stats = await fs.stat(lockDir).catch(() => {
        return null
      })
      if (stats && Date.now() - stats.mtimeMs > AUTH_LOCK_STALE_MS) {
        await fs.rm(lockDir, { force: true, recursive: true }).catch(() => {})
        continue
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for auth lock: ${lockDir}`)
      }

      await sleep(AUTH_LOCK_RETRY_MS)
    }
  }

  try {
    return await fn()
  } finally {
    await fs.rm(lockDir, { force: true, recursive: true }).catch(() => {})
  }
}

// --- Account store normalization ---

export function normalizeAccountStore(
  input: Partial<AccountStore> | null | undefined,
): AccountStore {
  const accounts = Array.isArray(input?.accounts)
    ? input.accounts.filter(
        (account): account is AccountRecord =>
          !!account &&
          account.type === 'oauth' &&
          typeof account.refresh === 'string' &&
          typeof account.access === 'string' &&
          typeof account.expires === 'number' &&
          (typeof account.email === 'undefined' || typeof account.email === 'string') &&
          (typeof account.accountId === 'undefined' || typeof account.accountId === 'string') &&
          typeof account.addedAt === 'number' &&
          typeof account.lastUsed === 'number',
      )
    : []
  const rawIndex = typeof input?.activeIndex === 'number' ? Math.floor(input.activeIndex) : 0
  const activeIndex =
    accounts.length === 0 ? 0 : ((rawIndex % accounts.length) + accounts.length) % accounts.length
  return { version: 1, activeIndex, accounts }
}

// --- Account labeling ---

export function accountLabel(
  account: OAuthStored & { email?: string; accountId?: string },
  index?: number,
): string {
  const identity = account.email || account.accountId
  const r = account.refresh
  const short = r.length > 12 ? `${r.slice(0, 8)}...${r.slice(-4)}` : r
  if (identity) {
    return index !== undefined ? `#${index + 1} (${identity})` : identity
  }
  return index !== undefined ? `#${index + 1} (${short})` : short
}

// --- Account matching ---

export function findCurrentAccountIndex(store: AccountStore, auth: OAuthStored) {
  if (!store.accounts.length) return 0
  const byRefresh = store.accounts.findIndex((account) => {
    return account.refresh === auth.refresh
  })
  if (byRefresh >= 0) return byRefresh
  const byAccess = store.accounts.findIndex((account) => {
    return account.access === auth.access
  })
  if (byAccess >= 0) return byAccess
  return store.activeIndex
}

// --- Account upsert ---

export type AccountIdentity = {
  email?: string
  accountId?: string
}

export function upsertAccount(
  store: AccountStore,
  auth: OAuthStored & AccountIdentity,
  now = Date.now(),
) {
  const identity = normalizeIdentity({
    email: auth.email,
    accountId: auth.accountId,
  })
  const index = store.accounts.findIndex((account) => {
    if (account.refresh === auth.refresh || account.access === auth.access) {
      return true
    }
    if (identity?.accountId && account.accountId === identity.accountId) {
      return true
    }
    if (identity?.email && account.email === identity.email) {
      return true
    }
    return false
  })
  const nextAccount: AccountRecord = {
    type: 'oauth',
    refresh: auth.refresh,
    access: auth.access,
    expires: auth.expires,
    ...identity,
    addedAt: now,
    lastUsed: now,
  }

  if (index < 0) {
    store.accounts.push(nextAccount)
    store.activeIndex = store.accounts.length - 1
    return store.activeIndex
  }

  const existing = store.accounts[index]
  if (!existing) return index
  store.accounts[index] = {
    ...existing,
    ...nextAccount,
    addedAt: existing.addedAt,
    email: nextAccount.email || existing.email,
    accountId: nextAccount.accountId || existing.accountId,
  }
  store.activeIndex = index
  return index
}

function normalizeIdentity(identity: AccountIdentity | undefined): AccountIdentity | undefined {
  if (!identity) return undefined
  const email = identity.email?.trim().toLowerCase() || undefined
  const accountId = identity.accountId?.trim() || undefined
  if (!email && !accountId) return undefined
  return { email, accountId }
}

// --- Rate limit detection ---

export function shouldRotateAuth(status: number, bodyText: string) {
  const haystack = bodyText.toLowerCase()
  if (status === 429) return true
  if (status === 401 || status === 403) return true
  return (
    haystack.includes('rate_limit') ||
    haystack.includes('rate limit') ||
    haystack.includes('usage limit') ||
    haystack.includes('usage_limit') ||
    haystack.includes('usage_limit_reached') ||
    haystack.includes('usage_not_included') ||
    haystack.includes('invalid api key') ||
    haystack.includes('authentication_error') ||
    haystack.includes('permission_error')
  )
}

export function isRateLimitRetryMessage(message: string) {
  const haystack = message.toLowerCase()
  return (
    haystack.includes('429') ||
    haystack.includes('usage limit') ||
    haystack.includes('rate limit') ||
    haystack.includes('rate_limit') ||
    haystack.includes('usage_limit_reached') ||
    haystack.includes('usage_not_included')
  )
}

export function isTokenRefreshError(message: string) {
  const haystack = message.toLowerCase()
  return (
    haystack.includes('token refresh failed') ||
    haystack.includes('refresh_token') ||
    (haystack.includes('401') && haystack.includes('refresh'))
  )
}

// --- Auth file helpers ---

export function isOAuthStored(value: unknown): value is OAuthStored {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as Record<string, unknown>
  return (
    record.type === 'oauth' &&
    typeof record.refresh === 'string' &&
    typeof record.access === 'string' &&
    typeof record.expires === 'number'
  )
}
