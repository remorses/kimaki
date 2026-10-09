// Single-instance lock on a fixed local port (KIMAKI_LOCK_PORT, default 29988).
// A new bot takes the port over from the running one (V1 or V2), like V1 did:
//
//   new bot ─GET /health─▶ old bot: { pid, wrapperPid }   (no answer: nothing to stop)
//           ─SIGTERM wrapperPid ?? pid─▶ wait for pid to exit (20s) ─▶ SIGKILL both
//           ─▶ bind the port
//
// The wrapper (V2: the supervisor in cli/bot.ts) gets the signal, not the
// bot: a killed bot alone looks like a crash. Both wrappers forward SIGTERM
// and then exit without spawning the bot again.

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import * as errore from 'errore'

import { BotNotRunningError, ConfigError, LockPortError } from './errors.ts'
import type { LockRouteInput, LockRouteName, LockRouteOutput } from './lock-routes.ts'
import { createLogger } from './logger.ts'

const logger = createLogger('LOCK')

export const DEFAULT_LOCK_PORT = 29988

// Exit code that tells the supervisor of the root `kimaki` command (cli/bot.ts) to start the bot again.
export const RESTART_EXIT_CODE = 75

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
  // Started by the `kimaki` supervisor (cli/bot.ts): `kimaki restart` can respawn it.
  supervised: boolean
  handle: (handler: LockHandler) => void
  close: () => Promise<void>
}

export type LockHandler = (route: string, input: unknown, signal: AbortSignal) => Promise<Error | { data: unknown }>

function listen(server: http.Server, port: number): Promise<NodeJS.ErrnoException | void> {
  return new Promise((resolve) => {
    const onError = (error: NodeJS.ErrnoException) => {
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

// PID of the supervisor while it is alive (IPC connected); an orphan bot reports none.
function wrapperPid(supervised: boolean): number | null {
  if (!supervised || !process.connected) return null
  return process.ppid
}

function isAlive(pid: number): boolean {
  const probed = errore.try(() => process.kill(pid, 0), (cause) => new ConfigError({ reason: `probe PID ${pid}`, cause }))
  if (!(probed instanceof Error)) return true
  // EPERM: the PID exists but belongs to another user.
  return probed.cause instanceof Error && Reflect.get(probed.cause, 'code') === 'EPERM'
}

async function waitForExit({ pid, timeoutMs }: { pid: number; timeoutMs: number }): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await sleep(100)
  }
  return !isAlive(pid)
}

function signal({ pid, name }: { pid: number; name: NodeJS.Signals }): void {
  const sent = errore.try(() => process.kill(pid, name), (cause) => new ConfigError({ reason: `${name} to PID ${pid}`, cause }))
  if (sent instanceof Error) logger.warn('cannot send', sent)
}

// Stops the kimaki bot on the port, if one answers /health. Its own shutdown
// has a deadline, so a bot still alive after the grace period is stuck.
export async function evictRunningBot({ port, graceMs = 20_000 }: { port: number; graceMs?: number }): Promise<void> {
  const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) })
    .then((response) => response.json())
    .catch(() => null)
  const field = (name: 'pid' | 'wrapperPid') => {
    if (!health || typeof health !== 'object') return null
    const value = Reflect.get(health, name)
    return typeof value === 'number' && value > 0 ? value : null
  }
  const pid = field('pid')
  if (!pid || pid === process.pid) return
  const reportedWrapper = field('wrapperPid')
  const wrapper = reportedWrapper && reportedWrapper !== process.ppid ? reportedWrapper : null
  logger.log(`stopping the kimaki bot on port ${port} (PID ${pid}, wrapper ${wrapper ?? 'none'})`)
  signal({ pid: wrapper ?? pid, name: 'SIGTERM' })
  if (await waitForExit({ pid, timeoutMs: graceMs })) return
  logger.warn(`PID ${pid} still runs after ${graceMs / 1000}s, sending SIGKILL`)
  // Wrapper first, so it cannot spawn the bot again.
  if (wrapper) signal({ pid: wrapper, name: 'SIGKILL' })
  signal({ pid, name: 'SIGKILL' })
  await waitForExit({ pid, timeoutMs: 5_000 })
}

export async function startLockServer({ port, dataDir, supervised = false }: { port: number; dataDir: string; supervised?: boolean }): Promise<LockPortError | LockServer> {
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
      res.end(JSON.stringify({ status: 'ok', pid: process.pid, wrapperPid: wrapperPid(supervised) }))
      return
    }
    if (!req.url?.startsWith('/kimaki/')) {
      res.writeHead(404)
      res.end()
      return
    }
    void handle(req, res).catch((cause) => {
      logger.error('lock request failed', cause)
      if (!res.headersSent) res.writeHead(500)
      res.end(JSON.stringify({ error: 'Kimaki request failed. Check kimaki logs.' }))
    })
  })

  // Before listening, not on EADDRINUSE: on macOS 127.0.0.1:port binds even
  // while a V1 bot holds 0.0.0.0:port (KIMAKI_INTERNET_REACHABLE_URL).
  await evictRunningBot({ port })
  const bound = await listen(server, port)
  if (bound instanceof Error) {
    const reason = bound.code === 'EADDRINUSE'
      ? 'port is in use and the process on it did not stop. Stop it or set KIMAKI_LOCK_PORT to a free port'
      : bound.message
    return new LockPortError({ port, reason, cause: bound })
  }

  logger.info(`lock server listening on 127.0.0.1:${port}`)
  const tokenFile = path.join(dataDir, 'lock-token')
  const written = await fs.promises.mkdir(dataDir, { recursive: true, mode: 0o700 })
    .then(() => fs.promises.writeFile(tokenFile, token, { mode: 0o600 }))
    .then(() => fs.promises.chmod(tokenFile, 0o600))
    .catch((cause) => new LockPortError({ port, reason: 'cannot write lock-token', cause }))
  if (written instanceof Error) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    return written
  }
  return {
    port,
    supervised,
    handle: (handler) => { state.handler = handler },
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      const saved = await fs.promises.readFile(tokenFile, 'utf8').catch(() => null)
      if (saved === token) await fs.promises.unlink(tokenFile).catch((cause) => logger.warn('remove token', cause))
    },
  }
}

// Typed by the route table; imports only its types, so the CLI loads no bot code.
export async function callBot<N extends LockRouteName>({ dataDir, route, input, signal }: {
  dataDir: string
  route: N
  input: LockRouteInput<N>
  signal?: AbortSignal
}): Promise<BotNotRunningError | ConfigError | { data: LockRouteOutput<N> }> {
  const token = await fs.promises.readFile(path.join(dataDir, 'lock-token'), 'utf8')
    .catch((cause) => new BotNotRunningError({ cause }))
  if (token instanceof Error) return token
  const port = Number(process.env['KIMAKI_LOCK_PORT'] || DEFAULT_LOCK_PORT)
  const response = await fetch(`http://127.0.0.1:${port}/kimaki/${route}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input), signal: signal ?? AbortSignal.timeout(30_000),
  }).catch((cause: Error) =>
    // A timeout means the bot runs but is slow: only a refused connection means no bot.
    cause.name === 'TimeoutError' || cause.name === 'AbortError'
      ? new ConfigError({ reason: `Kimaki bot did not answer ${route} in time. Check kimaki logs`, cause })
      : new BotNotRunningError({ cause }))
  if (response instanceof Error) return response
  const body = await response.json().then((data: unknown) => ({ data }))
    .catch((cause) => new ConfigError({ reason: 'Invalid bot response. Check kimaki logs.', cause }))
  if (body instanceof Error) return body
  if (!response.ok) {
    const value = body.data
    const reason = value && typeof value === 'object' && 'error' in value && typeof value.error === 'string' ? value.error : `Bot returned HTTP ${response.status}`
    return new ConfigError({ reason })
  }
  // The bot answered this route with its run() result.
  return { data: body.data as LockRouteOutput<N> }
}
