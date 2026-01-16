import { test, expect } from 'vitest'
import { unnestCodeBlocksFromLists } from './unnest-code-blocks.js'

test('basic - single item with code block', () => {
  const input = `- Item 1
  \`\`\`js
  const x = 1
  \`\`\``
  const result = unnestCodeBlocksFromLists(input)
  expect(result).toMatchInlineSnapshot(`
    "- Item 1

    \`\`\`js
    const x = 1
    \`\`\`
    "
  `)
})

test('multiple items - code in middle item only', () => {
  const input = `- Item 1
- Item 2
  \`\`\`js
  const x = 1
  \`\`\`
- Item 3`
  const result = unnestCodeBlocksFromLists(input)
  expect(result).toMatchInlineSnapshot(`
    "- Item 1
    - Item 2

    \`\`\`js
    const x = 1
    \`\`\`
    - Item 3"
  `)
})

test('multiple code blocks in one item', () => {
  const input = `- Item with two code blocks
  \`\`\`js
  const a = 1
  \`\`\`
  \`\`\`python
  b = 2
  \`\`\``
  const result = unnestCodeBlocksFromLists(input)
  expect(result).toMatchInlineSnapshot(`
    "- Item with two code blocks

    \`\`\`js
    const a = 1
    \`\`\`
    \`\`\`python
    b = 2
    \`\`\`
    "
  `)
})

test('nested list with code', () => {
  const input = `- Item 1
  - Nested item
    \`\`\`js
    const x = 1
    \`\`\`
- Item 2`
  const result = unnestCodeBlocksFromLists(input)
  expect(result).toMatchInlineSnapshot(`
    "- Item 1
    - Nested item

    \`\`\`js
    const x = 1
    \`\`\`
    - Item 2"
  `)
})

test('ordered list preserves numbering', () => {
  const input = `1. First item
   \`\`\`js
   const a = 1
   \`\`\`
2. Second item
3. Third item`
  const result = unnestCodeBlocksFromLists(input)
  expect(result).toMatchInlineSnapshot(`
    "1. First item

    \`\`\`js
    const a = 1
    \`\`\`
    2. Second item
    3. Third item"
  `)
})

test('list without code blocks unchanged', () => {
  const input = `- Item 1
- Item 2
- Item 3`
  const result = unnestCodeBlocksFromLists(input)
  expect(result).toMatchInlineSnapshot(`
    "- Item 1
    - Item 2
    - Item 3"
  `)
})

test('mixed - some items have code, some dont', () => {
  const input = `- Normal item
- Item with code
  \`\`\`js
  const x = 1
  \`\`\`
- Another normal item
- Another with code
  \`\`\`python
  y = 2
  \`\`\``
  const result = unnestCodeBlocksFromLists(input)
  expect(result).toMatchInlineSnapshot(`
    "- Normal item
    - Item with code

    \`\`\`js
    const x = 1
    \`\`\`
    - Another normal item
    - Another with code

    \`\`\`python
    y = 2
    \`\`\`
    "
  `)
})

test('text before and after code in same item', () => {
  const input = `- Start text
  \`\`\`js
  const x = 1
  \`\`\`
  End text`
  const result = unnestCodeBlocksFromLists(input)
  expect(result).toMatchInlineSnapshot(`
    "- Start text

    \`\`\`js
    const x = 1
    \`\`\`
    - End text
    "
  `)
})

test('preserves content outside lists', () => {
  const input = `# Heading

Some paragraph text.

- List item
  \`\`\`js
  const x = 1
  \`\`\`

More text after.`
  const result = unnestCodeBlocksFromLists(input)
  expect(result).toMatchInlineSnapshot(`
    "# Heading

    Some paragraph text.

    - List item

    \`\`\`js
    const x = 1
    \`\`\`


    More text after."
  `)
})

test('code block at root level unchanged', () => {
  const input = `\`\`\`js
const x = 1
\`\`\``
  const result = unnestCodeBlocksFromLists(input)
  expect(result).toMatchInlineSnapshot(`
    "\`\`\`js
    const x = 1
    \`\`\`"
  `)
})

test('handles code block without language', () => {
  const input = `- Item
  \`\`\`
  plain code
  \`\`\``
  const result = unnestCodeBlocksFromLists(input)
  expect(result).toMatchInlineSnapshot(`
    "- Item

    \`\`\`
    plain code
    \`\`\`
    "
  `)
})

test('handles empty list item with code', () => {
  const input = `- \`\`\`js
  const x = 1
  \`\`\``
  const result = unnestCodeBlocksFromLists(input)
  expect(result).toMatchInlineSnapshot(`
    "\`\`\`js
    const x = 1
    \`\`\`
    "
  `)
})

test('numbered list with text after code block', () => {
  const input = `1. First item
   \`\`\`js
   const a = 1
   \`\`\`
   Text after the code
2. Second item`
  const result = unnestCodeBlocksFromLists(input)
  expect(result).toMatchInlineSnapshot(`
    "1. First item

    \`\`\`js
    const a = 1
    \`\`\`
    - Text after the code
    2. Second item"
  `)
})
