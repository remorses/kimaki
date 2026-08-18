import { describe, test, expect, vi, afterEach } from 'vitest'
import {
  createSdkFetch,
  getNodeFetchRuntime,
  SDK_FETCH_TIMEOUT_MS,
} from './opencode.js'

// The SDK fetch wrapper must raise Node's default undici timeouts: without an
// explicit dispatcher, every SDK dispatch runs on undici's 300s
// headersTimeout, which long agent turns legitimately exceed (spurious
// "fetch failed" dispatch errors while the server kept processing the prompt).
// On Bun the wrapper keeps the `timeout: false` convention, which is what
// disables Bun's own 300s fetch timeout there.
describe('SDK fetch timeouts', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('default timeout is 15 minutes', () => {
    expect(SDK_FETCH_TIMEOUT_MS).toBe(900_000)
  })

  test('KIMAKI_SDK_FETCH_TIMEOUT_MS overrides the default', async () => {
    vi.stubEnv('KIMAKI_SDK_FETCH_TIMEOUT_MS', '1200000')
    // resolveSdkFetchTimeoutMs is exercised through a fresh import so the env
    // is read at call time rather than relying on module-load order.
    const { resolveSdkFetchTimeoutMs } = await import('./opencode.js')
    expect(resolveSdkFetchTimeoutMs()).toBe(1_200_000)
  })

  test('invalid override falls back to the default', async () => {
    vi.stubEnv('KIMAKI_SDK_FETCH_TIMEOUT_MS', 'not-a-number')
    const { resolveSdkFetchTimeoutMs } = await import('./opencode.js')
    expect(resolveSdkFetchTimeoutMs()).toBe(900_000)
  })

  test('Node runtime resolves one shared dispatcher (Agent-per-call would leak sockets)', async () => {
    vi.stubGlobal('Bun', undefined)
    const first = getNodeFetchRuntime()
    const second = getNodeFetchRuntime()
    if (!first || !second) throw new Error('Node runtime must be available when Bun is undefined')
    expect(second).toBe(first)
    const runtime = await first
    expect(typeof (runtime.dispatcher as { dispatch?: unknown }).dispatch).toBe('function')
    // Same instance on repeated resolution.
    expect(await second).toBe(runtime)
  })

  test('Bun path passes timeout:false and no dispatcher', async () => {
    vi.stubGlobal('Bun', {})
    const captured: { timeout?: unknown; dispatcher?: unknown } = {}
    vi.stubGlobal('fetch', (async (_request: Request, init?: RequestInit) => {
      captured.timeout = (init as { timeout?: unknown })?.timeout
      captured.dispatcher = (init as { dispatcher?: unknown })?.dispatcher
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch)

    // getNodeFetchRuntime is cached per process; the Bun stub must win here.
    expect(getNodeFetchRuntime()).toBeUndefined()

    const response = await createSdkFetch()(new Request('http://127.0.0.1:1/session/prompt'))
    expect(response.status).toBe(200)
    expect(captured.timeout).toBe(false)
    expect(captured.dispatcher).toBeUndefined()
  })
})
