// Executor adapter for the `libsql` npm package (better-sqlite3 compatible API).
// Synchronous — all methods return values directly.
//
// Usage:
//   import Database from 'libsql'
//   const executor = libsqlExecutor(new Database('path.db'))

import type { HranaExecuteResult, HranaDescribeResult } from './types.ts'
import { encodeHranaValue } from './values.ts'
import type { LibsqlExecutor } from './executor.ts'

// Minimal interface matching the `libsql` / `better-sqlite3` Database shape.
// Users pass the real Database instance — this avoids a hard dependency.
export interface LibsqlDatabase {
  prepare(sql: string): LibsqlStatement
  exec(sql: string): void
}

export interface LibsqlStatement {
  reader: boolean
  columns(): Array<{ name: string; type: string | null }>
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): { changes: number; lastInsertRowid?: number | bigint | null }
}

export function libsqlExecutor(database: LibsqlDatabase): LibsqlExecutor {
  return {
    executeSql(sql: string, params: unknown[]): HranaExecuteResult {
      const prepared = database.prepare(sql)

      if (prepared.reader) {
        const cols = prepared.columns()
        const rows = prepared.all(...params)
        return {
          cols: cols.map((c) => ({ name: c.name, decltype: c.type })),
          rows: rows.map((row) => {
            const r = row as Record<string, unknown>
            return cols.map((c) => encodeHranaValue(r[c.name]))
          }),
          affected_row_count: 0,
          last_insert_rowid: null,
        }
      }

      const result = prepared.run(...params)
      return {
        cols: [],
        rows: [],
        affected_row_count: result.changes,
        last_insert_rowid:
          result.lastInsertRowid != null ? result.lastInsertRowid.toString() : null,
      }
    },

    execRaw(sql: string): void {
      database.exec(sql)
    },

    describe(sql: string): HranaDescribeResult {
      const prepared = database.prepare(sql)
      const cols = prepared.columns()
      // libsql/better-sqlite3 doesn't expose parameter info directly,
      // so we return empty params and infer from the columns
      const isExplain = sql.trimStart().toUpperCase().startsWith('EXPLAIN')
      return {
        params: [],
        cols: cols.map((c) => ({ name: c.name, decltype: c.type })),
        is_explain: isExplain,
        is_readonly: prepared.reader,
      }
    },
  }
}
