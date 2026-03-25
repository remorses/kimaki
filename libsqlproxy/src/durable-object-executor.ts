// Executor adapter for Cloudflare Durable Object SQLite storage.
// Synchronous — ctx.storage.sql.exec() returns a synchronous cursor.
//
// Usage:
//   import { durableObjectExecutor } from 'libsqlproxy'
//   const executor = durableObjectExecutor(ctx.storage)
//
// Important: CF DO sql.exec() cannot use BEGIN TRANSACTION directly.
// The executor wraps batch operations normally; if transactions are needed,
// use ctx.storage.transactionSync() at a higher level.

import type { HranaExecuteResult, HranaDescribeResult } from './types.ts'
import { encodeHranaValue } from './values.ts'
import type { LibsqlExecutor } from './executor.ts'

// Minimal interface matching Cloudflare's SqlStorage cursor.
// Avoids hard dependency on @cloudflare/workers-types.
export interface DurableObjectSqlCursor {
  columnNames: string[]
  toArray(): Record<string, unknown>[]
  readonly rowsRead: number
  readonly rowsWritten: number
}

export interface DurableObjectSqlStorage {
  exec(query: string, ...bindings: unknown[]): DurableObjectSqlCursor
}

export interface DurableObjectStorage {
  sql: DurableObjectSqlStorage
}

// Detect readonly queries by checking the SQL verb.
// rowsWritten === 0 is unreliable for DDL/PRAGMA/no-op writes.
// WITH (CTE) can be writable: "WITH ... INSERT/UPDATE/DELETE ..."
// so we check if the CTE body contains a write verb after the final closing paren.
const READONLY_PREFIXES = ['SELECT', 'EXPLAIN', 'PRAGMA']
const WRITE_VERBS = ['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'DROP', 'ALTER']

function isReadonlyQuery(sql: string): boolean {
  const upper = sql.trimStart().toUpperCase()
  if (READONLY_PREFIXES.some((p) => upper.startsWith(p))) {
    return true
  }
  // WITH CTEs: readonly only if the final statement is SELECT
  if (upper.startsWith('WITH')) {
    return !WRITE_VERBS.some((v) => upper.includes(v))
  }
  return false
}

export function durableObjectExecutor(storage: DurableObjectStorage): LibsqlExecutor {
  const sql = storage.sql

  return {
    executeSql(sqlQuery: string, params: unknown[]): HranaExecuteResult {
      const cursor = sql.exec(sqlQuery, ...params)
      const columnNames = cursor.columnNames
      const rows = cursor.toArray()
      const isRead = isReadonlyQuery(sqlQuery)

      if (isRead) {
        return {
          cols: columnNames.map((name) => ({ name, decltype: null })),
          rows: rows.map((row) => {
            return columnNames.map((name) => encodeHranaValue(row[name]))
          }),
          affected_row_count: 0,
          last_insert_rowid: null,
        }
      }

      // For write queries, CF doesn't expose lastInsertRowid directly via sql.exec.
      // We query it separately.
      let lastRowId: string | null = null
      try {
        const ridCursor = sql.exec('SELECT last_insert_rowid() as rid')
        const ridRow = ridCursor.toArray()[0]
        if (ridRow && ridRow['rid'] != null) {
          lastRowId = String(ridRow['rid'])
        }
      } catch {
        console.warn('libsqlproxy: failed to query last_insert_rowid()')
      }

      return {
        cols: columnNames.map((name) => ({ name, decltype: null })),
        rows: rows.map((row) => {
          return columnNames.map((name) => encodeHranaValue(row[name]))
        }),
        affected_row_count: cursor.rowsWritten,
        last_insert_rowid: lastRowId,
      }
    },

    execRaw(sqlQuery: string): void {
      sql.exec(sqlQuery)
    },

    describe(sqlQuery: string): HranaDescribeResult {
      // CF sql.exec doesn't have a "describe without executing" mode.
      // We use EXPLAIN to get column info without side effects.
      const isExplain = sqlQuery.trimStart().toUpperCase().startsWith('EXPLAIN')
      const isRead = isReadonlyQuery(sqlQuery)
      try {
        const cursor = sql.exec(`EXPLAIN ${sqlQuery}`)
        const columnNames = cursor.columnNames
        return {
          params: [],
          cols: columnNames.map((name) => ({ name, decltype: null })),
          is_explain: isExplain,
          is_readonly: isRead,
        }
      } catch {
        console.warn('libsqlproxy: EXPLAIN failed for describe, returning empty cols')
        return {
          params: [],
          cols: [],
          is_explain: isExplain,
          is_readonly: isRead,
        }
      }
    },
  }
}
