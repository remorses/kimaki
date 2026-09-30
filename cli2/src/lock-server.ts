// Single-instance lock on a fixed local port (KIMAKI_LOCK_PORT, default 29988).
// GET /health answers { status, pid }. A new bot that finds the port taken asks
// /health for the old pid, sends it SIGTERM, and retries the bind for 20s
// before SIGKILL. /kimaki/send and the agent UI routes arrive in phase 7.

import http from 'node:http'
import { setTimeout as sleep } from 'node:timers/promises'
import * as errore from 'errore'

import { LockPortError } from './errors.ts'
import { createLogger } from './logger.ts'

const logger = createLogger('LOCK')

export const DEFAULT_LOCK_PORT = 29988

export type LockServer = {
  port: number
  close: () => Promise<void>
}

function listen(server: http.Server, port: number): Promise<Error | void> {
  return new Promise((resolve) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      resolve(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

async function readHealthPid(port: number): Promise<number | null> {
  const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) }).catch(
    () => null,
  )
  if (!response?.ok) return null
  const body = (await response.json().catch(() => null)) as { pid?: unknown } | null
  return typeof body?.pid === 'number' ? body.pid : null
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  const result = errore.try(
    () => process.kill(pid, signal),
    (e) => new LockPortError({ port: 0, reason: `kill ${pid} failed`, cause: e }),
  )
  if (result instanceof Error) logger.warn(result.message)
}

export async function startLockServer({ port }: { port: number }): Promise<LockPortError | LockServer> {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', pid: process.pid }))
      return
    }
    res.writeHead(404)
    res.end()
  })

  const first = await listen(server, port)
  if (first instanceof Error) {
    if (!('code' in first) || first.code !== 'EADDRINUSE') {
      return new LockPortError({ port, reason: first.message, cause: first })
    }
    const pid = await readHealthPid(port)
    if (pid === null || pid === process.pid) {
      return new LockPortError({ port, reason: 'port is used by another program' })
    }
    logger.log(`another kimaki (pid ${pid}) holds port ${port}, sending SIGTERM`)
    signalProcess(pid, 'SIGTERM')
    const deadline = Date.now() + 25_000
    const killAt = Date.now() + 20_000
    const bound = await (async () => {
      const killed = { sent: false }
      while (Date.now() < deadline) {
        await sleep(250)
        if (!killed.sent && Date.now() >= killAt) {
          killed.sent = true
          signalProcess(pid, 'SIGKILL')
        }
        const retry = await listen(server, port)
        if (!(retry instanceof Error)) return true
      }
      return false
    })()
    if (!bound) return new LockPortError({ port, reason: `pid ${pid} did not exit` })
  }

  logger.log(`lock server listening on 127.0.0.1:${port}`)
  return {
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}
