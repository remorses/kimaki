import { WebSocket } from 'ws'
import { EventEmitter } from 'events'

interface RealtimeConfig {
  apiKey?: string
  baseURL?: string
  model?: string
}

interface SessionConfig {
  model?: string
  voice?: string
  instructions?: string
  input_audio_format?: string
  output_audio_format?: string
  input_audio_transcription?: {
    model: string
  }
  turn_detection?: {
    type: string
    threshold?: number
    prefix_padding_ms?: number
    silence_duration_ms?: number
  }
  tools?: Array<{
    type: string
    name: string
    description: string
    parameters: object
  }>
  tool_choice?: string
  temperature?: number
  max_response_output_tokens?: number | 'inf'
}

interface ClientEvent {
  type: string
  event_id?: string
  [key: string]: any
}

interface ServerEvent {
  type: string
  event_id: string
  [key: string]: any
}

export class RealtimeClient extends EventEmitter {
  private ws: WebSocket | null = null
  private config: RealtimeConfig
  private sessionConfig: SessionConfig = {}
  private reconnectAttempts = 0
  private maxReconnectAttempts = 5
  private reconnectDelay = 1000

  constructor(config: RealtimeConfig = {}) {
    super()
    this.config = {
      apiKey: config.apiKey || process.env.OPENAI_API_KEY,
      baseURL: config.baseURL || 'wss://api.openai.com',
      model: config.model || 'gpt-4o-realtime-preview-2024-12-17',
    }
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${this.config.baseURL}/v1/realtime?model=${this.config.model}`

      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      })

      this.ws.on('open', () => {
        console.log('Connected to OpenAI Realtime API')
        this.reconnectAttempts = 0
        this.emit('connected')

        if (Object.keys(this.sessionConfig).length > 0) {
          this.updateSession(this.sessionConfig)
        }

        resolve()
      })

      this.ws.on('message', (data: Buffer) => {
        try {
          const event: ServerEvent = JSON.parse(data.toString())
          this.handleServerEvent(event)
        } catch (error) {
          console.error('Failed to parse server event:', error)
        }
      })

      this.ws.on('error', (error) => {
        console.error('WebSocket error:', error)
        this.emit('error', error)
        reject(error)
      })

      this.ws.on('close', (code, reason) => {
        console.log(`WebSocket closed: ${code} - ${reason}`)
        this.emit('disconnected', { code, reason })
        this.ws = null

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++
          setTimeout(() => {
            console.log(
              `Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`,
            )
            this.connect()
          }, this.reconnectDelay * this.reconnectAttempts)
        }
      })
    })
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  private sendEvent(event: ClientEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('WebSocket is not connected')
      return
    }

    const eventWithId = {
      ...event,
      event_id: event.event_id || this.generateEventId(),
    }

    this.ws.send(JSON.stringify(eventWithId))
  }

  private handleServerEvent(event: ServerEvent): void {
    this.emit('server-event', event)

    switch (event.type) {
      case 'error':
        this.emit('error', event.error)
        break

      case 'session.created':
        this.emit('session.created', event.session)
        break

      case 'session.updated':
        this.emit('session.updated', event.session)
        break

      case 'conversation.item.created':
        this.emit('conversation.item.created', event.item)
        break

      case 'conversation.item.deleted':
        this.emit('conversation.item.deleted', event.item_id)
        break

      case 'conversation.item.truncated':
        this.emit(
          'conversation.item.truncated',
          event.item_id,
          event.audio_end_ms,
        )
        break

      case 'input_audio_buffer.committed':
        this.emit('input_audio_buffer.committed', event.item_id)
        break

      case 'input_audio_buffer.cleared':
        this.emit('input_audio_buffer.cleared')
        break

      case 'input_audio_buffer.speech_started':
        this.emit('input_audio_buffer.speech_started', event.audio_start_ms)
        break

      case 'input_audio_buffer.speech_stopped':
        this.emit('input_audio_buffer.speech_stopped', event.audio_end_ms)
        break

      case 'response.created':
        this.emit('response.created', event.response)
        break

      case 'response.done':
        this.emit('response.done', event.response)
        break

      case 'response.output_item.added':
        this.emit('response.output_item.added', event.item)
        break

      case 'response.output_item.done':
        this.emit('response.output_item.done', event.item)
        break

      case 'response.content_part.added':
        this.emit('response.content_part.added', event.part)
        break

      case 'response.content_part.done':
        this.emit('response.content_part.done', event.part)
        break

      case 'response.text.delta':
        this.emit('response.text.delta', event.delta)
        break

      case 'response.text.done':
        this.emit('response.text.done', event.text)
        break

      case 'response.audio_transcript.delta':
        this.emit('response.audio_transcript.delta', event.delta)
        break

      case 'response.audio_transcript.done':
        this.emit('response.audio_transcript.done', event.transcript)
        break

      case 'response.audio.delta':
        this.emit('response.audio.delta', event.delta)
        break

      case 'response.audio.done':
        this.emit('response.audio.done')
        break

      case 'response.function_call_arguments.delta':
        this.emit('response.function_call_arguments.delta', event.delta)
        break

      case 'response.function_call_arguments.done':
        this.emit('response.function_call_arguments.done', event.arguments)
        break

      case 'rate_limits.updated':
        this.emit('rate_limits.updated', event.rate_limits)
        break
    }
  }

  updateSession(config: SessionConfig): void {
    this.sessionConfig = { ...this.sessionConfig, ...config }
    this.sendEvent({
      type: 'session.update',
      session: config,
    })
  }

  sendUserMessageContent(
    content: Array<{ type: string; text?: string; audio?: string }>,
  ): void {
    this.sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content,
      },
    })
  }

  appendInputAudio(audioBase64: string): void {
    this.sendEvent({
      type: 'input_audio_buffer.append',
      audio: audioBase64,
    })
  }

  commitInputAudio(): void {
    this.sendEvent({
      type: 'input_audio_buffer.commit',
    })
  }

  clearInputAudio(): void {
    this.sendEvent({
      type: 'input_audio_buffer.clear',
    })
  }

  createResponse(): void {
    this.sendEvent({
      type: 'response.create',
    })
  }

  cancelResponse(): void {
    this.sendEvent({
      type: 'response.cancel',
    })
  }

  submitToolOutput(callId: string, output: string): void {
    this.sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output,
      },
    })
  }

  deleteConversationItem(itemId: string): void {
    this.sendEvent({
      type: 'conversation.item.delete',
      item_id: itemId,
    })
  }

  truncateConversationItem(
    itemId: string,
    contentIndex: number,
    audioEndMs: number,
  ): void {
    this.sendEvent({
      type: 'conversation.item.truncate',
      item_id: itemId,
      content_index: contentIndex,
      audio_end_ms: audioEndMs,
    })
  }

  private generateEventId(): string {
    return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN
  }

  waitForSessionCreated(): Promise<any> {
    return new Promise((resolve) => {
      this.once('session.created', resolve)
    })
  }
}

export const createRealtimeClient = (
  config?: RealtimeConfig,
): RealtimeClient => {
  return new RealtimeClient(config)
}
