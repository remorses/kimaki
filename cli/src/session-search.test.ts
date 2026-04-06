// Tests for session search query parsing and snippet matching helpers.

import { describe, expect, test } from 'vitest'
import {
  buildSessionSearchSnippet,
  findFirstSessionSearchHit,
  parseSessionSearchPattern,
} from './session-search.js'

describe('session search helpers', () => {
  test('returns error for invalid regex query', () => {
    const parsed = parseSessionSearchPattern('/(unclosed/')
    expect(parsed).toBeInstanceOf(Error)
  })

  test('returns snippets that include the matched substring', () => {
    const cases = [
      {
        query: 'panic',
        text: 'There was a PANIC in production',
        expectedSubstring: 'PANIC',
      },
      {
        query: '/error\\s+42/i',
        text: 'Request failed with ERROR 42 in worker',
        expectedSubstring: 'ERROR 42',
      },
    ]

    cases.forEach(({ query, text, expectedSubstring }) => {
      const parsed = parseSessionSearchPattern(query)
      if (parsed instanceof Error) {
        throw parsed
      }
      const hit = findFirstSessionSearchHit({ text, searchPattern: parsed })
      expect(hit).toBeDefined()
      if (!hit) {
        return
      }

      const snippet = buildSessionSearchSnippet({
        text,
        hit,
        contextLength: 8,
      })

      expect(snippet.toUpperCase()).toContain(expectedSubstring.toUpperCase())
    })
  })
})
