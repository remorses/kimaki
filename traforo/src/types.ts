// ============================================
// Messages: Worker/DO → Local Client (upstream)
// ============================================

// HTTP request to be proxied to local server
export type HttpRequestMessage = {
  type: 'http_request'
  id: string
  method: string
  path: string
  headers: Record<string, string>
  body: string | null // base64 encoded for binary safety
}

// WebSocket connection request from remote user
export type WsOpenMessage = {
  type: 'ws_open'
  connId: string
  path: string
  headers: Record<string, string>
}

// WebSocket frame from remote user
export type WsFrameMessage = {
  type: 'ws_frame'
  connId: string
  data: string // text or base64 for binary
  binary?: boolean
}

// WebSocket close from remote user
export type WsCloseMessage = {
  type: 'ws_close'
  connId: string
  code: number
  reason: string
}

// All messages that can be sent TO the local client
export type UpstreamMessage =
  | HttpRequestMessage
  | WsOpenMessage
  | WsFrameMessage
  | WsCloseMessage

// ============================================
// Messages: Local Client → Worker/DO
// ============================================

// HTTP response from local server (non-streaming, for small responses)
export type HttpResponseMessage = {
  type: 'http_response'
  id: string
  status: number
  headers: Record<string, string>
  body: string | null // base64 encoded
}

// HTTP streaming response start (status + headers, body follows in chunks)
export type HttpResponseStartMessage = {
  type: 'http_response_start'
  id: string
  status: number
  headers: Record<string, string>
}

// HTTP streaming response chunk
export type HttpResponseChunkMessage = {
  type: 'http_response_chunk'
  id: string
  chunk: string // base64 encoded
}

// HTTP streaming response end
export type HttpResponseEndMessage = {
  type: 'http_response_end'
  id: string
}

// HTTP error (local server unavailable, timeout, etc)
export type HttpErrorMessage = {
  type: 'http_error'
  id: string
  error: string
}

// WebSocket opened successfully to local server
export type WsOpenedMessage = {
  type: 'ws_opened'
  connId: string
}

// WebSocket frame from local server
export type WsFrameResponseMessage = {
  type: 'ws_frame'
  connId: string
  data: string
  binary?: boolean
}

// WebSocket closed by local server
export type WsClosedMessage = {
  type: 'ws_closed'
  connId: string
  code: number
  reason: string
}

// WebSocket error connecting to local server
export type WsErrorMessage = {
  type: 'ws_error'
  connId: string
  error: string
}

// All messages that can be sent FROM the local client
export type DownstreamMessage =
  | HttpResponseMessage
  | HttpResponseStartMessage
  | HttpResponseChunkMessage
  | HttpResponseEndMessage
  | HttpErrorMessage
  | WsOpenedMessage
  | WsFrameResponseMessage
  | WsClosedMessage
  | WsErrorMessage

// ============================================
// Events: DO → Remote Users (downstream WebSocket)
// ============================================

export type UpstreamConnectedEvent = {
  event: 'upstream_connected'
}

export type UpstreamDisconnectedEvent = {
  event: 'upstream_disconnected'
}

export type DownstreamEvent = UpstreamConnectedEvent | UpstreamDisconnectedEvent

// ============================================
// Helper functions
// ============================================

// Helper to create type-safe messages
export function createMessage<T extends UpstreamMessage | DownstreamMessage>(
  msg: T
): string {
  return JSON.stringify(msg)
}

// Helper to parse messages with type narrowing
export function parseUpstreamMessage(data: string): UpstreamMessage | null {
  try {
    const msg = JSON.parse(data) as UpstreamMessage
    if (!msg.type) {
      return null
    }
    return msg
  } catch {
    return null
  }
}

export function parseDownstreamMessage(data: string): DownstreamMessage | null {
  try {
    const msg = JSON.parse(data) as DownstreamMessage
    if (!msg.type) {
      return null
    }
    return msg
  } catch {
    return null
  }
}
