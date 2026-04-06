import type { Plugin } from '@opencode-ai/plugin'
import * as fs from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const AUTH_LOCK_STALE_MS = 30_000
const AUTH_LOCK_RETRY_MS = 100

export type OAuthStored = {
  type: 'oauth'
  refresh: string
  access: string
  expires: number
}

type AccountRecord = OAuthStored & {
  addedAt: number
  lastUsed: number
}

type AccountStore = {
  version: number
  activeIndex: number
  accounts: AccountRecord[]
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T
  } catch {
    return fallback
  }
}

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8')
  await fs.chmod(filePath, 0o600)
}

function getErrorCode(error: unknown) {
  if (!(error instanceof Error)) return undefined
  return (error as NodeJS.ErrnoException).code
}

async function sleep(ms: number) {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

export function authFilePath() {
  if (process.env.XDG_DATA_HOME) {
    return path.join(process.env.XDG_DATA_HOME, 'opencode', 'auth.json')
  }
  return path.join(homedir(), '.local', 'share', 'opencode', 'auth.json')
}

export function accountsFilePath() {
  if (process.env.XDG_DATA_HOME) {
    return path.join(process.env.XDG_DATA_HOME, 'opencode', 'anthropic-oauth-accounts.json')
  }
  return path.join(homedir(), '.local', 'share', 'opencode', 'anthropic-oauth-accounts.json')
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
          typeof account.addedAt === 'number' &&
          typeof account.lastUsed === 'number',
      )
    : []
  const rawIndex = typeof input?.activeIndex === 'number' ? Math.floor(input.activeIndex) : 0
  const activeIndex =
    accounts.length === 0 ? 0 : ((rawIndex % accounts.length) + accounts.length) % accounts.length
  return { version: 1, activeIndex, accounts }
}

export async function loadAccountStore() {
  const raw = await readJson<Partial<AccountStore> | null>(accountsFilePath(), null)
  return normalizeAccountStore(raw)
}

export async function saveAccountStore(store: AccountStore) {
  await writeJson(accountsFilePath(), normalizeAccountStore(store))
}

function findCurrentAccountIndex(store: AccountStore, auth: OAuthStored) {
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

export function upsertAccount(store: AccountStore, auth: OAuthStored, now = Date.now()) {
  const index = store.accounts.findIndex((account) => {
    return account.refresh === auth.refresh || account.access === auth.access
  })
  const nextAccount: AccountRecord = {
    type: 'oauth',
    refresh: auth.refresh,
    access: auth.access,
    expires: auth.expires,
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
  }
  store.activeIndex = index
  return index
}

export async function rememberAnthropicOAuth(auth: OAuthStored) {
  await withAuthStateLock(async () => {
    const store = await loadAccountStore()
    upsertAccount(store, auth)
    await saveAccountStore(store)
  })
}

async function writeAnthropicAuthFile(auth: OAuthStored | undefined) {
  const file = authFilePath()
  const data = await readJson<Record<string, unknown>>(file, {})
  if (auth) {
    data.anthropic = auth
  } else {
    delete data.anthropic
  }
  await writeJson(file, data)
}

export async function setAnthropicAuth(
  auth: OAuthStored,
  client: Parameters<Plugin>[0]['client'],
) {
  await writeAnthropicAuthFile(auth)
  await client.auth.set({ path: { id: 'anthropic' }, body: auth })
}

export async function rotateAnthropicAccount(
  auth: OAuthStored,
  client: Parameters<Plugin>[0]['client'],
) {
  return withAuthStateLock(async () => {
    const store = await loadAccountStore()
    if (store.accounts.length < 2) return undefined

    const currentIndex = findCurrentAccountIndex(store, auth)
    const nextIndex = (currentIndex + 1) % store.accounts.length
    const nextAccount = store.accounts[nextIndex]
    if (!nextAccount) return undefined

    nextAccount.lastUsed = Date.now()
    store.activeIndex = nextIndex
    await saveAccountStore(store)

    const nextAuth: OAuthStored = {
      type: 'oauth',
      refresh: nextAccount.refresh,
      access: nextAccount.access,
      expires: nextAccount.expires,
    }
    await setAnthropicAuth(nextAuth, client)
    return nextAuth
  })
}

export async function removeAccount(index: number) {
  return withAuthStateLock(async () => {
    const store = await loadAccountStore()
    if (!Number.isInteger(index) || index < 0 || index >= store.accounts.length) {
      throw new Error(`Account ${index + 1} does not exist`)
    }

    store.accounts.splice(index, 1)
    if (store.accounts.length === 0) {
      store.activeIndex = 0
      await saveAccountStore(store)
      await writeAnthropicAuthFile(undefined)
      return { store, active: undefined }
    }

    if (store.activeIndex > index) {
      store.activeIndex -= 1
    } else if (store.activeIndex >= store.accounts.length) {
      store.activeIndex = 0
    }

    const active = store.accounts[store.activeIndex]
    if (!active) throw new Error('Active Anthropic account disappeared during removal')
    active.lastUsed = Date.now()
    await saveAccountStore(store)
    const nextAuth: OAuthStored = {
      type: 'oauth',
      refresh: active.refresh,
      access: active.access,
      expires: active.expires,
    }
    await writeAnthropicAuthFile(nextAuth)
    return { store, active: nextAuth }
  })
}

export function shouldRotateAuth(status: number, bodyText: string) {
  const haystack = bodyText.toLowerCase()
  if (status === 429) return true
  if (status === 401 || status === 403) return true
  return (
    haystack.includes('rate_limit') ||
    haystack.includes('rate limit') ||
    haystack.includes('invalid api key') ||
    haystack.includes('authentication_error') ||
    haystack.includes('permission_error') ||
    haystack.includes('oauth')
  )
}
