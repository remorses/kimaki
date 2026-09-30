// Input parsers: every Discord input becomes one Route (spec 9.4). Pure.
// Phase 1 knows only `steer`; queue, btw, shell and commands arrive in
// phases 3, 5 and 6.

export type Route = {
  kind: 'steer'
  text: string
}

export function parseTextMessage({ content }: { content: string }): Route | null {
  const text = content.trim()
  if (!text) return null
  return { kind: 'steer', text }
}
