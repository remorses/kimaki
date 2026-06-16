// Verifies deployed slack-bridge worker routes are reachable and coherent.

type CheckResult = {
  ok: boolean
  name: string
  details: string
}

async function main(): Promise<void> {
  const baseUrlArg = process.argv[2]
  if (!baseUrlArg) {
    throw new Error('Usage: pnpm verify:slack-bridge <base-url>')
  }

  const baseUrl = new URL(baseUrlArg)
  const checks: Array<Promise<CheckResult>> = [
    checkGatewayBotEndpoint({ baseUrl }),
    checkGatewayProxyEndpoint({ baseUrl }),
    checkWebhookEndpoint({ baseUrl }),
  ]

  const results = await Promise.all(checks)
  const failed = results.filter((result) => {
    return !result.ok
  })

  for (const result of results) {
    const status = result.ok ? 'PASS' : 'FAIL'
    console.log(`[${status}] ${result.name} - ${result.details}`)
  }

  if (failed.length > 0) {
    throw new Error(`Slack bridge verification failed (${failed.length} checks)`)
  }
}

async function checkGatewayBotEndpoint({ baseUrl }: { baseUrl: URL }): Promise<CheckResult> {
  const url = new URL('/api/v10/gateway/bot', baseUrl)
  const response = await fetch(url)
  if (!response.ok) {
    return {
      ok: false,
      name: 'gateway bot endpoint',
      details: `expected 200, got ${response.status}`,
    }
  }

  const body = await response.json()
  if (!(body && typeof body === 'object')) {
    return {
      ok: false,
      name: 'gateway bot endpoint',
      details: 'response is not an object',
    }
  }

  const gatewayUrl = readStringField({ body, key: 'url' })
  if (!gatewayUrl) {
    return {
      ok: false,
      name: 'gateway bot endpoint',
      details: 'missing expected url field',
    }
  }

  return {
    ok: true,
    name: 'gateway bot endpoint',
    details: `url=${gatewayUrl}`,
  }
}

async function checkGatewayProxyEndpoint({ baseUrl }: { baseUrl: URL }): Promise<CheckResult> {
  const url = new URL('/slack/gateway', baseUrl)
  const response = await fetch(url)
  if (response.status !== 426) {
    return {
      ok: false,
      name: 'gateway route',
      details: `expected 426 (websocket upgrade required), got ${response.status}`,
    }
  }
  return {
    ok: true,
    name: 'gateway route',
    details: 'upgrade-required response received',
  }
}

async function checkWebhookEndpoint({ baseUrl }: { baseUrl: URL }): Promise<CheckResult> {
  const url = new URL('/slack/events', baseUrl)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'url_verification' }),
  })

  if (response.status !== 401) {
    return {
      ok: false,
      name: 'webhook route',
      details: `expected 401 (signature required), got ${response.status}`,
    }
  }

  return {
    ok: true,
    name: 'webhook route',
    details: 'signature guard response received',
  }
}

function readStringField({
  body,
  key,
}: {
  body: unknown
  key: string
}): string | undefined {
  if (!isRecord(body)) {
    return undefined
  }
  const value = body[key]
  if (typeof value === 'string') {
    return value
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
