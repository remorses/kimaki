// Helpers for extracting and normalizing Anthropic OAuth account identity.

export type AnthropicAccountIdentity = {
  email?: string
  accountId?: string
}

type IdentityCandidate = AnthropicAccountIdentity & {
  score: number
}

const identityHintKeys = new Set(['user', 'profile', 'account', 'viewer'])
const idKeys = ['user_id', 'userId', 'account_id', 'accountId', 'id', 'sub']

export function normalizeAnthropicAccountIdentity(
  identity: AnthropicAccountIdentity | null | undefined,
) {
  const email =
    typeof identity?.email === 'string' && identity.email.trim()
      ? identity.email.trim().toLowerCase()
      : undefined
  const accountId =
    typeof identity?.accountId === 'string' && identity.accountId.trim()
      ? identity.accountId.trim()
      : undefined
  if (!email && !accountId) return undefined
  return {
    ...(email ? { email } : {}),
    ...(accountId ? { accountId } : {}),
  }
}

function getCandidateFromRecord(record: Record<string, unknown>, path: string[]) {
  const email = typeof record.email === 'string' ? record.email : undefined
  const accountId = idKeys
    .map((key) => {
      const value = record[key]
      return typeof value === 'string' ? value : undefined
    })
    .find((value) => {
      return Boolean(value)
    })
  const normalized = normalizeAnthropicAccountIdentity({ email, accountId })
  if (!normalized) return undefined
  const hasIdentityHint = path.some((segment) => {
    return identityHintKeys.has(segment)
  })
  return {
    ...normalized,
    score: (normalized.email ? 4 : 0) + (normalized.accountId ? 2 : 0) + (hasIdentityHint ? 2 : 0),
  } satisfies IdentityCandidate
}

function collectIdentityCandidates(value: unknown, path: string[] = []): IdentityCandidate[] {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      return collectIdentityCandidates(entry, path)
    })
  }

  const record = value as Record<string, unknown>
  const nested = Object.entries(record).flatMap(([key, entry]) => {
    return collectIdentityCandidates(entry, [...path, key])
  })
  const current = getCandidateFromRecord(record, path)
  return current ? [current, ...nested] : nested
}

export function extractAnthropicAccountIdentity(value: unknown) {
  const candidates = collectIdentityCandidates(value)
  const best = candidates.sort((a, b) => {
    return b.score - a.score
  })[0]
  if (!best) return undefined
  return normalizeAnthropicAccountIdentity(best)
}
