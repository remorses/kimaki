// Two-stage classifier parse. Stage 1 is one token. Stage 2 is exact JSON.

export type FastDecision = 'allow' | 'review' | 'invalid'

export type DetailedDecision =
  | { decision: 'allow'; reason: string }
  | { decision: 'block'; reason: string }
  | undefined

export function parseFastDecision(text: string): FastDecision {
  const trimmed = text.trim()
  if (trimmed === '0') return 'allow'
  if (trimmed === '1') return 'review'
  return 'invalid'
}

export function parseDetailedDecision(text: string): DetailedDecision {
  const trimmed = text.trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const keys = Object.keys(parsed).sort()
  if (keys.join(',') !== 'decision,reason') return undefined
  const record = parsed as { decision?: unknown; reason?: unknown }
  if (record.decision !== 'allow' && record.decision !== 'block') return undefined
  if (typeof record.reason !== 'string' || record.reason.trim() === '') return undefined
  return { decision: record.decision, reason: record.reason }
}

export const FAST_INSTRUCTION =
  'Return exactly one digit and nothing else: 0 only when the action is clearly allowed; 1 when it may need blocking or you are uncertain. Err on 1.'

export const DETAILED_INSTRUCTION =
  'Return only JSON with keys decision and reason. decision must be allow or block. reason must be a brief concrete sentence. No extra keys.'
