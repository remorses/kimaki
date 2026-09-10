// Utility to condense MEMORY.md into a line-numbered table of contents.
// Keep this out of plugin entry files. OpenCode calls every export as a plugin.

import { Lexer } from 'marked'

/**
 * Condense MEMORY.md into a line-numbered table of contents.
 * Parses markdown AST with marked's Lexer, emits each heading prefixed by
 * its source line number, and collapses non-heading content to `...`.
 * The agent can then use Read with offset/limit to read specific sections.
 */
export function condenseMemoryMd(content: string): string {
  const tokens = new Lexer().lex(content)
  const lines: string[] = []
  let charOffset = 0
  let lastWasEllipsis = false

  for (const token of tokens) {
    // Compute 1-based line number from character offset
    const lineNumber = content.slice(0, charOffset).split('\n').length
    if (token.type === 'heading') {
      const prefix = '#'.repeat(token.depth)
      lines.push(`${lineNumber}: ${prefix} ${token.text}`)
      lastWasEllipsis = false
    } else if (!lastWasEllipsis) {
      lines.push('...')
      lastWasEllipsis = true
    }
    charOffset += token.raw.length
  }

  return lines.join('\n')
}
