// Single-instance lock on a fixed local port (KIMAKI_LOCK_PORT, default 29988).
// GET /health answers { status, pid }. A new bot that finds the port taken asks
// /health for the old pid, sends it SIGTERM, and retries the bind for 20s
// before SIGKILL. /kimaki/send and the agent UI routes arrive in phase 7.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import * as errore from 'errore'

import { ConfigError, LockPortError } from './errors.ts'
import { createLogger } from './logger.ts'

const logger = createLogger('LOCK')

export const DEFAULT_LOCK_PORT = 29988

export async function installShim({ dataDir, command }: { dataDir: string; command: string }): Promise<ConfigError | void> {
  const directory = path.join(dataDir, 'bin')
  const created = await fs.promises.mkdir(directory, { recursive: true }).catch((cause) => new ConfigError({ reason: 'Cannot create Kimaki shim directory', cause }))
  if (created instanceof Error) return created
  const file = path.join(directory, process.platform === 'win32' ? 'kimaki.cmd' : 'kimaki')
  const script = process.platform === 'win32' ? `@echo off\r\n${command} %*\r\n` : `#!/bin/sh\nexec ${command} "$@"\n`
  return fs.promises.writeFile(file, script, { mode: 0o700 }).then(() => fs.promises.chmod(file, 0o700))
    .catch((cause) => new ConfigError({ reason: 'Cannot install Kimaki command shim', cause }))
}

export type LockServer = {
  port: number
  handle: (handler: LockHandler) => void
  close: () => Promise<void>
}

export type LockHandler = (route: string, input: unknown, signal: AbortSignal) => Promise<Error | { data: unknown }>

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
  return typeof body?.pid === 'number' && Number.isSafeInteger(body.pid) && body.pid > 1 ? body.pid : null
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  const result = errore.try(
    () => process.kill(pid, signal),
    (e) => new LockPortError({ port: 0, reason: `kill ${pid} failed`, cause: e }),
  )
  if (result instanceof Error) logger.warn(result.message)
}

export async function startLockServer({ port, dataDir }: { port: number; dataDir: string }): Promise<LockPortError | LockServer> {
  const token = crypto.randomBytes(32).toString('hex')
  const state: { handler: LockHandler | null } = { handler: null }
  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (req.headers.authorization !== `Bearer ${token}`) return json(401, { error: 'Not authorized. Use the lock-token of this bot.' })
    if (req.method !== 'POST') return json(405, { error: 'Use POST' })
    if (!state.handler) return json(503, { error: 'Kimaki is starting. Try again.' })
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 1_048_576) return json(413, { error: 'Request is larger than 1 MiB' })
      chunks.push(Buffer.from(chunk))
    }
    const parsed = errore.try(() => ({ input: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }),
      (cause) => new ConfigError({ reason: 'Invalid JSON request', cause }))
    if (parsed instanceof Error) return json(400, { error: parsed.message })
    const controller = new AbortController()
    res.once('close', () => controller.abort())
    const result = await state.handler(req.url ?? '', parsed.input, controller.signal)
    if (res.destroyed) return
    if (result instanceof Error) return json(result instanceof ConfigError ? 400 : 500, { error: result.message })
    json(200, result.data)
  }
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', pid: process.pid }))
      return
    }
    if (!req.url?.startsWith('/kimaki/')) {
      res.writeHead(404)
      res.end()
      return
    }
    void handle(req, res).catch((cause) => {
      logger.error(`lock request failed: ${String(cause)}`)
      if (!res.headersSent) res.writeHead(500)
      res.end(JSON.stringify({ error: 'Kimaki request failed. Check kimaki logs.' }))
    })
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
  const tokenFile = path.join(dataDir, 'lock-token')
  const written = await fs.promises.writeFile(tokenFile, token, { mode: 0o600 }).then(() => fs.promises.chmod(tokenFile, 0o600))
    .catch((cause) => new LockPortError({ port, reason: 'cannot write lock-token', cause }))
  if (written instanceof Error) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    return written
  }
  return {
    port,
    handle: (handler) => { state.handler = handler },
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      const saved = await fs.promises.readFile(tokenFile, 'utf8').catch(() => null)
      if (saved === token) await fs.promises.unlink(tokenFile).catch((cause) => logger.warn(`remove token: ${String(cause)}`))
    },
  }
}

export async function callBot({ dataDir, route, input, signal }: { dataDir: string; route: string; input: unknown; signal?: AbortSignal }): Promise<ConfigError | { data: unknown }> {
  const token = await fs.promises.readFile(path.join(dataDir, 'lock-token'), 'utf8')
    .catch((cause) => new ConfigError({ reason: 'Kimaki bot is not running. Start kimaki first.', cause }))
  if (token instanceof Error) return token
  const port = Number(process.env['KIMAKI_LOCK_PORT'] || DEFAULT_LOCK_PORT)
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input), signal: signal ?? AbortSignal.timeout(30_000),
  }).catch((cause) => new ConfigError({ reason: 'Kimaki bot is not running. Start kimaki first.', cause }))
  if (response instanceof Error) return response
  const body = await response.json().then((data: unknown) => ({ data }))
    .catch((cause) => new ConfigError({ reason: 'Invalid bot response. Check kimaki logs.', cause }))
  if (body instanceof Error) return body
  if (!response.ok) {
    const value = body.data
    const reason = value && typeof value === 'object' && 'error' in value && typeof value.error === 'string' ? value.error : `Bot returned HTTP ${response.status}`
    return new ConfigError({ reason })
  }
  return body
}
