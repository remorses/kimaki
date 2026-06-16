// Web standard Hrana v2 handler.
// createLibsqlHandler(executor) returns a function: (Request) => Promise<Response>
//
// Handles:
//   GET  /v2          — version check
//   POST /v2/pipeline — pipeline execution with baton-based stream management
//
// Baton and stream state is scoped to the handler instance (not module-global),
// so multiple handlers in the same process are fully isolated.
// Abandoned streams are evicted after STREAM_TTL_MS of inactivity.

import type { HranaPipelineRequest, HranaPipelineResponse, HranaRequest } from './types.ts'
import { processHranaRequest } from './protocol.ts'
import type { LibsqlExecutor } from './executor.ts'

export type LibsqlHandler = (request: Request) => Promise<Response>

// Runtime-agnostic random baton generator.
// crypto.randomUUID() is available in Node 19+, CF Workers, and browsers.
function generateBaton(): string {
  return crypto.randomUUID()
}

// Streams idle longer than this are evicted to prevent unbounded memory growth.
// Hrana v2 spec recommends servers close inactive streams after a short period.
const STREAM_TTL_MS = 120_000

interface StreamState {
  sqlStore: Map<number, string>
  lastSeenMs: number
}

export function createLibsqlHandler(executor: LibsqlExecutor): LibsqlHandler {
  // Per-handler state — isolated per createLibsqlHandler() call.
  const streams = new Map<string, StreamState>()

  function evictStaleStreams(): void {
    const now = Date.now()
    for (const [baton, state] of streams) {
      if (now - state.lastSeenMs > STREAM_TTL_MS) {
        streams.delete(baton)
      }
    }
  }

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

      // Validate envelope — body must be a non-null object
      if (body === null || typeof body !== 'object') {
        return Response.json(
          { error: { message: 'Pipeline body must be a JSON object', code: 'HRANA_PROTO_ERROR' } },
          { status: 400 },
        )
      }

      // Validate requests — reject explicitly malformed values,
      // treat missing/null as empty array for client compat
      if (body.requests !== undefined && body.requests !== null && !Array.isArray(body.requests)) {
        return Response.json(
          { error: { message: '"requests" must be an array', code: 'HRANA_PROTO_ERROR' } },
          { status: 400 },
        )
      }
      const requests = Array.isArray(body.requests) ? body.requests : []

      // Evict stale streams on each pipeline call (cheap linear scan)
      evictStaleStreams()

      // Resolve per-stream SQL store keyed by baton.
      // baton=null/undefined means "open new stream"; a non-null baton that doesn't
      // exist in streams means it was closed, evicted, or never existed — protocol error.
      const incoming = body.baton
      if (incoming != null && !streams.has(incoming)) {
        return Response.json(
          { error: { message: 'Invalid or expired baton', code: 'HRANA_PROTO_ERROR' } },
          { status: 400 },
        )
      }

      const sqlStore = (incoming ? streams.get(incoming)?.sqlStore : undefined)
        ?? new Map<number, string>()
      if (incoming) {
        streams.delete(incoming)
      }

      const results = []
      let streamClosed = false
      for (const req of requests) {
        if (streamClosed) {
          results.push({
            type: 'error' as const,
            error: { message: 'Stream already closed', code: 'HRANA_PROTO_ERROR' },
          })
          continue
        }
        // Validate each request entry is a non-null object with a string type
        if (req === null || typeof req !== 'object' || typeof (req as HranaRequest).type !== 'string') {
          results.push({
            type: 'error' as const,
            error: { message: 'Each request must be an object with a "type" field', code: 'HRANA_PROTO_ERROR' },
          })
          continue
        }
        results.push(await processHranaRequest(executor, req as HranaRequest, sqlStore))
        if ((req as HranaRequest).type === 'close') {
          streamClosed = true
        }
      }

      const baton = streamClosed ? null : generateBaton()
      if (baton) {
        streams.set(baton, { sqlStore, lastSeenMs: Date.now() })
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
