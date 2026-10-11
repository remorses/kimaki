// GPT-Live call over WebRTC, billed to the ChatGPT subscription. Same private
// endpoints as the Codex CLI (codex-rs/codex-api/src/endpoint/realtime_call.rs)
// and OpenClaw (extensions/openai/realtime-quicksilver-*.ts):
//
//   POST chatgpt.com/backend-api/codex/realtime/calls ── SDP offer ──▶ SDP answer, Location .../rtc_…
//   werift peer ◀══ RTP, Opus 48 kHz stereo, 20 ms frames ══▶ microphone mix in, voice out
//   wss://api.openai.com/v1/live/<call id> (sideband) ◀──▶ JSON: transcripts, delegations, appends
//
// The sideband rejects audio events and this route has no function tools: the model
// hands work off with delegation.created, and results come back as context appends.
// The subscription token gets "Voice session access denied" on the WebSocket-only
// /v1/live route, so WebRTC is required.

import crypto from 'node:crypto'
import * as errore from 'errore'
import OpusScript from 'opusscript'
import { RTCPeerConnection, RtpHeader, RtpPacket, useOPUS } from 'werift'

import { createLogger } from './logger.ts'

const logger = createLogger('LIVE')

// The only model the subscription route accepts; any other value is a 400.
const MODEL = 'gpt-live-1-codex'
// Voices of gpt-live-1-codex. Realtime voices like marin get "Voice session access denied".
export const LIVE_VOICES = ['cove', 'arbor', 'breeze', 'ember', 'juniper', 'maple', 'sol', 'spruce', 'vale'] as const
export const DEFAULT_LIVE_VOICE = 'cove'

export type LiveUrls = { calls: string; sideband: string }
export const DEFAULT_LIVE_URLS: LiveUrls = {
  calls: 'https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas',
  sideband: 'wss://api.openai.com/v1/live',
}

export type ChatGPTAuth = { accessToken: string; accountId: string | null }

export type LiveEvent =
  // The model asks the backend for work. `text` is the model's summary of the request.
  | { type: 'delegation'; id: string; text: string }
  // A finished user or assistant turn, with its full transcript.
  | { type: 'turn'; role: 'user' | 'assistant'; text: string }
  | { type: 'error'; message: string }
  // reason: expired, content, remote_hangup, connection_lost, client_request.
  | { type: 'closed'; reason: string }

export type LiveChannel = 'speakable' | 'commentary'

export type LiveCall = {
  // speakable: the model says it in its own words. commentary: silent context.
  append(input: { text: string; channel: LiveChannel; delegationId?: string }): void
  close(): Promise<void>
}

export class LiveCallError extends errore.createTaggedError({
  name: 'LiveCallError',
  message: 'GPT-Live $operation failed',
}) {}

const PAYLOAD_TYPE = 111
const FRAME_SAMPLES = 960
// One 20 ms frame of 48 kHz stereo PCM16, what the Discord decoder emits per packet.
export const FRAME_BYTES = FRAME_SAMPLES * 2 * 2
const SILENT_FRAME = Buffer.alloc(FRAME_BYTES)
// Every append is split into chunks of at most 500 UTF-8 bytes (Codex methods_frameless_bidi.rs).
const APPEND_BYTES = 500
const START_TIMEOUT_MS = 15_000

// Splits text into chunks of at most `max` UTF-8 bytes, never inside a character.
export function chunkUtf8(text: string, max = APPEND_BYTES): string[] {
  const chunks: string[] = []
  const current = { text: '', bytes: 0 }
  for (const char of text) {
    const bytes = Buffer.byteLength(char)
    if (current.bytes + bytes > max) {
      chunks.push(current.text)
      current.text = ''
      current.bytes = 0
    }
    current.text += char
    current.bytes += bytes
  }
  if (current.text) chunks.push(current.text)
  return chunks
}

type WireEvent = {
  type?: string
  item?: { id?: string; type?: string; target?: string; content?: Array<{ type?: string; text?: string }> }
  turn?: { role?: string; transcript?: string }
  reason?: string
  error?: { message?: string } | string
  message?: string
}

function decode(event: WireEvent): LiveEvent | null {
  if (event.type === 'delegation.created' && event.item?.target === 'client' && event.item.id) {
    const text = (event.item.content ?? []).flatMap((part) => (part.type === 'input_text' && part.text ? [part.text] : [])).join('\n')
    return { type: 'delegation', id: event.item.id, text }
  }
  if (event.type === 'turn.done' && (event.turn?.role === 'user' || event.turn?.role === 'assistant')) {
    return { type: 'turn', role: event.turn.role, text: (event.turn.transcript ?? '').trim() }
  }
  if (event.type === 'session.closed') return { type: 'closed', reason: event.reason ?? 'unknown' }
  if (event.type === 'error') {
    const message = typeof event.error === 'string' ? event.error : (event.error?.message ?? event.message ?? 'unknown error')
    return { type: 'error', message }
  }
  return null
}

// Starts a call. readFrame returns the next 20 ms of microphone PCM (48 kHz stereo) or null for
// silence; it is called every 20 ms, because the model expects a continuous stream. onOpus gets every
// 20 ms Opus packet of the model in order, silence included: it is part of the audio timeline.
export async function startLiveCall({
  auth,
  voice,
  instructions,
  urls = DEFAULT_LIVE_URLS,
  readFrame,
  onOpus,
  onEvent,
}: {
  auth: ChatGPTAuth
  voice: string
  instructions: string
  urls?: LiveUrls
  readFrame: () => Buffer | null
  onOpus: (packet: Buffer) => void
  onEvent: (event: LiveEvent) => void
}): Promise<LiveCallError | LiveCall> {
  const headers = {
    authorization: `Bearer ${auth.accessToken}`,
    ...(auth.accountId && { 'chatgpt-account-id': auth.accountId }),
    originator: 'codex_cli_rs',
    'openai-alpha': 'quicksilver=v2',
    'x-session-id': crypto.randomUUID(),
  }
  const peer = new RTCPeerConnection({ codecs: { audio: [useOPUS({ payloadType: PAYLOAD_TYPE })], video: [] } })
  const transceiver = peer.addTransceiver('audio', { direction: 'sendrecv' })
  const encoder = new OpusScript(48_000, 2, OpusScript.Application.VOIP)
  const state = { started: false, closing: false, clock: null as ReturnType<typeof setInterval> | null, socket: null as WebSocket | null }

  const teardown = async () => {
    if (state.clock) clearInterval(state.clock)
    state.clock = null
    state.socket?.close(1000)
    await peer.close().catch((error: Error) => logger.warn('close peer', error))
    encoder.delete()
  }
  const fail = async (error: LiveCallError) => {
    state.closing = true
    await teardown()
    return error
  }

  const offer = await peer
    .createOffer()
    .then((description) => peer.setLocalDescription(description))
    .then(() => peer.localDescription?.sdp ?? '')
    .catch((cause) => new LiveCallError({ operation: 'create offer', cause }))
  if (offer instanceof Error) return fail(offer)

  const response = await fetch(urls.calls, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      sdp: offer,
      session: { model: MODEL, instructions, audio: { output: { voice } }, delegation: { type: 'client', ack_filler: true } },
    }),
    signal: AbortSignal.timeout(START_TIMEOUT_MS),
  }).catch((cause) => new LiveCallError({ operation: 'call creation', cause }))
  if (response instanceof Error) return fail(response)
  const answer = await response.text().catch(() => '')
  if (response.status !== 201) return fail(new LiveCallError({ operation: `call creation (HTTP ${response.status}: ${answer.slice(0, 300)})` }))
  // Location: /v1/realtime/calls/rtc_xxx
  const callId = (response.headers.get('location') ?? '').split('?')[0]!.split('/').findLast((part) => part.startsWith('rtc_'))
  if (!callId) return fail(new LiveCallError({ operation: 'call creation (no call ID in the Location header)' }))

  const answered = await peer
    .setRemoteDescription({ type: 'answer', sdp: answer })
    .catch((cause) => new LiveCallError({ operation: 'apply SDP answer', cause }))
  if (answered instanceof Error) return fail(answered)

  // The answer declares no SSRC, so read the receiver's default track instead of onTrack.
  const inbound = { sequence: null as number | null }
  transceiver.receiver.track.onReceiveRtp.subscribe((rtp) => {
    const { sequenceNumber } = rtp.header
    // Duplicates and packets older than the last one forwarded are dropped.
    const distance = inbound.sequence === null ? 1 : (sequenceNumber - inbound.sequence) & 0xffff
    if (distance === 0 || distance >= 0x8000) return
    inbound.sequence = sequenceNumber
    onOpus(rtp.payload)
  })

  const outbound = { sequence: crypto.randomInt(0x10000), timestamp: crypto.randomInt(0x100000000) }
  state.clock = setInterval(() => {
    const frame = readFrame() ?? SILENT_FRAME
    if (peer.connectionState !== 'connected') return
    const opus = errore.try(() => encoder.encode(frame, FRAME_SAMPLES), (cause) => new LiveCallError({ operation: 'encode audio', cause }))
    if (opus instanceof Error) return logger.warn(opus)
    const header = new RtpHeader({ payloadType: PAYLOAD_TYPE, sequenceNumber: outbound.sequence, timestamp: outbound.timestamp, marker: false })
    outbound.sequence = (outbound.sequence + 1) & 0xffff
    outbound.timestamp = (outbound.timestamp + FRAME_SAMPLES) >>> 0
    transceiver.sender.sendRtp(new RtpPacket(header, Buffer.from(opus))).catch((error: Error) => logger.warn('send audio', error))
  }, 20)

  // Node's WebSocket (undici) accepts headers in the init object.
  const socket = new WebSocket(`${urls.sideband}/${callId}`, { headers })
  state.socket = socket
  const started = await new Promise<LiveCallError | void>((resolve) => {
    const timer = setTimeout(() => resolve(new LiveCallError({ operation: 'session start (timed out)' })), START_TIMEOUT_MS)
    socket.addEventListener('message', (message: MessageEvent) => {
      const event = errore.try(() => JSON.parse(String(message.data)) as WireEvent)
      if (event instanceof Error) return logger.warn('invalid sideband message', event)
      if (event.type === 'session.started') {
        state.started = true
        clearTimeout(timer)
        resolve()
      }
      const decoded = decode(event)
      if (decoded && state.started) onEvent(decoded)
    })
    socket.addEventListener('close', (event: CloseEvent) => {
      clearTimeout(timer)
      resolve(new LiveCallError({ operation: `sideband (closed ${event.code} ${event.reason})` }))
      if (state.started && !state.closing) onEvent({ type: 'closed', reason: 'connection_lost' })
    })
  })
  if (started instanceof Error) return fail(started)

  const send = (event: Record<string, unknown>) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event))
  }
  return {
    append({ text, channel, delegationId }) {
      for (const chunk of chunkUtf8(text)) {
        const content = [{ type: 'input_text', text: chunk }]
        if (delegationId) send({ type: 'delegation.context.append', delegation_item_id: delegationId, channel, content })
        else send({ type: 'session.context.append', channel, content })
      }
    },
    async close() {
      if (state.closing) return
      state.closing = true
      send({ type: 'session.close' })
      await teardown()
    },
  }
}
