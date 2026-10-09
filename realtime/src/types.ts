// Shared types: the event log, session config, adapter contract and history.
// The event log only holds small text events. Audio never enters it.

export type Provider = 'openai' | 'gemini' | 'xai'

export type Usage = {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  inputAudioTokens: number
  outputAudioTokens: number
  /** Billed audio time, for providers that charge per minute (xAI). */
  billedSeconds: number
}

export type ResponseStatus = 'completed' | 'cancelled' | 'incomplete' | 'failed'

/** One entry of the session log. Server events come from adapters, client events from the session. */
export type RealtimeEvent =
  // server
  | { type: 'session.started'; provider: Provider; model: string; sessionId: string | null }
  | { type: 'session.closed'; code: number; reason: string }
  | { type: 'speech.started' }
  | { type: 'speech.stopped' }
  | { type: 'input.committed'; itemId: string }
  | { type: 'input.text'; text: string; itemId: string | null; final: boolean }
  | { type: 'response.started'; responseId: string | null }
  /** OpenAI/xAI assistant item that will carry audio; its id is the target of a truncate. */
  | { type: 'output.item'; itemId: string }
  | { type: 'output.text'; text: string; itemId: string | null }
  /** The server cut unheard audio from a reply. `text` is the heard transcript when the provider sends it (xAI). */
  | { type: 'output.truncated'; itemId: string; text: string | null }
  | { type: 'tool.call'; callId: string; name: string; args: string }
  /** A server-side tool the provider ran by itself, e.g. Gemini Google Search. Informational: no result is sent. */
  | { type: 'tool.builtin'; name: string; args: string }
  | { type: 'tools.cancelled'; callIds: string[] }
  | { type: 'response.done'; status: ResponseStatus }
  | { type: 'usage'; usage: Usage }
  | { type: 'interrupted' }
  /** `null` means the previous handle is no longer safe to resume from. */
  | { type: 'resume.handle'; handle: string | null }
  | { type: 'go.away'; timeLeftMs: number }
  | { type: 'error'; message: string; code: string | null }
  // client
  | { type: 'history.seeded'; items: HistoryItem[] }
  | { type: 'user.text'; text: string }
  | { type: 'tool.result'; callId: string; name: string; output: string }
  | { type: 'response.requested' }
  | { type: 'close.requested' }

/** Model audio. Emitted to subscribers, never stored in the log. */
export type OutputAudio = { type: 'output.audio'; pcm: Int16Array; rate: number; itemId: string | null }

export type HistoryItem =
  | { role: 'summary'; text: string }
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string }
  | { role: 'tool'; callId: string; name: string; args: string; output: string }

export type TurnDetection =
  | {
      mode: 'server'
      /** Silence that ends a turn. Default 500. */
      silenceMs?: number
      prefixMs?: number
      sensitivity?: 'low' | 'high'
      /** User speech cancels the model reply. Default true. */
      interrupt?: boolean
    }
  /** OpenAI only. */
  | { mode: 'semantic'; eagerness?: 'low' | 'medium' | 'high' | 'auto' }
  /** Push-to-talk: call startTurn() and endTurn(). */
  | { mode: 'manual' }

export type ToolDefinition = {
  name: string
  description?: string
  /** JSON Schema of the arguments object. */
  parameters: Record<string, unknown>
}

export type SessionConfig = {
  instructions?: string
  voice?: string
  turns?: TurnDetection
  /** Input and output transcripts. Needed to rebuild history for resume. Default true. */
  transcribe?: boolean
  maxOutputTokens?: number
  tools?: ToolDefinition[]
}

export type SetupInput = SessionConfig & { resumeHandle: string | null; seeding: boolean }

export type Command =
  | { type: 'audio'; pcm: Int16Array }
  /** Sent after trailing silence when the speaker pauses. */
  | { type: 'audio.end' }
  | { type: 'turn.start' }
  | { type: 'turn.end' }
  /** `respond: false` only adds context; the model answers at its next turn. */
  | { type: 'text'; text: string; respond: boolean }
  | { type: 'tool.result'; callId: string; name: string; output: string }
  | { type: 'response.create' }
  | { type: 'response.cancel' }
  | { type: 'truncate'; itemId: string; playedMs: number }

export type Decoded = RealtimeEvent | OutputAudio

/** Provider protocol. Pure functions, no state, so recorded wire messages replay in tests. */
export type Adapter = {
  provider: Provider
  model: string
  /** PCM16 mono rate the provider receives. */
  inputRate: number
  /** PCM16 mono rate the provider sends. */
  outputRate: number
  /** OpenAI and xAI need response.create after tool outputs; Gemini continues on its own. */
  needsResponseCreate: boolean
  connect(input: { resumeHandle: string | null }): {
    url: string
    protocols?: string[]
    headers?: Record<string, string>
  }
  /** Messages sent when the socket opens. */
  setup(input: SetupInput): Error | unknown[]
  /** History messages, sent after the provider confirmed the setup. */
  seed(history: HistoryItem[]): unknown[]
  encode(command: Command): unknown[]
  decode(message: unknown): Decoded[]
}
