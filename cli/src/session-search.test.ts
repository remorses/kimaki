// Tests for session search query parsing and snippet matching helpers.

import { describe, expect, test } from 'vitest'
import {
  buildSessionSearchSnippet,
  collectSessionSearchMatches,
  findFirstSessionSearchHit,
  parseSessionSearchPattern,
  resolveSessionSearchDirectories,
  validateSessionSearchScope,
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

  test('rejects --all combined with --project or --channel', () => {
    expect(
      validateSessionSearchScope({ all: true, project: '/tmp/a' }),
    ).toBeInstanceOf(Error)
    expect(
      validateSessionSearchScope({ all: true, channel: '123' }),
    ).toBeInstanceOf(Error)
    expect(validateSessionSearchScope({ all: true })).toBeNull()
    expect(
      validateSessionSearchScope({ project: '/tmp/a', channel: '123' }),
    ).toBeInstanceOf(Error)
  })

  test('resolves --all to every registered project directory', () => {
    const resolved = resolveSessionSearchDirectories({
      all: true,
      registeredDirectories: ['/tmp/kimaki', '/tmp/website', '/tmp/kimaki'],
      cwd: '/tmp/current',
    })
    expect(resolved).toEqual(['/tmp/kimaki', '/tmp/website'])
  })

  test('returns error when --all has no registered projects', () => {
    const resolved = resolveSessionSearchDirectories({
      all: true,
      registeredDirectories: [],
      cwd: '/tmp/current',
    })
    expect(resolved).toBeInstanceOf(Error)
  })

  test('defaults to cwd or an explicit project when --all is off', () => {
    expect(
      resolveSessionSearchDirectories({
        all: false,
        cwd: '/tmp/current',
        registeredDirectories: ['/tmp/kimaki'],
      }),
    ).toEqual(['/tmp/current'])
    expect(
      resolveSessionSearchDirectories({
        all: false,
        explicitDirectory: '/tmp/website',
        cwd: '/tmp/current',
        registeredDirectories: ['/tmp/kimaki'],
      }),
    ).toEqual(['/tmp/website'])
  })

  test('collects newest matches across projects up to the global limit', async () => {
    const parsed = parseSessionSearchPattern('auth timeout')
    if (parsed instanceof Error) {
      throw parsed
    }

    const result = await collectSessionSearchMatches({
      sessions: [
        {
          id: 'ses_old',
          title: 'old website hit',
          directory: '/tmp/website',
          updated: 1,
          messages: [
            {
              info: { role: 'user' },
              parts: [{ type: 'text', text: 'auth timeout on login', synthetic: false }],
            },
          ],
        },
        {
          id: 'ses_new',
          title: 'new kimaki hit',
          directory: '/tmp/kimaki',
          updated: 3,
          messages: [
            {
              info: { role: 'assistant' },
              parts: [{ type: 'text', text: 'fixed the auth timeout', synthetic: false }],
            },
          ],
        },
        {
          id: 'ses_miss',
          title: 'unrelated',
          directory: '/tmp/cli',
          updated: 4,
          messages: [
            {
              info: { role: 'user' },
              parts: [{ type: 'text', text: 'refactor logger', synthetic: false }],
            },
          ],
        },
        {
          id: 'ses_mid',
          title: 'mid cli hit',
          directory: '/tmp/cli',
          updated: 2,
          messages: [
            {
              info: { role: 'user' },
              parts: [{ type: 'text', text: 'auth timeout retry', synthetic: false }],
            },
          ],
        },
      ],
      searchPattern: parsed,
      sessionToThread: new Map([
        ['ses_new', 'thread_new'],
        ['ses_mid', 'thread_mid'],
      ]),
      limit: 2,
    })

    expect(result.scannedSessions).toBe(3)
    expect(result.matches.map((match) => match.id)).toEqual([
      'ses_new',
      'ses_mid',
    ])
    expect(result.matches[0]?.directory).toBe('/tmp/kimaki')
    expect(result.matches[0]?.source).toBe('kimaki')
    expect(result.matches[1]?.directory).toBe('/tmp/cli')
  })
})
