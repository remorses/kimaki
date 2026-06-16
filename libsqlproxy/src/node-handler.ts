// Node.js http adapter for the Hrana handler.
// Converts Node.js IncomingMessage/ServerResponse to Web Request/Response.
//
// Usage:
//   import http from 'node:http'
//   import { createLibsqlHandler, createLibsqlNodeHandler, libsqlExecutor } from 'libsqlproxy'
//
//   const handler = createLibsqlHandler(libsqlExecutor(database))
//   const nodeHandler = createLibsqlNodeHandler(handler, { auth: { bearer: 'token' } })
//   http.createServer(nodeHandler).listen(8080)

import type { LibsqlHandler } from './handler.ts'

// Minimal Node.js types to avoid importing 'node:http' at module level,
// which would break Cloudflare Workers if this file gets bundled.
export interface NodeIncomingMessage {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  on(event: string, listener: (...args: unknown[]) => void): void
}

export interface NodeServerResponse {
  writeHead(statusCode: number, headers?: Record<string, string>): void
  end(body?: string | Buffer): void
  destroy(): void
}

// 10 MB default — enough for large batch pipelines, prevents memory DoS
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024

export interface LibsqlNodeHandlerOptions {
  auth?: {
    // Bearer token for authentication. Compared in constant time.
    bearer: string
  }
  // Maximum request body size in bytes. Defaults to 10 MB.
  maxBodyBytes?: number
}

export type LibsqlNodeHandler = (req: NodeIncomingMessage, res: NodeServerResponse) => void

export function createLibsqlNodeHandler(
  handler: LibsqlHandler,
  options?: LibsqlNodeHandlerOptions,
): LibsqlNodeHandler {
  const maxBytes = options?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES

  return (req, res) => {
    // Auth check
    if (options?.auth?.bearer) {
      const authHeader = req.headers.authorization
      const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length)
        : null
      if (!token || !timingSafeEqual(token, options.auth.bearer)) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }
    }

    // Collect body for POST requests, then convert to Web Request
    if (req.method === 'POST') {
      const chunks: Buffer[] = []
      let totalBytes = 0
      let aborted = false
      req.on('error', () => {
        aborted = true
        res.destroy()
      })
      req.on('data', (chunk: unknown) => {
        if (aborted) {
          return
        }
        const buf = chunk as Buffer
        totalBytes += buf.length
        if (totalBytes > maxBytes) {
          aborted = true
          res.writeHead(413, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'Request body too large', code: 'HRANA_PROTO_ERROR' } }))
          return
        }
        chunks.push(buf)
      })
      req.on('end', () => {
        if (aborted) {
          return
        }
        const body = Buffer.concat(chunks)
        const webRequest = new Request(
          `http://localhost${req.url || '/'}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          },
        )
        handler(webRequest).then((webResponse) => {
          return sendWebResponse(res, webResponse)
        }).catch(() => {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'internal_error' }))
        })
      })
      return
    }

    // GET requests (version check)
    const webRequest = new Request(
      `http://localhost${req.url || '/'}`,
      { method: req.method || 'GET' },
    )
    handler(webRequest).then((webResponse) => {
      return sendWebResponse(res, webResponse)
    }).catch(() => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'internal_error' }))
    })
  }
}

async function sendWebResponse(res: NodeServerResponse, webResponse: Response): Promise<void> {
  const headers: Record<string, string> = {}
  webResponse.headers.forEach((value, key) => {
    headers[key] = value
  })
  res.writeHead(webResponse.status, headers)
  const body = await webResponse.text()
  res.end(body)
}

// Timing-safe string comparison to prevent timing attacks.
// Uses only Web APIs (no Node.js crypto dependency).
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false
  }
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return mismatch === 0
}
