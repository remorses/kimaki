// Relative durations like `30m` or `2h` (`session wait --timeout`, `kimaki sleep --duration`).
// Dependency-light so the CLI can use it without loading bot modules.

import { ConfigError } from './errors.ts'

const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i
const DURATION_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }

// Milliseconds of a positive duration: a number plus ms, s, m, h, or d.
export function parseDuration(text: string): ConfigError | number {
  const trimmed = text.trim()
  const match = DURATION.exec(trimmed)
  if (!match) return new ConfigError({ reason: `Invalid duration "${trimmed}". Use a number plus ms, s, m, h, or d (example: 2h)` })
  const amount = Number(match[1]) * DURATION_MS[match[2]!.toLowerCase()]!
  if (!(amount > 0)) return new ConfigError({ reason: 'Duration must be greater than 0' })
  return amount
}
