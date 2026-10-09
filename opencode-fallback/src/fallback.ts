// Pure fallback logic: classify a failed model request into a block, parse the
// exact reset time, and pick the best (model, account) pair that is not blocked.
// No I/O here; index.ts feeds it storage, catalog and accounts.

export type ModelRef = { providerID: string; id: string; variant?: string }

export type BlockReason = 'rate-limit' | 'quota' | 'overloaded' | 'auth'

// `*` widens the scope: credentialID `*` = every account, modelID `*` = every model.
// `env` is the account of a provider that has no saved credential.
export type Block = {
  providerID: string
  credentialID: string
  modelID: string
  until: number
  reason: BlockReason
}

export type FailedRequest = {
  model: ModelRef
  credentialID: string
  error: { type: string; message: string; status?: number; response?: { body: string } }
  headers?: Record<string, string>
}

export const ENV_ACCOUNT = 'env'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

// Used only when the provider sends no reset information.
export const DEFAULT_BLOCK_MS: Record<BlockReason, number> = {
  'rate-limit': MINUTE,
  quota: 30 * MINUTE,
  overloaded: 30 * SECOND,
  auth: 24 * HOUR,
}

// Best first. Entries a user has no provider for are skipped at runtime.
export const DEFAULT_MODELS = [
  'anthropic/claude-opus-5-5',
  'openai/gpt-6-sol',
  'xai/grok-4.6',
  'opencode-go/grok-4.7',
  'github-copilot/gpt-6-sol',
  'anthropic/claude-sonnet-5-5',
  'openai/gpt-5.5',
  'opencode-go/glm-5.3-flash',
]

// `provider/model#variant`. Provider ends at the first `/`, variant starts at the last `#`.
export function parseModel(value: string): ModelRef | undefined {
  const slash = value.indexOf('/')
  if (slash <= 0) return undefined
  const hash = value.lastIndexOf('#')
  const id = value.slice(slash + 1, hash > slash ? hash : undefined)
  if (!id) return undefined
  const variant = hash > slash ? value.slice(hash + 1) : undefined
  return { providerID: value.slice(0, slash), id, ...(variant ? { variant } : {}) }
}

export function formatModel(model: ModelRef): string {
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ''}`
}

const REASONS: readonly string[] = ['rate-limit', 'quota', 'overloaded', 'auth'] satisfies BlockReason[]

export function isBlock(value: unknown): value is Block {
  if (!value || typeof value !== 'object') return false
  const record: Record<string, unknown> = { ...value }
  return (
    typeof record.providerID === 'string' &&
    typeof record.credentialID === 'string' &&
    typeof record.modelID === 'string' &&
    typeof record.until === 'number' &&
    typeof record.reason === 'string' &&
    REASONS.includes(record.reason)
  )
}

export function blockKey(block: Pick<Block, 'providerID' | 'credentialID' | 'modelID'>): string {
  return ['block', block.providerID, block.credentialID, block.modelID].map(encodeURIComponent).join('/')
}

function lowerHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]))
}

function parseJson(text: string | undefined): unknown {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function numberField(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object' || !(key in value)) return undefined
  const field: unknown = Reflect.get(value, key)
  const number = typeof field === 'string' ? Number(field) : field
  return typeof number === 'number' && Number.isFinite(number) ? number : undefined
}

function finiteNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

// OpenAI `x-ratelimit-reset-*` durations: `1s`, `6m0s`, `20ms`, `1h2m3.5s`.
export function parseDuration(value: string): number | undefined {
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)]
  if (parts.length === 0 || parts.map((part) => part[0]).join('') !== value.trim()) return undefined
  const unit: Record<string, number> = { ms: 1, s: SECOND, m: MINUTE, h: HOUR }
  return parts.reduce((total, [, amount, suffix]) => total + Number(amount) * (unit[suffix ?? ''] ?? 0), 0)
}

// Earliest time the failed request can succeed again, most specific source first.
export function resetAt({
  headers: rawHeaders,
  body,
  now,
}: {
  headers?: Record<string, string>
  body?: string
  now: number
}): number | undefined {
  const headers = lowerHeaders(rawHeaders)

  // Codex/ChatGPT usage limits: {"error":{"type":"usage_limit_reached","resets_at":<s>,"resets_in_seconds":<s>}}
  const json = parseJson(body)
  const error: unknown = json && typeof json === 'object' && 'error' in json ? json.error : json
  const resetsAt = numberField(error, 'resets_at')
  if (resetsAt !== undefined) return resetsAt * SECOND
  const resetsIn = numberField(error, 'resets_in_seconds')
  if (resetsIn !== undefined) return now + resetsIn * SECOND

  // Claude Pro/Max subscription windows (epoch seconds).
  const unified = finiteNumber(headers['anthropic-ratelimit-unified-reset'])
  if (unified !== undefined) return unified * SECOND

  // Codex windows: take the reset of the window that is used up.
  const codex = (['primary', 'secondary'] as const)
    .filter((window) => (finiteNumber(headers[`x-codex-${window}-used-percent`]) ?? 0) >= 100)
    .map((window) => finiteNumber(headers[`x-codex-${window}-reset-at`]))
    .filter((value) => value !== undefined)
  if (codex.length > 0) return Math.max(...codex) * SECOND

  const retryAfterMs = finiteNumber(headers['retry-after-ms'])
  if (retryAfterMs !== undefined && retryAfterMs >= 0) return now + retryAfterMs
  const retryAfter = headers['retry-after']
  if (retryAfter !== undefined) {
    const seconds = finiteNumber(retryAfter)
    if (seconds !== undefined && seconds >= 0) return now + seconds * SECOND
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) return Math.max(now, date)
  }

  // Per-limit resets: only limits that are exhausted, the latest one wins.
  const exhausted = Object.entries(headers).flatMap(([name, value]) => {
    const anthropic = /^anthropic-ratelimit-(.+)-reset$/.exec(name)
    if (anthropic && headers[`anthropic-ratelimit-${anthropic[1]}-remaining`] === '0') {
      const date = Date.parse(value)
      return Number.isFinite(date) ? [date] : []
    }
    const openai = /^x-ratelimit-reset-(.+)$/.exec(name)
    if (openai && headers[`x-ratelimit-remaining-${openai[1]}`] === '0') {
      const duration = parseDuration(value)
      return duration === undefined ? [] : [now + duration]
    }
    return []
  })
  if (exhausted.length > 0) return Math.max(...exhausted)
  return undefined
}

const QUOTA_TEXT = /usage_limit_reached|usage[-_\s]limit|insufficient[-_\s]quota|quota[-_\s]exceeded|credit balance|spending[-_\s]limit/i
const OVERLOAD_TEXT = /overloaded|at capacity|temporarily unavailable|service[-_\s]unavailable/i

// The block a failed request implies, or undefined when it is not a fallback error.
export function classify({ failed, now }: { failed: FailedRequest; now: number }): Block | undefined {
  const { error, model, credentialID } = failed
  const headers = lowerHeaders(failed.headers)
  const text = `${error.message} ${error.response?.body ?? ''}`
  const reason = ((): BlockReason | undefined => {
    if (error.type === 'provider.auth') return 'auth'
    if (error.type === 'provider.quota') return 'quota'
    if (error.type === 'provider.rate-limit') {
      // Subscription windows (Claude Pro/Max, Codex) cover every model of the account.
      if (QUOTA_TEXT.test(text) || headers['anthropic-ratelimit-unified-status'] === 'rejected') return 'quota'
      return 'rate-limit'
    }
    if (error.type === 'provider.internal' || error.type === 'provider.unknown') {
      if (QUOTA_TEXT.test(text)) return 'quota'
      if (error.status === 529 || error.status === 503 || OVERLOAD_TEXT.test(text)) return 'overloaded'
    }
    return undefined
  })()
  if (!reason) return undefined
  const reset = reason === 'auth' ? undefined : resetAt({ headers, body: error.response?.body, now })
  return {
    providerID: model.providerID,
    // Overload is provider capacity: every account sees it.
    credentialID: reason === 'overloaded' ? '*' : credentialID,
    // Quota and auth belong to the account, not to one model.
    modelID: reason === 'quota' || reason === 'auth' ? '*' : model.id,
    until: reset !== undefined && reset > now ? reset : now + DEFAULT_BLOCK_MS[reason],
    reason,
  }
}

export function blockedUntil({
  blocks,
  providerID,
  credentialID,
  modelID,
  now,
}: {
  blocks: readonly Block[]
  providerID: string
  credentialID: string
  modelID: string
  now: number
}): number | undefined {
  const matching = blocks
    .filter((block) => block.until > now && block.providerID === providerID)
    .filter((block) => block.credentialID === '*' || block.credentialID === credentialID)
    .filter((block) => block.modelID === '*' || block.modelID === modelID)
    .map((block) => block.until)
  return matching.length > 0 ? Math.max(...matching) : undefined
}

export type Choice = { model: ModelRef; credentialID: string; waitUntil?: number }

// Best (model, account) pair that is not blocked. Ranking order wins over
// accounts; for one model the accounts are tried in the given order (active first).
// When everything is blocked, returns the pair that recovers first with `waitUntil`.
export function pick({
  ranking,
  accounts,
  blocks,
  now,
}: {
  ranking: readonly ModelRef[]
  accounts: Readonly<Record<string, readonly string[]>>
  blocks: readonly Block[]
  now: number
}): Choice | undefined {
  const candidates = ranking.flatMap((model) =>
    (accounts[model.providerID] ?? []).map((credentialID) => ({
      model,
      credentialID,
      until: blockedUntil({ blocks, providerID: model.providerID, credentialID, modelID: model.id, now }),
    })),
  )
  const free = candidates.find((candidate) => candidate.until === undefined)
  if (free) return { model: free.model, credentialID: free.credentialID }
  const first = candidates.reduce<(typeof candidates)[number] | undefined>(
    (best, candidate) => (!best || (candidate.until ?? 0) < (best.until ?? 0) ? candidate : best),
    undefined,
  )
  return first && { model: first.model, credentialID: first.credentialID, waitUntil: first.until }
}
