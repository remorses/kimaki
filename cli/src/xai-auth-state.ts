/**
 * xAI OAuth account store and rotation.
 * Mirrors openai-auth-state.ts but for xAI/Grok OAuth accounts.
 * Piggybacks on opencode's built-in XaiAuthPlugin for auth; this module
 * only manages the rotation pool and account switching.
 *
 * Store file: ~/.local/share/opencode/xai-oauth-accounts.json
 *
 * xAI returns 402 Payment Required with "Grok Build usage balance exhausted"
 * when the account's usage balance is depleted. This is the primary trigger
 * for rotation (unlike Anthropic/OpenAI which use 429).
 */

import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  type AccountStore,
  type OAuthStored,
  type RotationResult,
  type AccountIdentity,
  accountLabel,
  authFilePath,
  findCurrentAccountIndex,
  isOAuthStored,
  normalizeAccountStore,
  readJson,
  upsertAccount,
  withAuthStateLock,
  writeJson,
} from './oauth-rotation-shared.js'

export { type OAuthStored, type AccountStore, type RotationResult, type AccountIdentity }
export { accountLabel, upsertAccount }

// --- JWT identity extraction ---

/**
 * Extract email and accountId from an xAI OAuth access token JWT.
 * xAI JWTs follow OIDC conventions with standard claims:
 *   "email": "user@example.com"
 *   "sub": "user_id_string"
 * Falls back to top-level auth entry fields if JWT decoding fails.
 */
export function extractXAIIdentity(auth: OAuthStored & Record<string, unknown>): AccountIdentity {
  try {
    const parts = auth.access.split('.')
    if (parts.length >= 2 && parts[1]) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Record<string, unknown>
      const email = typeof payload.email === 'string' ? payload.email : undefined
      const accountId = typeof payload.sub === 'string' ? payload.sub : undefined
      if (email || accountId) {
        return { email, accountId }
      }
    }
  } catch {
    // JWT decode failed, fall through
  }

  return {
    email: typeof auth.email === 'string' ? auth.email : undefined,
    accountId: typeof auth.accountId === 'string' ? auth.accountId : undefined,
  }
}

// --- Store file path ---

export function xaiAccountsFilePath() {
  if (process.env.XDG_DATA_HOME) {
    return path.join(process.env.XDG_DATA_HOME, 'opencode', 'xai-oauth-accounts.json')
  }
  return path.join(homedir(), '.local', 'share', 'opencode', 'xai-oauth-accounts.json')
}

// --- Store I/O ---

export async function loadXAIAccountStore(): Promise<AccountStore> {
  const raw = await readJson<Partial<AccountStore> | null>(xaiAccountsFilePath(), null)
  return normalizeAccountStore(raw)
}

export async function saveXAIAccountStore(store: AccountStore) {
  await writeJson(xaiAccountsFilePath(), normalizeAccountStore(store))
}

// --- Current account ---

export type CurrentXAIAccount = {
  auth: OAuthStored
  account?: OAuthStored & AccountIdentity
  index?: number
}

export async function getCurrentXAIAccount(): Promise<CurrentXAIAccount | null> {
  const authJson = await readJson<Record<string, unknown>>(authFilePath(), {})
  const auth = authJson.xai
  if (!isOAuthStored(auth)) {
    return null
  }

  const store = await loadXAIAccountStore()
  const index = findCurrentAccountIndex(store, auth)
  const account = store.accounts[index]
  if (!account) {
    return { auth }
  }

  if (account.refresh !== auth.refresh && account.access !== auth.access) {
    return { auth }
  }

  return { auth, account, index }
}

// --- Auth file write + SDK sync ---

async function writeXAIAuthFile(auth: OAuthStored | undefined) {
  const file = authFilePath()
  const data = await readJson<Record<string, unknown>>(file, {})
  if (auth) {
    data.xai = auth
  } else {
    delete data.xai
  }
  await writeJson(file, data)
}

export async function setXAIAuth(
  auth: OAuthStored,
  client: OpencodeClient,
) {
  await writeXAIAuthFile(auth)
  await client.auth.set({ providerID: 'xai', auth })
}

// --- Remember new login ---

export async function rememberXAIOAuth(
  auth: OAuthStored,
  identity?: AccountIdentity,
) {
  await withAuthStateLock(async () => {
    const store = await loadXAIAccountStore()
    upsertAccount(store, { ...auth, ...identity })
    await saveXAIAccountStore(store)
  })
}

/**
 * Detect if the current auth.json xai entry is a new account not yet in
 * our rotation pool. If so, upsert it. Returns the identity if a new account
 * was added, undefined otherwise.
 */
export async function detectAndRememberNewXAIAccount(): Promise<AccountIdentity | undefined> {
  const authJson = await readJson<Record<string, unknown>>(authFilePath(), {})
  const auth = authJson.xai
  if (!isOAuthStored(auth)) return undefined

  const identity = extractXAIIdentity(auth)

  const store = await loadXAIAccountStore()
  const existingIndex = store.accounts.findIndex(
    (account) => account.refresh === auth.refresh || account.access === auth.access,
  )

  // Known account: backfill missing email/accountId from JWT if needed
  if (existingIndex >= 0) {
    const existing = store.accounts[existingIndex]
    if (existing && (!existing.email || !existing.accountId) && (identity.email || identity.accountId)) {
      await withAuthStateLock(async () => {
        const freshStore = await loadXAIAccountStore()
        const account = freshStore.accounts[existingIndex]
        if (!account) return
        if (!account.email && identity.email) account.email = identity.email
        if (!account.accountId && identity.accountId) account.accountId = identity.accountId
        await saveXAIAccountStore(freshStore)
      })
    }
    return undefined
  }

  // Check if the identity matches an existing account even though tokens
  // don't match (happens after token refresh rotates both tokens).
  // Without this check we'd show a false "account added" toast.
  if (identity.email || identity.accountId) {
    const matchesByIdentity = store.accounts.some((account) => {
      if (identity.accountId && account.accountId === identity.accountId) return true
      if (identity.email && account.email?.toLowerCase() === identity.email.toLowerCase()) return true
      return false
    })
    if (matchesByIdentity) {
      // Update the stored tokens for this known account
      await withAuthStateLock(async () => {
        const freshStore = await loadXAIAccountStore()
        upsertAccount(freshStore, { ...auth, ...identity })
        await saveXAIAccountStore(freshStore)
      })
      return undefined
    }
  }

  // New account: upsert with identity
  await withAuthStateLock(async () => {
    const freshStore = await loadXAIAccountStore()
    const alreadyKnown = freshStore.accounts.some(
      (account) => account.refresh === auth.refresh || account.access === auth.access,
    )
    if (alreadyKnown) return
    upsertAccount(freshStore, { ...auth, ...identity })
    await saveXAIAccountStore(freshStore)
  })

  return identity
}

// --- Rotation ---

export async function rotateXAIAccount(
  auth: OAuthStored,
  client: OpencodeClient,
): Promise<RotationResult | undefined> {
  return withAuthStateLock(async () => {
    const store = await loadXAIAccountStore()
    if (store.accounts.length < 2) return undefined

    const currentIndex = findCurrentAccountIndex(store, auth)
    const currentAccount = store.accounts[currentIndex]
    const nextIndex = (currentIndex + 1) % store.accounts.length
    const nextAccount = store.accounts[nextIndex]
    if (!nextAccount) return undefined

    const fromLabel = currentAccount
      ? accountLabel(currentAccount, currentIndex)
      : accountLabel(auth, currentIndex)

    nextAccount.lastUsed = Date.now()
    store.activeIndex = nextIndex
    await saveXAIAccountStore(store)

    const nextAuth: OAuthStored = {
      type: 'oauth',
      refresh: nextAccount.refresh,
      access: nextAccount.access,
      expires: nextAccount.expires,
    }
    await setXAIAuth(nextAuth, client)
    return {
      auth: nextAuth,
      fromLabel,
      toLabel: accountLabel(nextAccount, nextIndex),
      fromIndex: currentIndex,
      toIndex: nextIndex,
    }
  })
}

// --- Remove account ---

export async function removeXAIAccount(index: number) {
  return withAuthStateLock(async () => {
    const store = await loadXAIAccountStore()
    if (!Number.isInteger(index) || index < 0 || index >= store.accounts.length) {
      throw new Error(`Account ${index + 1} does not exist`)
    }

    store.accounts.splice(index, 1)
    if (store.accounts.length === 0) {
      store.activeIndex = 0
      await saveXAIAccountStore(store)
      await writeXAIAuthFile(undefined)
      return { store, active: undefined }
    }

    if (store.activeIndex > index) {
      store.activeIndex -= 1
    } else if (store.activeIndex >= store.accounts.length) {
      store.activeIndex = 0
    }

    const active = store.accounts[store.activeIndex]
    if (!active) throw new Error('Active xAI account disappeared during removal')
    active.lastUsed = Date.now()
    await saveXAIAccountStore(store)
    const nextAuth: OAuthStored = {
      type: 'oauth',
      refresh: active.refresh,
      access: active.access,
      expires: active.expires,
    }
    await writeXAIAuthFile(nextAuth)
    return { store, active: nextAuth }
  })
}
