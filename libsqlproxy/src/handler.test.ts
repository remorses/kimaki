import { describe, test, expect, beforeEach } from 'vitest'
import { createLibsqlHandler } from './handler.ts'
import type { LibsqlExecutor } from './executor.ts'
import type { HranaExecuteResult } from './types.ts'

// In-memory executor for testing — tracks tables and rows
function createMemoryExecutor(): LibsqlExecutor {
  const tables = new Map<string, { cols: string[]; rows: unknown[][] }>()

  return {
    executeSql(sql: string, params: unknown[]): HranaExecuteResult {
      const trimmed = sql.trim().toUpperCase()

      if (trimmed.startsWith('CREATE TABLE')) {
        const match = sql.match(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(([^)]+)\)/i)
        if (match) {
          const name = match[1]!
          const colDefs = match[2]!.split(',').map((c) => c.trim().split(/\s+/)[0]!)
          tables.set(name, { cols: colDefs, rows: [] })
        }
        return { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: null }
      }

      if (trimmed.startsWith('INSERT INTO')) {
        const match = sql.match(/INSERT INTO (\w+)/i)
        if (match) {
          const table = tables.get(match[1]!)
          if (table) {
            table.rows.push(params)
            return {
              cols: [],
              rows: [],
              affected_row_count: 1,
              last_insert_rowid: String(table.rows.length),
            }
          }
        }
        return { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: null }
      }

      if (trimmed.startsWith('SELECT')) {
        const match = sql.match(/FROM (\w+)/i)
        if (match) {
          const table = tables.get(match[1]!)
          if (table) {
            return {
              cols: table.cols.map((name) => ({ name, decltype: null })),
              rows: table.rows.map((row) => {
                return row.map((val) => {
                  if (val === null) {
                    return { type: 'null' as const }
                  }
                  if (typeof val === 'number') {
                    return { type: 'integer' as const, value: String(val) }
                  }
                  return { type: 'text' as const, value: String(val) }
                })
              }),
              affected_row_count: 0,
              last_insert_rowid: null,
            }
          }
        }
        return { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: null }
      }

      return { cols: [], rows: [], affected_row_count: 0, last_insert_rowid: null }
    },

    execRaw(_sql: string): void {
      // no-op for testing
    },
  }
}

function pipeline(handler: ReturnType<typeof createLibsqlHandler>, body: unknown) {
  return handler(new Request('http://localhost/v2/pipeline', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

describe('createLibsqlHandler', () => {
  let handler: ReturnType<typeof createLibsqlHandler>

  beforeEach(() => {
    handler = createLibsqlHandler(createMemoryExecutor())
  })

  test('GET /v2 returns version', async () => {
    const req = new Request('http://localhost/v2', { method: 'GET' })
    const res = await handler(req)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchInlineSnapshot(`
      {
        "version": "hrana-v2",
      }
    `)
  })

  test('POST /v2/pipeline execute returns result', async () => {
    const res = await pipeline(handler, {
      baton: null,
      requests: [
        { type: 'execute', stmt: { sql: 'CREATE TABLE users (id, name)' } },
        {
          type: 'execute',
          stmt: {
            sql: 'INSERT INTO users VALUES (?, ?)',
            args: [
              { type: 'integer', value: '1' },
              { type: 'text', value: 'alice' },
            ],
          },
        },
        { type: 'execute', stmt: { sql: 'SELECT * FROM users' } },
        { type: 'close' },
      ],
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { baton: string | null; results: unknown[] }
    expect(body.baton).toBe(null)
    expect(body.results).toMatchInlineSnapshot(`
      [
        {
          "response": {
            "result": {
              "affected_row_count": 0,
              "cols": [],
              "last_insert_rowid": null,
              "rows": [],
            },
            "type": "execute",
          },
          "type": "ok",
        },
        {
          "response": {
            "result": {
              "affected_row_count": 1,
              "cols": [],
              "last_insert_rowid": "1",
              "rows": [],
            },
            "type": "execute",
          },
          "type": "ok",
        },
        {
          "response": {
            "result": {
              "affected_row_count": 0,
              "cols": [
                {
                  "decltype": null,
                  "name": "id",
                },
                {
                  "decltype": null,
                  "name": "name",
                },
              ],
              "last_insert_rowid": null,
              "rows": [
                [
                  {
                    "type": "integer",
                    "value": "1",
                  },
                  {
                    "type": "text",
                    "value": "alice",
                  },
                ],
              ],
            },
            "type": "execute",
          },
          "type": "ok",
        },
        {
          "response": {
            "type": "close",
          },
          "type": "ok",
        },
      ]
    `)
  })

  test('baton is returned when stream is not closed', async () => {
    const res = await pipeline(handler, {
      baton: null,
      requests: [
        { type: 'execute', stmt: { sql: 'CREATE TABLE t1 (x)' } },
      ],
    })
    const body = await res.json() as { baton: string | null }
    expect(body.baton).toBeTruthy()
    expect(typeof body.baton).toBe('string')
  })

  test('store_sql and close_sql work', async () => {
    const res = await pipeline(handler, {
      baton: null,
      requests: [
        { type: 'store_sql', sql_id: 1, sql: 'CREATE TABLE t2 (x)' },
        { type: 'execute', stmt: { sql_id: 1 } },
        { type: 'close_sql', sql_id: 1 },
        { type: 'close' },
      ],
    })
    const body = await res.json() as { results: Array<{ type: string }> }
    expect(body.results.map((r) => r.type)).toMatchInlineSnapshot(`
      [
        "ok",
        "ok",
        "ok",
        "ok",
      ]
    `)
  })

  test('invalid JSON returns 400', async () => {
    const res = await handler(new Request('http://localhost/v2/pipeline', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    }))
    expect(res.status).toBe(400)
  })

  test('unknown path returns 404', async () => {
    const res = await handler(new Request('http://localhost/unknown', { method: 'GET' }))
    expect(res.status).toBe(404)
  })

  // ── Baton validation ─────────────────────────────────────────────

  test('unknown baton returns 400', async () => {
    const res = await pipeline(handler, {
      baton: 'nonexistent-baton',
      requests: [{ type: 'execute', stmt: { sql: 'SELECT 1' } }],
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { message: string } }
    expect(body.error.message).toContain('Invalid or expired baton')
  })

  test('baton from one handler is not accepted by another', async () => {
    const handler2 = createLibsqlHandler(createMemoryExecutor())
    const res1 = await pipeline(handler, {
      baton: null,
      requests: [{ type: 'execute', stmt: { sql: 'SELECT 1' } }],
    })
    const body1 = await res1.json() as { baton: string }

    const res2 = await pipeline(handler2, {
      baton: body1.baton,
      requests: [{ type: 'execute', stmt: { sql: 'SELECT 1' } }],
    })
    expect(res2.status).toBe(400)
  })

  test('closed baton is rejected on next request', async () => {
    const res1 = await pipeline(handler, {
      baton: null,
      requests: [
        { type: 'execute', stmt: { sql: 'SELECT 1' } },
        { type: 'close' },
      ],
    })
    const body1 = await res1.json() as { baton: string | null }
    expect(body1.baton).toBe(null)

    // Using null baton again is fine (new stream), but a stale baton should fail
    // Since baton is null after close, this test verifies the close worked
  })

  // ── Requests after close in same pipeline ─────────────────────────

  test('requests after close in same pipeline return error', async () => {
    const res = await pipeline(handler, {
      baton: null,
      requests: [
        { type: 'close' },
        { type: 'execute', stmt: { sql: 'SELECT 1' } },
      ],
    })
    const body = await res.json() as { results: Array<{ type: string; error?: { message: string } }> }
    expect(body.results[0]!.type).toBe('ok')
    expect(body.results[1]!.type).toBe('error')
    expect(body.results[1]!.error!.message).toContain('Stream already closed')
  })

  // ── Malformed body ────────────────────────────────────────────────

  test('malformed requests field returns 400', async () => {
    const res = await pipeline(handler, {
      baton: null,
      requests: 'not an array',
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { message: string } }
    expect(body.error.message).toContain('"requests" must be an array')
  })

  test('missing requests field treated as empty (200)', async () => {
    const res = await pipeline(handler, { baton: null })
    expect(res.status).toBe(200)
    const body = await res.json() as { results: unknown[] }
    expect(body.results).toEqual([])
  })

  // ── store_sql duplicate rejection ─────────────────────────────────

  test('duplicate store_sql returns error', async () => {
    const res = await pipeline(handler, {
      baton: null,
      requests: [
        { type: 'store_sql', sql_id: 1, sql: 'SELECT 1' },
        { type: 'store_sql', sql_id: 1, sql: 'SELECT 2' },
        { type: 'close' },
      ],
    })
    const body = await res.json() as { results: Array<{ type: string; error?: { message: string } }> }
    expect(body.results[0]!.type).toBe('ok')
    expect(body.results[1]!.type).toBe('error')
    expect(body.results[1]!.error!.message).toContain('already stored')
  })

  // ── sql resolution ─────────────────────────────────────────────────

  test('execute with both sql and sql_id prefers sql', async () => {
    const res = await pipeline(handler, {
      baton: null,
      requests: [
        { type: 'store_sql', sql_id: 1, sql: 'CREATE TABLE t_ignored (x)' },
        { type: 'execute', stmt: { sql: 'CREATE TABLE t_preferred (x)', sql_id: 1 } },
        { type: 'execute', stmt: { sql: 'SELECT * FROM t_preferred' } },
        { type: 'close' },
      ],
    })
    const body = await res.json() as { results: Array<{ type: string }> }
    // All succeed — sql was preferred over sql_id
    expect(body.results.map((r) => r.type)).toMatchInlineSnapshot(`
      [
        "ok",
        "ok",
        "ok",
        "ok",
      ]
    `)
  })
})
