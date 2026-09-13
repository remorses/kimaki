import http from 'node:http'
import { OpenCode } from '@opencode/client'
import { describe, expect, test } from 'vitest'
import {
  RepeatedOpencodeCursorError,
  listAllMessages,
  listAllSessions,
} from './opencode-pagination.js'
import { ShareMarkdown } from './markdown.js'

type RequestRecord = {
  path: string
  query: Record<string, string>
}

async function withPaginationServer<T>({
  respond,
  run,
}: {
  respond: (request: RequestRecord) => unknown
  run: (
    client: ReturnType<typeof OpenCode.make>,
    requests: RequestRecord[],
  ) => Promise<T>
}): Promise<T> {
  const requests: RequestRecord[] = []
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const record = {
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
    }
    requests.push(record)
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(respond(record)))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Test server did not bind to a TCP port')
  }

  const client = OpenCode.make({
    baseUrl: `http://127.0.0.1:${address.port}`,
  })
  const result = await run(client, requests).catch((cause) => {
    return new Error('Pagination test failed', { cause })
  })
  const closeResult = await new Promise<null | Error>((resolve) => {
    server.close((cause) => {
      resolve(
        cause ? new Error('Failed to close test server', { cause }) : null,
      )
    })
  })
  if (closeResult instanceof Error) throw closeResult
  if (result instanceof Error) throw result
  return result
}

describe('OpenCode cursor pagination', () => {
  test('lists more than 200 messages and preserves ascending server order', async () => {
    const ids = Array.from({ length: 451 }, (_, index) => `message-${index}`)
    const cursors = ['opaque:first+/=', 'opaque:second?&value']

    const result = await withPaginationServer({
      respond: ({ query }) => {
        const start = query.cursor === cursors[0]
          ? 200
          : query.cursor === cursors[1]
            ? 400
            : 0
        return {
          data: ids
            .slice(start, start + 200)
            .map((id) => ({ id, type: 'user' })),
          cursor: { next: start < 400 ? cursors[start / 200] : null },
        }
      },
      run: async (client, requests) => {
        const messages = await listAllMessages({
          client,
          sessionId: 'session-long',
          order: 'asc',
          type: 'user',
        })
        expect(messages).not.toBeInstanceOf(Error)
        if (messages instanceof Error) return null
        expect(messages.map((message) => message.id)).toEqual(ids)
        expect(requests).toMatchInlineSnapshot(`
          [
            {
              "path": "/api/session/session-long/message",
              "query": {
                "limit": "200",
                "order": "asc",
                "type": "user",
              },
            },
            {
              "path": "/api/session/session-long/message",
              "query": {
                "cursor": "opaque:first+/=",
                "limit": "200",
                "type": "user",
              },
            },
            {
              "path": "/api/session/session-long/message",
              "query": {
                "cursor": "opaque:second?&value",
                "limit": "200",
                "type": "user",
              },
            },
          ]
        `)
        return null
      },
    })

    expect(result).toBeNull()
  })

  test('lists more than 100 sessions and preserves descending server order', async () => {
    const ids = Array.from({ length: 151 }, (_, index) => `session-${150 - index}`)

    await withPaginationServer({
      respond: ({ query }) => {
        const start = query.cursor === 'sessions:page-2' ? 100 : 0
        return {
          data: ids.slice(start, start + 100).map((id) => ({ id })),
          cursor: { next: start === 0 ? 'sessions:page-2' : null },
        }
      },
      run: async (client, requests) => {
        const sessions = await listAllSessions({
          client,
          directory: '/project',
          parentId: 'parent-session',
          order: 'desc',
        })
        expect(sessions).not.toBeInstanceOf(Error)
        if (sessions instanceof Error) return null
        expect(sessions.map((session) => session.id)).toEqual(ids)
        expect(requests.map((request) => request.query)).toMatchInlineSnapshot(`
          [
            {
              "directory": "/project",
              "limit": "100",
              "order": "desc",
              "parentID": "parent-session",
            },
            {
              "cursor": "sessions:page-2",
              "directory": "/project",
              "limit": "100",
              "parentID": "parent-session",
            },
          ]
        `)
        return null
      },
    })
  })

  test('continues through empty first and later pages', async () => {
    await withPaginationServer({
      respond: ({ query }) => {
        if (!('cursor' in query)) return { data: [], cursor: { next: 'empty:first' } }
        if (query.cursor === 'empty:first') {
          return {
            data: [{ id: 'only-message', type: 'assistant' }],
            cursor: { next: 'empty:last' },
          }
        }
        return { data: [], cursor: { next: null } }
      },
      run: async (client, requests) => {
        const messages = await listAllMessages({
          client,
          sessionId: 'session-empty-pages',
          order: 'desc',
        })
        expect(messages).not.toBeInstanceOf(Error)
        if (messages instanceof Error) return null
        expect(messages.map((message) => message.id)).toEqual(['only-message'])
        expect(requests).toHaveLength(3)
        return null
      },
    })
  })

  test('returns a typed error for a repeated cursor', async () => {
    await withPaginationServer({
      respond: () => ({ data: [], cursor: { next: 'same:cursor' } }),
      run: async (client, requests) => {
        const result = await listAllSessions({ client, order: 'asc' })
        expect(result).toBeInstanceOf(RepeatedOpencodeCursorError)
        expect(result).toMatchObject({
          cursor: 'same:cursor',
          resource: 'sessions',
        })
        expect(requests).toHaveLength(2)
        return null
      },
    })
  })

  test('rejects a repeated opaque message cursor without sending order again', async () => {
    const cursor = 'messages:opaque+/=?&next'

    await withPaginationServer({
      respond: () => ({
        data: [{ id: 'message', type: 'assistant' }],
        cursor: { next: cursor },
      }),
      run: async (client, requests) => {
        const result = await listAllMessages({
          client,
          sessionId: 'session-repeated-message-cursor',
          order: 'desc',
        })
        expect(result).toBeInstanceOf(RepeatedOpencodeCursorError)
        expect(result).toMatchObject({ cursor, resource: 'messages' })
        expect(requests.map((request) => request.query)).toMatchInlineSnapshot(`
          [
            {
              "limit": "200",
              "order": "desc",
            },
            {
              "cursor": "messages:opaque+/=?&next",
              "limit": "200",
            },
          ]
        `)
        return null
      },
    })
  })

  test('stops after the first matching item without requesting another page', async () => {
    await withPaginationServer({
      respond: () => ({
        data: [
          { id: 'message-3', type: 'assistant' },
          { id: 'message-2', type: 'assistant' },
          { id: 'message-1', type: 'assistant' },
        ],
        cursor: { next: 'unused:cursor' },
      }),
      run: async (client, requests) => {
        const messages = await listAllMessages({
          client,
          sessionId: 'session-early-stop',
          order: 'desc',
          stopWhen: (message) => message.id === 'message-2',
        })
        expect(messages).not.toBeInstanceOf(Error)
        if (messages instanceof Error) return null
        expect(messages.map((message) => message.id)).toEqual([
          'message-3',
          'message-2',
        ])
        expect(requests).toHaveLength(1)
        return null
      },
    })
  })

  test('stops descending session pagination at a recent-history cutoff', async () => {
    await withPaginationServer({
      respond: () => ({
        data: [
          { id: 'session-new', time: { updated: 300 } },
          { id: 'session-cutoff', time: { updated: 200 } },
          { id: 'session-old', time: { updated: 199 } },
        ],
        cursor: { next: 'unused:older-sessions' },
      }),
      run: async (client, requests) => {
        const sessions = await listAllSessions({
          client,
          directory: '/project',
          order: 'desc',
          stopWhen: (session) => session.time.updated < 200,
        })
        expect(sessions).not.toBeInstanceOf(Error)
        if (sessions instanceof Error) return null
        expect(sessions.map((session) => session.id)).toEqual([
          'session-new',
          'session-cutoff',
          'session-old',
        ])
        expect(requests).toHaveLength(1)
        expect(requests[0]?.query).toEqual({
          directory: '/project',
          limit: '100',
          order: 'desc',
        })
        return null
      },
    })
  })

  test('markdown export includes messages after the first page', async () => {
    const ids = Array.from({ length: 205 }, (_, index) => `history-${index}`)

    await withPaginationServer({
      respond: ({ path, query }) => {
        if (!path.endsWith('/message')) {
          return {
            data: {
              id: 'export-session',
              title: 'Complete export',
              time: { created: 1, updated: 2 },
            },
          }
        }
        const start = query.cursor === 'export:next-page' ? 200 : 0
        return {
          data: ids.slice(start, start + 200).map((id, index) => ({
            id,
            type: 'user',
            text: `${id} text`,
            time: { created: start + index },
          })),
          cursor: { next: start === 0 ? 'export:next-page' : null },
        }
      },
      run: async (client, requests) => {
        const markdown = await new ShareMarkdown(client).generate({
          sessionID: 'export-session',
        })
        expect(markdown).not.toBeInstanceOf(Error)
        if (markdown instanceof Error) return null
        expect(markdown).toContain('history-0 text')
        expect(markdown).toContain('history-204 text')
        expect(
          requests
            .filter((request) => request.path.endsWith('/message'))
            .map((request) => request.query),
        ).toMatchInlineSnapshot(`
          [
            {
              "limit": "200",
              "order": "asc",
            },
            {
              "cursor": "export:next-page",
              "limit": "200",
            },
          ]
        `)
        return null
      },
    })
  })
})
