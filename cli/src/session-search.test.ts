// Tests for session search query parsing and snippet matching helpers.

import { describe, expect, test } from 'vitest'
import {
  buildSessionSearchSnippet,
  collectSessionSearchMatches,
  findFirstSessionSearchHit,
  parseSessionSearchDays,
  parseSessionSearchPattern,
  resolveSessionSearchDirectories,
  sessionSearchMinUpdated,
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

  test('defaults --days to 14 and treats 0 as all time', () => {
    expect(parseSessionSearchDays(undefined)).toBe(14)
    expect(parseSessionSearchDays('0')).toBe(0)
    expect(parseSessionSearchDays('7')).toBe(7)
    expect(parseSessionSearchDays('-1')).toBeInstanceOf(Error)
    expect(parseSessionSearchDays('nope')).toBeInstanceOf(Error)
    expect(sessionSearchMinUpdated({ days: 0, now: 1_000 })).toBeUndefined()
    expect(sessionSearchMinUpdated({ days: 14, now: 1_000 })).toBe(
      1_000 - 14 * 24 * 60 * 60 * 1000,
    )
  })

  test('skips sessions older than minUpdated without loading messages', async () => {
    const parsed = parseSessionSearchPattern('auth timeout')
    if (parsed instanceof Error) {
      throw parsed
    }

    const now = 1_000_000_000_000
    const minUpdated = now - 14 * 24 * 60 * 60 * 1000
    const loaded: string[] = []
    const result = await collectSessionSearchMatches({
      sessions: [
        {
          id: 'ses_new',
          title: 'new hit',
          directory: '/tmp/kimaki',
          updated: now,
        },
        {
          id: 'ses_old',
          title: 'old hit',
          directory: '/tmp/website',
          updated: minUpdated - 1,
        },
      ],
      searchPattern: parsed,
      sessionToThread: new Map(),
      limit: 20,
      minUpdated,
      loadMessages: async (session) => {
        loaded.push(session.id)
        return [
          {
            info: { role: 'user' },
            parts: [{ type: 'text', text: 'auth timeout', synthetic: false }],
          },
        ]
      },
    })

    expect(loaded).toEqual(['ses_new'])
    expect(result.scannedSessions).toBe(1)
    expect(result.matches.map((match) => match.id)).toEqual(['ses_new'])
  })

  test('loads old matching sessions when minUpdated is unset', async () => {
    const parsed = parseSessionSearchPattern('auth timeout')
    if (parsed instanceof Error) {
      throw parsed
    }

    const loaded: string[] = []
    const result = await collectSessionSearchMatches({
      sessions: [
        {
          id: 'ses_old',
          title: 'old hit',
          directory: '/tmp/website',
          updated: 1,
        },
      ],
      searchPattern: parsed,
      sessionToThread: new Map(),
      limit: 20,
      loadMessages: async (session) => {
        loaded.push(session.id)
        return [
          {
            info: { role: 'user' },
            parts: [{ type: 'text', text: 'auth timeout', synthetic: false }],
          },
        ]
      },
    })

    expect(loaded).toEqual(['ses_old'])
    expect(result.matches.map((match) => match.id)).toEqual(['ses_old'])
  })

  test('loads messages in parallel but keeps newest matches first', async () => {
    const parsed = parseSessionSearchPattern('auth timeout')
    if (parsed instanceof Error) {
      throw parsed
    }

    let inFlight = 0
    let maxInFlight = 0
    const streamed: string[] = []
    const result = await collectSessionSearchMatches({
      sessions: [
        {
          id: 'ses_new',
          title: 'new hit',
          directory: '/tmp/kimaki',
          updated: 3,
        },
        {
          id: 'ses_mid',
          title: 'mid hit',
          directory: '/tmp/cli',
          updated: 2,
        },
        {
          id: 'ses_old',
          title: 'old hit',
          directory: '/tmp/website',
          updated: 1,
        },
      ],
      searchPattern: parsed,
      sessionToThread: new Map(),
      limit: 2,
      concurrency: 3,
      onMatch: (match) => {
        streamed.push(match.id)
      },
      loadMessages: async (session) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) => {
          setTimeout(resolve, session.id === 'ses_new' ? 40 : 5)
        })
        inFlight--
        return [
          {
            info: { role: 'user' },
            parts: [{ type: 'text', text: 'auth timeout', synthetic: false }],
          },
        ]
      },
    })

    expect(maxInFlight).toBeGreaterThan(1)
    expect(result.matches.map((match) => match.id)).toEqual([
      'ses_new',
      'ses_mid',
    ])
    expect(streamed).toEqual(['ses_new', 'ses_mid'])
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
      concurrency: 1,
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
