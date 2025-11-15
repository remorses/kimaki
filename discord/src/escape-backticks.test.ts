import { test, expect } from 'vitest'
import { Lexer } from 'marked'
import { escapeBackticksInCodeBlocks } from './discordBot.js'



test('escapes single backticks in code blocks', () => {
  const input = '```js\nconst x = `hello`\n```'
  const result = escapeBackticksInCodeBlocks(input)

  expect(result).toMatchInlineSnapshot(`
"\`\`\`js
const x = \\\`hello\\\`
\`\`\`
"
`)
})

test('escapes backticks in code blocks with language', () => {
  const input = '```typescript\nconst greeting = `Hello, ${name}!`\nconst inline = `test`\n```'
  const result = escapeBackticksInCodeBlocks(input)

  expect(result).toMatchInlineSnapshot(`
"\`\`\`typescript
const greeting = \\\`Hello, \${name}!\\\`
const inline = \\\`test\\\`
\`\`\`
"
`)
})

test('does not escape backticks outside code blocks', () => {
  const input = 'This is `inline code` and this is a code block:\n```\nconst x = `template`\n```'
  const result = escapeBackticksInCodeBlocks(input)

  expect(result).toMatchInlineSnapshot(`
"This is \`inline code\` and this is a code block:
\`\`\`
const x = \\\`template\\\`
\`\`\`
"
`)
})

test('handles multiple code blocks', () => {
  const input = `First block:
\`\`\`js
const a = \`test\`
\`\`\`

Some text with \`inline\` code

Second block:
\`\`\`python
name = f\`hello {world}\`
\`\`\``

  const result = escapeBackticksInCodeBlocks(input)

  expect(result).toMatchInlineSnapshot(`
"First block:
\`\`\`js
const a = \\\`test\\\`
\`\`\`


Some text with \`inline\` code

Second block:
\`\`\`python
name = f\\\`hello {world}\\\`
\`\`\`
"
`)
})

test('handles code blocks without language', () => {
  const input = '```\nconst x = `value`\n```'
  const result = escapeBackticksInCodeBlocks(input)

  expect(result).toMatchInlineSnapshot(`
"\`\`\`
const x = \\\`value\\\`
\`\`\`
"
`)
})

test('handles nested backticks in code blocks', () => {
  const input = '```js\nconst nested = `outer ${`inner`} text`\n```'
  const result = escapeBackticksInCodeBlocks(input)

  expect(result).toMatchInlineSnapshot(`
"\`\`\`js
const nested = \\\`outer \${\\\`inner\\\`} text\\\`
\`\`\`
"
`)
})

test('preserves markdown outside code blocks', () => {
  const input = `# Heading

This is **bold** and *italic* text

\`\`\`js
const code = \`with template\`
\`\`\`

- List item 1
- List item 2`

  const result = escapeBackticksInCodeBlocks(input)

  expect(result).toMatchInlineSnapshot(`
"# Heading

This is **bold** and *italic* text

\`\`\`js
const code = \\\`with template\\\`
\`\`\`


- List item 1
- List item 2"
`)
})

test('does not escape code block delimiter backticks', () => {
  const input = '```js\nconst x = `hello`\n```'
  const result = escapeBackticksInCodeBlocks(input)

  expect(result.startsWith('```')).toBe(true)
  expect(result.endsWith('```\n')).toBe(true)
  expect(result).toContain('\\`hello\\`')
  expect(result).not.toContain('\\`\\`\\`js')
  expect(result).not.toContain('\\`\\`\\`\n')

  expect(result).toMatchInlineSnapshot(`
"\`\`\`js
const x = \\\`hello\\\`
\`\`\`
"
`)
})
