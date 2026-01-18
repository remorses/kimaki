// Markdown table to code block converter.
// Discord doesn't render GFM tables, so this converts them to
// space-aligned code blocks for proper monospace display.

import { Lexer, type Token, type Tokens } from 'marked'

export function formatMarkdownTables(markdown: string): string {
  const lexer = new Lexer()
  const tokens = lexer.lex(markdown)

  let result = ''
  for (const token of tokens) {
    if (token.type === 'table') {
      result += formatTableToken(token as Tokens.Table)
    } else {
      result += token.raw
    }
  }
  return result
}

function formatTableToken(table: Tokens.Table): string {
  const headers = table.header.map((cell) => {
    return extractCellText(cell.tokens)
  })
  const rows = table.rows.map((row) => {
    return row.map((cell) => {
      return extractCellText(cell.tokens)
    })
  })

  const columnWidths = calculateColumnWidths(headers, rows)
  const lines: string[] = []

  lines.push(formatRow(headers, columnWidths))
  lines.push(formatSeparator(columnWidths))
  for (const row of rows) {
    lines.push(formatRow(row, columnWidths))
  }

  return '```\n' + lines.join('\n') + '\n```\n'
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

function calculateColumnWidths(headers: string[], rows: string[][]): number[] {
  const widths = headers.map((h) => {
    return h.length
  })
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const cell = row[i] ?? ''
      widths[i] = Math.max(widths[i] ?? 0, cell.length)
    }
  }
  return widths
}

function formatRow(cells: string[], widths: number[]): string {
  const paddedCells = cells.map((cell, i) => {
    return cell.padEnd(widths[i] ?? 0)
  })
  return paddedCells.join(' ')
}

function formatSeparator(widths: number[]): string {
  return widths
    .map((w) => {
      return '-'.repeat(w)
    })
    .join(' ')
}
