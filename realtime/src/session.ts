// RealtimeSession owns the socket and the event log. All decisions (tool loop,
// barge-in, resume) are derived from the log with the pure functions in reducer.ts.

import * as errore from 'errore'
import { resample, silence, toMono } from './audio.ts'
import { deriveHistory, deriveView, type View } from './reducer.ts'
import type { Adapter, Command, Decoded, OutputAudio, RealtimeEvent, SessionConfig, ToolDefinition } from './types.ts'

export class ConnectError extends errore.createTaggedError({
  name: 'ConnectError',
  message: 'Could not start the $provider realtime session: $reason',
}) {}

export class ToolError extends errore.createTaggedError({
  name: 'ToolError',
  message: 'Tool $tool threw',
}) {}

export class NotConnectedError extends errore.createTaggedError({
  name: 'NotConnectedError',
  message: 'Realtime session is not connected. Call connect() first.',
}) {}

export type Tool = Omit<ToolDefinition, 'name'> & {
  /** Receives the parsed JSON arguments. The return value is sent back as JSON. */
  execute(args: unknown): unknown
}

/** Plays model audio. `stop()` returns the ms of the current reply already heard, or null when idle. */
export type AudioSink = {
  play(audio: OutputAudio): void
  stop(): number | null
}

/** Everything needed to resume later. Plain JSON: store it anywhere. */
export type RealtimeSnapshot = { version: 1; events: RealtimeEvent[] }

export type SessionOptions = Omit<SessionConfig, 'tools'> & {
  model: Adapter
  tools?: Record<string, Tool>
  output?: AudioSink
  /** Raw provider messages in both directions, for debugging and fixtures. */
  onWire?: (message: { direction: 'in' | 'out'; data: unknown }) => void
  connectTimeoutMs?: number
}

type Listener = (event: Decoded) => void

export class RealtimeSession {
  readonly model: Adapter
  #options: SessionOptions
  #events: RealtimeEvent[] = []
  #listeners = new Set<Listener>()
  #socket: WebSocket | null = null

  constructor(options: SessionOptions) {
    this.model = options.model
    this.#options = options
  }

  get events(): readonly RealtimeEvent[] {
    return this.#events
  }

  view(): View {
    return deriveView(this.#events)
  }

  snapshot(): RealtimeSnapshot {
    return { version: 1, events: [...this.#events] }
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * Opens the socket. With `resume`, it first tries the provider's server-side resume
   * (Gemini handle, xAI conversation id); if that fails it seeds the stored history.
   */
  async connect({ resume }: { resume?: RealtimeSnapshot } = {}): Promise<ConnectError | void> {
    if (this.#socket) return new ConnectError({ provider: this.model.provider, reason: 'already connected' })
    if (resume) this.#events = [...resume.events]
    const handle = this.#resumeHandle()
    const start = this.#events.length
    const first = await this.#open(handle)
    if (!(first instanceof Error) || handle === null) return first
    // close() during the attempt is not a resume failure; do not open a second socket.
    if (this.#events.some((e, i) => i >= start && e.type === 'close.requested')) return first
    this.#append({ type: 'error', message: `Server resume failed, seeding history: ${first.message}`, code: null })
    return this.#open(null)
  }

  async close(): Promise<void> {
    const socket = this.#socket
    if (!socket) return
    this.#append({ type: 'close.requested' })
    this.#options.output?.stop()
    const closed = new Promise<void>((resolve) => socket.addEventListener('close', () => resolve(), { once: true }))
    socket.close(1000)
    await closed
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }

  /** Send microphone PCM16 in any rate and channel count. */
  appendAudio(pcm: Int16Array, { rate, channels = 1 }: { rate: number; channels?: number }) {
    const mono = resample(toMono(pcm, channels), rate, this.model.inputRate)
    return this.#send({ type: 'audio', pcm: mono })
  }

  /**
   * The speaker paused, e.g. Discord stopped sending packets. Server VAD only ends a turn
   * after hearing silence, so send a bit more than the configured silence. OpenAI does not
   * bill silence with VAD on; on Gemini it is a few hundred ms of audio tokens per turn.
   */
  endOfSpeech() {
    const turns = this.#options.turns ?? { mode: 'server' }
    if (turns.mode === 'manual') return
    const silenceMs = (turns.mode === 'server' ? (turns.silenceMs ?? 500) : 500) + 200
    const sent = this.#send({ type: 'audio', pcm: silence({ ms: silenceMs, rate: this.model.inputRate }) })
    if (sent instanceof Error) return sent
    return this.#send({ type: 'audio.end' })
  }

  /** Push-to-talk press. Cancels a running reply. */
  startTurn() {
    const interrupted = this.interrupt()
    if (interrupted instanceof Error) return interrupted
    return this.#send({ type: 'turn.start' })
  }

  /** Push-to-talk release. */
  endTurn() {
    return this.#send({ type: 'turn.end' })
  }

  sendText(text: string, { respond = true }: { respond?: boolean } = {}) {
    const sent = this.#send({ type: 'text', text, respond })
    if (sent instanceof Error) return sent
    this.#append({ type: 'user.text', text })
  }

  /** Stop playback, cancel the reply if one is generating, and cut unheard audio out of the context. */
  interrupt() {
    if (!this.#socket) return new NotConnectedError()
    const view = this.view()
    this.#stopPlayback(view)
    if (!view.responding) return
    return this.#send({ type: 'response.cancel' })
  }

  #resumeHandle(): string | null {
    const lastStart = this.#events.findLast((e) => e.type === 'session.started')
    if (lastStart?.type !== 'session.started') return null
    if (lastStart.provider !== this.model.provider || lastStart.model !== this.model.model) return null
    return deriveView(this.#events).resumeHandle
  }

  async #open(resumeHandle: string | null): Promise<ConnectError | void> {
    const { model } = this
    const tools = Object.entries(this.#options.tools ?? {}).map(([name, tool]) => ({
      name,
      description: tool.description,
      parameters: tool.parameters,
    }))
    const history = resumeHandle === null ? deriveHistory(this.#events) : []
    const setup = model.setup({ ...this.#options, tools, resumeHandle, seeding: history.length > 0 })
    if (setup instanceof Error) return new ConnectError({ provider: model.provider, reason: setup.message, cause: setup })

    const { url, protocols, headers } = model.connect({ resumeHandle })
    // Node (undici) accepts headers in an init object; browsers only accept protocols.
    const socket = headers ? new WebSocket(url, { protocols, headers }) : new WebSocket(url, protocols)
    socket.binaryType = 'arraybuffer'
    this.#socket = socket
    // Handlers of a replaced or failed socket must not touch the log.
    const owned = () => this.#socket === socket

    return new Promise<ConnectError | void>((resolve) => {
      let settled = false
      const finish = (result: ConnectError | void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (result instanceof Error) this.#detach({ socket, reason: 'connect failed' })
        resolve(result)
      }
      const fail = (reason: string) => finish(new ConnectError({ provider: model.provider, reason }))
      const timer = setTimeout(() => fail('timed out waiting for the session to start'), this.#options.connectTimeoutMs ?? 15_000)

      socket.addEventListener('open', () => {
        if (owned()) for (const data of setup) this.#write(socket, data)
      })
      socket.addEventListener('message', (message: MessageEvent) => {
        if (!owned()) return
        const text = typeof message.data === 'string' ? message.data : new TextDecoder().decode(message.data as ArrayBuffer)
        const data = errore.try(() => ({ value: JSON.parse(text) as unknown }))
        if (data instanceof Error) return this.#append({ type: 'error', message: `Invalid JSON from server: ${text.slice(0, 200)}`, code: null })
        this.#options.onWire?.({ direction: 'in', data: data.value })
        for (const event of model.decode(data.value)) {
          if (!owned()) return
          this.#receive({ event, socket })
          if (settled) continue
          if (event.type === 'error') return fail(event.message)
          if (event.type !== 'session.started') continue
          // History goes in only after the provider accepted the setup.
          for (const item of model.seed(history)) this.#write(socket, item)
          finish()
        }
      })
      socket.addEventListener('close', (event: CloseEvent) => {
        if (!owned()) return
        this.#socket = null
        this.#options.output?.stop()
        this.#append({ type: 'session.closed', code: event.code, reason: event.reason })
        fail(`socket closed (${event.code}) ${event.reason}`)
      })
    })
  }

  /** Stop owning a socket: log the close now, so late callbacks of the old socket are ignored. */
  #detach({ socket, reason }: { socket: WebSocket; reason: string }) {
    if (this.#socket === socket) {
      this.#socket = null
      this.#append({ type: 'session.closed', code: 1000, reason })
    }
    socket.close(1000)
  }

  #write(socket: WebSocket, data: unknown) {
    this.#options.onWire?.({ direction: 'out', data })
    socket.send(JSON.stringify(data))
  }

  #send(command: Command): NotConnectedError | void {
    const socket = this.#socket
    if (!socket || socket.readyState !== socket.OPEN) return new NotConnectedError()
    for (const data of this.model.encode(command)) this.#write(socket, data)
  }

  /** For sends caused by server events. Returns false and logs when the socket is gone. */
  #sendInBackground(command: Command): boolean {
    const sent = this.#send(command)
    if (!(sent instanceof Error)) return true
    this.#append({ type: 'error', message: `Could not send ${command.type}: ${sent.message}`, code: null })
    return false
  }

  #append(event: RealtimeEvent) {
    this.#events.push(event)
    this.#emit(event)
  }

  #emit(event: Decoded) {
    for (const listener of this.#listeners) listener(event)
  }

  #receive({ event, socket }: { event: Decoded; socket: WebSocket }) {
    if (event.type === 'output.audio') {
      this.#options.output?.play(event)
      return this.#emit(event)
    }
    this.#append(event)
    const turns = this.#options.turns ?? { mode: 'server' }
    const bargeIn = event.type === 'interrupted' || (event.type === 'speech.started' && !(turns.mode === 'server' && turns.interrupt === false))
    if (bargeIn) this.#stopPlayback(this.view())
    if (event.type === 'tool.call') void this.#runTool({ call: event, socket })
    if (event.type === 'response.done') this.#maybeRespond()
    if (event.type === 'go.away') {
      // Hard deadline: reconnect just before the server drops the socket, even mid-turn.
      setTimeout(() => void this.#reconnect(socket), Math.max(0, event.timeLeftMs - 1000))
    }
    if (event.type === 'go.away' || event.type === 'resume.handle' || event.type === 'response.done') {
      if (this.#canMoveAfterGoAway()) void this.#reconnect(socket)
    }
  }

  /** Gemini sent goAway and the session is at a resumable point: no reply or tool call running. */
  #canMoveAfterGoAway(): boolean {
    const lastStart = this.#events.findLastIndex((e) => e.type === 'session.started')
    if (!this.#events.some((e, i) => i > lastStart && e.type === 'go.away')) return false
    const view = this.view()
    return view.resumeHandle !== null && !view.responding && view.pendingToolCalls.length === 0
  }

  /** Stop local playback and tell OpenAI/xAI how much of the reply the user heard. */
  #stopPlayback(view: View) {
    const playedMs = this.#options.output?.stop() ?? null
    if (playedMs === null || view.outputItemId === null || !this.model.needsResponseCreate) return
    this.#sendInBackground({ type: 'truncate', itemId: view.outputItemId, playedMs })
  }

  async #runTool({ call, socket }: { call: Extract<RealtimeEvent, { type: 'tool.call' }>; socket: WebSocket }) {
    const tool = this.#options.tools?.[call.name]
    const args = errore.try(() => ({ value: JSON.parse(call.args) as unknown }))
    const result = await (async () => {
      if (!tool) return { error: `Unknown tool ${call.name}` }
      if (args instanceof Error) return { error: `Invalid JSON arguments: ${call.args}` }
      const value = await Promise.resolve()
        .then(() => tool.execute(args.value))
        .catch((e) => new ToolError({ tool: call.name, cause: e }))
      if (value instanceof ToolError) return { error: value.cause instanceof Error ? value.cause.message : String(value.cause) }
      if (value instanceof Error) return { error: value.message }
      return value ?? null
    })()
    // The call belongs to a connection that is gone, or it was cancelled meanwhile.
    if (this.#socket !== socket || !this.view().pendingToolCalls.includes(call.callId)) return
    const serialized = errore.try(() => JSON.stringify(result) ?? 'null', (e) => new ToolError({ tool: call.name, cause: e }))
    const output = serialized instanceof Error ? JSON.stringify({ error: `Tool result is not JSON: ${serialized.cause}` }) : serialized
    if (!this.#sendInBackground({ type: 'tool.result', callId: call.callId, name: call.name, output })) return
    this.#append({ type: 'tool.result', callId: call.callId, name: call.name, output })
    this.#maybeRespond()
  }

  #maybeRespond() {
    if (!this.model.needsResponseCreate || !this.view().needsResponse) return
    if (this.#sendInBackground({ type: 'response.create' })) this.#append({ type: 'response.requested' })
  }

  async #reconnect(socket: WebSocket) {
    // Only once per socket: the deadline timer and the safe-point check can both fire.
    if (this.#socket !== socket) return
    this.#detach({ socket, reason: 'go away' })
    const result = await this.connect()
    if (result instanceof Error) this.#append({ type: 'error', message: result.message, code: 'reconnect_failed' })
  }
}
