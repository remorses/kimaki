// Backend router: a local HTTP server that speaks the OpenCode v2 protocol.
//
// Kimaki's OpencodeClient instances point at this router instead of the raw
// opencode server. Each request is dispatched:
//   - Claude Code sessions (ses_claude_* ids, perm_claude_*/que_claude_*
//     request ids, or session.create with the x-kimaki-backend header) are
//     handled in-process by the ClaudeCodeSessionManager.
//   - provider/status/list responses are merged so Claude Code appears as a
//     normal provider next to the upstream opencode ones.
//   - /global/event is a merged SSE stream (upstream events + claude events).
//   - Everything else is transparently proxied to the real opencode server.
//
// This keeps all 40+ existing OpencodeClient call sites working unchanged for
// both backends.

import http from 'node:http'
import { once } from 'node:events'
import type {
  Event as OpenCodeEvent,
  PermissionRuleset,
  QuestionAnswer,
  Session,
  TextPartInput,
  FilePartInput,
} from '@opencode-ai/sdk/v2'
import { createLogger, LogPrefix } from '../logger.js'
import { ClaudeCodeSessionManager, type PromptRequest, type QueryImpl } from './sessions.js'
import { isClaudeCodePermissionId, isClaudeCodeQuestionId, isClaudeCodeSessionId } from './ids.js'
import {
  CLAUDE_CODE_PROVIDER_ID,
  DEFAULT_CLAUDE_MODEL_ID,
  getClaudeCodeProvider,
} from './models.js'

const logger = createLogger(LogPrefix.SESSION)

export const CLAUDE_BACKEND_HEADER = 'x-kimaki-backend'
export const CLAUDE_BACKEND_VALUE = 'claude-code'

type EventSubscriber = (directory: string, event: OpenCodeEvent) => void

export type ClaudeCodeRouter = {
  baseUrl: string
  manager: ClaudeCodeSessionManager
  close: () => Promise<void>
}

type RouterOptions = {
  /** Returns the current upstream opencode base URL (may change on restart). */
  getUpstreamBaseUrl: () => string | null
  /** Extra headers to attach when proxying to the upstream server. */
  getUpstreamHeaders?: () => Record<string, string>
  /** Injectable for hermetic tests. */
  queryImpl?: QueryImpl
  /** Basic-auth credentials required from clients (mirrors opencode's). */
  expectedAuthorization?: () => string | undefined
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    req.on('end', () => {
      resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(payload)
}

function sendError(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message })
}

function parseJson(buffer: Buffer): Record<string, unknown> {
  if (buffer.length === 0) {
    return {}
  }
  const text = buffer.toString('utf8')
  if (!text.trim()) {
    return {}
  }
  const parseAttempt = (): unknown => {
    return JSON.parse(text)
  }
  let parsed: unknown
  try {
    parsed = parseAttempt()
  } catch {
    return {}
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  return {}
}

function promptRequestFromBody(body: Record<string, unknown>): PromptRequest {
  const rawParts = Array.isArray(body.parts) ? body.parts : []
  const parts: Array<TextPartInput | FilePartInput> = []
  for (const raw of rawParts) {
    if (!raw || typeof raw !== 'object') {
      continue
    }
    const rec = raw as Record<string, unknown>
    if (rec.type === 'text' && typeof rec.text === 'string') {
      parts.push({
        type: 'text',
        text: rec.text,
        ...(rec.synthetic === true ? { synthetic: true } : {}),
      })
    } else if (rec.type === 'file' && typeof rec.url === 'string' && typeof rec.mime === 'string') {
      parts.push({
        type: 'file',
        mime: rec.mime,
        url: rec.url,
        ...(typeof rec.filename === 'string' ? { filename: rec.filename } : {}),
      })
    }
  }
  const model = (() => {
    if (!body.model || typeof body.model !== 'object') {
      return undefined
    }
    const rec = body.model as Record<string, unknown>
    if (typeof rec.providerID === 'string' && typeof rec.modelID === 'string') {
      return { providerID: rec.providerID, modelID: rec.modelID }
    }
    return undefined
  })()
  return {
    parts,
    ...(model ? { model } : {}),
    ...(typeof body.agent === 'string' ? { agent: body.agent } : {}),
    ...(typeof body.variant === 'string' ? { variant: body.variant } : {}),
    ...(typeof body.system === 'string' ? { system: body.system } : {}),
    ...(body.noReply === true ? { noReply: true } : {}),
  }
}

/**
 * Start the backend router. The returned baseUrl is what every
 * OpencodeClient in kimaki should use as its server address.
 */
export async function startClaudeCodeRouter(options: RouterOptions): Promise<ClaudeCodeRouter> {
  const subscribers = new Set<EventSubscriber>()

  const manager = new ClaudeCodeSessionManager({
    emitEvent: (directory, event) => {
      for (const subscriber of subscribers) {
        subscriber(directory, event)
      }
    },
    queryImpl: options.queryImpl,
  })

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(`[CLAUDE ROUTER] ${req.method} ${req.url} failed: ${message}`)
      if (!res.headersSent) {
        sendError(res, 500, message)
      } else {
        res.end()
      }
    })
  })

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname
    const method = req.method ?? 'GET'

    const expectedAuth = options.expectedAuthorization?.()
    if (expectedAuth && req.headers.authorization !== expectedAuth) {
      sendError(res, 401, 'Unauthorized')
      return
    }

    // ── Merged global event stream ─────────────────────────────
    if (method === 'GET' && (pathname === '/global/event' || pathname === '/event')) {
      handleGlobalEventStream(req, res)
      return
    }

    // ── Claude-handled session endpoints ───────────────────────
    const sessionMatch = /^\/session\/([^/]+)(\/.*)?$/.exec(pathname)
    if (sessionMatch && isClaudeCodeSessionId(sessionMatch[1])) {
      await handleClaudeSessionRoute({
        req,
        res,
        method,
        sessionId: sessionMatch[1]!,
        subPath: sessionMatch[2] ?? '',
      })
      return
    }

    if (method === 'POST' && pathname === '/session') {
      const backendHeader = req.headers[CLAUDE_BACKEND_HEADER]
      if (backendHeader === CLAUDE_BACKEND_VALUE) {
        const body = parseJson(await readBody(req))
        const directory =
          url.searchParams.get('directory') ??
          (typeof body.directory === 'string' ? body.directory : undefined)
        if (!directory) {
          sendError(res, 400, 'directory is required for claude-code sessions')
          return
        }
        const permission = Array.isArray(body.permission)
          ? (body.permission as PermissionRuleset)
          : []
        const session = manager.create({
          directory,
          permission,
          ...(typeof body.title === 'string' ? { title: body.title } : {}),
          ...(typeof body.parentID === 'string' ? { parentID: body.parentID } : {}),
          ...(typeof body.agent === 'string' ? { agent: body.agent } : {}),
        })
        sendJson(res, 200, session.toWire())
        return
      }
      // fall through to proxy
    }

    const permissionReplyMatch = /^\/permission\/([^/]+)\/reply$/.exec(pathname)
    if (
      method === 'POST' &&
      permissionReplyMatch &&
      isClaudeCodePermissionId(permissionReplyMatch[1])
    ) {
      const body = parseJson(await readBody(req))
      const reply = body.reply
      if (reply !== 'once' && reply !== 'always' && reply !== 'reject') {
        sendError(res, 400, `Invalid permission reply: ${String(reply)}`)
        return
      }
      const ok = manager.replyPermission({
        requestId: permissionReplyMatch[1]!,
        reply,
        ...(typeof body.message === 'string' ? { message: body.message } : {}),
      })
      sendJson(res, 200, ok)
      return
    }

    const questionReplyMatch = /^\/question\/([^/]+)\/(reply|reject)$/.exec(pathname)
    if (method === 'POST' && questionReplyMatch && isClaudeCodeQuestionId(questionReplyMatch[1])) {
      const body = parseJson(await readBody(req))
      if (questionReplyMatch[2] === 'reject') {
        sendJson(res, 200, manager.rejectQuestion({ requestId: questionReplyMatch[1]! }))
        return
      }
      const answers = Array.isArray(body.answers) ? (body.answers as QuestionAnswer[]) : []
      sendJson(res, 200, manager.replyQuestion({ requestId: questionReplyMatch[1]!, answers }))
      return
    }

    // ── Merged listings ────────────────────────────────────────
    if (method === 'GET' && pathname === '/session/status') {
      const directory = url.searchParams.get('directory') ?? undefined
      const upstream = await proxyJson<Record<string, unknown>>({ req, url, method })
      const merged: Record<string, unknown> = {
        ...(upstream.ok ? upstream.body : {}),
        ...manager.statuses({ directory }),
      }
      sendJson(res, 200, merged)
      return
    }

    if (method === 'GET' && pathname === '/session') {
      const directory = url.searchParams.get('directory') ?? undefined
      const upstream = await proxyJson<Session[]>({ req, url, method })
      const upstreamSessions = upstream.ok && Array.isArray(upstream.body) ? upstream.body : []
      const claudeSessions = manager.list({ directory })
      const merged = [...claudeSessions, ...upstreamSessions].sort((a, b) => {
        return (b.time?.updated ?? 0) - (a.time?.updated ?? 0)
      })
      sendJson(res, 200, merged)
      return
    }

    if (method === 'GET' && pathname === '/provider') {
      const upstream = await proxyJson<{
        all: unknown[]
        default: Record<string, string>
        connected: string[]
      }>({ req, url, method })
      const base = upstream.ok ? upstream.body : { all: [], default: {}, connected: [] }
      const merged = {
        all: [...(base.all ?? []), getClaudeCodeProvider()],
        default: {
          ...(base.default ?? {}),
          [CLAUDE_CODE_PROVIDER_ID]: DEFAULT_CLAUDE_MODEL_ID,
        },
        connected: [...(base.connected ?? []), CLAUDE_CODE_PROVIDER_ID],
      }
      sendJson(res, 200, merged)
      return
    }

    if (method === 'GET' && pathname === '/config/providers') {
      const upstream = await proxyJson<{
        providers: unknown[]
        default: Record<string, string>
      }>({ req, url, method })
      const base = upstream.ok ? upstream.body : { providers: [], default: {} }
      const merged = {
        providers: [...(base.providers ?? []), getClaudeCodeProvider()],
        default: {
          ...(base.default ?? {}),
          [CLAUDE_CODE_PROVIDER_ID]: DEFAULT_CLAUDE_MODEL_ID,
        },
      }
      sendJson(res, 200, merged)
      return
    }

    await proxyPassthrough({ req, res, url, method })
  }

  async function handleClaudeSessionRoute({
    req,
    res,
    method,
    sessionId,
    subPath,
  }: {
    req: http.IncomingMessage
    res: http.ServerResponse
    method: string
    sessionId: string
    subPath: string
  }): Promise<void> {
    const session = manager.get(sessionId)
    if (!session) {
      sendError(res, 404, `Session not found: ${sessionId}`)
      return
    }

    if (subPath === '' || subPath === '/') {
      if (method === 'GET') {
        sendJson(res, 200, session.toWire())
        return
      }
      if (method === 'POST') {
        const body = parseJson(await readBody(req))
        const updated = await session.update({
          ...(typeof body.title === 'string' ? { title: body.title } : {}),
          ...(Array.isArray(body.permission)
            ? { permission: body.permission as PermissionRuleset }
            : {}),
        })
        sendJson(res, 200, updated)
        return
      }
      if (method === 'DELETE') {
        sendJson(res, 200, await manager.delete(sessionId))
        return
      }
    }

    if (subPath === '/message' && method === 'GET') {
      sendJson(res, 200, await session.messagesWire())
      return
    }

    if (subPath === '/prompt_async' && method === 'POST') {
      const body = parseJson(await readBody(req))
      await session.prompt(promptRequestFromBody(body))
      res.writeHead(204)
      res.end()
      return
    }

    if (subPath === '/abort' && method === 'POST') {
      sendJson(res, 200, await session.abort())
      return
    }

    if (subPath === '/summarize' && method === 'POST') {
      await session.summarize()
      sendJson(res, 200, true)
      return
    }

    if (subPath === '/revert' && method === 'POST') {
      const body = parseJson(await readBody(req))
      const revertResult = await session
        .revert({
          ...(typeof body.messageID === 'string' ? { messageID: body.messageID } : {}),
        })
        .catch((error: unknown) => {
          return error instanceof Error ? error : new Error(String(error))
        })
      if (revertResult instanceof Error) {
        sendError(res, 400, revertResult.message)
        return
      }
      sendJson(res, 200, revertResult)
      return
    }

    if (subPath === '/unrevert' && method === 'POST') {
      sendJson(res, 200, await session.unrevert())
      return
    }

    if (subPath === '/fork' && method === 'POST') {
      const body = parseJson(await readBody(req))
      const forked = session.fork({
        ...(typeof body.messageID === 'string' ? { messageID: body.messageID } : {}),
      })
      sendJson(res, 200, forked.toWire())
      return
    }

    if (subPath === '/command' && method === 'POST') {
      // Claude Code parses slash commands directly from prompt text.
      const body = parseJson(await readBody(req))
      const command = typeof body.command === 'string' ? body.command : ''
      const args = typeof body.arguments === 'string' ? body.arguments : ''
      if (!command) {
        sendError(res, 400, 'command is required')
        return
      }
      await session.prompt({
        parts: [{ type: 'text', text: `/${command}${args ? ` ${args}` : ''}` }],
      })
      sendJson(res, 200, {})
      return
    }

    if (subPath === '/diff' && method === 'GET') {
      sendJson(res, 200, session.toWire().summary?.diffs ?? [])
      return
    }

    if (subPath === '/children' && method === 'GET') {
      const children = manager.list({}).filter((candidate) => {
        return candidate.parentID === sessionId
      })
      sendJson(res, 200, children)
      return
    }

    if (subPath === '/todo' && method === 'GET') {
      sendJson(res, 200, [])
      return
    }

    sendError(
      res,
      501,
      `Not implemented for Claude Code sessions: ${method} /session/{id}${subPath}`,
    )
  }

  // ── Upstream proxy helpers ───────────────────────────────────

  function upstreamRequestHeaders(req: http.IncomingMessage): Record<string, string> {
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value !== 'string') {
        continue
      }
      const lower = key.toLowerCase()
      if (
        lower === 'host' ||
        lower === 'connection' ||
        lower === 'content-length' ||
        lower === 'transfer-encoding'
      ) {
        continue
      }
      headers[key] = value
    }
    for (const [key, value] of Object.entries(options.getUpstreamHeaders?.() ?? {})) {
      headers[key] = value
    }
    return headers
  }

  async function proxyJson<T>({
    req,
    url,
    method,
  }: {
    req: http.IncomingMessage
    url: URL
    method: string
  }): Promise<{ ok: true; body: T } | { ok: false }> {
    const upstreamBase = options.getUpstreamBaseUrl()
    if (!upstreamBase) {
      return { ok: false }
    }
    const target = `${upstreamBase}${url.pathname}${url.search}`
    const response = await fetch(target, {
      method,
      headers: upstreamRequestHeaders(req),
    }).catch(() => {
      return null
    })
    if (!response || !response.ok) {
      return { ok: false }
    }
    const body = (await response.json().catch(() => {
      return null
    })) as T | null
    if (body === null) {
      return { ok: false }
    }
    return { ok: true, body }
  }

  async function proxyPassthrough({
    req,
    res,
    url,
    method,
  }: {
    req: http.IncomingMessage
    res: http.ServerResponse
    url: URL
    method: string
  }): Promise<void> {
    const upstreamBase = options.getUpstreamBaseUrl()
    if (!upstreamBase) {
      sendError(res, 503, 'OpenCode server is not running')
      return
    }
    const parsed = new URL(upstreamBase)
    const upstreamReq = http.request(
      {
        host: parsed.hostname,
        port: parsed.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: upstreamRequestHeaders(req),
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        upstreamRes.pipe(res)
      },
    )
    upstreamReq.on('error', (error) => {
      logger.warn(`[CLAUDE ROUTER] proxy error for ${method} ${url.pathname}: ${error.message}`)
      if (!res.headersSent) {
        sendError(res, 502, `Upstream opencode error: ${error.message}`)
      } else {
        res.end()
      }
    })
    req.pipe(upstreamReq)
  }

  // ── Merged SSE ───────────────────────────────────────────────

  function handleGlobalEventStream(req: http.IncomingMessage, res: http.ServerResponse): void {
    // The downstream connection only succeeds once the upstream stream is
    // attached. This preserves the pre-router invariant "subscribed ⇒
    // receiving opencode events": if the merged stream accepted subscribers
    // while the upstream was down (e.g. during an opencode restart), events
    // emitted right after the restart would be silently lost while the
    // listener believed it was connected. A 503 here makes kimaki's global
    // listener retry with its own backoff, exactly like connecting to a
    // restarting opencode server directly.
    const upstreamBase = options.getUpstreamBaseUrl()
    if (!upstreamBase) {
      sendError(res, 503, 'OpenCode server is not running')
      return
    }

    let closed = false
    let upstreamAbort: AbortController | null = null

    const subscriber: EventSubscriber = (directory, event) => {
      if (closed) {
        return
      }
      const payload = JSON.stringify({ directory, payload: event })
      res.write(`data: ${payload}\n\n`)
    }

    const cleanup = () => {
      if (closed) {
        return
      }
      closed = true
      subscribers.delete(subscriber)
      upstreamAbort?.abort()
    }

    const parsed = new URL(upstreamBase)
    upstreamAbort = new AbortController()
    const upstreamReq = http.request(
      {
        host: parsed.hostname,
        port: parsed.port,
        path: '/global/event',
        method: 'GET',
        headers: {
          accept: 'text/event-stream',
          ...(options.getUpstreamHeaders?.() ?? {}),
        },
        signal: upstreamAbort.signal,
      },
      (upstreamRes) => {
        if (upstreamRes.statusCode !== 200) {
          upstreamRes.resume()
          cleanup()
          if (!res.headersSent) {
            sendError(
              res,
              503,
              `OpenCode event stream unavailable (status ${upstreamRes.statusCode})`,
            )
          }
          return
        }
        // Upstream attached — open the merged stream downstream.
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        res.write(':ok\n\n')
        subscribers.add(subscriber)

        upstreamRes.on('data', (chunk: Buffer) => {
          if (!closed) {
            res.write(chunk)
          }
        })
        upstreamRes.on('end', () => {
          // Upstream stream ended (e.g. opencode restart) — end the merged
          // stream too; kimaki's global listener reconnects immediately.
          cleanup()
          res.end()
        })
        upstreamRes.on('error', () => {
          cleanup()
          res.end()
        })
      },
    )
    upstreamReq.on('error', (error) => {
      cleanup()
      if (!res.headersSent) {
        sendError(res, 503, `OpenCode event stream unavailable: ${error.message}`)
      } else {
        res.end()
      }
    })
    upstreamReq.end()

    req.on('close', () => {
      cleanup()
    })
  }

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind claude-code router port')
  }
  const baseUrl = `http://127.0.0.1:${address.port}`
  logger.log(`[CLAUDE ROUTER] listening on ${baseUrl}`)

  return {
    baseUrl,
    manager,
    close: async () => {
      await manager.disposeAll()
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    },
  }
}
