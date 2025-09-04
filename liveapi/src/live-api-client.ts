import {
  CallableTool,
  FunctionCall,
  GoogleGenAI,
  LiveCallbacks,
  LiveConnectConfig,
  LiveServerMessage,
  MediaResolution,
  Part,
  Session,
  SessionResumptionConfig,
  LiveServerSessionResumptionUpdate,
} from '@google/genai'

import { LiveClientOptions } from './types.js'
import { AudioRecorder } from './audio-recorder.js'
import { AudioStreamer } from './audio-streamer.js'
import { audioContext, base64ToArrayBuffer } from './utils.js'
import VolMeterWorket from './worklets/vol-meter.js'

export interface LiveAPIState {
  connected: boolean
  muted: boolean
  inVolume: number
  outVolume: number
  logs: string[]
  config: LiveConnectConfig
}

export interface LiveAPIClientOptions extends LiveClientOptions {
  model?: string
  onUserAudioChunk?: (chunk: ArrayBuffer) => void
  onStateChange?: (state: LiveAPIState) => void
  onMessage?: (message: LiveServerMessage) => void
  enableGoogleSearch?: boolean
  recordingSampleRate?: number
  config?: Partial<LiveConnectConfig> & {
    tools?: Array<CallableTool & { name: string }>
  }
  /** Enable automatic reconnection when connection is lost unexpectedly (default: true) */
  autoReconnect?: boolean
  /** Maximum number of reconnection attempts (default: 5) */
  maxReconnectAttempts?: number
}

export class LiveAPIClient {
  private client: GoogleGenAI
  public session: Session | null = null
  private audioStreamer: AudioStreamer | null = null
  private audioRecorder: AudioRecorder | null = null
  private model: string
  private onStateChange?: (state: LiveAPIState) => void
  private onMessage?: (message: LiveServerMessage) => void

  private state: LiveAPIState = {
    connected: false,
    muted: false,
    inVolume: 0,
    outVolume: 0,
    logs: [],
    config: {
      inputAudioTranscription: {}, // transcribes your input speech
      outputAudioTranscription: {}, // transcribes the model's spoken audio
      mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
      contextWindowCompression: {
        triggerTokens: '25600',
        slidingWindow: { targetTokens: '12800' },
      },
    },
  }

  private onUserAudioChunk?: (chunk: ArrayBuffer) => void

  private tools: Array<CallableTool & { name: string }> = []

  public sessionHandle: string | null = null
  private isExplicitDisconnect: boolean = false
  private reconnectAttempts: number = 0
  public readonly maxReconnectAttempts: number
  private reconnectTimeout: NodeJS.Timeout | null = null
  public readonly autoReconnect: boolean

  constructor(options: LiveAPIClientOptions) {
    const {
      model,
      onStateChange,
      onMessage,
      onUserAudioChunk,
      apiKey,
      enableGoogleSearch,
      recordingSampleRate = 16000,
      config,
      autoReconnect = true,
      maxReconnectAttempts = 5,
    } = options

    if (!apiKey) {
      throw new Error('API key is required')
    }

    this.client = new GoogleGenAI({ apiKey })
    this.model = model || 'models/gemini-2.0-flash-exp'
    this.onStateChange = onStateChange
    this.onMessage = onMessage
    this.onUserAudioChunk = onUserAudioChunk
    this.autoReconnect = autoReconnect
    this.maxReconnectAttempts = maxReconnectAttempts

    this.tools = config?.tools || []
    if (enableGoogleSearch) {
      this.tools.push({ googleSearch: {} } as any)
    }

    // Merge provided config with defaults
    if (config) {
      this.state.config = { ...this.state.config, ...config }
    }

    // Enable session resumption by default for transparent reconnection when auto-reconnect is enabled
    if (this.autoReconnect && !this.state.config.sessionResumption) {
      this.state.config.sessionResumption = {
        transparent: true,
      }
    }

    this.audioRecorder = new AudioRecorder(recordingSampleRate)
    this.setupAudioRecorder()
  }

  // Method to update state and notify listeners
  private updateState(updates: Partial<LiveAPIState>) {
    this.state = { ...this.state, ...updates }
    this.onStateChange?.(this.state)
  }

  // Get a copy of the current state
  public getState(): LiveAPIState {
    return { ...this.state }
  }

  private async initAudioStreamer() {
    if (!this.audioStreamer) {
      const audioCtx = await audioContext({ id: 'audio-out' })
      this.audioStreamer = new AudioStreamer(audioCtx)
      await this.audioStreamer.addWorklet<any>(
        'vumeter-out',
        VolMeterWorket,
        (ev: any) => {
          this.updateState({ outVolume: ev.data.volume })
        },
      )
    }
  }

  private setupAudioRecorder() {
    if (!this.audioRecorder) return
    this.audioRecorder.on('data', (arrayBuffer: ArrayBuffer) => {
      if (this.state.connected && !this.state.muted) {
        // Convert to base64 for sending to API
        const binary = String.fromCharCode(...new Uint8Array(arrayBuffer))
        const base64 = btoa(binary)

        this.sendRealtimeInput([
          {
            mimeType: 'audio/pcm;rate=16000',
            data: base64,
          },
        ])

        // Call the callback with the audio chunk (already at 16k)
        if (this.onUserAudioChunk) {
          this.onUserAudioChunk(arrayBuffer.slice(0))
        }
      }
    })

    this.audioRecorder.on('volume', (volume: number) => {
      this.updateState({ inVolume: volume })
    })
  }

  private log(message: string) {
    console.log(message)
    const newEvents = [...this.state.logs, message]

    if (newEvents.length > 200) {
      this.updateState({ logs: newEvents.slice(-150) })
    } else {
      this.updateState({ logs: newEvents })
    }
  }

  async connect(): Promise<boolean> {
    if (this.state.connected) {
      return false
    }

    // Clear reconnect state when manually connecting
    this.isExplicitDisconnect = false
    this.reconnectAttempts = 0
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }

    await this.initAudioStreamer()

    const callbacks: LiveCallbacks = {
      onopen: this.onOpen.bind(this),
      onmessage: this.handleMessage.bind(this),
      onerror: this.onError.bind(this),
      onclose: this.onClose.bind(this),
    }

    // Prepare config with session resumption if we have a handle
    const connectConfig = { ...this.state.config }
    if (this.sessionHandle && connectConfig.sessionResumption) {
      connectConfig.sessionResumption = {
        ...connectConfig.sessionResumption,
        handle: this.sessionHandle,
      }
      this.log('connect: Attempting to resume session with handle')
    }

    try {
      this.session = await this.client.live.connect({
        model: this.model,
        config: connectConfig,
        callbacks,
      })
    } catch (e) {
      console.error('Error connecting to GenAI Live:', e)
      this.log(
        'error: ' + JSON.stringify({ message: 'Failed to connect', error: e }),
      )
      return false
    }

    return true
  }

  disconnect() {
    if (!this.session) {
      return false
    }

    // Mark this as an explicit disconnect to prevent auto-reconnect
    this.isExplicitDisconnect = true

    // Clear reconnect timeout if any
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }

    this.session?.close()
    this.session = null
    this.setConnected(false)

    this.audioRecorder?.stop()
    this.audioStreamer?.stop()

    // Clear session handle on explicit disconnect
    this.sessionHandle = null
    this.reconnectAttempts = 0

    this.log('close: ' + JSON.stringify({ reason: 'User disconnected' }))
    return true
  }

  private setConnected(value: boolean) {
    this.updateState({ connected: value })

    if (value && !this.state.muted) {
      this.audioRecorder?.start()
    } else {
      this.audioRecorder?.stop()
    }
  }

  private onOpen() {
    this.setConnected(true)
    this.log('open')
  }

  private onError(e: ErrorEvent) {
    this.log('error: ' + JSON.stringify({ message: e.message, error: e }))
  }

  private async onClose(e: CloseEvent) {
    this.setConnected(false)
    this.log('close: ' + JSON.stringify({ reason: e.reason, code: e.code }))

    // Attempt to reconnect if auto-reconnect is enabled, this wasn't an explicit disconnect,
    // and we have a session handle to resume
    if (
      this.autoReconnect &&
      !this.isExplicitDisconnect &&
      this.sessionHandle
    ) {
      await this.attemptReconnect()
    }
  }

  private async attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.log('error: Max reconnection attempts reached, giving up')
      this.sessionHandle = null
      this.reconnectAttempts = 0
      return
    }

    this.reconnectAttempts++
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts - 1),
      10000,
    ) // Exponential backoff with max 10s

    this.log(
      `reconnect: Attempting reconnection ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`,
    )

    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null

      try {
        const success = await this.connect()
        if (success) {
          this.log('reconnect: Successfully reconnected to session')
          this.reconnectAttempts = 0
        } else {
          // Connect failed, will trigger another reconnect attempt via onClose
          this.log('reconnect: Failed to reconnect, will retry')
        }
      } catch (error) {
        this.log(
          'reconnect: Error during reconnection: ' + JSON.stringify(error),
        )
        // Will trigger another attempt via onClose if we still have attempts left
      }
    }, delay)
  }

  private async handleMessage(message: LiveServerMessage) {
    // Clone the message to avoid reference issues
    const clonedMessage = JSON.parse(JSON.stringify(message))

    // Call the external callback if provided
    this.onMessage?.(clonedMessage)

    if (message.setupComplete) {
      this.log('setupcomplete')
      return
    }

    // Handle session resumption updates
    if (message.sessionResumptionUpdate) {
      const update = message.sessionResumptionUpdate
      if (update.resumable && update.newHandle) {
        this.sessionHandle = update.newHandle
        this.log(
          'sessionResumption: Updated handle for resumption ' +
            update.newHandle,
        )
      } else if (!update.resumable) {
        // Session is not resumable at this point
        this.sessionHandle = null
        this.log('sessionResumption: Session not resumable at this point')
      }
      return
    }

    // Handle GoAway message - server will disconnect soon
    if (message.goAway) {
      this.log('goAway: Server will disconnect, preparing for reconnection')
      // The server will close the connection, which will trigger onClose
      // and our automatic reconnection logic if we have a session handle
      return
    }

    if (message.toolCall) {
      this.log('toolcall: ' + JSON.stringify(message.toolCall))

      // Handle tool calls
      if (message.toolCall.functionCalls) {
        await this.handleToolCalls(message.toolCall.functionCalls)
      }
      return
    }

    if (message.toolCallCancellation) {
      this.log(
        'toolcallcancellation: ' + JSON.stringify(message.toolCallCancellation),
      )
      return
    }

    if (message.serverContent) {
      const { serverContent } = message

      if (serverContent.interrupted) {
        this.log('interrupted')
        this.audioStreamer?.stop()
        return
      }

      if (serverContent.turnComplete) {
        this.log('turncomplete')
      }

      if (serverContent.modelTurn) {
        let parts: Part[] = serverContent.modelTurn?.parts || []

        const [audioParts, otherParts] = partition(
          parts,

          (p) => p.inlineData && p.inlineData.mimeType?.startsWith('audio/pcm'),
        )
        const base64s = audioParts.map((p) => p.inlineData?.data)

        base64s.forEach((b64) => {
          if (b64) {
            const data = base64ToArrayBuffer(b64)
            this.audioStreamer?.addPCM16(new Uint8Array(data))
            // this.log(
            //   'audio: ' + JSON.stringify({ byteLength: data.byteLength }),
            // )
          }
        })

        if (otherParts.length) {
          this.log(
            'content: ' + JSON.stringify({ modelTurn: { parts: otherParts } }),
          )
          // Log python executable code in a readable way
          otherParts.forEach((part) => {
            if (
              part.executableCode &&
              part.executableCode.language === 'PYTHON' &&
              part.executableCode.code
            ) {
              // Only pretty-print if python with code string
              const preview = part.executableCode.code

              this.log('python executableCode:\n' + preview)
            }
          })
        }
      }
    }
  }

  setMuted(muted: boolean) {
    this.updateState({ muted })
    if (this.state.connected) {
      if (muted) {
        this.audioRecorder?.stop()
      } else {
        this.audioRecorder?.start()
      }
    }
  }

  sendText(text: string, turnComplete: boolean = true) {
    if (!this.session) return

    const parts: Part[] = [{ text }]
    this.session.sendClientContent({ turns: parts, turnComplete })
    this.log('client-send: ' + JSON.stringify({ turns: parts, turnComplete }))
  }

  sendRealtimeInput(chunks: Array<{ mimeType: string; data: string }>) {
    if (!this.session) return

    let hasAudio = false
    let hasVideo = false

    for (const ch of chunks) {
      this.session.sendRealtimeInput({ media: ch })
      if (ch.mimeType.includes('audio')) {
        hasAudio = true
      }
      if (ch.mimeType.includes('image')) {
        hasVideo = true
      }
    }

    const mediaType = (() => {
      if (hasAudio && hasVideo) return 'audio+video'
      if (hasAudio) return 'audio'
      if (hasVideo) return 'video'
      return 'unknown'
    })()
    // this.log('client-realtimeInput: ' + JSON.stringify({ mediaType }))
  }

  private async handleToolCalls(functionCalls: FunctionCall[]) {
    if (!this.session) {
      console.log('No session active in handleToolCalls')
      return
    }
    if (!this.tools.length) {
      console.log('No tools registered in handleToolCalls')
      return
    }

    try {
      for (const tool of this.tools) {
        if (!functionCalls.some((x) => x.name === tool.name)) {
          console.log(`no tool found for ${functionCalls.map((x) => x.name)}`)
          continue
        }
        const parts = await tool.callTool(functionCalls)

        const functionResponses = parts
          .filter((part) => part.functionResponse)
          .map((part) => ({
            response: part.functionResponse!.response as Record<
              string,
              unknown
            >,
            id: part.functionResponse!.id,
            name: part.functionResponse!.name,
          }))

        if (functionResponses.length > 0) {
          this.session.sendToolResponse({ functionResponses })
          this.log(
            'client-toolResponse: ' + JSON.stringify({ functionResponses }),
          )
        } else {
          console.log(`no tool call response!`)
        }
      }
    } catch (error) {
      console.error('Error handling tool calls:', error)
      this.log(
        'error: ' + JSON.stringify({ message: 'Tool call failed', error }),
      )
    }
  }

  public sendToolResponse(response: {
    functionResponses: Array<{
      response: { output: any; error?: string }
      id: string
      name: string
    }>
  }) {
    if (!this.session) {
      console.error('Cannot send tool response: session not connected')
      return
    }
    this.session.sendToolResponse(response)
    this.log('client-toolResponse: ' + JSON.stringify(response))
  }

  setConfig(config: LiveConnectConfig) {
    if (config.tools) {
      this.tools = config.tools as any
    }
    this.updateState({ config })
  }

  getConfig() {
    return { ...this.state.config }
  }

  destroy() {
    this.isExplicitDisconnect = true
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
    this.disconnect()
    this.audioRecorder?.stop()
    this.audioStreamer?.stop()
    this.tools = []
    this.sessionHandle = null
    this.reconnectAttempts = 0
  }
}

function partition<T>(
  arr: T[],
  predicate: (item: T, index: number, array: T[]) => boolean | undefined,
): [T[], T[]] {
  const truthy: T[] = []
  const falsy: T[] = []
  arr.forEach((item, index) => {
    if (predicate(item, index, arr)) {
      truthy.push(item)
    } else {
      falsy.push(item)
    }
  })
  return [truthy, falsy]
}
