// Limit heading depth for Discord.
// Discord only supports headings up to ### (h3), so this converts
// ####, #####, etc. to ### to maintain consistent rendering.

import { Lexer, type Tokens } from 'marked'

export function limitHeadingDepth(markdown: string, maxDepth = 3): string {
  const lexer = new Lexer()
  const tokens = lexer.lex(markdown)

  let result = ''
  for (const token of tokens) {
    if (token.type === 'heading') {
      const heading = token as Tokens.Heading
      if (heading.depth > maxDepth) {
        const hashes = '#'.repeat(maxDepth)
        result += hashes + ' ' + heading.text + '\n'
      } else {
        result += token.raw
      }
    } else {
      result += token.raw
    }
  }
  return result
}
