/**
 * Integration tests for traforo tunnel.
 *
 * These tests run against the preview deployment at *-tunnel-preview.kimaki.xyz.
 * They start a local test server, connect via TunnelClient, and verify HTTP,
 * WebSocket, and SSE requests work through the tunnel.
 *
 * Run: pnpm test
 * Note: Requires preview deployment to be active (pnpm deploy:preview)
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { TunnelClient } from './client.js'
import WebSocket, { WebSocketServer } from 'ws'
import type { Server } from 'node:http'
import http from 'node:http'

const TEST_TIMEOUT = 30_000

// Generate unique tunnel ID for each test run to avoid conflicts
const getTunnelId = (): string => {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

// Simple test server that handles HTTP, WebSocket, and SSE
function createTestServer(port: number): Promise<{
  server: Server
  close: () => Promise<void>
  broadcast: (message: string) => void
  getConnectionCount: () => number
}> {
  return new Promise((resolve) => {
    const wsConnections = new Set<WebSocket>()

    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${port}`)
      const path = url.pathname

      // Echo endpoint - returns request info
      if (path === '/echo') {
        const headers: Record<string, string> = {}
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') {
            headers[key] = value
          }
        }

        let bodyChunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => {
          bodyChunks.push(chunk)
        })
        req.on('end', () => {
          const body = Buffer.concat(bodyChunks)
          res.setHeader('Content-Type', 'application/json')
          res.end(
            JSON.stringify({
              method: req.method,
              path: url.pathname,
              query: Object.fromEntries(url.searchParams),
              headers,
              body: body.length > 0 ? body.toString() : null,
              bodyLength: body.length,
            })
          )
        })
        return
      }

      // Static HTML
      if (path === '/') {
        res.setHeader('Content-Type', 'text/html')
        res.end('<html><body><h1>Test Server</h1></body></html>')
        return
      }

      // JSON endpoint
      if (path === '/json') {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }))
        return
      }

      // POST endpoint
      if (path === '/post' && req.method === 'POST') {
        let body = ''
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString()
        })
        req.on('end', () => {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ received: body, length: body.length }))
        })
        return
      }

      // Binary echo endpoint - returns raw binary data
      if (path === '/binary-echo') {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => {
          chunks.push(chunk)
        })
        req.on('end', () => {
          const body = Buffer.concat(chunks)
          res.setHeader('Content-Type', 'application/octet-stream')
          res.setHeader('Content-Length', body.length.toString())
          res.end(body)
        })
        return
      }

      // Large response endpoint
      if (path === '/large') {
        const size = parseInt(url.searchParams.get('size') || '10000', 10)
        const data = 'x'.repeat(size)
        res.setHeader('Content-Type', 'text/plain')
        res.end(data)
        return
      }

      // Empty response endpoint
      if (path === '/empty') {
        res.statusCode = 204
        res.end()
        return
      }

      // Server error endpoint
      if (path === '/error') {
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'Internal Server Error' }))
        return
      }

      // Slow endpoint
      if (path === '/slow') {
        const delay = parseInt(url.searchParams.get('delay') || '2000', 10)
        setTimeout(() => {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ delayed: true, delay }))
        }, delay)
        return
      }

      // SSE endpoint - sends 5 events quickly for testing
      if (path === '/sse') {
        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')

        let count = 0
        const maxCount = 5
        const interval = setInterval(() => {
          count++
          res.write(`data: {"count":${count},"time":"${new Date().toISOString()}"}\n\n`)

          if (count >= maxCount) {
            clearInterval(interval)
            res.end()
          }
        }, 100)

        req.on('close', () => {
          clearInterval(interval)
        })
        return
      }

      // 404
      res.statusCode = 404
      res.end('Not Found')
    })

    // WebSocket handling using ws package
    const wss = new WebSocketServer({ server })

    wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
      const url = new URL(req.url || '/', `http://localhost:${port}`)
      wsConnections.add(ws)

      // Send welcome with connection count
      ws.send(
        JSON.stringify({
          type: 'connected',
          timestamp: Date.now(),
          connectionCount: wsConnections.size,
          path: url.pathname,
        })
      )

      ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) {
          // Echo binary data back as binary
          ws.send(data, { binary: true })
        } else {
          const message = data.toString()

          // Check for special commands
          if (message === 'GET_CONNECTION_COUNT') {
            ws.send(JSON.stringify({ type: 'connection_count', count: wsConnections.size }))
            return
          }

          if (message === 'BROADCAST_TEST') {
            // Broadcast to all connections including self
            for (const client of wsConnections) {
              if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'broadcast', message: 'Hello from server!' }))
              }
            }
            return
          }

          // Echo back
          ws.send(
            JSON.stringify({
              type: 'echo',
              message,
              timestamp: Date.now(),
            })
          )
        }
      })

      ws.on('close', () => {
        wsConnections.delete(ws)
      })
    })

    server.listen(port, () => {
      resolve({
        server,
        close: () => {
          return new Promise((res) => {
            for (const ws of wsConnections) {
              ws.close()
            }
            wss.close()
            server.close(() => {
              res()
            })
          })
        },
        broadcast: (message: string) => {
          for (const ws of wsConnections) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(message)
            }
          }
        },
        getConnectionCount: () => wsConnections.size,
      })
    })
  })
}

describe('Traforo Tunnel Integration', () => {
  const tunnelId = getTunnelId()
  const localPort = 19876 + Math.floor(Math.random() * 1000)
  let testServer: {
    server: Server
    close: () => Promise<void>
    broadcast: (message: string) => void
    getConnectionCount: () => number
  }
  let tunnelClient: TunnelClient

  const tunnelUrl = `https://${tunnelId}-tunnel-preview.kimaki.xyz`
  const serverUrl = `wss://${tunnelId}-tunnel-preview.kimaki.xyz`

  beforeAll(async () => {
    // Start local test server
    testServer = await createTestServer(localPort)
    console.log(`Test server running on port ${localPort}`)

    // Create and connect tunnel client
    tunnelClient = new TunnelClient({
      localPort,
      tunnelId,
      serverUrl,
      autoReconnect: false,
    })

    await tunnelClient.connect()
    console.log(`Tunnel connected: ${tunnelUrl}`)

    // Wait a moment for connection to stabilize
    await new Promise((r) => {
      setTimeout(r, 500)
    })
  }, TEST_TIMEOUT)

  afterAll(async () => {
    tunnelClient?.close()
    await testServer?.close()
  })

  describe('HTTP Requests', () => {
    test(
      'GET static HTML page',
      async () => {
        const res = await fetch(`${tunnelUrl}/`)
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toContain('text/html')

        const body = await res.text()
        expect(body).toContain('<h1>Test Server</h1>')
      },
      TEST_TIMEOUT
    )

    test(
      'GET JSON endpoint',
      async () => {
        const res = await fetch(`${tunnelUrl}/json`)
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toContain('application/json')

        const data = (await res.json()) as { status: string; timestamp: number }
        expect(data.status).toBe('ok')
        expect(typeof data.timestamp).toBe('number')
      },
      TEST_TIMEOUT
    )

    test(
      'GET echo with query params',
      async () => {
        const res = await fetch(`${tunnelUrl}/echo?foo=bar&baz=123`)
        expect(res.status).toBe(200)

        const data = (await res.json()) as {
          method: string
          path: string
          query: Record<string, string>
        }
        expect(data.method).toBe('GET')
        expect(data.path).toBe('/echo')
        expect(data.query.foo).toBe('bar')
        expect(data.query.baz).toBe('123')
      },
      TEST_TIMEOUT
    )

    test(
      'POST with JSON body',
      async () => {
        const body = JSON.stringify({ hello: 'world', number: 42 })
        const res = await fetch(`${tunnelUrl}/post`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        })

        expect(res.status).toBe(200)
        const data = (await res.json()) as { received: string; length: number }
        expect(data.received).toBe(body)
        expect(data.length).toBe(body.length)
      },
      TEST_TIMEOUT
    )

    test(
      'GET 404 for unknown path',
      async () => {
        const res = await fetch(`${tunnelUrl}/unknown-path-xyz`)
        expect(res.status).toBe(404)
      },
      TEST_TIMEOUT
    )

    test(
      'custom headers are forwarded',
      async () => {
        const res = await fetch(`${tunnelUrl}/echo`, {
          headers: {
            'X-Custom-Header': 'test-value',
            'X-Another-Header': 'another-value',
          },
        })

        const data = (await res.json()) as { headers: Record<string, string> }
        expect(data.headers['x-custom-header']).toBe('test-value')
        expect(data.headers['x-another-header']).toBe('another-value')
      },
      TEST_TIMEOUT
    )

    test(
      'PUT request with body',
      async () => {
        const body = JSON.stringify({ update: 'data' })
        const res = await fetch(`${tunnelUrl}/echo`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body,
        })

        const data = (await res.json()) as { method: string; body: string }
        expect(data.method).toBe('PUT')
        expect(data.body).toBe(body)
      },
      TEST_TIMEOUT
    )

    test(
      'DELETE request',
      async () => {
        const res = await fetch(`${tunnelUrl}/echo`, { method: 'DELETE' })
        const data = (await res.json()) as { method: string }
        expect(data.method).toBe('DELETE')
      },
      TEST_TIMEOUT
    )

    test(
      'PATCH request with body',
      async () => {
        const body = JSON.stringify({ patch: 'value' })
        const res = await fetch(`${tunnelUrl}/echo`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body,
        })

        const data = (await res.json()) as { method: string; body: string }
        expect(data.method).toBe('PATCH')
        expect(data.body).toBe(body)
      },
      TEST_TIMEOUT
    )

    test(
      'empty response (204 No Content)',
      async () => {
        const res = await fetch(`${tunnelUrl}/empty`)
        expect(res.status).toBe(204)
        const body = await res.text()
        expect(body).toBe('')
      },
      TEST_TIMEOUT
    )

    test(
      'server error (500)',
      async () => {
        const res = await fetch(`${tunnelUrl}/error`)
        expect(res.status).toBe(500)
        const data = (await res.json()) as { error: string }
        expect(data.error).toBe('Internal Server Error')
      },
      TEST_TIMEOUT
    )

    test(
      'large response body (100KB)',
      async () => {
        const size = 100_000
        const res = await fetch(`${tunnelUrl}/large?size=${size}`)
        expect(res.status).toBe(200)
        const body = await res.text()
        expect(body.length).toBe(size)
      },
      TEST_TIMEOUT
    )

    test(
      'large request body (50KB)',
      async () => {
        const size = 50_000
        const body = 'y'.repeat(size)
        const res = await fetch(`${tunnelUrl}/echo`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body,
        })

        const data = (await res.json()) as { bodyLength: number }
        expect(data.bodyLength).toBe(size)
      },
      TEST_TIMEOUT
    )

    test(
      'binary request and response',
      async () => {
        // Create binary data (random bytes)
        const binaryData = new Uint8Array(1024)
        for (let i = 0; i < binaryData.length; i++) {
          binaryData[i] = i % 256
        }

        const res = await fetch(`${tunnelUrl}/binary-echo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: binaryData,
        })

        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toBe('application/octet-stream')

        const responseData = new Uint8Array(await res.arrayBuffer())
        expect(responseData.length).toBe(binaryData.length)
        expect(responseData).toEqual(binaryData)
      },
      TEST_TIMEOUT
    )

    test(
      'concurrent HTTP requests',
      async () => {
        const requests = Array.from({ length: 5 }, (_, i) => {
          return fetch(`${tunnelUrl}/echo?request=${i}`).then((res) => res.json())
        })

        const results = (await Promise.all(requests)) as Array<{ query: { request: string } }>
        const requestIds = results.map((r) => r.query.request).sort()
        expect(requestIds).toEqual(['0', '1', '2', '3', '4'])
      },
      TEST_TIMEOUT
    )
  })

  describe('SSE Streaming', () => {
    test(
      'receives all SSE events in order',
      async () => {
        const res = await fetch(`${tunnelUrl}/sse`)
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toContain('text/event-stream')

        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        const events: Array<{ count: number; time: string }> = []

        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            break
          }

          const text = decoder.decode(value)
          const lines = text.split('\n')

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = JSON.parse(line.slice(6))
              events.push(data)
            }
          }
        }

        expect(events.length).toBe(5)
        expect(events.map((e) => e.count)).toEqual([1, 2, 3, 4, 5])
      },
      TEST_TIMEOUT
    )
  })

  describe('WebSocket Connections', () => {
    test(
      'can connect and receive welcome message',
      async () => {
        const wsUrl = tunnelUrl.replace('https://', 'wss://') + '/ws'
        const ws = new WebSocket(wsUrl)

        const welcomeMessage = await new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('WebSocket welcome timeout'))
          }, 10_000)

          ws.on('open', () => {
            console.log('WebSocket connected')
          })

          ws.on('message', (data: WebSocket.RawData) => {
            clearTimeout(timeout)
            resolve(data.toString())
          })

          ws.on('error', (err: Error) => {
            clearTimeout(timeout)
            reject(err)
          })
        })

        const parsed = JSON.parse(welcomeMessage) as { type: string; timestamp: number }
        expect(parsed.type).toBe('connected')
        expect(typeof parsed.timestamp).toBe('number')

        ws.close()
      },
      TEST_TIMEOUT
    )

    test(
      'can send and receive echo messages',
      async () => {
        const wsUrl = tunnelUrl.replace('https://', 'wss://') + '/ws'
        const ws = new WebSocket(wsUrl)

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('WebSocket open timeout'))
          }, 10_000)

          ws.on('open', () => {
            clearTimeout(timeout)
            resolve()
          })
          ws.on('error', reject)
        })

        // Skip welcome message
        await new Promise<void>((resolve) => {
          ws.once('message', () => {
            resolve()
          })
        })

        // Send test message
        const testMessage = 'Hello from test!'
        ws.send(testMessage)

        const echoResponse = await new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Echo timeout'))
          }, 10_000)

          ws.once('message', (data: WebSocket.RawData) => {
            clearTimeout(timeout)
            resolve(data.toString())
          })
        })

        const parsed = JSON.parse(echoResponse) as { type: string; message: string }
        expect(parsed.type).toBe('echo')
        expect(parsed.message).toBe(testMessage)

        ws.close()
      },
      TEST_TIMEOUT
    )

    test(
      'bidirectional message exchange',
      async () => {
        const wsUrl = tunnelUrl.replace('https://', 'wss://') + '/ws'
        const ws = new WebSocket(wsUrl)

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('WebSocket open timeout'))
          }, 10_000)
          ws.on('open', () => {
            clearTimeout(timeout)
            resolve()
          })
          ws.on('error', reject)
        })

        // Skip welcome
        await new Promise<void>((r) => {
          ws.once('message', () => {
            r()
          })
        })

        // Send multiple messages and collect responses
        const messages = ['message1', 'message2', 'message3']
        const responses: string[] = []

        ws.on('message', (data: WebSocket.RawData) => {
          const parsed = JSON.parse(data.toString()) as { type: string; message: string }
          if (parsed.type === 'echo') {
            responses.push(parsed.message)
          }
        })

        for (const msg of messages) {
          ws.send(msg)
          await new Promise((r) => {
            setTimeout(r, 100)
          })
        }

        // Wait for all responses
        await new Promise((r) => {
          setTimeout(r, 500)
        })

        expect(responses).toEqual(messages)

        ws.close()
      },
      TEST_TIMEOUT
    )

    test(
      'multiple concurrent WebSocket connections',
      async () => {
        const wsUrl = tunnelUrl.replace('https://', 'wss://') + '/ws'
        const connectionCount = 3
        const connections: WebSocket[] = []
        const welcomeMessages: Array<{ connectionCount: number }> = []

        // Create multiple connections
        for (let i = 0; i < connectionCount; i++) {
          const ws = new WebSocket(wsUrl)
          connections.push(ws)

          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              reject(new Error(`WebSocket ${i} open timeout`))
            }, 10_000)

            ws.on('open', () => {
              clearTimeout(timeout)
            })

            ws.once('message', (data: WebSocket.RawData) => {
              const parsed = JSON.parse(data.toString()) as { type: string; connectionCount: number }
              if (parsed.type === 'connected') {
                welcomeMessages.push({ connectionCount: parsed.connectionCount })
              }
              resolve()
            })

            ws.on('error', reject)
          })
        }

        // Each connection should see an incrementing connection count
        expect(welcomeMessages.length).toBe(connectionCount)
        // Connection counts should increment (not checking absolute values since other tests may have connections)
        const counts = welcomeMessages.map((m) => m.connectionCount)
        expect(counts[1] - counts[0]).toBe(1)
        expect(counts[2] - counts[1]).toBe(1)

        // Clean up
        for (const ws of connections) {
          ws.close()
        }

        // Wait for cleanup
        await new Promise((r) => {
          setTimeout(r, 200)
        })
      },
      TEST_TIMEOUT
    )

    test(
      'server broadcasts to all connected clients',
      async () => {
        const wsUrl = tunnelUrl.replace('https://', 'wss://') + '/ws'
        const connections: WebSocket[] = []
        const broadcastReceived: boolean[] = [false, false]

        // Create 2 connections
        for (let i = 0; i < 2; i++) {
          const ws = new WebSocket(wsUrl)
          connections.push(ws)

          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
              reject(new Error(`WebSocket ${i} open timeout`))
            }, 10_000)

            ws.on('open', () => {
              clearTimeout(timeout)
            })

            // Skip welcome message
            ws.once('message', () => {
              resolve()
            })

            ws.on('error', reject)
          })

          // Set up broadcast listener
          const idx = i
          ws.on('message', (data: WebSocket.RawData) => {
            const parsed = JSON.parse(data.toString()) as { type: string }
            if (parsed.type === 'broadcast') {
              broadcastReceived[idx] = true
            }
          })
        }

        // First connection triggers a broadcast
        connections[0].send('BROADCAST_TEST')

        // Wait for broadcast to propagate
        await new Promise((r) => {
          setTimeout(r, 500)
        })

        // Both connections should have received the broadcast
        expect(broadcastReceived).toEqual([true, true])

        // Clean up
        for (const ws of connections) {
          ws.close()
        }
      },
      TEST_TIMEOUT
    )

    test(
      'binary WebSocket messages',
      async () => {
        const wsUrl = tunnelUrl.replace('https://', 'wss://') + '/ws'
        const ws = new WebSocket(wsUrl)

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('WebSocket open timeout'))
          }, 10_000)
          ws.on('open', () => {
            clearTimeout(timeout)
            resolve()
          })
          ws.on('error', reject)
        })

        // Skip welcome
        await new Promise<void>((r) => {
          ws.once('message', () => {
            r()
          })
        })

        // Send binary data
        const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd])
        ws.send(binaryData)

        // Receive binary echo
        const response = await new Promise<Buffer>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Binary echo timeout'))
          }, 10_000)

          ws.once('message', (data: WebSocket.RawData) => {
            clearTimeout(timeout)
            resolve(Buffer.from(data as ArrayBuffer))
          })
        })

        expect(response).toEqual(binaryData)

        ws.close()
      },
      TEST_TIMEOUT
    )

    test(
      'large WebSocket message',
      async () => {
        const wsUrl = tunnelUrl.replace('https://', 'wss://') + '/ws'
        const ws = new WebSocket(wsUrl)

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('WebSocket open timeout'))
          }, 10_000)
          ws.on('open', () => {
            clearTimeout(timeout)
            resolve()
          })
          ws.on('error', reject)
        })

        // Skip welcome
        await new Promise<void>((r) => {
          ws.once('message', () => {
            r()
          })
        })

        // Send large message (50KB)
        const largeMessage = 'x'.repeat(50_000)
        ws.send(largeMessage)

        const response = await new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Large message echo timeout'))
          }, 10_000)

          ws.once('message', (data: WebSocket.RawData) => {
            clearTimeout(timeout)
            resolve(data.toString())
          })
        })

        const parsed = JSON.parse(response) as { type: string; message: string }
        expect(parsed.type).toBe('echo')
        expect(parsed.message.length).toBe(largeMessage.length)

        ws.close()
      },
      TEST_TIMEOUT
    )

    test(
      'rapid WebSocket message sending',
      async () => {
        const wsUrl = tunnelUrl.replace('https://', 'wss://') + '/ws'
        const ws = new WebSocket(wsUrl)

        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('WebSocket open timeout'))
          }, 10_000)
          ws.on('open', () => {
            clearTimeout(timeout)
            resolve()
          })
          ws.on('error', reject)
        })

        // Skip welcome
        await new Promise<void>((r) => {
          ws.once('message', () => {
            r()
          })
        })

        // Send 20 messages rapidly without waiting
        const messageCount = 20
        const responses: string[] = []

        ws.on('message', (data: WebSocket.RawData) => {
          const parsed = JSON.parse(data.toString()) as { type: string; message: string }
          if (parsed.type === 'echo') {
            responses.push(parsed.message)
          }
        })

        for (let i = 0; i < messageCount; i++) {
          ws.send(`rapid-${i}`)
        }

        // Wait for all responses
        await new Promise((r) => {
          setTimeout(r, 2000)
        })

        expect(responses.length).toBe(messageCount)
        // Messages should arrive (order may vary due to async nature)
        const sortedResponses = responses.sort()
        const expected = Array.from({ length: messageCount }, (_, i) => `rapid-${i}`).sort()
        expect(sortedResponses).toEqual(expected)

        ws.close()
      },
      TEST_TIMEOUT
    )
  })
})

describe('Tunnel Status and Offline Behavior', () => {
  test(
    'status endpoint shows offline when no client connected',
    async () => {
      const offlineTunnelId = getTunnelId()
      const statusUrl = `https://${offlineTunnelId}-tunnel-preview.kimaki.xyz/traforo-status`

      const res = await fetch(statusUrl)
      expect(res.status).toBe(200)

      const data = (await res.json()) as { online: boolean; tunnelId: string }
      expect(data.online).toBe(false)
      expect(data.tunnelId).toBe(offlineTunnelId)
    },
    TEST_TIMEOUT
  )

  test(
    'HTTP request to offline tunnel returns 503',
    async () => {
      const offlineTunnelId = getTunnelId()
      const offlineUrl = `https://${offlineTunnelId}-tunnel-preview.kimaki.xyz/some-path`

      const res = await fetch(offlineUrl)
      expect(res.status).toBe(503)

      const body = await res.text()
      expect(body).toContain('offline')
    },
    TEST_TIMEOUT
  )

  test(
    'WebSocket to offline tunnel fails gracefully',
    async () => {
      const offlineTunnelId = getTunnelId()
      const wsUrl = `wss://${offlineTunnelId}-tunnel-preview.kimaki.xyz/ws`
      const ws = new WebSocket(wsUrl)

      const closeEvent = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('WebSocket close timeout'))
        }, 10_000)

        ws.on('close', (code: number, reason: Buffer) => {
          clearTimeout(timeout)
          resolve({ code, reason: reason.toString() })
        })

        ws.on('error', () => {
          // Error is expected, wait for close
        })
      })

      // Should close with code 4008 (Tunnel offline)
      expect(closeEvent.code).toBe(4008)
    },
    TEST_TIMEOUT
  )
})

describe('Tunnel Reconnection', () => {
  test(
    'new upstream connection replaces old one',
    async () => {
      const reconnectTunnelId = getTunnelId()
      const localPort = 29876 + Math.floor(Math.random() * 1000)
      const serverUrl = `wss://${reconnectTunnelId}-tunnel-preview.kimaki.xyz`

      // Start a local server
      const testServer = await createTestServer(localPort)

      // Create first tunnel client
      const client1 = new TunnelClient({
        localPort,
        tunnelId: reconnectTunnelId,
        serverUrl,
        autoReconnect: false,
      })

      await client1.connect()

      // Verify tunnel is online
      const statusUrl = `https://${reconnectTunnelId}-tunnel-preview.kimaki.xyz/traforo-status`
      const status1 = await fetch(statusUrl)
      const data1 = (await status1.json()) as { online: boolean }
      expect(data1.online).toBe(true)

      // Create second tunnel client (should replace first)
      const client2 = new TunnelClient({
        localPort,
        tunnelId: reconnectTunnelId,
        serverUrl,
        autoReconnect: false,
      })

      await client2.connect()

      // Wait for replacement to complete
      await new Promise((r) => {
        setTimeout(r, 500)
      })

      // Tunnel should still be online
      const status2 = await fetch(statusUrl)
      const data2 = (await status2.json()) as { online: boolean }
      expect(data2.online).toBe(true)

      // HTTP request should work through new client
      const tunnelUrl = `https://${reconnectTunnelId}-tunnel-preview.kimaki.xyz`
      const res = await fetch(`${tunnelUrl}/json`)
      expect(res.status).toBe(200)

      // Clean up
      client1.close()
      client2.close()
      await testServer.close()
    },
    TEST_TIMEOUT
  )
})
