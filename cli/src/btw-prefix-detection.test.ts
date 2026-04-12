import { describe, expect, test } from 'vitest'
import { extractBtwPrefix } from './btw-prefix-detection.js'

describe('extractBtwPrefix', () => {
  test('matches lowercase prefix', () => {
    expect(extractBtwPrefix('btw fix this')).toMatchInlineSnapshot(`
      {
        "prompt": "fix this",
      }
    `)
  })

  test('matches uppercase prefix', () => {
    expect(extractBtwPrefix('BTW check this')).toMatchInlineSnapshot(`
      {
        "prompt": "check this",
      }
    `)
  })

  test('keeps multiline content', () => {
    expect(extractBtwPrefix('  btw first line\nsecond line  ')).toMatchInlineSnapshot(`
      {
        "prompt": "first line
      second line",
      }
    `)
  })

  test('matches dot separator', () => {
    expect(extractBtwPrefix('btw. fix this')).toMatchInlineSnapshot(`
      {
        "prompt": "fix this",
      }
    `)
  })

  test('matches comma separator', () => {
    expect(extractBtwPrefix('btw, fix this')).toMatchInlineSnapshot(`
      {
        "prompt": "fix this",
      }
    `)
  })

  test('matches colon separator', () => {
    expect(extractBtwPrefix('btw: fix this')).toMatchInlineSnapshot(`
      {
        "prompt": "fix this",
      }
    `)
  })

  test('matches punctuation without trailing space', () => {
    expect(extractBtwPrefix('btw.fix this')).toMatchInlineSnapshot(`
      {
        "prompt": "fix this",
      }
    `)
  })

  test('does not match without separating whitespace', () => {
    expect(extractBtwPrefix('btwfix this')).toMatchInlineSnapshot(`null`)
  })

  test('does not match mid-message', () => {
    expect(extractBtwPrefix('hello btw fix this')).toMatchInlineSnapshot(`null`)
  })

  test('does not match empty payload', () => {
    expect(extractBtwPrefix('btw   ')).toMatchInlineSnapshot(`null`)
  })
})
