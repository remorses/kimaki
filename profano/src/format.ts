// Format profile analysis results as a terminal table.

import type { FunctionStat } from './parse.js'

/** Shorten file paths for display: strip node_modules prefix, project paths */
export function shortenPath(url: string): string {
  if (!url) {
    return '(native)'
  }
  // Strip to node_modules-relative path
  const nmIndex = url.lastIndexOf('/node_modules/')
  if (nmIndex !== -1) {
    return 'nm/' + url.slice(nmIndex + '/node_modules/'.length)
  }
  // Strip long absolute paths to last 2 segments
  const parts = url.split('/')
  if (parts.length > 3) {
    return parts.slice(-2).join('/')
  }
  return url
}

export function formatTable(opts: {
  functions: FunctionStat[]
  limit: number
  durationSeconds: number
  totalSamples: number
  nonIdleSamples: number
}): string {
  const { functions, limit, durationSeconds, totalSamples, nonIdleSamples } = opts
  const lines: string[] = []

  const idlePct = totalSamples > 0
    ? (((totalSamples - nonIdleSamples) / totalSamples) * 100).toFixed(1)
    : '0.0'

  lines.push(`Duration: ${durationSeconds.toFixed(2)}s`)
  lines.push(`Samples:  ${nonIdleSamples} active / ${totalSamples} total (${idlePct}% idle)`)
  lines.push('')
  lines.push(
    'Samples  %Active  Function                                    Location',
  )
  lines.push(
    '───────  ───────  ──────────────────────────────────────────  ────────────────────────────────',
  )

  const shown = functions.slice(0, limit)
  for (const fn of shown) {
    const samples = String(fn.selfSamples).padStart(7)
    const pct = fn.activePercent.toFixed(1).padStart(6) + '%'
    const name = fn.functionName.padEnd(42).slice(0, 42)
    const loc = shortenPath(fn.url) + (fn.lineNumber >= 0 ? ':' + fn.lineNumber : '')
    lines.push(`${samples}  ${pct}  ${name}  ${loc}`)
  }

  if (functions.length > limit) {
    lines.push(`  ... and ${functions.length - limit} more functions`)
  }

  return lines.join('\n')
}
