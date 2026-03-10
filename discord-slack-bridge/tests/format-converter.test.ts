import { describe, test, expect } from 'vitest'
import { mrkdwnToMarkdown, markdownToMrkdwn } from '../src/format-converter.js'

describe('mrkdwnToMarkdown', () => {
  test('converts bold', () => {
    expect(mrkdwnToMarkdown('Hello *world*')).toMatchInlineSnapshot(`"Hello **world**"`)
  })

  test('converts strikethrough', () => {
    expect(mrkdwnToMarkdown('Hello ~world~')).toMatchInlineSnapshot(`"Hello ~~world~~"`)
  })

  test('converts Slack links to markdown links', () => {
    expect(mrkdwnToMarkdown('Check <https://example.com|this link>')).toMatchInlineSnapshot(
      `"Check [this link](https://example.com)"`,
    )
  })

  test('converts bare Slack links', () => {
    expect(mrkdwnToMarkdown('Visit <https://example.com>')).toMatchInlineSnapshot(
      `"Visit https://example.com"`,
    )
  })

  test('preserves inline code', () => {
    expect(mrkdwnToMarkdown('Use `*bold*` for emphasis')).toMatchInlineSnapshot(
      `"Use \`*bold*\` for emphasis"`,
    )
  })

  test('preserves code blocks', () => {
    const input = '```\n*bold* ~strike~\n```'
    expect(mrkdwnToMarkdown(input)).toMatchInlineSnapshot(`
      "\`\`\`
      *bold* ~strike~
      \`\`\`"
    `)
  })

  test('preserves italic (same in both)', () => {
    expect(mrkdwnToMarkdown('Hello _world_')).toMatchInlineSnapshot(`"Hello _world_"`)
  })

  test('handles mixed formatting', () => {
    expect(mrkdwnToMarkdown('*bold* and ~strike~ and <https://x.com|link>')).toMatchInlineSnapshot(
      `"**bold** and ~~strike~~ and [link](https://x.com)"`,
    )
  })

  test('preserves mentions', () => {
    expect(mrkdwnToMarkdown('Hello <@U123>')).toMatchInlineSnapshot(`"Hello <@U123>"`)
  })
})

describe('markdownToMrkdwn', () => {
  test('converts bold', () => {
    expect(markdownToMrkdwn('Hello **world**')).toMatchInlineSnapshot(`"Hello *world*"`)
  })

  test('converts strikethrough', () => {
    expect(markdownToMrkdwn('Hello ~~world~~')).toMatchInlineSnapshot(`"Hello ~world~"`)
  })

  test('converts markdown links to Slack links', () => {
    expect(markdownToMrkdwn('Check [this link](https://example.com)')).toMatchInlineSnapshot(
      `"Check <https://example.com|this link>"`,
    )
  })

  test('preserves inline code', () => {
    expect(markdownToMrkdwn('Use `**bold**` for emphasis')).toMatchInlineSnapshot(
      `"Use \`**bold**\` for emphasis"`,
    )
  })

  test('preserves code blocks', () => {
    const input = '```\n**bold** ~~strike~~\n```'
    expect(markdownToMrkdwn(input)).toMatchInlineSnapshot(`
      "\`\`\`
      **bold** ~~strike~~
      \`\`\`"
    `)
  })

  test('roundtrips with mrkdwnToMarkdown', () => {
    const original = '*bold* and ~strike~ and <https://x.com|link>'
    const markdown = mrkdwnToMarkdown(original)
    const backToMrkdwn = markdownToMrkdwn(markdown)
    expect(backToMrkdwn).toMatchInlineSnapshot(`"*bold* and ~strike~ and <https://x.com|link>"`)
  })
})
