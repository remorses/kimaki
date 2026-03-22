// SQL executor interface for dependency injection.
// Implementations can be synchronous or asynchronous — the protocol handler
// awaits all return values uniformly.

import type { HranaExecuteResult, HranaDescribeResult } from './types.ts'

export interface LibsqlExecutor {
  // Execute a prepared statement with positional params (or a single named-params object).
  // Returns column info, rows, affected count, and last insert rowid.
  executeSql(sql: string, params: unknown[]): HranaExecuteResult | Promise<HranaExecuteResult>

  // Execute raw SQL (possibly multiple semicolon-separated statements).
  // No results needed — used by the `sequence` request type.
  execRaw(sql: string): void | Promise<void>

  // Describe a statement without executing it.
  // Returns column info and parameter info. Used by GUI tools for schema introspection.
  // Optional — if not provided, `describe` requests return an error.
  describe?(sql: string): HranaDescribeResult | Promise<HranaDescribeResult>
}
