// Gemini Live adapter. Gemini messages carry no response or item ids, so the
// decoder emits text fragments without ids and the reducer groups them by order.
// Docs: https://ai.google.dev/api/live, https://ai.google.dev/gemini-api/docs/live-guide

import * as errore from 'errore'
import { base64ToPcm, pcmToBase64 } from './audio.ts'
import { UnsupportedOptionError } from './openai.ts'
import type { Adapter, Command, Decoded, HistoryItem, SetupInput } from './types.ts'

const INPUT_RATE = 16000
const OUTPUT_RATE = 24000

type Wire = {
  setupComplete?: unknown
  voiceActivity?: { type?: 'ACTIVITY_START' | 'ACTIVITY_END' }
  serverContent?: {
    interrupted?: boolean
    turnComplete?: boolean
    modelTurn?: { parts?: Array<{ text?: string; thought?: boolean; inlineData?: { data?: string } }> }
    inputTranscription?: { text?: string; finished?: boolean }
    outputTranscription?: { text?: string }
    groundingMetadata?: { webSearchQueries?: string[] }
  }
  toolCall?: { functionCalls?: Array<{ id?: string; name?: string; args?: unknown }> }
  toolCallCancellation?: { ids?: string[] }
  goAway?: { timeLeft?: string }
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean }
  usageMetadata?: {
    promptTokenCount?: number
    cachedContentTokenCount?: number
    responseTokenCount?: number
    promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }>
    responseTokensDetails?: Array<{ modality?: string; tokenCount?: number }>
  }
  error?: { message?: string; code?: number }
}

function audioTokens(details: Array<{ modality?: string; tokenCount?: number }> | undefined): number {
  return (details ?? []).reduce((sum, d) => (d.modality === 'AUDIO' ? sum + (d.tokenCount ?? 0) : sum), 0)
}

/** Parses protobuf durations like "10s" or "1.5s". */
function durationMs(value: string | undefined): number {
  const seconds = Number.parseFloat(value ?? '')
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0
}

function decode({ message, model }: { message: unknown; model: string }): Decoded[] {
  const wire = message as Wire
  const out: Decoded[] = []
  if (wire.setupComplete !== undefined) out.push({ type: 'session.started', provider: 'gemini', model, sessionId: null })
  if (wire.voiceActivity?.type === 'ACTIVITY_START') out.push({ type: 'speech.started' })
  if (wire.voiceActivity?.type === 'ACTIVITY_END') out.push({ type: 'speech.stopped' })
  const content = wire.serverContent
  if (content?.interrupted) out.push({ type: 'interrupted' })
  if (content?.inputTranscription?.text || content?.inputTranscription?.finished) {
    out.push({
      type: 'input.text',
      text: content.inputTranscription.text ?? '',
      itemId: null,
      final: content.inputTranscription.finished === true,
    })
  }
  for (const part of content?.modelTurn?.parts ?? []) {
    if (part.inlineData?.data) {
      out.push({ type: 'output.audio', pcm: base64ToPcm(part.inlineData.data), rate: OUTPUT_RATE, itemId: null })
    }
    // With AUDIO output, text parts are thoughts; the spoken words come as outputTranscription.
    if (part.text && !part.thought) out.push({ type: 'output.text', text: part.text, itemId: null })
  }
  if (content?.outputTranscription?.text) {
    out.push({ type: 'output.text', text: content.outputTranscription.text, itemId: null })
  }
  // The googleSearch tool runs server-side; grounding metadata names its queries.
  for (const query of content?.groundingMetadata?.webSearchQueries ?? []) {
    out.push({ type: 'tool.builtin', name: 'google_search', args: JSON.stringify({ query }) })
  }
  for (const call of wire.toolCall?.functionCalls ?? []) {
    out.push({ type: 'tool.call', callId: call.id ?? '', name: call.name ?? '', args: JSON.stringify(call.args ?? {}) })
  }
  if (wire.toolCallCancellation?.ids?.length) out.push({ type: 'tools.cancelled', callIds: wire.toolCallCancellation.ids })
  if (wire.usageMetadata) {
    const usage = wire.usageMetadata
    out.push({
      type: 'usage',
      usage: {
        inputTokens: usage.promptTokenCount ?? 0,
        cachedInputTokens: usage.cachedContentTokenCount ?? 0,
        outputTokens: usage.responseTokenCount ?? 0,
        inputAudioTokens: audioTokens(usage.promptTokensDetails),
        outputAudioTokens: audioTokens(usage.responseTokensDetails),
        billedSeconds: 0,
      },
    })
  }
  // Usage first, so the log shows the cost of a reply before it ends.
  if (content?.turnComplete) out.push({ type: 'response.done', status: content.interrupted ? 'cancelled' : 'completed' })
  if (wire.sessionResumptionUpdate) {
    // resumable is false during generation and tool calls; resuming from the old handle would lose that turn.
    const update = wire.sessionResumptionUpdate
    out.push({ type: 'resume.handle', handle: update.resumable && update.newHandle ? update.newHandle : null })
  }
  if (wire.goAway) out.push({ type: 'go.away', timeLeftMs: durationMs(wire.goAway.timeLeft) })
  if (wire.error) out.push({ type: 'error', message: wire.error.message ?? 'Unknown error', code: String(wire.error.code ?? '') || null })
  return out
}

function activityDetection(input: SetupInput) {
  const turns = input.turns ?? { mode: 'server' }
  if (turns.mode === 'semantic') return new UnsupportedOptionError({ provider: 'Gemini', option: 'semantic turn detection' })
  if (turns.mode === 'manual') return { automaticActivityDetection: { disabled: true } }
  const sensitivity = turns.sensitivity === 'low' ? 'LOW' : 'HIGH'
  return {
    automaticActivityDetection: {
      disabled: false,
      startOfSpeechSensitivity: `START_SENSITIVITY_${sensitivity}`,
      endOfSpeechSensitivity: `END_SENSITIVITY_${sensitivity}`,
      silenceDurationMs: turns.silenceMs ?? 500,
      ...(turns.prefixMs !== undefined ? { prefixPaddingMs: turns.prefixMs } : {}),
    },
    activityHandling: turns.interrupt === false ? 'NO_INTERRUPTION' : 'START_OF_ACTIVITY_INTERRUPTS',
  }
}

function historyTurns(history: HistoryItem[]) {
  // Live tool calls only travel as toolCall/toolResponse messages, so past tool use is replayed as text.
  return history.map((item) => {
    if (item.role === 'assistant') return { role: 'model', parts: [{ text: item.text }] }
    if (item.role === 'user') return { role: 'user', parts: [{ text: item.text }] }
    if (item.role === 'summary') return { role: 'user', parts: [{ text: `Summary of the conversation so far: ${item.text}` }] }
    return { role: 'model', parts: [{ text: `Called tool ${item.name}(${item.args}), result: ${item.output}` }] }
  })
}

function setup({ input, model, options }: { input: SetupInput; model: string; options: GeminiOptions }) {
  const realtimeInputConfig = activityDetection(input)
  if (realtimeInputConfig instanceof Error) return realtimeInputConfig
  const transcribe = input.transcribe ?? true
  const tools = input.tools ?? []
  const builtinTools = options.builtinTools ?? []
  const declarations = tools.map((tool) => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters }))
  const allTools = [...builtinTools, ...(declarations.length > 0 ? [{ functionDeclarations: declarations }] : [])]
  const setupMessage = {
    setup: {
      model: `models/${model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        ...(input.voice !== undefined ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: input.voice } } } } : {}),
        ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
      },
      ...(input.instructions !== undefined ? { systemInstruction: { parts: [{ text: input.instructions }] } } : {}),
      ...(allTools.length > 0 ? { tools: allTools } : {}),
      realtimeInputConfig,
      ...(transcribe ? { inputAudioTranscription: {}, outputAudioTranscription: {} } : {}),
      // Bounds the context re-billed on every turn and removes the 15 minute session limit.
      contextWindowCompression: {
        triggerTokens: options.compressionTriggerTokens ?? 32000,
        slidingWindow: { targetTokens: options.compressionTargetTokens ?? 12000 },
      },
      sessionResumption: input.resumeHandle === null ? {} : { handle: input.resumeHandle },
      ...(input.seeding ? { historyConfig: { initialHistoryInClientContent: true } } : {}),
    },
  }
  return [setupMessage]
}

function encode(command: Command): unknown[] {
  switch (command.type) {
    case 'audio':
      return [{ realtimeInput: { audio: { data: pcmToBase64(command.pcm), mimeType: `audio/pcm;rate=${INPUT_RATE}` } } }]
    case 'audio.end':
      // Gemini 3.8 ignores audioStreamEnd for turn taking (tested 2026-10); the silence before it ends the turn.
      return [{ realtimeInput: { audioStreamEnd: true } }]
    case 'turn.start':
      return [{ realtimeInput: { activityStart: {} } }]
    case 'turn.end':
      return [{ realtimeInput: { activityEnd: {} } }]
    case 'text':
      // clientContent with turnComplete false adds context without starting a model turn.
      if (!command.respond) return [{ clientContent: { turns: [{ role: 'user', parts: [{ text: command.text }] }], turnComplete: false } }]
      return [{ realtimeInput: { text: command.text } }]
    case 'tool.result': {
      const result = errore.try(() => ({ value: JSON.parse(command.output) as unknown }))
      const parsed = result instanceof Error ? command.output : result.value
      // functionResponse.response must be an object (protobuf Struct).
      const response =
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : { output: parsed }
      return [{ toolResponse: { functionResponses: [{ id: command.callId, name: command.name, response }] } }]
    }
    case 'response.create':
    case 'response.cancel':
    case 'truncate':
      return []
  }
}

export type GeminiOptions = ({ apiKey: string; token?: never } | { token: string; apiKey?: never }) & {
  model?: string
  /** Server-side tools, e.g. `{ googleSearch: {} }`. https://ai.google.dev/gemini-api/docs/live-api/tools */
  builtinTools?: Record<string, unknown>[]
  compressionTriggerTokens?: number
  compressionTargetTokens?: number
}

export function gemini(options: GeminiOptions): Adapter {
  const model = options.model ?? 'gemini-3.8-live'
  const base = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService'
  return {
    provider: 'gemini',
    model,
    inputRate: INPUT_RATE,
    outputRate: OUTPUT_RATE,
    needsResponseCreate: false,
    connect: () => {
      if (options.token) return { url: `${base}.BidiGenerateContentConstrained?access_token=${encodeURIComponent(options.token)}` }
      return { url: `${base}.BidiGenerateContent`, headers: { 'x-goog-api-key': options.apiKey ?? '' } }
    },
    setup: (input) => setup({ input, model, options }),
    seed: (history) => (history.length === 0 ? [] : [{ clientContent: { turns: historyTurns(history), turnComplete: true } }]),
    encode,
    decode: (message) => decode({ message, model }),
  }
}
