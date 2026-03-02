// In-process HTTP server speaking the Hrana v2 protocol.
// Replaces the sqld child process (39MB Rust binary) with a lightweight
// server backed by the `libsql` npm package (better-sqlite3 API).
// Binds to the fixed lock port for single-instance enforcement.
//
// Serves POST /v2/pipeline (Hrana v2 JSON), GET /v2, and GET /health.
// The @libsql/client HTTP driver and @prisma/adapter-libsql connect here.
//
// Hrana v2 protocol spec ("Hrana over HTTP"):
//   https://github.com/tursodatabase/libsql/blob/main/docs/HTTP_V2_SPEC.md
//
// The protocol exposes stateful streams over HTTP. Each stream corresponds
// to a SQLite connection. Requests on the same stream are tied together
// via a "baton" — the server returns a baton in every response, and the
// client includes it in the next request. Stream-scoped state includes
// SQL text cached via store_sql (referenced by sql_id in later stmts).
//
// Request types implemented:
//   execute     — run a single SQL statement, return cols/rows/changes
//   batch       — run multiple steps with conditional execution (ok/not/and/or)
//   sequence    — split raw SQL by semicolons, execute each (no results)
//   store_sql   — cache SQL text under a numeric sql_id for the stream
//   close_sql   — remove a cached sql_id
//   close       — close the stream (baton becomes null)
//
// Value encoding (SQLite → Hrana JSON):
//   INTEGER → {"type":"integer","value":"42"}  (string, not number)
//   REAL    → {"type":"float","value":3.14}
//   TEXT    → {"type":"text","value":"hello"}
//   BLOB    → {"type":"blob","base64":"..."}
//   NULL    → {"type":"null"}

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import Database from 'libsql'
import * as errore from 'errore'
import { createLogger, LogPrefix } from './logger.js'
import { ServerStartError, FetchError } from './errors.js'
import { getLockPort } from './config.js'

const hranaLogger = createLogger(LogPrefix.DB)

let db: Database.Database | null = null
let server: http.Server | null = null
let hranaUrl: string | null = null

/**
 * Get the Hrana HTTP URL for injecting into plugin child processes.
 * Returns null if the server hasn't been started yet.
 * Only used for KIMAKI_DB_URL env var in opencode.ts — the bot process
 * itself always uses direct file: access via Prisma.
 */
export function getHranaUrl(): string | null {
  return hranaUrl
}

/**
 * Start the in-process Hrana v2 server on the fixed lock port.
 * Handles single-instance enforcement: if the port is occupied, kills the
 * existing process first.
 */
export async function startHranaServer({ dbPath }: { dbPath: string }) {
  if (server && db && hranaUrl) return hranaUrl

  const port = getLockPort()

  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  await evictExistingInstance({ port })

  hranaLogger.log(
    `Starting hrana server on 127.0.0.1:${port} with db: ${dbPath}`,
  )

  const database = new Database(dbPath)
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA busy_timeout = 5000')
  db = database

  const handler = createHranaHandler(database)

  const started = await new Promise<ServerStartError | true>((resolve) => {
    const srv = http.createServer(handler)
    srv.on('error', (err: NodeJS.ErrnoException) => {
      resolve(
        new ServerStartError({
          port,
          reason:
            err.code === 'EADDRINUSE'
              ? `Port ${port} still in use after eviction`
              : err.message,
        }),
      )
    })
    srv.listen(port, '127.0.0.1', () => {
      server = srv
      resolve(true)
    })
  })
  if (started instanceof Error) {
    database.close()
    db = null
    return started
  }

  hranaUrl = `http://127.0.0.1:${port}`
  hranaLogger.log(`Hrana server ready at ${hranaUrl}`)
  return hranaUrl
}

/**
 * Stop the Hrana server and close the database.
 */
export async function stopHranaServer() {
  if (server) {
    hranaLogger.log('Stopping hrana server...')
    await new Promise<void>((resolve) => {
      server!.close(() => {
        resolve()
      })
    })
    server = null
  }
  if (db) {
    db.close()
    db = null
  }
  hranaUrl = null
  hranaLogger.log('Hrana server stopped')
}

// ── Hrana v2 protocol types ──────────────────────────────────────────────

type HranaValue =
  | { type: 'null' }
  | { type: 'integer'; value: string }
  | { type: 'float'; value: number }
  | { type: 'text'; value: string }
  | { type: 'blob'; base64: string }

interface HranaStmt {
  sql?: string
  sql_id?: number
  args?: HranaValue[]
  named_args?: Array<{ name: string; value: HranaValue }>
  want_rows?: boolean
}

interface HranaCondition {
  type: 'ok' | 'not' | 'and' | 'or'
  step?: number
  cond?: HranaCondition
  conds?: HranaCondition[]
}

interface HranaBatchStep {
  stmt: HranaStmt
  condition?: HranaCondition | null
}

interface HranaRequest {
  type: string
  stmt?: HranaStmt
  batch?: { steps: HranaBatchStep[] }
  sql?: string
  sql_id?: number
}

interface HranaPipelineRequest {
  baton: string | null
  requests: HranaRequest[]
}

interface HranaColInfo {
  name: string
  decltype: string | null
}

interface HranaExecuteResult {
  cols: HranaColInfo[]
  rows: HranaValue[][]
  affected_row_count: number
  last_insert_rowid: string | null
}

// ── Value encoding/decoding ──────────────────────────────────────────────

function encodeValue(val: unknown): HranaValue {
  if (val === null || val === undefined) return { type: 'null' }
  if (typeof val === 'bigint') return { type: 'integer', value: val.toString() }
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return { type: 'integer', value: val.toString() }
    return { type: 'float', value: val }
  }
  if (typeof val === 'string') return { type: 'text', value: val }
  if (Buffer.isBuffer(val))
    return { type: 'blob', base64: val.toString('base64') }
  if (val instanceof Uint8Array)
    return { type: 'blob', base64: Buffer.from(val).toString('base64') }
  return { type: 'text', value: String(val) }
}

function decodeValue(val: HranaValue): unknown {
  if (val.type === 'null') return null
  if (val.type === 'integer') {
    const n = Number(val.value)
    return Number.isSafeInteger(n) ? n : BigInt(val.value)
  }
  if (val.type === 'float') return val.value
  if (val.type === 'text') return val.value
  if (val.type === 'blob') return Buffer.from(val.base64, 'base64')
  return null
}

// ── Statement execution ──────────────────────────────────────────────────

// SqliteError from libsql has a `code` property but catch gives Error.
function getSqliteErrorCode(err: Error): string {
  return (err as unknown as { code?: string }).code ?? 'SQLITE_ERROR'
}

function resolveStmtSql(
  stmt: HranaStmt,
  sqlStore: Map<number, string>,
): string {
  if (stmt.sql != null) return stmt.sql
  if (stmt.sql_id != null) return sqlStore.get(stmt.sql_id) ?? ''
  return ''
}

function bindParams(stmt: HranaStmt): unknown[] {
  if (stmt.named_args && stmt.named_args.length > 0) {
    const named: Record<string, unknown> = {}
    for (const na of stmt.named_args) {
      named[na.name] = decodeValue(na.value)
    }
    return [named]
  }
  return (stmt.args ?? []).map(decodeValue)
}

function executeStmt(
  database: Database.Database,
  stmt: HranaStmt,
  sqlStore: Map<number, string>,
): HranaExecuteResult {
  const sql = resolveStmtSql(stmt, sqlStore)
  const prepared = database.prepare(sql)
  const params = bindParams(stmt)

  if (prepared.reader) {
    const cols = prepared.columns()
    const rows = prepared.all(...params) as Record<string, unknown>[]
    return {
      cols: cols.map((c) => ({ name: c.name, decltype: c.type })),
      rows: rows.map((row) => cols.map((c) => encodeValue(row[c.name]))),
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
}

// ── Batch condition evaluation ───────────────────────────────────────────

function evaluateCondition(
  cond: HranaCondition | null | undefined,
  stepResults: Array<HranaExecuteResult | null>,
  stepErrors: Array<{ message: string; code: string } | null>,
): boolean {
  if (!cond) return true
  if (cond.type === 'ok')
    return stepErrors[cond.step!] === null && stepResults[cond.step!] !== null
  if (cond.type === 'not')
    return !evaluateCondition(cond.cond, stepResults, stepErrors)
  if (cond.type === 'and')
    return (cond.conds ?? []).every((c) =>
      evaluateCondition(c, stepResults, stepErrors),
    )
  if (cond.type === 'or')
    return (cond.conds ?? []).some((c) =>
      evaluateCondition(c, stepResults, stepErrors),
    )
  return true
}

// ── Request handlers ─────────────────────────────────────────────────────

function handleExecute(
  database: Database.Database,
  req: HranaRequest,
  sqlStore: Map<number, string>,
) {
  if (!req.stmt)
    return {
      type: 'error' as const,
      error: { message: 'Missing stmt', code: 'HRANA_PROTO_ERROR' },
    }
  const result = errore.try({
    try: () => executeStmt(database, req.stmt!, sqlStore),
    catch: (e) => e as Error,
  })
  if (result instanceof Error) {
    return {
      type: 'error' as const,
      error: { message: result.message, code: getSqliteErrorCode(result) },
    }
  }
  return { type: 'ok' as const, response: { type: 'execute', result } }
}

function handleBatch(
  database: Database.Database,
  req: HranaRequest,
  sqlStore: Map<number, string>,
) {
  const steps = req.batch?.steps ?? []
  const stepResults: Array<HranaExecuteResult | null> = []
  const stepErrors: Array<{ message: string; code: string } | null> = []

  for (const step of steps) {
    if (!evaluateCondition(step.condition, stepResults, stepErrors)) {
      stepResults.push(null)
      stepErrors.push(null)
      continue
    }
    const result = errore.try({
      try: () => executeStmt(database, step.stmt, sqlStore),
      catch: (e) => e as Error,
    })
    if (result instanceof Error) {
      stepResults.push(null)
      stepErrors.push({
        message: result.message,
        code: getSqliteErrorCode(result),
      })
    } else {
      stepResults.push(result)
      stepErrors.push(null)
    }
  }

  return {
    type: 'ok' as const,
    response: {
      type: 'batch',
      result: { step_results: stepResults, step_errors: stepErrors },
    },
  }
}

function handleSequence(
  database: Database.Database,
  req: HranaRequest,
  sqlStore: Map<number, string>,
) {
  const sql = req.sql ?? (req.sql_id != null ? sqlStore.get(req.sql_id) : null)
  if (!sql) return { type: 'ok' as const, response: { type: 'sequence' } }
  const result = errore.try({
    try: () => {
      database.exec(sql)
    },
    catch: (e) => e as Error,
  })
  if (result instanceof Error) {
    return {
      type: 'error' as const,
      error: { message: result.message, code: getSqliteErrorCode(result) },
    }
  }
  return { type: 'ok' as const, response: { type: 'sequence' } }
}

function processRequest(
  database: Database.Database,
  req: HranaRequest,
  sqlStore: Map<number, string>,
) {
  if (req.type === 'execute') return handleExecute(database, req, sqlStore)
  if (req.type === 'batch') return handleBatch(database, req, sqlStore)
  if (req.type === 'sequence') return handleSequence(database, req, sqlStore)
  if (req.type === 'close')
    return { type: 'ok' as const, response: { type: 'close' } }
  if (req.type === 'store_sql') {
    if (req.sql_id != null && req.sql != null) sqlStore.set(req.sql_id, req.sql)
    return { type: 'ok' as const, response: { type: 'store_sql' } }
  }
  if (req.type === 'close_sql') {
    if (req.sql_id != null) sqlStore.delete(req.sql_id)
    return { type: 'ok' as const, response: { type: 'close_sql' } }
  }
  return {
    type: 'error' as const,
    error: {
      message: `Unknown request type: ${req.type}`,
      code: 'HRANA_PROTO_ERROR',
    },
  }
}

// ── HTTP handler ─────────────────────────────────────────────────────────

// @libsql/client HTTP driver uses batons to keep streams alive across
// pipeline requests (needed for interactive transactions). Each stream has
// its own SQL store for store_sql/close_sql scoping.

let batonCounter = 0
const streamStores = new Map<string, Map<number, string>>()

export function createHranaHandler(
  database: Database.Database,
): http.RequestListener {
  return (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', pid: process.pid }))
      return
    }
    if (req.method === 'GET' && req.url === '/v2') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"version":"hrana-v2"}')
      return
    }
    if (req.method === 'POST' && req.url === '/v2/pipeline') {
      const chunks: Buffer[] = []
      let aborted = false
      req.on('error', () => {
        aborted = true
        res.destroy()
      })
      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (aborted) return
        const parseResult = errore.try({
          try: () =>
            JSON.parse(
              Buffer.concat(chunks).toString(),
            ) as HranaPipelineRequest,
          catch: (e) => e as Error,
        })
        if (parseResult instanceof Error) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              error: {
                message: parseResult.message,
                code: 'HRANA_PROTO_ERROR',
              },
            }),
          )
          return
        }

        // Resolve or create per-stream SQL store keyed by baton
        const incoming = parseResult.baton
        const sqlStore =
          (incoming ? streamStores.get(incoming) : undefined) ??
          new Map<number, string>()
        if (incoming) streamStores.delete(incoming)

        const results = (parseResult.requests ?? []).map((r) =>
          processRequest(database, r, sqlStore),
        )
        const hasClose = (parseResult.requests ?? []).some(
          (r) => r.type === 'close',
        )

        const baton = hasClose ? null : `b${++batonCounter}`
        if (baton) streamStores.set(baton, sqlStore)

        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ baton, base_url: null, results }))
      })
      return
    }
    res.writeHead(404)
    res.end()
  }
}

// ── Single-instance enforcement ──────────────────────────────────────────

/**
 * Evict a previous kimaki instance on the lock port.
 * Fetches /health to get the running process PID, then kills it directly.
 * No lsof/netstat/spawnSync needed — the PID comes from the health response.
 */
export async function evictExistingInstance({ port }: { port: number }) {
  const url = `http://127.0.0.1:${port}/health`

  const probe = await fetch(url, { signal: AbortSignal.timeout(1000) }).catch(
    (e) => new FetchError({ url, cause: e }),
  )
  if (probe instanceof Error) return

  const body = await (probe.json() as Promise<{ pid?: number }>).catch(
    (e) => new FetchError({ url, cause: e }),
  )
  if (body instanceof Error) return

  const targetPid = body.pid
  if (!targetPid || targetPid === process.pid) return

  hranaLogger.log(
    `Evicting existing kimaki process (PID: ${targetPid}) on port ${port}`,
  )
  const killResult = errore.try({
    try: () => {
      process.kill(targetPid, 'SIGTERM')
    },
    catch: (e) => e as Error,
  })
  if (killResult instanceof Error) {
    hranaLogger.log(`Failed to kill PID ${targetPid}: ${killResult.message}`)
    return
  }

  await new Promise((resolve) => {
    setTimeout(resolve, 1000)
  })

  // Verify it's gone — if still alive, escalate to SIGKILL
  const secondProbe = await fetch(url, {
    signal: AbortSignal.timeout(500),
  }).catch((e) => new FetchError({ url, cause: e }))
  if (secondProbe instanceof Error) return

  hranaLogger.log(`PID ${targetPid} still alive after SIGTERM, sending SIGKILL`)
  errore.try({
    try: () => {
      process.kill(targetPid, 'SIGKILL')
    },
    catch: (e) => e as Error,
  })
  await new Promise((resolve) => {
    setTimeout(resolve, 1000)
  })
}
