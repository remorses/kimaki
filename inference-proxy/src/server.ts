// OpenAI-compatible inference proxy for Kimaki Pro.
// Proxies /v1/chat/completions and /v1/models to Fireworks AI,
// rewriting model IDs and injecting the Fireworks API key.
// Deployed at openai.kimaki.dev.
//
// Usage tracking: each request's cost is recorded in a UsageCounter
// Durable Object (one per org). Monthly cost is capped at
// COST_LIMIT_RATIO * subscription price to keep margins positive.

import { waitUntil } from 'cloudflare:workers'
import { createParser, type EventSourceMessage } from 'eventsource-parser'
import { validateApiKey } from './auth'
import { MONTHLY_COST_LIMIT_USD } from './usage-counter'
import type { UsageCounter } from './usage-counter'

export { UsageCounter } from './usage-counter'

const FIREWORKS_BASE_URL = 'https://api.fireworks.ai/inference/v1'

// Maps Kimaki model names to their current backing model on Fireworks.
// This is the single place to update when swapping to a better model.
const MODEL_MAP: Record<string, string> = {
  kimaki: 'accounts/fireworks/models/glm-5p2',
}

// Fireworks pricing per million tokens (USD)
const PRICING = {
  inputPerMillion: 1.40,
  outputPerMillion: 4.40,
}

const MODEL_INFO = {
  id: 'kimaki',
  object: 'model' as const,
  created: Math.floor(Date.now() / 1000),
  owned_by: 'kimaki',
}

function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) return null
  return auth.slice(7)
}


function calculateCostUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * PRICING.inputPerMillion +
    (outputTokens / 1_000_000) * PRICING.outputPerMillion
  )
}

function getUsageStub(env: Env, orgId: string): DurableObjectStub<UsageCounter> {
  const id = env.USAGE_COUNTER.idFromName(orgId)
  return env.USAGE_COUNTER.get(id) as DurableObjectStub<UsageCounter>
}

function recordUsage(
  usageStub: DurableObjectStub<UsageCounter>,
  inputTokens: number,
  outputTokens: number,
  model: string,
) {
  const costUsd = calculateCostUsd(inputTokens, outputTokens)
  waitUntil(
    usageStub
      .record({ costUsd, inputTokens, outputTokens, model })
      .catch((err) => console.error('[usage] failed to record', err)),
  )
}

async function handleChatCompletions(
  request: Request,
  env: Env,
): Promise<Response> {
  const apiKey = extractBearerToken(request)
  if (!apiKey) {
    return Response.json(
      { error: { message: 'Missing Authorization header', type: 'auth_error' } },
      { status: 401 },
    )
  }

  const { valid, orgId } = await validateApiKey(apiKey, env.HYPERDRIVE.connectionString)
  if (!valid) {
    return Response.json(
      { error: { message: 'Invalid API key', type: 'auth_error' } },
      { status: 401 },
    )
  }

  // Pre-flight usage check: reject if already over limit.
  // Fail closed if the DO is unreachable to prevent unbounded spend.
  const usageStub = getUsageStub(env, orgId)
  const currentUsage = await usageStub.getMonthlyUsage().catch((err) => {
    console.error('[usage] pre-flight check failed, rejecting request', err)
    return 'failed' as const
  })
  if (currentUsage === 'failed') {
    return Response.json(
      { error: { message: 'Usage check unavailable, try again later', type: 'rate_limit_error' } },
      { status: 503 },
    )
  }
  if (currentUsage && currentUsage.totalCostUsd >= MONTHLY_COST_LIMIT_USD) {
    return Response.json(
      {
        error: {
          message: `Monthly usage limit exceeded ($${MONTHLY_COST_LIMIT_USD.toFixed(2)}). Resets on the 1st of next month.`,
          type: 'rate_limit_error',
        },
      },
      { status: 429 },
    )
  }

  let body: {
    model?: string
    stream?: boolean
    [key: string]: unknown
  }
  try {
    body = await request.json()
  } catch {
    return Response.json(
      { error: { message: 'Invalid JSON body', type: 'invalid_request_error' } },
      { status: 400 },
    )
  }
  const requestedModel = body.model ?? 'kimaki'
  const fireworksModel = MODEL_MAP[requestedModel]

  if (!fireworksModel) {
    return Response.json(
      {
        error: {
          message: `Unknown model: ${requestedModel}. Available: ${Object.keys(MODEL_MAP).join(', ')}`,
          type: 'invalid_request_error',
        },
      },
      { status: 400 },
    )
  }

  body.model = fireworksModel
  body.user = orgId
  body.metadata = {
    ...(body.metadata as Record<string, string> | undefined),
    kimaki_org: orgId,
  }
  const isStreaming = body.stream === true

  const fireworksResponse = await fetch(`${FIREWORKS_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.FIREWORKS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!fireworksResponse.ok) {
    return new Response(fireworksResponse.body, {
      status: fireworksResponse.status,
      headers: {
        'Content-Type': fireworksResponse.headers.get('Content-Type') || 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    })
  }

  if (isStreaming) {
    return handleStreamingResponse(fireworksResponse, requestedModel, usageStub)
  }

  // Non-streaming: extract usage from response body
  const responseBody = (await fireworksResponse.json()) as {
    model?: string
    usage?: { prompt_tokens?: number; completion_tokens?: number }
    [key: string]: unknown
  }

  if (responseBody.model) {
    responseBody.model = requestedModel
  }

  const inputTokens = responseBody.usage?.prompt_tokens ?? 0
  const outputTokens = responseBody.usage?.completion_tokens ?? 0

  if (!responseBody.usage || (inputTokens === 0 && outputTokens === 0)) {
    console.warn('[usage] non-streaming response missing token counts', { model: requestedModel })
  }

  recordUsage(usageStub, inputTokens, outputTokens, requestedModel)

  return Response.json(responseBody, {
    status: fireworksResponse.status,
    headers: { 'Access-Control-Allow-Origin': '*' },
  })
}

/**
 * Handles streaming responses using eventsource-parser for robust SSE parsing.
 * Rewrites model names in chunks and extracts usage from the final event.
 * Records partial usage on client cancellation.
 */
function handleStreamingResponse(
  fireworksResponse: Response,
  requestedModel: string,
  usageStub: DurableObjectStub<UsageCounter>,
): Response {
  const encoder = new TextEncoder()
  let inputTokens = 0
  let outputTokens = 0
  let usageRecorded = false

  function flushUsage() {
    if (usageRecorded) return
    usageRecorded = true
    if (inputTokens === 0 && outputTokens === 0) {
      console.warn('[usage] streaming response ended without token counts', { model: requestedModel })
    }
    recordUsage(usageStub, inputTokens, outputTokens, requestedModel)
  }

  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()

  const parser = createParser({
    onEvent(event: EventSourceMessage) {
      const { data } = event
      if (data === '[DONE]') {
        flushUsage()
        writer.write(encoder.encode('data: [DONE]\n\n'))
        return
      }

      try {
        const parsed = JSON.parse(data)

        // Extract usage from the final chunk
        if (parsed.usage) {
          inputTokens = parsed.usage.prompt_tokens ?? inputTokens
          outputTokens = parsed.usage.completion_tokens ?? outputTokens
        }

        // Rewrite model name so clients see "kimaki" instead of the backing model
        if (parsed.model) {
          parsed.model = requestedModel
        }

        writer.write(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`))
      } catch {
        // Forward unparseable data as-is
        writer.write(encoder.encode(`data: ${data}\n\n`))
      }
    },
  })

  // Pipe the upstream response through the parser
  const upstream = fireworksResponse.body!
  const reader = upstream.getReader()
  const decoder = new TextDecoder()

  ;(async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        parser.feed(decoder.decode(value, { stream: true }))
      }
      // Flush any remaining partial data
      parser.feed(decoder.decode())
      flushUsage()
    } catch (err) {
      console.error('[stream] upstream read error', err)
      flushUsage()
    } finally {
      writer.close().catch(() => {})
    }
  })()

  return new Response(readable, {
    status: fireworksResponse.status,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

async function handleModels(request: Request, env: Env): Promise<Response> {
  const apiKey = extractBearerToken(request)
  if (!apiKey) {
    return Response.json(
      { error: { message: 'Missing Authorization header', type: 'auth_error' } },
      { status: 401 },
    )
  }

  const { valid } = await validateApiKey(apiKey, env.HYPERDRIVE.connectionString)
  if (!valid) {
    return Response.json(
      { error: { message: 'Invalid API key', type: 'auth_error' } },
      { status: 401 },
    )
  }

  return Response.json(
    { object: 'list', data: [MODEL_INFO] },
    { headers: { 'Access-Control-Allow-Origin': '*' } },
  )
}

async function handleUsage(request: Request, env: Env): Promise<Response> {
  const apiKey = extractBearerToken(request)
  if (!apiKey) {
    return Response.json(
      { error: { message: 'Missing Authorization header', type: 'auth_error' } },
      { status: 401 },
    )
  }

  const { valid, orgId } = await validateApiKey(apiKey, env.HYPERDRIVE.connectionString)
  if (!valid) {
    return Response.json(
      { error: { message: 'Invalid API key', type: 'auth_error' } },
      { status: 401 },
    )
  }

  const usageStub = getUsageStub(env, orgId)
  const usage = await usageStub.getMonthlyUsage()

  return Response.json(
    {
      ...usage,
      monthlyLimitUsd: MONTHLY_COST_LIMIT_USD,
      limitExceeded: usage.totalCostUsd >= MONTHLY_COST_LIMIT_USD,
    },
    { headers: { 'Access-Control-Allow-Origin': '*' } },
  )
}

function handleCors(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return handleCors()
    }

    if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
      return handleChatCompletions(request, env)
    }

    if (url.pathname === '/v1/models' && request.method === 'GET') {
      return handleModels(request, env)
    }

    if (url.pathname === '/v1/usage' && request.method === 'GET') {
      return handleUsage(request, env)
    }

    if (url.pathname === '/' || url.pathname === '') {
      return Response.json({
        name: 'Kimaki Pro Inference API',
        docs: 'https://kimaki.dev/docs/pro',
      })
    }

    return Response.json(
      { error: { message: 'Not found', type: 'not_found' } },
      { status: 404 },
    )
  },
} satisfies ExportedHandler<Env>
