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
    \`\`\`"
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
    \`\`\`"
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
    \`\`\`"
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
    - End text"
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
    \`\`\`"
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
    \`\`\`"
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

test('numbered list with multiple code blocks and text between', () => {
  const input = `1. First item
   \`\`\`js
   const a = 1
   \`\`\`
   Middle text
   \`\`\`python
   b = 2
   \`\`\`
   Final text
2. Second item`
  const result = unnestCodeBlocksFromLists(input)
  expect(result).toMatchInlineSnapshot(`
    "1. First item

    \`\`\`js
    const a = 1
    \`\`\`
    - Middle text

    \`\`\`python
    b = 2
    \`\`\`
    - Final text
    2. Second item"
  `)
})

test('unordered list with multiple code blocks and text between', () => {
  const input = `- First item
  \`\`\`js
  const a = 1
  \`\`\`
  Middle text
  \`\`\`python
  b = 2
  \`\`\`
  Final text
- Second item`
  const result = unnestCodeBlocksFromLists(input)
  expect(result).toMatchInlineSnapshot(`
    "- First item

    \`\`\`js
    const a = 1
    \`\`\`
    - Middle text

    \`\`\`python
    b = 2
    \`\`\`
    - Final text
    - Second item"
  `)
})

test('numbered list starting from 5', () => {
  const input = `5. Fifth item
   \`\`\`js
   code
   \`\`\`
   Text after
6. Sixth item`
  const result = unnestCodeBlocksFromLists(input)
  expect(result).toMatchInlineSnapshot(`
    "5. Fifth item

    \`\`\`js
    code
    \`\`\`
    - Text after
    6. Sixth item"
  `)
})

test('deeply nested list with code', () => {
  const input = `- Level 1
  - Level 2
    - Level 3
      \`\`\`js
      deep code
      \`\`\`
      Text after deep code
    - Another level 3
  - Back to level 2`
  const result = unnestCodeBlocksFromLists(input)
  expect(result).toMatchInlineSnapshot(`
    "- Level 1
    - Level 2
    - Level 3

    \`\`\`js
    deep code
    \`\`\`
    - Text after deep code
    - Another level 3
    - Back to level 2"
  `)
})

test('nested numbered list inside unordered with code', () => {
  const input = `- Unordered item
  1. Nested numbered
     \`\`\`js
     code
     \`\`\`
     Text after
  2. Second nested
- Another unordered`
  const result = unnestCodeBlocksFromLists(input)
  expect(result).toMatchInlineSnapshot(`
    "- Unordered item
    1. Nested numbered

    \`\`\`js
    code
    \`\`\`
    - Text after
    2. Second nested
    - Another unordered"
  `)
})

test('code block at end of numbered item no text after', () => {
  const input = `1. First with text
   \`\`\`js
   code here
   \`\`\`
2. Second item
3. Third item`
  const result = unnestCodeBlocksFromLists(input)
  expect(result).toMatchInlineSnapshot(`
    "1. First with text

    \`\`\`js
    code here
    \`\`\`
    2. Second item
    3. Third item"
  `)
})

test('multiple items each with code and text after', () => {
  const input = `1. First
   \`\`\`js
   code1
   \`\`\`
   After first
2. Second
   \`\`\`python
   code2
   \`\`\`
   After second
3. Third no code`
  const result = unnestCodeBlocksFromLists(input)
  expect(result).toMatchInlineSnapshot(`
    "1. First

    \`\`\`js
    code1
    \`\`\`
    - After first
    2. Second

    \`\`\`python
    code2
    \`\`\`
    - After second
    3. Third no code"
  `)
})

test('code block immediately after list marker', () => {
  const input = `1. \`\`\`js
   immediate code
   \`\`\`
2. Normal item`
  const result = unnestCodeBlocksFromLists(input)
  expect(result).toMatchInlineSnapshot(`
    "\`\`\`js
    immediate code
    \`\`\`
    2. Normal item"
  `)
})

test('code block with filename metadata', () => {
  const input = `- Item with code
  \`\`\`tsx filename=example.tsx
  const x = 1
  \`\`\``
  const result = unnestCodeBlocksFromLists(input)
  expect(result).toMatchInlineSnapshot(`
    "- Item with code

    \`\`\`tsx filename=example.tsx
    const x = 1
    \`\`\`"
  `)
})

test('numbered list with filename metadata code block', () => {
  const input = `1. First item
   \`\`\`tsx filename=app.tsx
   export default function App() {}
   \`\`\`
2. Second item`
  const result = unnestCodeBlocksFromLists(input)
  expect(result).toMatchInlineSnapshot(`
    "1. First item

    \`\`\`tsx filename=app.tsx
    export default function App() {}
    \`\`\`
    2. Second item"
  `)
})
