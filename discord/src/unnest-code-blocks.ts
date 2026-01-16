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
  for (const token of tokens) {
    if (token.type === 'list') {
      const segments = processListToken(token as Tokens.List)
      result.push(renderSegments(segments))
    } else {
      result.push(token.raw)
    }
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
    } else if (token.type === 'list') {
      flushText()
      // Recursively process nested list - segments bubble up
      const nestedSegments = processListToken(token as Tokens.List)
      segments.push(...nestedSegments)
    } else {
      currentText.push(extractText(token))
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
  if (token.type === 'text') {
    return (token as Tokens.Text).text
  }
  if (token.type === 'space') {
    return ''
  }
  if ('raw' in token) {
    return token.raw
  }
  return ''
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
