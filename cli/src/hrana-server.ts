// In-process HTTP server speaking the Hrana v2 protocol.
// Backed by the `libsql` npm package (better-sqlite3 API).
// Binds to the fixed lock port for single-instance enforcement.
//
// Protocol logic is implemented in the `libsqlproxy` package.
// This file handles: server lifecycle, single-instance enforcement,
// auth, and kimaki-specific endpoints (/kimaki/wake, /health).
//
// Hrana v2 protocol spec ("Hrana over HTTP"):
//   https://github.com/tursodatabase/libsql/blob/main/docs/HTTP_V2_SPEC.md

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import Database from 'libsql'
import * as errore from 'errore'
import {
  createLibsqlHandler,
  createLibsqlNodeHandler,
  libsqlExecutor,
} from 'libsqlproxy'
import { createLogger, LogPrefix } from './logger.js'
import { ServerStartError, FetchError } from './errors.js'
import { execAsync } from './exec-async.js'
import { getLockPort } from './config.js'
import { store } from './store.js'
import { getOpencodeServerPid } from './opencode.js'

const hranaLogger = createLogger(LogPrefix.DB)

let db: Database.Database | null = null
let server: http.Server | null = null
let hranaUrl: string | null = null
let discordGatewayReady = false
let readyWaiters: Array<() => void> = []

export function markDiscordGatewayReady(): void {
  if (discordGatewayReady) {
    return
  }
  discordGatewayReady = true
  for (const resolve of readyWaiters) {
    resolve()
  }
  readyWaiters = []
}

async function waitForDiscordGatewayReady({ timeoutMs }: { timeoutMs: number }): Promise<boolean> {
  if (discordGatewayReady) {
    return true
  }
  const readyPromise = new Promise<boolean>((resolve) => {
    readyWaiters.push(() => {
      resolve(true)
    })
  })
  const timeoutPromise = new Promise<boolean>((resolve) => {
    setTimeout(() => {
      resolve(false)
    }, timeoutMs)
  })
  return Promise.race([readyPromise, timeoutPromise])
}

function getRequestAuthToken(req: http.IncomingMessage): string | null {
  const authorizationHeader = req.headers.authorization
  if (typeof authorizationHeader === 'string' && authorizationHeader.startsWith('Bearer ')) {
    return authorizationHeader.slice('Bearer '.length)
  }

  return null
}

// Timing-safe comparison to prevent timing attacks when the hrana server
// is internet-facing (bindAll=true / KIMAKI_INTERNET_REACHABLE_URL set).
function isAuthorizedRequest(req: http.IncomingMessage): boolean {
  const expectedToken = store.getState().gatewayToken
  if (!expectedToken) {
    return false
  }
  const providedToken = getRequestAuthToken(req)
  if (!providedToken) {
    return false
  }
  const expectedBuf = Buffer.from(expectedToken, 'utf8')
  const providedBuf = Buffer.from(providedToken, 'utf8')
  if (expectedBuf.length !== providedBuf.length) {
    return false
  }
  return crypto.timingSafeEqual(expectedBuf, providedBuf)
}

function ensureServiceAuthTokenInStore(): string {
  const existingToken = store.getState().gatewayToken
  if (existingToken) {
    return existingToken
  }
  const generatedToken = `${crypto.randomUUID()}:${crypto.randomBytes(32).toString('hex')}`
  store.setState({ gatewayToken: generatedToken })
  return generatedToken
}

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
export async function startHranaServer({
  dbPath,
  bindAll = false,
}: {
  dbPath: string
  /** Bind to 0.0.0.0 instead of 127.0.0.1. Set when KIMAKI_INTERNET_REACHABLE_URL is defined. */
  bindAll?: boolean
}) {
  if (server && db && hranaUrl) return hranaUrl

  const port = getLockPort()
  const bindHost = bindAll ? '0.0.0.0' : '127.0.0.1'
  const serviceAuthToken = ensureServiceAuthTokenInStore()
  process.env.KIMAKI_DB_AUTH_TOKEN = serviceAuthToken

  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  await sweepOrphanOpencodeServers()
  await evictExistingInstance({ port })

  hranaLogger.log(
    `Starting hrana server on ${bindHost}:${port} with db: ${dbPath}`,
  )

  const database = new Database(dbPath)
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA busy_timeout = 5000')
  db = database

  // Create the Hrana handler using libsqlproxy
  const hranaFetchHandler = createLibsqlHandler(libsqlExecutor(database))
  const hranaNodeHandler = createLibsqlNodeHandler(hranaFetchHandler)

  // Combined handler: kimaki-specific endpoints + hrana protocol
  const handler: http.RequestListener = async (req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname
    if (pathname === '/kimaki/wake') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'method_not_allowed' }))
        return
      }
      if (!isAuthorizedRequest(req)) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      const isReady = await waitForDiscordGatewayReady({ timeoutMs: 30_000 })
      if (!isReady) {
        res.writeHead(504, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ready: false, error: 'timeout_waiting_for_discord_ready' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ready: true }))
      return
    }
    // Health check — no auth required.
    //
    // `opencodePid` is included so a second kimaki instance doing eviction
    // can SIGTERM the opencode child alongside the parent. Without this, if
    // the parent gets SIGKILL'd (our 1s grace timeout below, V8 heap OOM in
    // bin.ts, Activity Monitor force-quit, etc.) the opencode child is
    // reparented to PID 1 and leaks ~500 MB RSS indefinitely.
    if (pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          status: 'ok',
          pid: process.pid,
          opencodePid: getOpencodeServerPid(),
        }),
      )
      return
    }
    // Hrana routes: /v2, /v2/pipeline — require auth
    if (pathname === '/v2' || pathname === '/v2/pipeline') {
      if (!isAuthorizedRequest(req)) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      hranaNodeHandler(req, res)
      return
    }
    res.writeHead(404)
    res.end()
  }

  const started = await new Promise<ServerStartError | true>((resolve) => {
    const srv = http.createServer(handler)

    srv.on('error', (err) => {
      const errorCode = Object.getOwnPropertyDescriptor(err, 'code')?.value
      resolve(
        new ServerStartError({
          port,
          reason:
            errorCode === 'EADDRINUSE'
              ? `Port ${port} still in use after eviction`
              : err.message,
        }),
      )
    })
    srv.listen(port, bindHost, () => {
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
  discordGatewayReady = false
  readyWaiters = []
  hranaLogger.log('Hrana server stopped')
}

// ── Single-instance enforcement ──────────────────────────────────────

function signalPid({
  pid,
  signal,
  label,
}: {
  pid: number
  signal: NodeJS.Signals
  label: string
}): void {
  const killResult = errore.try({
    try: () => {
      process.kill(pid, signal)
    },
    catch: (e) =>
      new Error(`Failed to send ${signal} to ${label}`, { cause: e }),
  })
  if (killResult instanceof Error) {
    hranaLogger.log(`Failed to ${signal} ${label} (PID ${pid}): ${killResult.message}`)
  }
}

function isPidAlive(pid: number): boolean {
  const result = errore.try({
    try: () => {
      // Signal 0 = existence check, no signal delivered.
      process.kill(pid, 0)
      return true
    },
    catch: () => new Error('not alive'),
  })
  return result === true
}

/**
 * Evict a previous kimaki instance on the lock port.
 * Fetches /health to get the running process PID, then kills it directly.
 * No lsof/netstat/spawnSync needed — the PID comes from the health response.
 *
 * Also kills the opencode child (from body.opencodePid) on the same deadline.
 * The old kimaki's SIGTERM handler normally does this, but SIGKILL skips
 * cleanup handlers and would leak a ~500 MB opencode process. Killing the
 * child externally via the advertised PID survives that case.
 */
export async function evictExistingInstance({ port }: { port: number }) {
  const url = `http://127.0.0.1:${port}/health`

  const probe = await fetch(url, { signal: AbortSignal.timeout(1000) }).catch(
    (e) => new FetchError({ url, cause: e }),
  )
  if (probe instanceof Error) return

  const bodyText = await probe.text().catch((e) => new FetchError({ url, cause: e }))
  if (bodyText instanceof Error) return

  const body = parseHealthPayload({ body: bodyText })
  const targetPid = body.pid
  if (!targetPid || targetPid === process.pid) return

  const opencodePid = body.opencodePid

  hranaLogger.log(
    `Evicting existing kimaki process (PID: ${targetPid}, opencode PID: ${
      opencodePid ?? 'none'
    }) on port ${port}`,
  )
  signalPid({ pid: targetPid, signal: 'SIGTERM', label: 'existing kimaki process' })

  await new Promise((resolve) => {
    setTimeout(resolve, 1000)
  })

  // Verify kimaki is gone — if still alive, escalate to SIGKILL.
  const secondProbe = await fetch(url, {
    signal: AbortSignal.timeout(500),
  }).catch((e) => new FetchError({ url, cause: e }))
  const kimakiStillAlive = !(secondProbe instanceof Error)

  if (kimakiStillAlive) {
    hranaLogger.log(
      `PID ${targetPid} still alive after SIGTERM, sending SIGKILL`,
    )
    signalPid({
      pid: targetPid,
      signal: 'SIGKILL',
      label: 'existing kimaki process',
    })
    await new Promise((resolve) => {
      setTimeout(resolve, 1000)
    })
  }

  // Clean up the opencode child regardless of how kimaki exited. If kimaki
  // shut down gracefully its own handler already SIGTERM'd this PID, so
  // isPidAlive will be false and we skip. If kimaki was SIGKILL'd (above,
  // or by V8 OOM, Activity Monitor, etc.) the child is orphaned on PID 1
  // with a closed socket and we kill it here.
  if (opencodePid && opencodePid !== process.pid && isPidAlive(opencodePid)) {
    hranaLogger.log(
      `Cleaning up opencode child (PID: ${opencodePid}) orphaned by evicted kimaki`,
    )
    signalPid({
      pid: opencodePid,
      signal: 'SIGTERM',
      label: 'orphaned opencode child',
    })
    await new Promise((resolve) => {
      setTimeout(resolve, 1000)
    })
    if (isPidAlive(opencodePid)) {
      signalPid({
        pid: opencodePid,
        signal: 'SIGKILL',
        label: 'orphaned opencode child',
      })
    }
  }
}

// ── Orphan sweep ─────────────────────────────────────────────────────
//
// Catches opencode servers abandoned by a prior kimaki that died before
// this instance started (so /health is unreachable and evictExistingInstance
// has nothing to read). Runs at startHranaServer() boot time.
//
// Exported for testing. Pure parsing is split out so we can unit-test the
// PID selection logic without touching real processes.

type PsRow = { pid: number; ppid: number; command: string }

type HealthPayload = {
  pid: number | null
  opencodePid: number | null
}

function parseHealthPayload({ body }: { body: string }): HealthPayload {
  const parsed = errore.try({
    try: () => JSON.parse(body),
    catch: () => null,
  })
  if (!parsed || parsed instanceof Error || Array.isArray(parsed)) {
    return { pid: null, opencodePid: null }
  }

  const record = parsed as { pid?: unknown; opencodePid?: unknown }
  return {
    pid: typeof record.pid === 'number' ? record.pid : null,
    opencodePid:
      typeof record.opencodePid === 'number' && record.opencodePid > 0
        ? record.opencodePid
        : null,
  }
}

/**
 * Parse `ps -axo pid=,ppid=,command=` output into rows.
 * Format per line: leading whitespace, pid, space(s), ppid, space(s), command.
 * `command` can contain arbitrary spaces/args and is kept verbatim.
 */
export function parsePsOutput(output: string): PsRow[] {
  const rows: PsRow[] = []
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trimStart()
    if (!line) continue
    const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/)
    if (!match) continue
    const pid = Number.parseInt(match[1]!, 10)
    const ppid = Number.parseInt(match[2]!, 10)
    const command = match[3]!
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue
    rows.push({ pid, ppid, command })
  }
  return rows
}

/**
 * Pick orphan opencode server PIDs from `ps` output.
 *
 * An orphan is a process whose:
 *  - parent is PID 1 (reparented after kimaki died without cleanup), and
 *  - first token of the command is an opencode binary (basename `opencode`
 *    or `.opencode`), and
 *  - second token is `serve` (we never want to kill `opencode tui`, `run`,
 *    or unrelated invocations).
 *
 * The binary path shape varies by install: kimaki's resolveOpencodeCommand()
 * often returns `~/.nvm/.../bin/opencode` (a shell wrapper), but when that
 * wrapper execs its sibling `.../lib/node_modules/opencode-ai/bin/.opencode`
 * and then dies, the reparented orphan shows a different absolute path
 * ending in `.opencode`. Matching on the basename catches both shapes.
 *
 * Self-exclusion is done by PID (never the current kimaki); at
 * startHranaServer() boot time there is no live opencode child yet.
 */
export function selectOrphanOpencodePids({
  rows,
  selfPid,
}: {
  rows: PsRow[]
  selfPid: number
}): number[] {
  const orphans: number[] = []
  for (const row of rows) {
    if (row.pid === selfPid) continue
    if (row.ppid !== 1) continue

    // Split on whitespace but preserve argv[0] intact even if it contains
    // spaces-in-paths (unlikely but possible). First token = binary path.
    const firstSpace = row.command.indexOf(' ')
    if (firstSpace < 0) continue
    const argv0 = row.command.slice(0, firstSpace)
    const rest = row.command.slice(firstSpace + 1)

    // Basename of argv[0].
    const lastSlash = argv0.lastIndexOf('/')
    const basename = lastSlash >= 0 ? argv0.slice(lastSlash + 1) : argv0
    if (basename !== 'opencode' && basename !== '.opencode') continue

    // Require `serve` as the subcommand (first positional arg).
    const restTrimmed = rest.trimStart()
    if (!restTrimmed.startsWith('serve')) continue
    const afterServe = restTrimmed.slice('serve'.length)
    if (afterServe.length > 0 && !/^\s/.test(afterServe)) continue

    orphans.push(row.pid)
  }
  return orphans
}

/**
 * Scan for orphan `opencode serve` processes and SIGTERM them.
 *
 * Safe to call on boot. Skips gracefully on non-POSIX platforms where `ps`
 * isn't available in this form (notably Windows).
 */
export async function sweepOrphanOpencodeServers(): Promise<void> {
  if (process.platform === 'win32') return

  const psResult = await execAsync('ps -axo pid=,ppid=,command=', {
    timeout: 3000,
  }).catch((e) => new Error('ps enumeration failed', { cause: e }))
  if (psResult instanceof Error) {
    hranaLogger.log(`Orphan sweep skipped: ${psResult.message}`)
    return
  }

  const rows = parsePsOutput(psResult.stdout)
  const orphans = selectOrphanOpencodePids({
    rows,
    selfPid: process.pid,
  })
  if (orphans.length === 0) return

  hranaLogger.log(
    `Orphan sweep: found ${orphans.length} abandoned opencode serve process(es), sending SIGTERM`,
  )
  for (const pid of orphans) {
    signalPid({ pid, signal: 'SIGTERM', label: `orphan opencode server` })
  }
}
