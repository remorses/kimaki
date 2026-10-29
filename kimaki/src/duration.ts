// Relative durations like `30m`, `2h` or `1 hour` (`session wait --timeout`, `kimaki sleep --duration`).
// Dependency-light so the CLI can use it without loading bot modules.

import { ConfigError } from './errors.ts'

const DURATION = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/i
const UNITS: ReadonlyArray<[number, string[]]> = [
  [1, ['ms', 'milli', 'millis']],
  [1_000, ['s', 'second', 'seconds']],
  [60_000, ['m', 'minute', 'minutes']],
  [3_600_000, ['h', 'hour', 'hours']],
  [86_400_000, ['d', 'day', 'days']],
]
const DURATION_MS = new Map(UNITS.flatMap(([ms, names]) => names.map((name) => [name, ms] as const)))

// Milliseconds of a positive duration: a number plus ms, s, m, h, or d.
// `label` names the input in errors, for example a flag like `--duration`.
export function parseDuration(text: string, label = 'duration'): ConfigError | number {
  const trimmed = text.trim()
  const match = DURATION.exec(trimmed)
  const unit = match ? DURATION_MS.get(match[2]!.toLowerCase()) : undefined
  if (!match || !unit) return new ConfigError({ reason: `Invalid ${label} "${trimmed}". Use a number plus ms, s, m, h, or d (example: 2h)` })
  const amount = Number(match[1]) * unit
  if (!(amount > 0)) return new ConfigError({ reason: `${label.charAt(0).toUpperCase()}${label.slice(1)} must be greater than 0` })
  return amount
}
