import { test, expect, describe } from 'vitest'
import { splitTablesFromMarkdown, buildTableComponents, type ContentSegment } from './format-tables.js'
import { Lexer, type Tokens } from 'marked'

function parseTable(markdown: string): Tokens.Table {
  const lexer = new Lexer()
  const tokens = lexer.lex(markdown)
  return tokens.find((t) => t.type === 'table') as Tokens.Table
}

/** Extract the first container's children from buildTableComponents result */
function getContainerChildren(
  segments: ContentSegment[],
): { type: number; content?: string; divider?: boolean; spacing?: number }[] {
  const seg = segments[0]!
  if (seg.type !== 'components') {
    throw new Error('Expected components segment')
  }
  const container = seg.components[0] as { type: number; components: unknown[] }
  return container.components as { type: number; content?: string; divider?: boolean; spacing?: number }[]
}

describe('buildTableComponents', () => {
  test('builds container with key-value TextDisplays', () => {
    const table = parseTable(`| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |`)
    const result = buildTableComponents(table)
    expect(result).toMatchInlineSnapshot(`
      [
        {
          "components": [
            {
              "components": [
                {
                  "content": "**Name** Alice
      **Age** 30",
                  "type": 10,
                },
                {
                  "divider": true,
                  "spacing": 1,
                  "type": 14,
                },
                {
                  "content": "**Name** Bob
      **Age** 25",
                  "type": 10,
                },
              ],
              "type": 17,
            },
          ],
          "type": "components",
        },
      ]
    `)
  })

  test('adds separators between row groups', () => {
    const table = parseTable(`| Key | Value |
| --- | --- |
| a | 1 |
| b | 2 |
| c | 3 |`)
    const result = buildTableComponents(table)
    const types = getContainerChildren(result).map((c) => c.type)
    // type 10 = TextDisplay, type 14 = Separator
    expect(types).toMatchInlineSnapshot(`
      [
        10,
        14,
        10,
        14,
        10,
      ]
    `)
  })

  test('single-row table has one TextDisplay, no separators', () => {
    const table = parseTable(`| Method | Endpoint |
| --- | --- |
| GET | /api/users |`)
    const result = buildTableComponents(table)
    const children = getContainerChildren(result)
    expect(children).toHaveLength(1)
    expect(children[0]!.type).toBe(10)
    expect(children[0]!.content).toMatchInlineSnapshot(`
      "**Method** GET
      **Endpoint** /api/users"
    `)
  })

  test('splits large table into multiple container segments', () => {
    // 25 rows: exceeds 19 rows per container, so splits into 2 containers
    const headers = '| A | B |'
    const sep = '| --- | --- |'
    const rows = Array.from({ length: 25 }, (_, i) => {
      return `| ${i}a | ${i}b |`
    }).join('\n')
    const table = parseTable(`${headers}\n${sep}\n${rows}`)
    const result = buildTableComponents(table)
    expect(result).toHaveLength(2)
    expect(result[0]!.type).toBe('components')
    expect(result[1]!.type).toBe('components')
    // First container has 19 rows (19 TDs + 18 seps = 37 children)
    const firstChildren = getContainerChildren([result[0]!])
    expect(firstChildren).toHaveLength(19 + 18)
    // Second container has 6 rows (6 TDs + 5 seps = 11 children)
    const secondChildren = getContainerChildren([result[1]!])
    expect(secondChildren).toHaveLength(6 + 5)
  })

  test('strips formatting from cells', () => {
    const table = parseTable(`| Header | Value |
| --- | --- |
| **Bold text** | Normal |
| *Italic* | \`code\` |`)
    const result = buildTableComponents(table)
    const children = getContainerChildren(result)
    expect(children[0]!.content).toMatchInlineSnapshot(`
      "**Header** Bold text
      **Value** Normal"
    `)
  })
})

describe('splitTablesFromMarkdown', () => {
  test('returns single text segment for content without tables', () => {
    const result = splitTablesFromMarkdown('Just some text.\n\nMore text.')
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe('text')
  })

  test('returns single components segment for table-only content', () => {
    const result = splitTablesFromMarkdown(`| A | B |
| --- | --- |
| 1 | 2 |`)
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe('components')
  })

  test('splits text before and after table into separate segments', () => {
    const result = splitTablesFromMarkdown(`Text before.

| Key | Value |
| --- | --- |
| a | 1 |

Text after.`)
    expect(result).toHaveLength(3)
    expect(result[0]!.type).toBe('text')
    expect(result[1]!.type).toBe('components')
    expect(result[2]!.type).toBe('text')
  })

  test('handles multiple tables with text between', () => {
    const result = splitTablesFromMarkdown(`First table:

| A | B |
| --- | --- |
| 1 | 2 |

Middle text.

| X | Y |
| --- | --- |
| a | b |`)
    expect(result).toHaveLength(4)
    expect(result.map((s) => s.type)).toMatchInlineSnapshot(`
      [
        "text",
        "components",
        "text",
        "components",
      ]
    `)
  })

  test('splits oversized table into multiple component segments', () => {
    const headers = '| A | B |'
    const sep = '| --- | --- |'
    const rows = Array.from({ length: 25 }, (_, i) => {
      return `| ${i}a | ${i}b |`
    }).join('\n')
    const result = splitTablesFromMarkdown(`${headers}\n${sep}\n${rows}`)
    // 25 rows splits into 2 container segments
    expect(result).toHaveLength(2)
    expect(result.every((s) => s.type === 'components')).toBe(true)
  })

  test('preserves code blocks alongside tables', () => {
    const result = splitTablesFromMarkdown(`Some code:

\`\`\`js
const x = 1
\`\`\`

| Key | Value |
| --- | --- |
| a | 1 |

Done.`)
    const types = result.map((s) => s.type)
    expect(types).toMatchInlineSnapshot(`
      [
        "text",
        "components",
        "text",
      ]
    `)
  })
})
