// Pure formatting of the bot's own lines: banner, footer, error line.
// Everything non-text is Discord subtext (`-# `).

export function asSubtext(text: string): string {
  return `-# ${text}`
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return '<1s'
  const seconds = Math.floor(ms / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export type ModelRef = { providerID: string; id: string }

export function formatBanner({ model, agent }: { model: ModelRef; agent: string }): string {
  return asSubtext(`*using ${model.providerID}/${model.id} ⋅ ${agent}*`)
}

export function formatFooter({
  folder,
  branch,
  durationMs,
  contextPercent,
  model,
  agent,
}: {
  folder: string
  branch: string | null
  durationMs: number
  contextPercent: number | null
  model: ModelRef | null
  agent: string | null
}): string {
  const parts = [
    folder,
    branch,
    formatDuration(durationMs),
    contextPercent === null ? null : `${contextPercent}%`,
    model?.id ?? null,
    agent && agent !== 'build' ? agent : null,
  ].filter((part): part is string => Boolean(part))
  return asSubtext(`*${parts.join(' ⋅ ')}*`)
}

export function formatError(message: string): string {
  const text = message.trim() || 'unknown error'
  return `✗ ${text.length > 400 ? `${text.slice(0, 399)}…` : text}`
}
