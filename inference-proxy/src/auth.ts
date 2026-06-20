// API key validation against the Postgres database via Hyperdrive.
// Keys are stored as SHA-256 hashes. The presented key is hashed and
// looked up in the api_key table. Returns the org_id for usage tracking.
//
// Results are memoized at the edge via the Cache API (5 min fresh, 10 min SWR).
// This avoids a Postgres round-trip on every request for the same key.
// Invalid keys return null (not cached). Valid keys cache the AuthResult.

import pg from 'pg'
import { memoize } from './memoize'

export interface AuthResult {
  valid: boolean
  orgId: string
}

const INVALID: AuthResult = { valid: false, orgId: '' }

async function hashKey(key: string): Promise<string> {
  const encoded = new TextEncoder().encode(key)
  const digest = await crypto.subtle.digest('SHA-256', encoded)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Raw DB lookup, not cached. Used as the backing function for memoize. */
async function lookupApiKey(
  keyHash: string,
  connectionString: string,
): Promise<AuthResult | null> {
  const client = new pg.Client({ connectionString })

  try {
    await client.connect()

    // Look up the key and verify the org has an active subscription
    const result = await client.query(
      `SELECT ak.org_id
       FROM api_key ak
       JOIN subscription s ON s.org_id = ak.org_id
       WHERE ak.key = $1
         AND ak.status = 'active'
         AND s.status IN ('active', 'trialing')
       LIMIT 1`,
      [keyHash],
    )

    if (result.rows.length === 0) return null

    return { valid: true, orgId: result.rows[0].org_id }
  } catch (err) {
    console.error('[auth] database validation failed', err)
    return null
  } finally {
    await client.end().catch(() => {})
  }
}

const memoizedLookup = memoize({
  namespace: 'api-key-auth',
  fn: lookupApiKey,
  ttl: 300, // 5 min fresh
  swr: 600, // 10 min stale-while-revalidate
})

export async function validateApiKey(
  key: string,
  connectionString: string,
): Promise<AuthResult> {
  if (!key) return INVALID

  const keyHash = await hashKey(key)
  const result = await memoizedLookup(keyHash, connectionString)

  return result ?? INVALID
}
