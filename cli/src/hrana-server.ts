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
import { createLibsqlHandler, createLibsqlNodeHandler, libsqlExecutor } from 'libsqlproxy'
import { createLogger, LogPrefix } from './logger.js'
import { ServerStartError, FetchError } from './errors.js'
import { getLockPort } from './config.js'
import { store } from './store.js'
// Circular import: opencode.ts → hrana-server.ts → opencode.ts.
// Safe because both sides only use lazy runtime function calls, never
// top-level initialization values. The cycle could be broken by moving
// the port into store.ts, but the current approach is simpler.
import { getOpencodeServerConnection } from './opencode.js'

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

function getRequestAuthToken(req: { headers: http.IncomingHttpHeaders }): string | null {
  const authorizationHeader = req.headers.authorization
  if (typeof authorizationHeader === 'string' && authorizationHeader.startsWith('Bearer ')) {
    return authorizationHeader.slice('Bearer '.length)
  }

  return null
}

// Timing-safe comparison to prevent timing attacks when the hrana server
// is internet-facing (bindAll=true / KIMAKI_INTERNET_REACHABLE_URL set).
export function isAuthorizedRequest(req: { headers: http.IncomingHttpHeaders }): boolean {
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
 * itself always uses direct file: access via Drizzle/libSQL.
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
  await evictExistingInstance({ port })

  hranaLogger.log(`Starting hrana server on ${bindHost}:${port} with db: ${dbPath}`)

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
    // Health check — no auth required
    if (pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', pid: process.pid, wrapperPid: getWrapperPid() }))
      return
    }
    // OpenCode server port discovery — no auth required (localhost only).
    // CLI subcommands query this to reuse the bot's running OpenCode server
    // instead of spawning a redundant second server process.
    if (pathname === '/kimaki/opencode-port') {
      if (!isAuthorizedRequest(req)) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
      const connection = getOpencodeServerConnection()
      if (!connection) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'no_opencode_server' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(connection))
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
      const code = 'code' in err ? err.code : undefined
      resolve(
        new ServerStartError({
          port,
          reason: code === 'EADDRINUSE' ? `Port ${port} still in use after eviction` : err.message,
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

/**
 * Evict a previous kimaki instance on the lock port.
 * Fetches /health to get the running process PID, then kills it directly.
 * No lsof/netstat/spawnSync needed — the PID comes from the health response.
 *
 * SIGTERM first so the old bot can clean up. Its own shutdown deadline is
 * 15s, so after a longer grace period we SIGKILL: a stuck process must never
 * block every future start. Safe because the PID comes from our own /health.
 */
export async function evictExistingInstance({
  port,
  gracePeriodMs = 20_000,
}: {
  port: number
  gracePeriodMs?: number
}) {
  const url = `http://127.0.0.1:${port}/health`

  const probe = await fetch(url, { signal: AbortSignal.timeout(1000) }).catch(
    (e) => new FetchError({ url, cause: e }),
  )
  if (probe instanceof Error) return

  const body = await (probe.json() as Promise<{ pid?: number; wrapperPid?: number | null }>).catch(
    (e) => new FetchError({ url, cause: e }),
  )
  if (body instanceof Error || !body) return

  const targetPid = body.pid
  if (!targetPid || targetPid === process.pid) return
  // Signal the bin.ts wrapper, not only the child: killing just the child
  // looks like a crash and the old wrapper respawns it, which then evicts us.
  // The wrapper forwards SIGTERM and does not restart after it.
  const wrapperPid = body.wrapperPid && body.wrapperPid !== process.ppid
    ? body.wrapperPid
    : null

  hranaLogger.log(`Evicting existing kimaki process (PID: ${targetPid}) on port ${port}`)
  const killResult = errore.try(
    () => {
      process.kill(wrapperPid ?? targetPid, 'SIGTERM')
    },
    (e) =>
      new Error('Failed to send SIGTERM to existing kimaki process', {
        cause: e,
      }),
  )
  if (killResult instanceof Error) {
    hranaLogger.log(`Failed to kill PID ${targetPid}: ${killResult.message}`)
    return
  }

  // Wait for process exit, not just a failed probe: a process that already
  // closed its HTTP server can still be alive and holding the socket briefly.
  if (await waitForProcessExit({ pid: targetPid, timeoutMs: gracePeriodMs })) {
    return
  }

  hranaLogger.log(
    `PID ${targetPid} still alive after ${gracePeriodMs / 1000}s SIGTERM grace period, sending SIGKILL`,
  )
  // Wrapper first so it cannot respawn the child we are about to kill.
  const wrapperKillResult = wrapperPid
    ? errore.try(
        () => {
          process.kill(wrapperPid, 'SIGKILL')
        },
        (e) => new Error('Failed to send SIGKILL to kimaki wrapper', { cause: e }),
      )
    : null
  if (wrapperKillResult instanceof Error) {
    hranaLogger.log(`Failed to kill wrapper PID ${wrapperPid}: ${wrapperKillResult.message}`)
  }
  const forceKillResult = errore.try(
    () => {
      process.kill(targetPid, 'SIGKILL')
    },
    (e) =>
      new Error('Failed to send SIGKILL to existing kimaki process', {
        cause: e,
      }),
  )
  if (forceKillResult instanceof Error) {
    hranaLogger.log(`Failed to kill PID ${targetPid}: ${forceKillResult.message}`)
    return
  }
  if (await waitForProcessExit({ pid: targetPid, timeoutMs: 5_000 })) {
    return
  }
  hranaLogger.log(`PID ${targetPid} still alive after SIGKILL`)
}

// PID of the bin.ts respawn wrapper, only while it is alive (IPC connected).
// Without the connected check an orphan would report ppid 1.
function getWrapperPid(): number | null {
  if (!process.env.__KIMAKI_CHILD || !process.connected) {
    return null
  }
  return process.ppid
}

function isProcessAlive(pid: number): boolean {
  const result = errore.try(
    () => {
      process.kill(pid, 0)
    },
    (e) => new Error('Process liveness check failed', { cause: e }),
  )
  if (result instanceof Error) {
    // EPERM means the PID exists but belongs to another user.
    return result.cause instanceof Error && Reflect.get(result.cause, 'code') === 'EPERM'
  }
  return true
}

async function waitForProcessExit({
  pid,
  timeoutMs,
}: {
  pid: number
  timeoutMs: number
}): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await new Promise((resolve) => {
      setTimeout(resolve, 200)
    })
  }
  return !isProcessAlive(pid)
}
