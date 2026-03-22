// Hrana v2 protocol request processing.
// Pure logic — no I/O, no HTTP. Takes an executor and processes pipeline requests.

import type {
  HranaRequest,
  HranaCondition,
  HranaExecuteResult,
  HranaStmt,
  HranaStreamResult,
  HranaError,
} from './types.ts'
import { decodeHranaParams } from './values.ts'
import type { LibsqlExecutor } from './executor.ts'

// Resolve SQL text from stmt.sql or stmt.sql_id.
// Prefers sql over sql_id when both are set (matches real client behavior).
// Returns empty string when neither is set — callers decide if that's an error.
function resolveStmtSql(
  stmt: HranaStmt,
  sqlStore: Map<number, string>,
): string {
  if (stmt.sql != null) {
    return stmt.sql
  }
  if (stmt.sql_id != null) {
    return sqlStore.get(stmt.sql_id) ?? ''
  }
  return ''
}

// Resolve SQL for sequence/describe which can also reference sql_id.
function resolveRawSql(
  req: HranaRequest,
  sqlStore: Map<number, string>,
): string | null {
  if (req.sql != null) {
    return req.sql
  }
  if (req.sql_id != null) {
    return sqlStore.get(req.sql_id) ?? null
  }
  return null
}

function isHranaError(val: unknown): val is HranaError {
  return typeof val === 'object' && val !== null && 'message' in val && 'code' in val
}

function getSqliteErrorCode(err: Error): string {
  return (err as unknown as { code?: string }).code ?? 'SQLITE_ERROR'
}

function toHranaError(err: unknown): HranaError {
  if (err instanceof Error) {
    return { message: err.message, code: getSqliteErrorCode(err) }
  }
  return { message: String(err), code: 'SQLITE_ERROR' }
}

// ── Condition evaluation ────────────────────────────────────────────

export function evaluateHranaCondition(
  cond: HranaCondition | null | undefined,
  stepResults: Array<HranaExecuteResult | null>,
  stepErrors: Array<HranaError | null>,
): boolean | HranaError {
  if (!cond) {
    return true
  }
  if (cond.type === 'ok') {
    return stepErrors[cond.step!] === null && stepResults[cond.step!] !== null
  }
  if (cond.type === 'error') {
    return stepErrors[cond.step!] !== null
  }
  if (cond.type === 'not') {
    const inner = evaluateHranaCondition(cond.cond, stepResults, stepErrors)
    if (isHranaError(inner)) {
      return inner
    }
    return !inner
  }
  if (cond.type === 'and') {
    return (cond.conds ?? []).every((c) => {
      const result = evaluateHranaCondition(c, stepResults, stepErrors)
      if (isHranaError(result)) {
        return false
      }
      return result
    })
  }
  if (cond.type === 'or') {
    return (cond.conds ?? []).some((c) => {
      const result = evaluateHranaCondition(c, stepResults, stepErrors)
      if (isHranaError(result)) {
        return false
      }
      return result
    })
  }
  if (cond.type === 'is_autocommit') {
    // is_autocommit requires runtime autocommit state from the database connection,
    // which is not available through the generic executor interface.
    return { message: 'is_autocommit condition is not supported', code: 'HRANA_PROTO_ERROR' }
  }
  return { message: `Unknown condition type: ${cond.type}`, code: 'HRANA_PROTO_ERROR' }
}

// ── Individual request handlers ─────────────────────────────────────

async function handleExecute(
  executor: LibsqlExecutor,
  req: HranaRequest,
  sqlStore: Map<number, string>,
): Promise<HranaStreamResult> {
  if (!req.stmt) {
    return {
      type: 'error',
      error: { message: 'Missing stmt', code: 'HRANA_PROTO_ERROR' },
    }
  }
  const sql = resolveStmtSql(req.stmt, sqlStore)
  try {
    const params = decodeHranaParams(req.stmt)
    const result = await executor.executeSql(sql, params)
    return { type: 'ok', response: { type: 'execute', result } }
  } catch (err) {
    return { type: 'error', error: toHranaError(err) }
  }
}

async function handleBatch(
  executor: LibsqlExecutor,
  req: HranaRequest,
  sqlStore: Map<number, string>,
): Promise<HranaStreamResult> {
  const steps = req.batch?.steps ?? []
  const stepResults: Array<HranaExecuteResult | null> = []
  const stepErrors: Array<HranaError | null> = []

  for (const step of steps) {
    const condResult = evaluateHranaCondition(step.condition, stepResults, stepErrors)
    if (isHranaError(condResult)) {
      stepResults.push(null)
      stepErrors.push(condResult)
      continue
    }
    if (!condResult) {
      stepResults.push(null)
      stepErrors.push(null)
      continue
    }
    const sql = resolveStmtSql(step.stmt, sqlStore)
    try {
      const params = decodeHranaParams(step.stmt)
      const result = await executor.executeSql(sql, params)
      stepResults.push(result)
      stepErrors.push(null)
    } catch (err) {
      stepResults.push(null)
      stepErrors.push(toHranaError(err))
    }
  }

  return {
    type: 'ok',
    response: {
      type: 'batch',
      result: { step_results: stepResults, step_errors: stepErrors },
    },
  }
}

async function handleSequence(
  executor: LibsqlExecutor,
  req: HranaRequest,
  sqlStore: Map<number, string>,
): Promise<HranaStreamResult> {
  const sql = resolveRawSql(req, sqlStore)
  if (!sql) {
    // No SQL provided — sequence is a no-op (matches sqld behavior)
    return { type: 'ok', response: { type: 'sequence' } }
  }
  try {
    await executor.execRaw(sql)
    return { type: 'ok', response: { type: 'sequence' } }
  } catch (err) {
    return { type: 'error', error: toHranaError(err) }
  }
}

async function handleDescribe(
  executor: LibsqlExecutor,
  req: HranaRequest,
  sqlStore: Map<number, string>,
): Promise<HranaStreamResult> {
  if (!executor.describe) {
    return {
      type: 'error',
      error: { message: 'describe not supported by this executor', code: 'HRANA_PROTO_ERROR' },
    }
  }
  const sql = resolveRawSql(req, sqlStore)
  if (!sql) {
    return {
      type: 'error',
      error: { message: 'Missing sql or sql_id for describe', code: 'HRANA_PROTO_ERROR' },
    }
  }
  try {
    const result = await executor.describe(sql)
    return { type: 'ok', response: { type: 'describe', result } }
  } catch (err) {
    return { type: 'error', error: toHranaError(err) }
  }
}

// ── Pipeline request dispatcher ─────────────────────────────────────

export async function processHranaRequest(
  executor: LibsqlExecutor,
  req: HranaRequest,
  sqlStore: Map<number, string>,
): Promise<HranaStreamResult> {
  if (req.type === 'execute') {
    return handleExecute(executor, req, sqlStore)
  }
  if (req.type === 'batch') {
    return handleBatch(executor, req, sqlStore)
  }
  if (req.type === 'sequence') {
    return handleSequence(executor, req, sqlStore)
  }
  if (req.type === 'describe') {
    return handleDescribe(executor, req, sqlStore)
  }
  if (req.type === 'close') {
    return { type: 'ok', response: { type: 'close' } }
  }
  if (req.type === 'store_sql') {
    if (req.sql_id == null || req.sql == null) {
      return {
        type: 'error',
        error: { message: 'store_sql requires both sql_id and sql', code: 'HRANA_PROTO_ERROR' },
      }
    }
    if (sqlStore.has(req.sql_id)) {
      return {
        type: 'error',
        error: { message: `sql_id ${req.sql_id} already stored`, code: 'HRANA_PROTO_ERROR' },
      }
    }
    sqlStore.set(req.sql_id, req.sql)
    return { type: 'ok', response: { type: 'store_sql' } }
  }
  if (req.type === 'close_sql') {
    if (req.sql_id != null) {
      sqlStore.delete(req.sql_id)
    }
    return { type: 'ok', response: { type: 'close_sql' } }
  }
  return {
    type: 'error',
    error: { message: `Unknown request type: ${req.type}`, code: 'HRANA_PROTO_ERROR' },
  }
}
