// Web standard Hrana v2 handler.
// createLibsqlHandler(executor) returns a function: (Request) => Promise<Response>
//
// Handles:
//   GET  /v2          — version check
//   POST /v2/pipeline — pipeline execution with baton-based stream management
//
// Baton and stream state is scoped to the handler instance (not module-global),
// so multiple handlers in the same process are fully isolated.

import type { HranaPipelineRequest, HranaPipelineResponse } from './types.ts'
import { processHranaRequest } from './protocol.ts'
import type { LibsqlExecutor } from './executor.ts'

export type LibsqlHandler = (request: Request) => Promise<Response>

// Runtime-agnostic random baton generator.
// crypto.randomUUID() is available in Node 19+, CF Workers, and browsers.
function generateBaton(): string {
  return crypto.randomUUID()
}

export function createLibsqlHandler(executor: LibsqlExecutor): LibsqlHandler {
  // Per-handler state — isolated per createLibsqlHandler() call.
  // Each stream has its own SQL store for store_sql/close_sql scoping.
  const streamStores = new Map<string, Map<number, string>>()

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const pathname = url.pathname

    if (request.method === 'GET' && pathname === '/v2') {
      return Response.json({ version: 'hrana-v2' })
    }

    if (request.method === 'POST' && pathname === '/v2/pipeline') {
      let body: HranaPipelineRequest
      try {
        body = await request.json() as HranaPipelineRequest
      } catch {
        return Response.json(
          { error: { message: 'Invalid JSON body', code: 'HRANA_PROTO_ERROR' } },
          { status: 400 },
        )
      }

      // Validate body shape — reject explicitly malformed values,
      // but treat missing/null as empty array for client compat
      if (body.requests !== undefined && body.requests !== null && !Array.isArray(body.requests)) {
        return Response.json(
          { error: { message: '"requests" must be an array', code: 'HRANA_PROTO_ERROR' } },
          { status: 400 },
        )
      }
      const requests = Array.isArray(body.requests) ? body.requests : []

      // Resolve per-stream SQL store keyed by baton.
      // baton=null/undefined means "open new stream"; a non-null baton that doesn't
      // exist in streamStores means the stream was closed or never existed — protocol error.
      const incoming = body.baton
      if (incoming != null && !streamStores.has(incoming)) {
        return Response.json(
          { error: { message: 'Invalid or expired baton', code: 'HRANA_PROTO_ERROR' } },
          { status: 400 },
        )
      }

      const sqlStore = (incoming ? streamStores.get(incoming) : undefined)
        ?? new Map<number, string>()
      if (incoming) {
        streamStores.delete(incoming)
      }

      const results = []
      let streamClosed = false
      for (const req of requests) {
        if (streamClosed) {
          // Requests after close in the same pipeline are errors
          results.push({
            type: 'error' as const,
            error: { message: 'Stream already closed', code: 'HRANA_PROTO_ERROR' },
          })
          continue
        }
        results.push(await processHranaRequest(executor, req, sqlStore))
        if (req.type === 'close') {
          streamClosed = true
        }
      }

      const baton = streamClosed ? null : generateBaton()
      if (baton) {
        streamStores.set(baton, sqlStore)
      }

      const response: HranaPipelineResponse = {
        baton,
        base_url: null,
        results,
      }
      return Response.json(response)
    }

    return new Response('Not found', { status: 404 })
  }
}
