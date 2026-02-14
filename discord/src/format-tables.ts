// Markdown table formatter for Discord.
// Converts GFM tables to Discord Components V2 (ContainerBuilder with TextDisplay
// key-value pairs and Separators between row groups). Large tables are split
// across multiple Container components to stay within the 40-component limit.

import { Lexer, type Token, type Tokens } from 'marked'
import {
  SeparatorSpacingSize,
  type APIContainerComponent,
  type APITextDisplayComponent,
  type APISeparatorComponent,
  type APIMessageTopLevelComponent,
} from 'discord.js'

export type ContentSegment =
  | { type: 'text'; text: string }
  | { type: 'components'; components: APIMessageTopLevelComponent[] }

// Max 40 components per message (nested components count toward the limit).
// Each container uses: 1 (container) + M (TextDisplays) + M-1 (separators) = 2M children.
// So max rows per container = floor((40 - 1) / 2) = 19.
const MAX_COMPONENTS = 40
const MAX_ROWS_PER_CONTAINER = Math.floor((MAX_COMPONENTS - 1) / 2)

/**
 * Split markdown into text and table component segments.
 * Tables are rendered as CV2 Container components with bold key-value TextDisplay
 * pairs. Large tables are split across multiple component segments.
 */
export function splitTablesFromMarkdown(markdown: string): ContentSegment[] {
  const lexer = new Lexer()
  const tokens = lexer.lex(markdown)
  const segments: ContentSegment[] = []
  let textBuffer = ''

  for (const token of tokens) {
    if (token.type === 'table') {
      if (textBuffer.trim()) {
        segments.push({ type: 'text', text: textBuffer })
        textBuffer = ''
      }
      const componentSegments = buildTableComponents(token as Tokens.Table)
      segments.push(...componentSegments)
    } else {
      textBuffer += token.raw
    }
  }

  if (textBuffer.trim()) {
    segments.push({ type: 'text', text: textBuffer })
  }

  return segments
}

/**
 * Build CV2 components for a table. Each data row becomes a single TextDisplay
 * with all key-value pairs joined by newlines (header bold as key). Separator
 * dividers are placed between row groups.
 * Large tables are split into multiple component segments, each containing a
 * Container with up to MAX_ROWS_PER_CONTAINER rows.
 */
export function buildTableComponents(table: Tokens.Table): ContentSegment[] {
  const headers = table.header.map((cell) => {
    return extractCellText(cell.tokens)
  })
  const rows = table.rows.map((row) => {
    return row.map((cell) => {
      return extractCellText(cell.tokens)
    })
  })

  // Split rows into chunks that fit within the component limit
  const chunks: string[][][] = []
  for (let i = 0; i < rows.length; i += MAX_ROWS_PER_CONTAINER) {
    chunks.push(rows.slice(i, i + MAX_ROWS_PER_CONTAINER))
  }

  return chunks.map((chunkRows) => {
    const children: (APITextDisplayComponent | APISeparatorComponent)[] = []

    for (let i = 0; i < chunkRows.length; i++) {
      if (i > 0) {
        children.push({ type: 14, divider: true, spacing: SeparatorSpacingSize.Small })
      }
      const row = chunkRows[i]!
      const lines = headers.map((key, j) => {
        const value = row[j] || ''
        return `**${key}** ${value}`
      })
      children.push({ type: 10, content: lines.join('\n') })
    }

    const container: APIContainerComponent = {
      type: 17,
      components: children,
    }

    return { type: 'components' as const, components: [container] as APIMessageTopLevelComponent[] }
  })
}

function extractCellText(tokens: Token[]): string {
  const parts: string[] = []
  for (const token of tokens) {
    parts.push(extractTokenText(token))
  }
  return parts.join('').trim()
}

function extractTokenText(token: Token): string {
  switch (token.type) {
    case 'text':
    case 'codespan':
    case 'escape':
      return token.text
    case 'link':
      return token.href
    case 'image':
      return token.href
    case 'strong':
    case 'em':
    case 'del':
      return token.tokens ? extractCellText(token.tokens) : token.text
    case 'br':
      return ' '
    default: {
      const tokenAny = token as { tokens?: Token[]; text?: string }
      if (tokenAny.tokens && Array.isArray(tokenAny.tokens)) {
        return extractCellText(tokenAny.tokens)
      }
      if (typeof tokenAny.text === 'string') {
        return tokenAny.text
      }
      return ''
    }
  }
}
