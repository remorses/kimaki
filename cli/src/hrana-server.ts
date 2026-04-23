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
import { getLockPort } from './config.js'
import { store } from './store.js'

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
    // Health check — no auth required
    if (pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', pid: process.pid }))
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
    catch: (e) =>
      new Error('Failed to send SIGTERM to existing kimaki process', {
        cause: e,
      }),
  })
  if (killResult instanceof Error) {
    hranaLogger.log(`Failed to kill PID ${targetPid}: ${killResult.message}`)
    return
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 1000)
    })

    // Verify it's gone. Some shutdown paths need a few seconds to run cleanup,
    // so we avoid SIGKILL and just poll for up to 10 seconds.
    const secondProbe = await fetch(url, {
      signal: AbortSignal.timeout(2000),
    }).catch((e) => new FetchError({ url, cause: e }))
    if (secondProbe instanceof Error) return
  }

  hranaLogger.log(`PID ${targetPid} still alive after 10s SIGTERM grace period`)
}
