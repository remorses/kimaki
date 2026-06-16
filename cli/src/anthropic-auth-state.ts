/**
 * Anthropic OAuth account store and rotation.
 * Uses shared utilities from oauth-rotation-shared.ts for file locking,
 * store I/O, and account management. Anthropic-specific: store file path,
 * identity normalization via AnthropicAccountIdentity.
 */

import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  normalizeAnthropicAccountIdentity,
  type AnthropicAccountIdentity,
} from './anthropic-account-identity.js'
import {
  type OAuthStored,
  type AccountStore,
  type RotationResult,
  accountLabel,
  authFilePath,
  findCurrentAccountIndex,
  isOAuthStored,
  normalizeAccountStore,
  readJson,
  upsertAccount as sharedUpsertAccount,
  withAuthStateLock,
  writeJson,
  shouldRotateAuth,
} from './oauth-rotation-shared.js'

// Re-export types and functions that consumers rely on
export type { OAuthStored, RotationResult }
export { accountLabel, authFilePath, withAuthStateLock, shouldRotateAuth }

export type CurrentAnthropicAccount = {
  auth: OAuthStored
  account?: OAuthStored & AnthropicAccountIdentity
  index?: number
}

// --- Store file path ---

export function accountsFilePath() {
  if (process.env.XDG_DATA_HOME) {
    return path.join(process.env.XDG_DATA_HOME, 'opencode', 'anthropic-oauth-accounts.json')
  }
  return path.join(homedir(), '.local', 'share', 'opencode', 'anthropic-oauth-accounts.json')
}

// --- Store I/O ---

export async function loadAccountStore() {
  const raw = await readJson<Partial<AccountStore> | null>(accountsFilePath(), null)
  return normalizeAccountStore(raw)
}

export async function saveAccountStore(store: AccountStore) {
  await writeJson(accountsFilePath(), normalizeAccountStore(store))
}

// --- Upsert with Anthropic identity normalization ---

export function upsertAccount(store: AccountStore, auth: OAuthStored, now = Date.now()) {
  const authWithIdentity = auth as OAuthStored & AnthropicAccountIdentity
  const identity = normalizeAnthropicAccountIdentity({
    email: authWithIdentity.email,
    accountId: authWithIdentity.accountId,
  })
  return sharedUpsertAccount(store, { ...auth, ...identity }, now)
}

// --- Remember new login ---

export async function rememberAnthropicOAuth(
  auth: OAuthStored,
  identity?: AnthropicAccountIdentity,
) {
  await withAuthStateLock(async () => {
    const store = await loadAccountStore()
    upsertAccount(store, { ...auth, ...normalizeAnthropicAccountIdentity(identity) })
    await saveAccountStore(store)
  })
}

// --- Auth file write + SDK sync ---

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
  client: OpencodeClient,
) {
  await writeAnthropicAuthFile(auth)
  await client.auth.set({ providerID: 'anthropic', auth })
}

// --- Current account ---

export async function getCurrentAnthropicAccount() {
  const authJson = await readJson<Record<string, unknown>>(authFilePath(), {})
  const auth = authJson.anthropic
  if (!isOAuthStored(auth)) {
    return null
  }

  const store = await loadAccountStore()
  const index = findCurrentAccountIndex(store, auth)
  const account = store.accounts[index]
  if (!account) {
    return { auth } satisfies CurrentAnthropicAccount
  }

  if (account.refresh !== auth.refresh && account.access !== auth.access) {
    return { auth } satisfies CurrentAnthropicAccount
  }

  return {
    auth,
    account,
    index,
  } satisfies CurrentAnthropicAccount
}

// --- Rotation ---

export async function rotateAnthropicAccount(
  auth: OAuthStored,
  client: OpencodeClient,
): Promise<RotationResult | undefined> {
  return withAuthStateLock(async () => {
    const store = await loadAccountStore()
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
    await saveAccountStore(store)

    const nextAuth: OAuthStored = {
      type: 'oauth',
      refresh: nextAccount.refresh,
      access: nextAccount.access,
      expires: nextAccount.expires,
    }
    await setAnthropicAuth(nextAuth, client)
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
