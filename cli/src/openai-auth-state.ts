/**
 * OpenAI OAuth account store and rotation.
 * Mirrors anthropic-auth-state.ts but for OpenAI/Codex OAuth accounts.
 * Piggybacks on opencode's built-in CodexAuthPlugin for auth; this module
 * only manages the rotation pool and account switching.
 *
 * Store file: ~/.local/share/opencode/openai-oauth-accounts.json
 * Migration: on first load, copies from multicodex-accounts.json if present.
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
 * Extract email and accountId from an OpenAI OAuth access token JWT.
 * The JWT payload contains:
 *   "https://api.openai.com/profile": { "email": "..." }
 *   "https://api.openai.com/auth": { "chatgpt_account_id": "..." }
 * Falls back to top-level auth entry fields if JWT decoding fails.
 */
export function extractOpenAIIdentity(auth: OAuthStored & Record<string, unknown>): AccountIdentity {
  // Try JWT first
  try {
    const parts = auth.access.split('.')
    if (parts.length >= 2 && parts[1]) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Record<string, unknown>
      const profile = payload['https://api.openai.com/profile'] as Record<string, unknown> | undefined
      const authClaims = payload['https://api.openai.com/auth'] as Record<string, unknown> | undefined
      const email = typeof profile?.email === 'string' ? profile.email : undefined
      const accountId = typeof authClaims?.chatgpt_account_id === 'string'
        ? authClaims.chatgpt_account_id
        : undefined
      if (email || accountId) {
        return { email, accountId }
      }
    }
  } catch {
    // JWT decode failed, fall through
  }

  // Fallback: check if auth entry has fields directly
  return {
    email: typeof auth.email === 'string' ? auth.email : undefined,
    accountId: typeof auth.accountId === 'string' ? auth.accountId : undefined,
  }
}

// --- Store file path ---

export function openaiAccountsFilePath() {
  if (process.env.XDG_DATA_HOME) {
    return path.join(process.env.XDG_DATA_HOME, 'opencode', 'openai-oauth-accounts.json')
  }
  return path.join(homedir(), '.local', 'share', 'opencode', 'openai-oauth-accounts.json')
}

// --- Store I/O ---

export async function loadOpenAIAccountStore(): Promise<AccountStore> {
  const raw = await readJson<Partial<AccountStore> | null>(openaiAccountsFilePath(), null)
  return normalizeAccountStore(raw)
}

export async function saveOpenAIAccountStore(store: AccountStore) {
  await writeJson(openaiAccountsFilePath(), normalizeAccountStore(store))
}

// --- Current account ---

export type CurrentOpenAIAccount = {
  auth: OAuthStored
  account?: OAuthStored & AccountIdentity
  index?: number
}

export async function getCurrentOpenAIAccount(): Promise<CurrentOpenAIAccount | null> {
  const authJson = await readJson<Record<string, unknown>>(authFilePath(), {})
  const auth = authJson.openai
  if (!isOAuthStored(auth)) {
    return null
  }

  const store = await loadOpenAIAccountStore()
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

async function writeOpenAIAuthFile(auth: OAuthStored | undefined) {
  const file = authFilePath()
  const data = await readJson<Record<string, unknown>>(file, {})
  if (auth) {
    data.openai = auth
  } else {
    delete data.openai
  }
  await writeJson(file, data)
}

export async function setOpenAIAuth(
  auth: OAuthStored,
  client: OpencodeClient,
) {
  await writeOpenAIAuthFile(auth)
  await client.auth.set({ providerID: 'openai', auth })
}

// --- Remember new login ---

export async function rememberOpenAIOAuth(
  auth: OAuthStored,
  identity?: AccountIdentity,
) {
  await withAuthStateLock(async () => {
    const store = await loadOpenAIAccountStore()
    upsertAccount(store, { ...auth, ...identity })
    await saveOpenAIAccountStore(store)
  })
}

/**
 * Detect if the current auth.json openai entry is a new account not yet in
 * our rotation pool. If so, upsert it. Returns the identity if a new account
 * was added, undefined otherwise.
 */
export async function detectAndRememberNewOpenAIAccount(): Promise<AccountIdentity | undefined> {
  const authJson = await readJson<Record<string, unknown>>(authFilePath(), {})
  const auth = authJson.openai
  if (!isOAuthStored(auth)) return undefined

  // Extract identity from JWT access token claims
  const identity = extractOpenAIIdentity(auth)

  const store = await loadOpenAIAccountStore()
  const existingIndex = store.accounts.findIndex(
    (account) => account.refresh === auth.refresh || account.access === auth.access,
  )

  // Known account: backfill missing email/accountId from JWT if needed
  if (existingIndex >= 0) {
    const existing = store.accounts[existingIndex]
    if (existing && (!existing.email || !existing.accountId) && (identity.email || identity.accountId)) {
      await withAuthStateLock(async () => {
        const freshStore = await loadOpenAIAccountStore()
        const account = freshStore.accounts[existingIndex]
        if (!account) return
        if (!account.email && identity.email) account.email = identity.email
        if (!account.accountId && identity.accountId) account.accountId = identity.accountId
        await saveOpenAIAccountStore(freshStore)
      })
    }
    return undefined
  }

  // New account: upsert with identity
  await withAuthStateLock(async () => {
    const freshStore = await loadOpenAIAccountStore()
    const alreadyKnown = freshStore.accounts.some(
      (account) => account.refresh === auth.refresh || account.access === auth.access,
    )
    if (alreadyKnown) return
    upsertAccount(freshStore, { ...auth, ...identity })
    await saveOpenAIAccountStore(freshStore)
  })

  return identity
}

// --- Rotation ---

export async function rotateOpenAIAccount(
  auth: OAuthStored,
  client: OpencodeClient,
): Promise<RotationResult | undefined> {
  return withAuthStateLock(async () => {
    const store = await loadOpenAIAccountStore()
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
    await saveOpenAIAccountStore(store)

    const nextAuth: OAuthStored = {
      type: 'oauth',
      refresh: nextAccount.refresh,
      access: nextAccount.access,
      expires: nextAccount.expires,
    }
    await setOpenAIAuth(nextAuth, client)
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

export async function removeOpenAIAccount(index: number) {
  return withAuthStateLock(async () => {
    const store = await loadOpenAIAccountStore()
    if (!Number.isInteger(index) || index < 0 || index >= store.accounts.length) {
      throw new Error(`Account ${index + 1} does not exist`)
    }

    store.accounts.splice(index, 1)
    if (store.accounts.length === 0) {
      store.activeIndex = 0
      await saveOpenAIAccountStore(store)
      await writeOpenAIAuthFile(undefined)
      return { store, active: undefined }
    }

    if (store.activeIndex > index) {
      store.activeIndex -= 1
    } else if (store.activeIndex >= store.accounts.length) {
      store.activeIndex = 0
    }

    const active = store.accounts[store.activeIndex]
    if (!active) throw new Error('Active OpenAI account disappeared during removal')
    active.lastUsed = Date.now()
    await saveOpenAIAccountStore(store)
    const nextAuth: OAuthStored = {
      type: 'oauth',
      refresh: active.refresh,
      access: active.access,
      expires: active.expires,
    }
    await writeOpenAIAuthFile(nextAuth)
    return { store, active: nextAuth }
  })
}
