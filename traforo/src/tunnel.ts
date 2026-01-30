import type {
  UpstreamMessage,
  DownstreamMessage,
  HttpRequestMessage,
  HttpResponseMessage,
  HttpErrorMessage,
  WsOpenMessage,
  WsFrameMessage,
  WsCloseMessage,
  WsOpenedMessage,
  WsFrameResponseMessage,
  WsClosedMessage,
  WsErrorMessage,
} from './types.js'

// Cloudflare-specific types
export type Env = {
  TUNNEL_DO: DurableObjectNamespace
}

type Attachment = {
  role: 'upstream' | 'downstream'
  tunnelId: string
}

type PendingHttpRequest = {
  resolve: (response: Response) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

type PendingWsConnection = {
  userWs: WebSocket
  timeout: ReturnType<typeof setTimeout>
}

const HTTP_TIMEOUT_MS = 30_000
const WS_OPEN_TIMEOUT_MS = 10_000

// Worker entrypoint
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === 'OPTIONS') {
      return addCors(new Response(null, { status: 204 }))
    }

    const url = new URL(req.url)
    const host = url.hostname

    // Extract tunnel ID from subdomain: {tunnelId}-tunnel.kimaki.xyz
    const tunnelId = extractTunnelId(host)
    if (!tunnelId) {
      return addCors(new Response('Invalid tunnel URL', { status: 400 }))
    }

    // Get the Durable Object for this tunnel
    const doId = env.TUNNEL_DO.idFromName(tunnelId)
    const stub = env.TUNNEL_DO.get(doId)

    // Forward request to DO
    const doUrl = new URL(req.url)
    doUrl.searchParams.set('_tunnelId', tunnelId)
    const res = await stub.fetch(new Request(doUrl.toString(), req))

    return addCors(res)
  },
}

function extractTunnelId(host: string): string | null {
  // Match: {tunnelId}-tunnel.kimaki.xyz or {tunnelId}-tunnel.localhost
  const match = host.match(/^([a-z0-9-]+)-tunnel\./)
  if (!match) {
    return null
  }
  return match[1]
}

// Durable Object
export class Tunnel {
  private ctx: DurableObjectState
  private env: Env
  private pendingHttpRequests: Map<string, PendingHttpRequest> = new Map()
  private pendingWsConnections: Map<string, PendingWsConnection> = new Map()

  constructor(state: DurableObjectState, env: Env) {
    this.ctx = state
    this.env = env

    // Auto-respond to ping messages without waking DO
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('ping', 'pong')
    )
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}')
    )
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const tunnelId = url.searchParams.get('_tunnelId') || 'default'
    const isUpgrade = req.headers.get('Upgrade') === 'websocket'

    // WebSocket upgrade requests
    if (isUpgrade) {
      if (url.pathname === '/traforo-upstream') {
        return this.handleUpstreamConnection(tunnelId)
      }
      // User WebSocket connection to be proxied
      return this.handleUserWsConnection(tunnelId, url.pathname, req.headers)
    }

    // Status endpoint
    if (url.pathname === '/traforo-status') {
      const upstream = this.getUpstream(tunnelId)
      return Response.json({
        online: !!upstream,
        tunnelId,
      })
    }

    // HTTP request to be proxied
    return this.handleHttpProxy(tunnelId, req)
  }

  // ============================================
  // Upstream (local client) connection
  // ============================================

  private handleUpstreamConnection(tunnelId: string): Response {
    // Close any existing upstream connection
    const existing = this.getUpstream(tunnelId)
    if (existing) {
      try {
        existing.close(4009, 'Replaced by new connection')
      } catch {}
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)

    this.ctx.acceptWebSocket(server, [`upstream:${tunnelId}`])
    server.serializeAttachment({
      role: 'upstream',
      tunnelId,
    } satisfies Attachment)

    // Notify any waiting downstream connections
    const downstreams = this.ctx.getWebSockets(`downstream:${tunnelId}`)
    for (const ws of downstreams) {
      try {
        ws.send(JSON.stringify({ event: 'upstream_connected' }))
      } catch {}
    }

    return new Response(null, { status: 101, webSocket: client })
  }

  private getUpstream(tunnelId: string): WebSocket | null {
    const sockets = this.ctx.getWebSockets(`upstream:${tunnelId}`)
    return sockets[0] || null
  }

  // ============================================
  // HTTP Proxy
  // ============================================

  private async handleHttpProxy(
    tunnelId: string,
    req: Request
  ): Promise<Response> {
    const upstream = this.getUpstream(tunnelId)
    if (!upstream) {
      return new Response('Tunnel offline', { status: 503 })
    }

    const reqId = crypto.randomUUID()
    const url = new URL(req.url)

    // Read request body
    let body: string | null = null
    if (req.body) {
      const buffer = await req.arrayBuffer()
      if (buffer.byteLength > 0) {
        body = arrayBufferToBase64(buffer)
      }
    }

    // Build headers object
    const headers: Record<string, string> = {}
    req.headers.forEach((value, key) => {
      // Skip hop-by-hop headers
      if (!isHopByHopHeader(key)) {
        headers[key] = value
      }
    })

    // Send request to local client
    const message: HttpRequestMessage = {
      type: 'http_request',
      id: reqId,
      method: req.method,
      path: url.pathname + url.search,
      headers,
      body,
    }

    try {
      upstream.send(JSON.stringify(message) satisfies string)
    } catch {
      return new Response('Failed to send to tunnel', { status: 502 })
    }

    // Wait for response
    return new Promise<Response>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingHttpRequests.delete(reqId)
        resolve(new Response('Tunnel timeout', { status: 504 }))
      }, HTTP_TIMEOUT_MS)

      this.pendingHttpRequests.set(reqId, { resolve, reject, timeout })
    })
  }

  // ============================================
  // User WebSocket Proxy
  // ============================================

  private handleUserWsConnection(
    tunnelId: string,
    path: string,
    reqHeaders: Headers
  ): Response {
    const upstream = this.getUpstream(tunnelId)
    if (!upstream) {
      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)
      server.accept()
      server.close(4008, 'Tunnel offline')
      return new Response(null, { status: 101, webSocket: client })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)

    const connId = crypto.randomUUID()

    this.ctx.acceptWebSocket(server, [`downstream:${tunnelId}`, `ws:${connId}`])
    server.serializeAttachment({
      role: 'downstream',
      tunnelId,
    } satisfies Attachment)

    // Build headers object
    const headers: Record<string, string> = {}
    reqHeaders.forEach((value, key) => {
      if (!isHopByHopHeader(key) && key.toLowerCase() !== 'upgrade') {
        headers[key] = value
      }
    })

    // Request local client to open WebSocket
    const message: WsOpenMessage = {
      type: 'ws_open',
      connId,
      path,
      headers,
    }

    try {
      upstream.send(JSON.stringify(message) satisfies string)
    } catch {
      server.close(4009, 'Failed to contact tunnel')
      return new Response(null, { status: 101, webSocket: client })
    }

    // Set timeout for WS open
    const timeout = setTimeout(() => {
      this.pendingWsConnections.delete(connId)
      try {
        server.close(4010, 'Local connection timeout')
      } catch {}
    }, WS_OPEN_TIMEOUT_MS)

    this.pendingWsConnections.set(connId, { userWs: server, timeout })

    return new Response(null, { status: 101, webSocket: client })
  }

  // ============================================
  // WebSocket Hibernation Handlers
  // ============================================

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') {
      return
    }

    const attachment = ws.deserializeAttachment() as Attachment | undefined
    if (!attachment) {
      return
    }

    if (attachment.role === 'upstream') {
      this.handleUpstreamMessage(attachment.tunnelId, message)
    } else if (attachment.role === 'downstream') {
      this.handleDownstreamMessage(attachment.tunnelId, ws, message)
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean
  ) {
    const attachment = ws.deserializeAttachment() as Attachment | undefined
    if (!attachment) {
      return
    }

    if (attachment.role === 'upstream') {
      // Upstream disconnected - notify all downstream connections
      const downstreams = this.ctx.getWebSockets(
        `downstream:${attachment.tunnelId}`
      )
      for (const down of downstreams) {
        try {
          down.send(JSON.stringify({ event: 'upstream_disconnected' }))
          down.close(1012, 'Upstream disconnected')
        } catch {}
      }

      // Reject all pending HTTP requests
      for (const [reqId, pending] of this.pendingHttpRequests) {
        clearTimeout(pending.timeout)
        pending.resolve(new Response('Tunnel disconnected', { status: 502 }))
      }
      this.pendingHttpRequests.clear()

      // Close all pending WS connections
      for (const [connId, pending] of this.pendingWsConnections) {
        clearTimeout(pending.timeout)
        try {
          pending.userWs.close(4011, 'Tunnel disconnected')
        } catch {}
      }
      this.pendingWsConnections.clear()
    }
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    // Treat errors same as close
    await this.webSocketClose(ws, 1011, 'WebSocket error', false)
  }

  // ============================================
  // Message Handlers
  // ============================================

  private handleUpstreamMessage(tunnelId: string, rawMessage: string) {
    let msg: DownstreamMessage
    try {
      msg = JSON.parse(rawMessage) as DownstreamMessage
    } catch {
      return
    }

    switch (msg.type) {
      case 'http_response':
        this.handleHttpResponse(msg)
        break
      case 'http_error':
        this.handleHttpError(msg)
        break
      case 'ws_opened':
        this.handleWsOpened(msg)
        break
      case 'ws_frame':
        this.handleWsFrame(tunnelId, msg)
        break
      case 'ws_closed':
        this.handleWsClosed(msg)
        break
      case 'ws_error':
        this.handleWsError(msg)
        break
    }
  }

  private handleDownstreamMessage(
    tunnelId: string,
    ws: WebSocket,
    rawMessage: string
  ) {
    // Forward message from user WebSocket to upstream
    const upstream = this.getUpstream(tunnelId)
    if (!upstream) {
      return
    }

    // Try to parse to get connId for routing
    let parsed: { connId?: string; data?: string }
    try {
      parsed = JSON.parse(rawMessage)
    } catch {
      return
    }

    // Find the connId for this downstream WebSocket
    const tags = this.ctx.getTags(ws)
    const wsTag = tags.find((t) => t.startsWith('ws:'))
    if (!wsTag) {
      return
    }
    const connId = wsTag.replace('ws:', '')

    // Forward as WsFrameMessage
    const message: WsFrameMessage = {
      type: 'ws_frame',
      connId,
      data: rawMessage,
    }

    try {
      upstream.send(JSON.stringify(message) satisfies string)
    } catch {}
  }

  private handleHttpResponse(msg: HttpResponseMessage) {
    const pending = this.pendingHttpRequests.get(msg.id)
    if (!pending) {
      return
    }

    clearTimeout(pending.timeout)
    this.pendingHttpRequests.delete(msg.id)

    // Decode body
    let body: BodyInit | null = null
    if (msg.body) {
      body = base64ToArrayBuffer(msg.body)
    }

    // Build response headers
    const headers = new Headers()
    for (const [key, value] of Object.entries(msg.headers)) {
      if (!isHopByHopHeader(key)) {
        headers.set(key, value)
      }
    }

    pending.resolve(new Response(body, { status: msg.status, headers }))
  }

  private handleHttpError(msg: HttpErrorMessage) {
    const pending = this.pendingHttpRequests.get(msg.id)
    if (!pending) {
      return
    }

    clearTimeout(pending.timeout)
    this.pendingHttpRequests.delete(msg.id)

    pending.resolve(new Response(msg.error, { status: 502 }))
  }

  private handleWsOpened(msg: WsOpenedMessage) {
    const pending = this.pendingWsConnections.get(msg.connId)
    if (!pending) {
      return
    }

    clearTimeout(pending.timeout)
    this.pendingWsConnections.delete(msg.connId)
    // WebSocket is now fully connected, messages will flow via webSocketMessage
  }

  private handleWsFrame(tunnelId: string, msg: WsFrameResponseMessage) {
    const sockets = this.ctx.getWebSockets(`ws:${msg.connId}`)
    for (const ws of sockets) {
      try {
        if (msg.binary) {
          ws.send(base64ToArrayBuffer(msg.data))
        } else {
          ws.send(msg.data)
        }
      } catch {}
    }
  }

  private handleWsClosed(msg: WsClosedMessage) {
    // Clear pending if still waiting
    const pending = this.pendingWsConnections.get(msg.connId)
    if (pending) {
      clearTimeout(pending.timeout)
      this.pendingWsConnections.delete(msg.connId)
    }

    // Close user WebSocket
    const sockets = this.ctx.getWebSockets(`ws:${msg.connId}`)
    for (const ws of sockets) {
      try {
        ws.close(msg.code, msg.reason)
      } catch {}
    }
  }

  private handleWsError(msg: WsErrorMessage) {
    // Clear pending if still waiting
    const pending = this.pendingWsConnections.get(msg.connId)
    if (pending) {
      clearTimeout(pending.timeout)
      this.pendingWsConnections.delete(msg.connId)
    }

    // Close user WebSocket with error
    const sockets = this.ctx.getWebSockets(`ws:${msg.connId}`)
    for (const ws of sockets) {
      try {
        ws.close(4012, msg.error)
      } catch {}
    }
  }
}

// ============================================
// Utilities
// ============================================

function addCors(res: Response): Response {
  const headers = new Headers(res.headers)
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('Access-Control-Allow-Headers', '*')
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
    webSocket: (res as Response & { webSocket?: WebSocket }).webSocket,
  })
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
])

function isHopByHopHeader(header: string): boolean {
  return HOP_BY_HOP_HEADERS.has(header.toLowerCase())
}
