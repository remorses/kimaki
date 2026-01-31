/**
 * Local tunnel client - runs on user's machine to expose a local server.
 */

import WebSocket from 'ws'
import type {
  UpstreamMessage,
  DownstreamMessage,
  HttpRequestMessage,
  HttpResponseMessage,
  HttpResponseStartMessage,
  HttpResponseChunkMessage,
  HttpResponseEndMessage,
  HttpErrorMessage,
  WsOpenMessage,
  WsFrameMessage,
  WsCloseMessage,
  WsOpenedMessage,
  WsFrameResponseMessage,
  WsClosedMessage,
  WsErrorMessage,
} from './types.js'

type TunnelClientOptions = {
  /** Local port to proxy to */
  localPort: number
  /** Local host (default: localhost) */
  localHost?: string
  /** Base domain for tunnel URLs (default: kimaki.xyz) */
  baseDomain?: string
  /** Tunnel server URL (default: wss://{tunnelId}-tunnel.{baseDomain}) */
  serverUrl?: string
  /** Tunnel ID */
  tunnelId: string
  /** Use HTTPS for local connections */
  localHttps?: boolean
  /** Reconnect on disconnect */
  autoReconnect?: boolean
  /** Reconnect delay in ms */
  reconnectDelay?: number
}

export class TunnelClient {
  private options: Required<TunnelClientOptions>
  private ws: WebSocket | null = null
  private localWsConnections: Map<string, WebSocket> = new Map()
  private closed = false

  constructor(options: TunnelClientOptions) {
    const baseDomain = options.baseDomain || 'traforo.dev'
    this.options = {
      localHost: 'localhost',
      baseDomain,
      serverUrl: `wss://${options.tunnelId}-tunnel.${baseDomain}`,
      localHttps: false,
      autoReconnect: true,
      reconnectDelay: 3000,
      ...options,
    }
  }

  get url(): string {
    return `https://${this.options.tunnelId}-tunnel.${this.options.baseDomain}`
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error('Client is closed')
    }

    const wsUrl = `${this.options.serverUrl}/traforo-upstream?_tunnelId=${this.options.tunnelId}`
    // console.log(`Connecting to ${wsUrl}...`)

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl)

      this.ws.on('open', () => {
        console.log(`Connected with Traforo! Tunnel URL: ${this.url}`)
        resolve()
      })

      this.ws.on('error', (err: Error) => {
        console.error('WebSocket error:', err.message)
        reject(new Error('WebSocket connection failed'))
      })

      this.ws.on('close', (code: number, reason: Buffer) => {
        console.log(`Disconnected: ${code} ${reason.toString()}`)
        this.ws = null

        // Close all local WS connections
        for (const [, localWs] of this.localWsConnections) {
          try {
            localWs.close()
          } catch {}
        }
        this.localWsConnections.clear()

        // Auto-reconnect
        if (this.options.autoReconnect && !this.closed) {
          console.log(`Reconnecting in ${this.options.reconnectDelay}ms...`)
          setTimeout(() => {
            this.connect().catch(console.error)
          }, this.options.reconnectDelay)
        }
      })

      this.ws.on('message', (data: WebSocket.RawData) => {
        this.handleMessage(data.toString())
      })
    })
  }

  close(): void {
    this.closed = true
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    for (const [, localWs] of this.localWsConnections) {
      try {
        localWs.close()
      } catch {}
    }
    this.localWsConnections.clear()
  }

  private handleMessage(rawMessage: string): void {
    let msg: UpstreamMessage
    try {
      msg = JSON.parse(rawMessage) as UpstreamMessage
    } catch {
      console.error('Failed to parse message:', rawMessage)
      return
    }

    switch (msg.type) {
      case 'http_request':
        this.handleHttpRequest(msg)
        break
      case 'ws_open':
        this.handleWsOpen(msg)
        break
      case 'ws_frame':
        this.handleWsFrame(msg)
        break
      case 'ws_close':
        this.handleWsClose(msg)
        break
    }
  }

  private async handleHttpRequest(msg: HttpRequestMessage): Promise<void> {
    const { localHost, localPort, localHttps } = this.options
    const protocol = localHttps ? 'https' : 'http'
    const url = `${protocol}://${localHost}:${localPort}${msg.path}`

    console.log(`HTTP ${msg.method} ${msg.path}`)

    try {
      // Decode body
      let body: Buffer | undefined
      if (msg.body) {
        body = Buffer.from(msg.body, 'base64')
      }

      // Make local request
      const res = await fetch(url, {
        method: msg.method,
        headers: msg.headers,
        body: msg.method !== 'GET' && msg.method !== 'HEAD' ? body : undefined,
      })

      // Build response headers
      const resHeaders: Record<string, string> = {}
      res.headers.forEach((value, key) => {
        resHeaders[key] = value
      })

      // Check if we should stream the response
      const contentType = res.headers.get('content-type') || ''
      const transferEncoding = res.headers.get('transfer-encoding') || ''
      const shouldStream =
        contentType.includes('text/event-stream') ||
        contentType.includes('application/x-ndjson') ||
        transferEncoding.includes('chunked')

      if (shouldStream && res.body) {
        console.log(`HTTP ${msg.method} ${msg.path} -> streaming response`)

        // Send response start
        const startMsg: HttpResponseStartMessage = {
          type: 'http_response_start',
          id: msg.id,
          status: res.status,
          headers: resHeaders,
        }
        this.send(startMsg)

        // Stream chunks
        const reader = res.body.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) {
              break
            }

            const chunkMsg: HttpResponseChunkMessage = {
              type: 'http_response_chunk',
              id: msg.id,
              chunk: Buffer.from(value).toString('base64'),
            }
            this.send(chunkMsg)
          }
        } finally {
          reader.releaseLock()
        }

        // Send response end
        const endMsg: HttpResponseEndMessage = {
          type: 'http_response_end',
          id: msg.id,
        }
        this.send(endMsg)
      } else {
        // Non-streaming: read full body
        const resBuffer = await res.arrayBuffer()
        const resBody =
          resBuffer.byteLength > 0
            ? Buffer.from(resBuffer).toString('base64')
            : null

        const response: HttpResponseMessage = {
          type: 'http_response',
          id: msg.id,
          status: res.status,
          headers: resHeaders,
          body: resBody,
        }

        this.send(response)
      }
    } catch (err) {
      console.error(`HTTP request failed:`, err)

      const errorResponse: HttpErrorMessage = {
        type: 'http_error',
        id: msg.id,
        error: err instanceof Error ? err.message : 'Unknown error',
      }

      this.send(errorResponse)
    }
  }

  private handleWsOpen(msg: WsOpenMessage): void {
    const { localHost, localPort, localHttps } = this.options
    const protocol = localHttps ? 'wss' : 'ws'
    const url = `${protocol}://${localHost}:${localPort}${msg.path}`

    console.log(`WS OPEN ${msg.path} (${msg.connId})`)

    try {
      const localWs = new WebSocket(url)

      localWs.on('open', () => {
        console.log(`WS CONNECTED ${msg.connId}`)
        this.localWsConnections.set(msg.connId, localWs)

        const opened: WsOpenedMessage = {
          type: 'ws_opened',
          connId: msg.connId,
        }
        this.send(opened)
      })

      localWs.on('error', (err: Error) => {
        console.error(`WS ERROR ${msg.connId}:`, err.message)

        const errorMsg: WsErrorMessage = {
          type: 'ws_error',
          connId: msg.connId,
          error: err.message || 'Connection failed',
        }
        this.send(errorMsg)

        this.localWsConnections.delete(msg.connId)
      })

      localWs.on('close', (code: number, reason: Buffer) => {
        console.log(`WS CLOSED ${msg.connId}: ${code} ${reason.toString()}`)

        const closed: WsClosedMessage = {
          type: 'ws_closed',
          connId: msg.connId,
          code,
          reason: reason.toString(),
        }
        this.send(closed)

        this.localWsConnections.delete(msg.connId)
      })

      localWs.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
        let frameData: string
        let binary = false

        if (isBinary || data instanceof Buffer) {
          frameData = Buffer.isBuffer(data)
            ? data.toString('base64')
            : Buffer.from(data as ArrayBuffer).toString('base64')
          binary = true
        } else {
          frameData = data.toString()
        }

        const frame: WsFrameResponseMessage = {
          type: 'ws_frame',
          connId: msg.connId,
          data: frameData,
          binary,
        }
        this.send(frame)
      })
    } catch (err) {
      console.error(`WS OPEN FAILED ${msg.connId}:`, err)

      const errorMsg: WsErrorMessage = {
        type: 'ws_error',
        connId: msg.connId,
        error: err instanceof Error ? err.message : 'Unknown error',
      }
      this.send(errorMsg)
    }
  }

  private handleWsFrame(msg: WsFrameMessage): void {
    const localWs = this.localWsConnections.get(msg.connId)
    if (!localWs) {
      console.warn(`WS FRAME for unknown connection: ${msg.connId}`)
      return
    }

    try {
      if (msg.binary) {
        const buffer = Buffer.from(msg.data, 'base64')
        localWs.send(buffer)
      } else {
        localWs.send(msg.data)
      }
    } catch (err) {
      console.error(`WS SEND FAILED ${msg.connId}:`, err)
    }
  }

  private handleWsClose(msg: WsCloseMessage): void {
    const localWs = this.localWsConnections.get(msg.connId)
    if (!localWs) {
      return
    }

    console.log(`WS CLOSE ${msg.connId}: ${msg.code} ${msg.reason}`)

    try {
      localWs.close(msg.code, msg.reason)
    } catch {}

    this.localWsConnections.delete(msg.connId)
  }

  private send(msg: DownstreamMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('Cannot send: WebSocket not connected')
      return
    }

    this.ws.send(JSON.stringify(msg))
  }
}
