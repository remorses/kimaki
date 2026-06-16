import { describe, expect, test } from 'vitest'
import { extractBtwSuffix } from './btw-prefix-detection.js'

describe('extractBtwSuffix', () => {
  test('matches after period', () => {
    expect(extractBtwSuffix('fix the bug. btw')).toMatchInlineSnapshot(`
      {
        "forceBtw": true,
        "prompt": "fix the bug",
      }
    `)
  })

  test('matches after exclamation', () => {
    expect(extractBtwSuffix('done! btw')).toMatchInlineSnapshot(`
      {
        "forceBtw": true,
        "prompt": "done",
      }
    `)
  })

  test('matches after comma', () => {
    expect(extractBtwSuffix('sure, btw')).toMatchInlineSnapshot(`
      {
        "forceBtw": true,
        "prompt": "sure",
      }
    `)
  })

  test('matches after newline', () => {
    expect(extractBtwSuffix('fix the bug\nbtw')).toMatchInlineSnapshot(`
      {
        "forceBtw": true,
        "prompt": "fix the bug",
      }
    `)
  })

  test('matches with trailing dot', () => {
    expect(extractBtwSuffix('fix the bug. btw.')).toMatchInlineSnapshot(`
      {
        "forceBtw": true,
        "prompt": "fix the bug",
      }
    `)
  })

  test('case insensitive', () => {
    expect(extractBtwSuffix('done. BTW')).toMatchInlineSnapshot(`
      {
        "forceBtw": true,
        "prompt": "done",
      }
    `)
  })

  test('no space between punctuation and btw', () => {
    expect(extractBtwSuffix('done.btw')).toMatchInlineSnapshot(`
      {
        "forceBtw": true,
        "prompt": "done",
      }
    `)
  })

  test('does not match at start of message', () => {
    expect(extractBtwSuffix('btw fix this')).toMatchInlineSnapshot(`
      {
        "forceBtw": false,
        "prompt": "btw fix this",
      }
    `)
  })

  test('does not match mid-message without punctuation', () => {
    expect(extractBtwSuffix('hello btw')).toMatchInlineSnapshot(`
      {
        "forceBtw": false,
        "prompt": "hello btw",
      }
    `)
  })

  test('does not match empty content', () => {
    expect(extractBtwSuffix('')).toMatchInlineSnapshot(`
      {
        "forceBtw": false,
        "prompt": "",
      }
    `)
  })

  test('multiline message with btw at end', () => {
    expect(extractBtwSuffix('first line\nsecond line. btw')).toMatchInlineSnapshot(`
      {
        "forceBtw": true,
        "prompt": "first line
      second line",
      }
    `)
  })
})
