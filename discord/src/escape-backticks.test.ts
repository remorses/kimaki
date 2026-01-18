import { test, expect } from 'vitest'
import { Lexer } from 'marked'
import { escapeBackticksInCodeBlocks, splitMarkdownForDiscord } from './discord-utils.js'

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

test('splitMarkdownForDiscord returns single chunk for short content', () => {
  const result = splitMarkdownForDiscord({
    content: 'Hello world',
    maxLength: 100,
  })
  expect(result).toMatchInlineSnapshot(`
    [
      "Hello world",
    ]
  `)
})

test('splitMarkdownForDiscord splits at line boundaries', () => {
  const result = splitMarkdownForDiscord({
    content: 'Line 1\nLine 2\nLine 3\nLine 4',
    maxLength: 15,
  })
  expect(result).toMatchInlineSnapshot(`
    [
      "Line 1
    Line 2
    ",
      "Line 3
    Line 4",
    ]
  `)
})

test('splitMarkdownForDiscord preserves code blocks when not split', () => {
  const result = splitMarkdownForDiscord({
    content: '```js\nconst x = 1\n```',
    maxLength: 100,
  })
  expect(result).toMatchInlineSnapshot(`
    [
      "\`\`\`js
    const x = 1
    \`\`\`",
    ]
  `)
})

test('splitMarkdownForDiscord adds closing and opening fences when splitting code block', () => {
  const result = splitMarkdownForDiscord({
    content: '```js\nline1\nline2\nline3\nline4\n```',
    maxLength: 20,
  })
  expect(result).toMatchInlineSnapshot(`
    [
      "\`\`\`js
    line1
    line2
    \`\`\`
    ",
      "\`\`\`js
    line3
    line4
    \`\`\`
    ",
    ]
  `)
})

test('splitMarkdownForDiscord handles code block with language', () => {
  const result = splitMarkdownForDiscord({
    content: '```typescript\nconst a = 1\nconst b = 2\n```',
    maxLength: 30,
  })
  expect(result).toMatchInlineSnapshot(`
    [
      "\`\`\`typescript
    const a = 1
    \`\`\`
    ",
      "\`\`\`typescript
    const b = 2
    \`\`\`
    ",
    ]
  `)
})

test('splitMarkdownForDiscord handles mixed content with code blocks', () => {
  const result = splitMarkdownForDiscord({
    content: 'Text before\n```js\ncode\n```\nText after',
    maxLength: 25,
  })
  expect(result).toMatchInlineSnapshot(`
    [
      "Text before
    \`\`\`js
    code
    \`\`\`
    ",
      "Text after",
    ]
  `)
})

test('splitMarkdownForDiscord handles code block without language', () => {
  const result = splitMarkdownForDiscord({
    content: '```\nline1\nline2\n```',
    maxLength: 12,
  })
  expect(result).toMatchInlineSnapshot(`
    [
      "\`\`\`
    line1
    \`\`\`
    ",
      "\`\`\`
    line2
    \`\`\`
    ",
    ]
  `)
})

test('splitMarkdownForDiscord handles multiple consecutive code blocks', () => {
  const result = splitMarkdownForDiscord({
    content: '```js\nfoo\n```\n```py\nbar\n```',
    maxLength: 20,
  })
  expect(result).toMatchInlineSnapshot(`
    [
      "\`\`\`js
    foo
    \`\`\`
    \`\`\`py
    \`\`\`
    ",
      "\`\`\`py
    bar
    \`\`\`
    ",
    ]
  `)
})

test('splitMarkdownForDiscord handles empty code block', () => {
  const result = splitMarkdownForDiscord({
    content: 'before\n```\n```\nafter',
    maxLength: 50,
  })
  expect(result).toMatchInlineSnapshot(`
    [
      "before
    \`\`\`
    \`\`\`
    after",
    ]
  `)
})

test('splitMarkdownForDiscord handles content exactly at maxLength', () => {
  const result = splitMarkdownForDiscord({
    content: '12345678901234567890',
    maxLength: 20,
  })
  expect(result).toMatchInlineSnapshot(`
    [
      "12345678901234567890",
    ]
  `)
})

test('splitMarkdownForDiscord handles code block only', () => {
  const result = splitMarkdownForDiscord({
    content: '```ts\nconst x = 1\n```',
    maxLength: 15,
  })
  expect(result).toMatchInlineSnapshot(`
    [
      "\`\`\`ts
    \`\`\`
    ",
      "\`\`\`ts
    const x = 1
    \`\`\`
    ",
    ]
  `)
})

test('splitMarkdownForDiscord handles code block at start with text after', () => {
  const result = splitMarkdownForDiscord({
    content: '```js\ncode\n```\nSome text after',
    maxLength: 20,
  })
  expect(result).toMatchInlineSnapshot(`
    [
      "\`\`\`js
    code
    \`\`\`
    ",
      "Some text after",
    ]
  `)
})

test('splitMarkdownForDiscord handles text before code block at end', () => {
  const result = splitMarkdownForDiscord({
    content: 'Some text before\n```js\ncode\n```',
    maxLength: 25,
  })
  expect(result).toMatchInlineSnapshot(`
    [
      "Some text before
    \`\`\`js
    \`\`\`
    ",
      "\`\`\`js
    code
    \`\`\`
    ",
    ]
  `)
})

test('splitMarkdownForDiscord handles very long line inside code block', () => {
  const result = splitMarkdownForDiscord({
    content: '```js\nshort\nveryverylonglinethatexceedsmaxlength\nshort\n```',
    maxLength: 25,
  })
  expect(result).toMatchInlineSnapshot(`
    [
      "\`\`\`js
    short
    \`\`\`
    ",
      "\`\`\`js
    veryverylo\`\`\`
    ",
      "\`\`\`js
    nglinethat\`\`\`
    ",
      "\`\`\`js
    exceedsmax\`\`\`
    ",
      "\`\`\`js
    length
    \`\`\`
    ",
      "short
    \`\`\`
    ",
    ]
  `)
})

test('splitMarkdownForDiscord handles realistic long markdown with code block', () => {
  const content = `Here is some explanation text before the code.

\`\`\`typescript
export function calculateTotal(items: Item[]): number {
  let total = 0
  for (const item of items) {
    total += item.price * item.quantity
  }
  return total
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount)
}
\`\`\`

And here is some text after the code block.`

  const result = splitMarkdownForDiscord({
    content,
    maxLength: 200,
  })
  expect(result).toMatchInlineSnapshot(`
    [
      "Here is some explanation text before the code.

    \`\`\`typescript
    export function calculateTotal(items: Item[]): number {
      let total = 0
      for (const item of items) {
    \`\`\`
    ",
      "\`\`\`typescript
        total += item.price * item.quantity
      }
      return total
    }

    export function formatCurrency(amount: number): string {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
    \`\`\`
    ",
      "\`\`\`typescript
        currency: 'USD',
      }).format(amount)
    }
    \`\`\`


    And here is some text after the code block.",
    ]
  `)
})
