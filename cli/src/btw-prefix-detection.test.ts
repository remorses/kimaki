import { describe, expect, test } from 'vitest'
import { extractBtwSuffix } from './btw-prefix-detection.js'

describe('extractBtwSuffix', () => {
  test('matches after period', () => {
    expect(extractBtwSuffix('fix the bug. btw check tests')).toMatchInlineSnapshot(`
      {
        "prompt": "check tests",
        "remaining": "fix the bug",
      }
    `)
  })

  test('matches after exclamation', () => {
    expect(extractBtwSuffix('done! btw also review auth')).toMatchInlineSnapshot(`
      {
        "prompt": "also review auth",
        "remaining": "done",
      }
    `)
  })

  test('matches after comma', () => {
    expect(extractBtwSuffix('sure, btw fix the tests')).toMatchInlineSnapshot(`
      {
        "prompt": "fix the tests",
        "remaining": "sure",
      }
    `)
  })

  test('matches after newline', () => {
    expect(extractBtwSuffix('fix the bug\nbtw check tests')).toMatchInlineSnapshot(`
      {
        "prompt": "check tests",
        "remaining": "fix the bug",
      }
    `)
  })

  test('case insensitive', () => {
    expect(extractBtwSuffix('done. BTW check this')).toMatchInlineSnapshot(`
      {
        "prompt": "check this",
        "remaining": "done",
      }
    `)
  })

  test('btw with colon separator', () => {
    expect(extractBtwSuffix('ok. btw: check this')).toMatchInlineSnapshot(`
      {
        "prompt": "check this",
        "remaining": "ok",
      }
    `)
  })

  test('btw with dot separator', () => {
    expect(extractBtwSuffix('ok. btw. check this')).toMatchInlineSnapshot(`
      {
        "prompt": "check this",
        "remaining": "ok",
      }
    `)
  })

  test('multiline btw prompt', () => {
    expect(extractBtwSuffix('fix the bug. btw first line\nsecond line')).toMatchInlineSnapshot(`
      {
        "prompt": "first line
      second line",
        "remaining": "fix the bug",
      }
    `)
  })

  test('does not match at start of message', () => {
    expect(extractBtwSuffix('btw fix this')).toMatchInlineSnapshot(`null`)
  })

  test('does not match mid-message without punctuation', () => {
    expect(extractBtwSuffix('hello btw fix this')).toMatchInlineSnapshot(`null`)
  })

  test('does not match empty payload after btw', () => {
    expect(extractBtwSuffix('fix bug. btw   ')).toMatchInlineSnapshot(`null`)
  })

  test('does not match empty content', () => {
    expect(extractBtwSuffix('')).toMatchInlineSnapshot(`null`)
  })

  test('remaining is empty when btw follows punctuation at start', () => {
    expect(extractBtwSuffix('. btw check this')).toMatchInlineSnapshot(`
      {
        "prompt": "check this",
        "remaining": "",
      }
    `)
  })
})
