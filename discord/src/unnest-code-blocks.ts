// Unnest code blocks from list items for Discord.
// Discord doesn't render code blocks inside lists, so this hoists them
// to root level while preserving list structure.

import { Lexer, type Token, type Tokens } from 'marked'

type Segment =
  | { type: 'list-item'; prefix: string; content: string }
  | { type: 'code'; content: string }

export function unnestCodeBlocksFromLists(markdown: string): string {
  const lexer = new Lexer()
  const tokens = lexer.lex(markdown)

  const result: string[] = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    const next = tokens[i + 1]

    const chunk = (() => {
      if (token.type === 'list') {
        const segments = processListToken(token as Tokens.List)
        return renderSegments(segments)
      }
      return token.raw
    })()

    if (!chunk) {
      continue
    }

    const nextRaw = next?.raw ?? ''
    const needsNewline =
      nextRaw && !chunk.endsWith('\n') && typeof nextRaw === 'string' && !nextRaw.startsWith('\n')

    result.push(needsNewline ? chunk + '\n' : chunk)
  }
  return result.join('')
}

function processListToken(list: Tokens.List): Segment[] {
  const segments: Segment[] = []
  const start = typeof list.start === 'number' ? list.start : parseInt(list.start, 10) || 1
  const prefix = list.ordered ? (i: number) => `${start + i}. ` : () => '- '

  for (let i = 0; i < list.items.length; i++) {
    const item = list.items[i]!
    const itemSegments = processListItem(item, prefix(i))
    segments.push(...itemSegments)
  }

  return segments
}

function processListItem(item: Tokens.ListItem, prefix: string): Segment[] {
  const segments: Segment[] = []
  let currentText: string[] = []
  // Track if we've seen a code block - text after code uses continuation prefix
  let seenCodeBlock = false

  const flushText = (): void => {
    const text = currentText.join('').trim()
    if (text) {
      // After a code block, use '-' as continuation prefix to avoid repeating numbers
      const effectivePrefix = seenCodeBlock ? '- ' : prefix
      segments.push({ type: 'list-item', prefix: effectivePrefix, content: text })
    }
    currentText = []
  }

  for (const token of item.tokens) {
    if (token.type === 'code') {
      flushText()
      const codeToken = token as Tokens.Code
      const lang = codeToken.lang || ''
      segments.push({
        type: 'code',
        content: '```' + lang + '\n' + codeToken.text + '\n```\n',
      })
      seenCodeBlock = true
      continue
    }

    if (token.type === 'list') {
      flushText()
      // Recursively process nested list - segments bubble up
      const nestedSegments = processListToken(token as Tokens.List)
      segments.push(...nestedSegments)
      continue
    }

    // marked sometimes flattens fenced code blocks into non-code tokens (e.g. text/paragraph)
    // depending on indentation and list-item structure. Split out any fenced blocks that start
    // at the beginning of a line so we can hoist them for Discord.
    const raw = extractText(token)
    const parts = splitOutFencedCodeBlocks(raw)
    for (const part of parts) {
      if (part.type === 'code') {
        flushText()
        segments.push({ type: 'code', content: ensureTrailingNewline(part.content) })
        seenCodeBlock = true
        continue
      }
      currentText.push(part.content)
    }
  }

  flushText()

  // If no segments were created (empty item), return empty
  if (segments.length === 0) {
    return []
  }

  // If item had no code blocks (all segments are list-items from this level),
  // return original raw to preserve formatting
  const hasCode = segments.some((s) => s.type === 'code')
  if (!hasCode) {
    return [{ type: 'list-item', prefix: '', content: item.raw }]
  }

  return segments
}

function extractText(token: Token): string {
  // Prefer raw to preserve newlines and markdown markers.
  if ('raw' in token && typeof token.raw === 'string') {
    return token.raw
  }

  if (token.type === 'text') {
    return (token as Tokens.Text).text
  }

  return ''
}

type FencedSplitPart =
  | { type: 'text'; content: string }
  | { type: 'code'; content: string }

function ensureTrailingNewline(text: string): string {
  if (text.endsWith('\n')) {
    return text
  }
  return text + '\n'
}

function splitOutFencedCodeBlocks(text: string): FencedSplitPart[] {
  // Only treat fences that start at the beginning of a line (CommonMark-style).
  // This avoids mis-detecting inline "```" sequences inside regular text.
  const fenceRegex = /^ {0,3}```[^\n]*\n[\s\S]*?\n {0,3}```[^\n]*\n?/gm

  const parts: FencedSplitPart[] = []
  let lastIndex = 0

  while (true) {
    const match = fenceRegex.exec(text)
    if (!match) {
      break
    }

    const start = match.index
    const matched = match[0]
    const end = start + matched.length

    if (start > lastIndex) {
      parts.push({ type: 'text', content: text.slice(lastIndex, start) })
    }
    parts.push({ type: 'code', content: matched })
    lastIndex = end
  }

  if (lastIndex < text.length) {
    parts.push({ type: 'text', content: text.slice(lastIndex) })
  }

  return parts.length > 0 ? parts : [{ type: 'text', content: text }]
}

function renderSegments(segments: Segment[]): string {
  const result: string[] = []

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!
    const prev = segments[i - 1]

    if (segment.type === 'code') {
      // Add newline before code if previous was a list item
      if (prev && prev.type === 'list-item') {
        result.push('\n')
      }
      result.push(segment.content)
    } else {
      // list-item
      if (segment.prefix) {
        result.push(segment.prefix + segment.content + '\n')
      } else {
        // Raw content (no prefix means it's original raw)
        // Ensure raw ends with newline for proper separation from next segment
        const raw = segment.content.trimEnd()
        result.push(raw + '\n')
      }
    }
  }

  return result.join('').trimEnd()
}
