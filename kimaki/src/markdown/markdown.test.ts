// Snapshot tests of the markdown pipeline on realistic model outputs.

import dedent from 'string-dedent'
import { expect, test } from 'vitest'

import { markdownPayloads } from './components.ts'
import { renderMarkdown } from './render-markdown.ts'

test('GFM table with links and inline code becomes a table segment and components', () => {
  const text = dedent`
    Here is the summary:

    | File | Change |
    | --- | --- |
    | \`src/a.ts\` | added [docs](https://kimaki.dev) link |
    | \`src/b.ts\` | removed \`x \\| y\` escaping |

    Done.
  `
  expect(renderMarkdown(text)).toMatchInlineSnapshot(`
    [
      {
        "kind": "text",
        "markdown": "Here is the summary:",
      },
      {
        "header": [
          "File",
          "Change",
        ],
        "kind": "table",
        "rows": [
          [
            "\`src/a.ts\`",
            "added [docs](https://kimaki.dev) link",
          ],
          [
            "\`src/b.ts\`",
            "removed \`x | y\` escaping",
          ],
        ],
      },
      {
        "kind": "text",
        "markdown": "Done.",
      },
    ]
  `)
  expect(markdownPayloads(text)).toMatchInlineSnapshot(`
    [
      {
        "content": "Here is the summary:",
      },
      {
        "components": [
          {
            "components": [
              {
                "content": "**File** \`src/a.ts\`
    **Change** added [docs](https://kimaki.dev) link",
                "type": 10,
              },
              {
                "type": 14,
              },
              {
                "content": "**File** \`src/b.ts\`
    **Change** removed \`x | y\` escaping",
                "type": 10,
              },
            ],
            "type": 17,
          },
        ],
        "flags": 32768,
      },
      {
        "content": "Done.",
      },
    ]
  `)
})

test('callout shapes: own lines, no blank line, single line, list before close', () => {
  const text = dedent`
    <callout accent="#f59e0b">
    ## Tests not fully green

    - \`pnpm test\` failed in \`cli.test.ts\`
    </callout>

    <callout accent="#3b82f6">
    **Gist:** everything works
    </callout>

    <callout accent="#e44">one line callout</callout>

    <callout accent="9133302">decimal accent</callout>

    <callout accent="8b5cf6">
    hex without # is not a valid accent, so this stays text
    </callout>
  `
  expect(renderMarkdown(text)).toMatchInlineSnapshot(`
    [
      {
        "accent": 16096779,
        "kind": "callout",
        "segments": [
          {
            "kind": "text",
            "markdown": "## Tests not fully green

    - \`pnpm test\` failed in \`cli.test.ts\`",
          },
        ],
      },
      {
        "accent": 3900150,
        "kind": "callout",
        "segments": [
          {
            "kind": "text",
            "markdown": "**Gist:** everything works",
          },
        ],
      },
      {
        "accent": 15615044,
        "kind": "callout",
        "segments": [
          {
            "kind": "text",
            "markdown": "one line callout",
          },
        ],
      },
      {
        "accent": 9133302,
        "kind": "callout",
        "segments": [
          {
            "kind": "text",
            "markdown": "decimal accent",
          },
        ],
      },
      {
        "kind": "text",
        "markdown": "<callout accent="8b5cf6">
    hex without # is not a valid accent, so this stays text
    </callout>",
      },
    ]
  `)
})

test('malformed callouts stay text: missing close, inside a code fence, nested', () => {
  const text = dedent`
    \`\`\`md
    <callout accent="#ef4444">
    inside a fence
    </callout>
    \`\`\`

    <callout accent="#ef4444">
    never closed
  `
  expect(renderMarkdown(text)).toMatchInlineSnapshot(`
    [
      {
        "kind": "text",
        "markdown": "\`\`\`md
    <callout accent="#ef4444">
    inside a fence
    </callout>
    \`\`\`

    <callout accent="#ef4444">
    never closed",
      },
    ]
  `)
  const nested = dedent`
    <callout accent="#ef4444">
    outer
    <callout accent="#3b82f6">
    inner
    </callout>
  `
  expect(renderMarkdown(nested)).toMatchInlineSnapshot(`
    [
      {
        "kind": "text",
        "markdown": "<callout accent="#ef4444">
    outer",
      },
      {
        "accent": 3900150,
        "kind": "callout",
        "segments": [
          {
            "kind": "text",
            "markdown": "inner",
          },
        ],
      },
    ]
  `)
})

test('callout with a table renders rows inside the accented container', () => {
  const text = dedent`
    <callout accent="#8b5cf6">
    ## Action required

    | Step | Command |
    | --- | --- |
    | build | \`pnpm build\` |
    | test | \`pnpm test\` |
    </callout>
  `
  expect(markdownPayloads(text)).toMatchInlineSnapshot(`
    [
      {
        "components": [
          {
            "accent_color": 9133302,
            "components": [
              {
                "content": "## Action required",
                "type": 10,
              },
              {
                "content": "**Step** build
    **Command** \`pnpm build\`",
                "type": 10,
              },
              {
                "type": 14,
              },
              {
                "content": "**Step** test
    **Command** \`pnpm test\`",
                "type": 10,
              },
            ],
            "type": 17,
          },
        ],
        "flags": 32768,
      },
    ]
  `)
})

test('code inside a list is lifted after its item, headings deeper than 3 are clamped', () => {
  const text = dedent`
    #### Steps

    1. Install:
       \`\`\`bash
       pnpm install
       \`\`\`
    2. Run the tests
    - done
  `
  expect(renderMarkdown(text)).toMatchInlineSnapshot(`
    [
      {
        "kind": "text",
        "markdown": "### Steps

    1. Install:
    \`\`\`bash
    pnpm install
    \`\`\`
    2. Run the tests
    - done",
      },
    ]
  `)
})

test('3000-char code block splits into valid fences under 2000 chars', () => {
  const code = Array.from({ length: 100 }, (_, index) => `console.log("line ${index} with some padding text")`).join('\n')
  const text = `Intro paragraph.\n\n\`\`\`ts\n${code}\n\`\`\`\n\nOutro.`
  const segments = renderMarkdown(text)
  expect(
    segments.map((segment) => {
      if (segment.kind !== 'text') return segment.kind
      const lines = segment.markdown.split('\n')
      return {
        length: segment.markdown.length,
        first: lines[0],
        last: lines[lines.length - 1],
        fences: (segment.markdown.match(/^```/gm) ?? []).length,
      }
    }),
  ).toMatchInlineSnapshot(`
    [
      {
        "fences": 2,
        "first": "Intro paragraph.",
        "last": "\`\`\`",
        "length": 1995,
      },
      {
        "fences": 2,
        "first": "\`\`\`ts",
        "last": "\`\`\`",
        "length": 1987,
      },
      {
        "fences": 2,
        "first": "\`\`\`ts",
        "last": "Outro.",
        "length": 661,
      },
    ]
  `)
})

test('backticks inside a code block keep the original fence', () => {
  const text = dedent`
    \`\`\`\`md
    Use \`\`\`ts fences for code.
    \`\`\`\`
  `
  expect(renderMarkdown(text)).toMatchInlineSnapshot(`
    [
      {
        "kind": "text",
        "markdown": "\`\`\`\`md
    Use \`\`\`ts fences for code.
    \`\`\`\`",
      },
    ]
  `)
})

test('long paragraph splits by sentences, tight paragraph-list spacing is kept', () => {
  const sentence = 'This sentence is long enough to need a few of them before the limit is reached. '
  const text = `Steps:\n- one\n- two\n\n${sentence.repeat(30)}`
  expect(renderMarkdown(text, { limit: 500 }).map((segment) => segment.kind === 'text' && segment.markdown.length)).toMatchInlineSnapshot(`
    [
      499,
      479,
      479,
      479,
      480,
    ]
  `)
  expect(renderMarkdown('Steps:\n- one\n- two')).toMatchInlineSnapshot(`
    [
      {
        "kind": "text",
        "markdown": "Steps:
    - one
    - two",
      },
    ]
  `)
})

test('edge cases: 2500-char code line, fence info line inside a fence, oversized row, empty callout', () => {
  const longLine = `\`\`\`txt\n${'x'.repeat(2500)}\n\`\`\``
  expect(
    renderMarkdown(longLine).map((segment) => {
      if (segment.kind !== 'text') return segment.kind
      const lines = segment.markdown.split('\n')
      return { length: segment.markdown.length, first: lines[0], last: lines[lines.length - 1] }
    }),
  ).toMatchInlineSnapshot(`
    [
      {
        "first": "\`\`\`txt",
        "last": "\`\`\`",
        "length": 2000,
      },
      {
        "first": "\`\`\`txt",
        "last": "\`\`\`",
        "length": 522,
      },
    ]
  `)

  // "```not-a-close" cannot close a fence, so the callout stays inside the code block.
  const fenced = '```md\n```not-a-close\n<callout accent="#ef4444">\nstill code\n</callout>\n```'
  expect(renderMarkdown(fenced).map((segment) => segment.kind)).toMatchInlineSnapshot(`
    [
      "text",
    ]
  `)

  const bigRow = `| A |\n| --- |\n| ${'y'.repeat(4100)} |`
  expect(
    markdownPayloads(bigRow).flatMap((payload) =>
      'components' in payload
        ? payload.components.flatMap((container) =>
            container.components.map((child) => ('content' in child ? child.content.length : child.type)),
          )
        : [],
    ),
  ).toMatchInlineSnapshot(`
    [
      4000,
      106,
    ]
  `)

  expect(markdownPayloads('<callout accent="#ef4444"></callout>')).toMatchInlineSnapshot(`[]`)
})
