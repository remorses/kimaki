// Real conversations against provider APIs. Each provider block runs only when its key is set:
// OPENAI_API_KEY (sigillo kimaki dev), GEMINI_API_KEY, XAI_API_KEY.
// Run: sigillo run -- pnpm run test --run src/live.e2e.test.ts
// Writes model audio and raw wire logs to realtime/output/ for listening and fixtures.

import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { describe, expect, test } from 'vitest'
import { encodeWav, readWav } from './audio.ts'
import { gemini } from './gemini.ts'
import { openai, xai } from './openai.ts'
import { RealtimeSession, type RealtimeSnapshot, type SessionOptions } from './session.ts'
import type { Adapter, RealtimeEvent } from './types.ts'

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const outputDir = path.join(root, 'output')
fs.mkdirSync(outputDir, { recursive: true })

function loadWav(name: string) {
  const wav = readWav(fs.readFileSync(path.join(root, 'fixtures', name)))
  if (wav instanceof Error) throw wav
  return wav
}

const weatherTool = {
  description: 'Get the current weather for a city',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string', description: 'City name' } },
    required: ['city'],
    additionalProperties: false,
  },
  execute: (args: unknown) => ({ city: (args as { city: string }).city, temperatureC: 21, condition: 'sunny' }),
}

/** Opens a session that records model audio and wire messages (audio payloads stripped). */
function createRecorded({ name, options }: { name: string; options: SessionOptions }) {
  const audio: Int16Array[] = []
  const wire: string[] = []
  const session = new RealtimeSession({
    ...options,
    onWire: ({ direction, data }) => wire.push(JSON.stringify({ direction, data: stripAudio(data) })),
  })
  session.subscribe((event) => {
    if (event.type === 'output.audio') audio.push(event.pcm)
  })
  const save = () => {
    const pcm = Int16Array.from(audio.flatMap((chunk) => Array.from(chunk)))
    fs.writeFileSync(path.join(outputDir, `${name}.wav`), encodeWav({ pcm, rate: session.model.outputRate }))
    fs.writeFileSync(path.join(outputDir, `${name}.wire.jsonl`), wire.join('\n') + '\n')
    fs.writeFileSync(path.join(outputDir, `${name}.events.json`), JSON.stringify(session.events, null, 2))
    return { seconds: pcm.length / session.model.outputRate, rms: rms(pcm) }
  }
  return { session, save }
}

/** Replaces base64 audio with one silent sample so wire logs stay small and still decode. */
function stripAudio(data: unknown): unknown {
  return JSON.parse(
    JSON.stringify(data, (key, value: unknown) =>
      typeof value === 'string' && value.length > 200 && (key === 'audio' || key === 'delta' || key === 'data')
        ? 'AAA='
        : value,
    ),
  )
}

function rms(pcm: Int16Array): number {
  if (pcm.length === 0) return 0
  let sum = 0
  for (const sample of pcm) sum += sample * sample
  return Math.sqrt(sum / pcm.length)
}

/** Resolves when `predicate` holds for the event log, checked after every event. */
function waitForEvents(session: RealtimeSession, predicate: (events: readonly RealtimeEvent[]) => boolean, timeoutMs = 45_000) {
  return new Promise<void>((resolve, reject) => {
    if (predicate(session.events)) return resolve()
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error(`Timed out. Events: ${JSON.stringify(session.events.filter((e) => e.type !== 'output.text'))}`))
    }, timeoutMs)
    const unsubscribe = session.subscribe(() => {
      if (!predicate(session.events)) return
      clearTimeout(timer)
      unsubscribe()
      resolve()
    })
  })
}

const completedReplies = (events: readonly RealtimeEvent[]) =>
  events.filter((e) => e.type === 'response.done' && e.status === 'completed').length

function assistantText(session: RealtimeSession): string {
  return session
    .view()
    .messages.flatMap((m) => (m.kind === 'assistant' ? [m.text] : []))
    .join(' ')
}

function userText(session: RealtimeSession): string {
  return session
    .view()
    .messages.flatMap((m) => (m.kind === 'user' ? [m.text] : []))
    .join(' ')
}

/** Sends the WAV, then signals the pause like Discord does when a user stops talking. */
function speak(session: RealtimeSession, file: string) {
  const wav = loadWav(file)
  const chunk = (wav.rate / 10) * wav.channels
  for (let i = 0; i < wav.pcm.length; i += chunk) {
    const sent = session.appendAudio(wav.pcm.subarray(i, i + chunk), { rate: wav.rate, channels: wav.channels })
    if (sent instanceof Error) throw sent
  }
  const ended = session.endOfSpeech()
  if (ended instanceof Error) throw ended
}

const providers: Array<{ name: string; key: string | undefined; model: (key: string) => Adapter; voice: string }> = [
  { name: 'openai', key: process.env.OPENAI_API_KEY, model: (apiKey) => openai({ apiKey }), voice: 'marin' },
  { name: 'gemini', key: process.env.GEMINI_API_KEY, model: (apiKey) => gemini({ apiKey }), voice: 'Kore' },
  { name: 'xai', key: process.env.XAI_API_KEY, model: (apiKey) => xai({ apiKey, reasoning: 'none' }), voice: 'eve' },
]

for (const provider of providers) {
  describe.skipIf(!provider.key)(`${provider.name} live`, () => {
    const options = (): SessionOptions => ({
      model: provider.model(provider.key ?? ''),
      instructions: 'You are a voice assistant in a test. Answer in one short sentence.',
      voice: provider.voice,
      turns: { mode: 'server', silenceMs: 500 },
      maxOutputTokens: 300,
      tools: { get_weather: weatherTool },
    })
    let snapshot: RealtimeSnapshot | null = null

    test('answers a spoken question with audio and transcripts', async () => {
      const recorded = createRecorded({ name: `${provider.name}-question`, options: options() })
      // Disposed even when a wait times out, so no billable socket stays open.
      await using session = recorded.session
      const { save } = recorded
      const connected = await session.connect()
      if (connected instanceof Error) throw connected

      speak(session, 'question.wav')
      await waitForEvents(session, (events) => completedReplies(events) >= 1)
      await session.close()
      const audio = save()
      snapshot = session.snapshot()

      expect(userText(session).toLowerCase()).toContain('france')
      expect(assistantText(session).toLowerCase()).toContain('paris')
      expect(audio.seconds).toBeGreaterThan(0.5)
      expect(audio.rms).toBeGreaterThan(300)
      expect(session.view().usage.outputTokens).toBeGreaterThan(0)
    })

    test('calls a tool and speaks the result', async () => {
      const recorded = createRecorded({ name: `${provider.name}-tool`, options: options() })
      // Disposed even when a wait times out, so no billable socket stays open.
      await using session = recorded.session
      const { save } = recorded
      const connected = await session.connect()
      if (connected instanceof Error) throw connected

      speak(session, 'tool-question.wav')
      // Wait for a reply spoken after the tool result, not the preamble before the call.
      await waitForEvents(session, (events) => {
        const result = events.findIndex((e) => e.type === 'tool.result')
        const text = events.findIndex((e, i) => i > result && e.type === 'output.text')
        return result !== -1 && text !== -1 && events.some((e, i) => i > text && e.type === 'response.done' && e.status === 'completed')
      })
      await session.close()
      save()

      const tool = session.view().messages.find((m) => m.kind === 'tool')
      expect(tool?.kind === 'tool' && tool.name).toBe('get_weather')
      expect(tool?.kind === 'tool' && tool.args.toLowerCase()).toContain('rome')
      expect(assistantText(session)).toMatch(/21|sunny/i)
    })

    // `server` uses the provider resume handle (Gemini, xAI); `seed` drops it and replays history as text.
    test.each(['server', 'seed'] as const)('resumes the conversation from a snapshot (%s)', async (mode) => {
      if (!snapshot) throw new Error('first test did not produce a snapshot')
      const resume = mode === 'server' ? snapshot : { ...snapshot, events: snapshot.events.filter((e) => e.type !== 'resume.handle') }
      const recorded = createRecorded({ name: `${provider.name}-resume-${mode}`, options: options() })
      // Disposed even when a wait times out, so no billable socket stays open.
      await using session = recorded.session
      const { save } = recorded
      const connected = await session.connect({ resume })
      if (connected instanceof Error) throw connected
      const before = completedReplies(session.events)

      const sent = session.sendText('Which country did I ask you about earlier? Answer with just the country name.')
      if (sent instanceof Error) throw sent
      await waitForEvents(session, (events) => completedReplies(events) > before)
      await session.close()
      save()

      const reply = session.view().messages.findLast((m) => m.kind === 'assistant')
      expect(reply?.kind === 'assistant' && reply.text.toLowerCase()).toContain('france')
    })
  })
}
