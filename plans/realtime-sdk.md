---
title: Lean realtime voice SDK (OpenAI Realtime, Gemini Live, xAI Grok Voice)
description: >
  Analysis of the AI SDK realtime abstraction and a plan for a small, event-sourced realtime
  package with VAD, push-to-talk, tools and cost controls. First consumer: Discord voice channels.
---

# Lean realtime voice SDK

Read on 2026-10-09: `vercel/ai` main (`ai@7.0.136`), provider docs fetched the same day.
OpenAI Live (`gpt-live-1`) is out of scope.

> **Implemented** in `realtime/` (`@kimaki/realtime`). Differences from this plan: `new RealtimeSession()`
> instead of `createSession()`, no Discord bridge yet, snapshot = the event log itself
> (`{ version, events }`), and `endOfSpeech()` sends trailing silence on every provider because
> Gemini 3.8 ignores `audioStreamEnd` for turn taking (tested live).

## 1. How the AI SDK realtime abstraction works

```
 provider package                     ai core                          @ai-sdk/react
 ───────────────────                  ─────────────────────────────    ────────────────
 RealtimeModelV4 (spec, provider/)
   buildSessionConfig(cfg) ──────────▶ AbstractRealtimeSession (937 l)  experimental_useRealtime
   serializeClientEvent(ev) ◀────────    ├─ BrowserRealtimeTransport     (useSyncExternalStore
   parseServerEvent(raw) ────────────▶   ├─ BrowserRealtimeWebRTC          over the session)
   getWebSocketConfig(token)             ├─ BrowserRealtimeAudio (ScriptProcessorNode)
   doCreateClientSecret() (server)       ├─ RealtimeEventReducer ──▶ UIMessage[]
                                         └─ RealtimeCommandTracker, RealtimeAttempt
```

| file (under `packages/`) | role |
| --- | --- |
| `provider/src/realtime-model/v4/*` | spec, neutral session config, 13 client and ~35 server events |
| `openai/src/realtime/openai-realtime-event-mapper.ts` | 1:1 map of GA `gpt-realtime` events |
| `google/src/realtime/google-realtime-event-mapper.ts` | stateful class: fake response/item IDs, merges transcript fragments |
| `xai/src/realtime/xai-realtime-event-mapper.ts` | OpenAI mapper copy with xAI differences |
| `ai/src/realtime/realtime-session.ts` | lifecycle, token fetch, tool loop, barge-in truncation |
| `ai/src/realtime/realtime-event-reducer.ts` | events → `UIMessage[]` |
| `ai/src/realtime/browser-realtime-audio.ts`, `audio-utils.ts` | mic, PCM16 base64, linear resample, playback |

Flow: server mints a short-lived token (`/v1/realtime/client_secrets` for OpenAI and xAI,
`/v1alpha/auth_tokens` for Gemini) → browser opens WS → sends session config → streams mic
chunks → events go through the mapper into the reducer → tool calls run `onToolCall`, result goes
back, OpenAI/xAI then need `response.create` → on `speech-started` during playback it stops audio
and sends `conversation.item.truncate` with played ms.

## 2. Problems in the AI SDK implementation

- **Gemini ignores `turnDetection`.** No `realtimeInputConfig`, no `activityStart/End`, so no
  push-to-talk. Cancel, clear and truncate serialize to `null`.
- **No Gemini longevity:** no `contextWindowCompression`, `goAway` and resumption handles are
  passed through as `custom` events only.
- **No cost surface:** `response.done.usage` and Gemini `usageMetadata` are not parsed.
- **Untyped OpenAI knobs:** `eagerness`, `create_response`, `interrupt_response`,
  `idle_timeout_ms`, `noise_reduction`, `truncation`, `max_output_tokens`.
- **xAI gaps:** no `reasoning.effort`, `resumption`, binary transport, built-in tools typed;
  `response.output_text.delta` (the second name xAI uses) is not mapped.
- **Browser only.** No Node path for Discord voice, phone or server agents.
- Deprecated `ScriptProcessorNode`, about 7k lines of non-test code.

## 3. Provider facts that drive the design

| | OpenAI `gpt-realtime-2.1` | Gemini `gemini-3.8-live` | xAI `grok-voice-think-fast-2.0` |
| --- | --- | --- | --- |
| protocol | OpenAI GA | own (`setup`, `realtimeInput`, `serverContent`) | OpenAI-like hybrid: flat `turn_detection`, `voice`; GA `audio.*.format`, GA output event names |
| auth (server) | `Authorization: Bearer` | `?key=` or header | `Authorization: Bearer` |
| input audio | PCM16 24 kHz | PCM16 16 kHz | PCM16 8k to **48 kHz**, opus, pcmu/pcma |
| output audio | PCM16 24 kHz | PCM16 24 kHz | PCM16 any rate above, opus 24 kHz |
| auto VAD | `server_vad` (threshold, prefix, silence, idle timeout), `semantic_vad` (eagerness) | `automaticActivityDetection` (start/end sensitivity, prefix, silence) | `server_vad` (+ `idle_timeout_ms`); threshold/silence fields unverified |
| manual turns | `turn_detection: null`, `clear` / `commit` / `response.create` | `disabled: true`, `activityStart` / `activityEnd` | `turn_detection: null`, `commit` / `response.create` |
| end-of-speech hint | none | `audioStreamEnd` | none |
| barge-in | WS: client sends `conversation.item.truncate` | `serverContent.interrupted`, flush playback | automatic, truncate supported |
| billing | tokens; history re-billed every response | tokens; history re-billed every turn | **$0.08 per minute** + $0.004 per text input |
| silence billed | no with VAD | yes on 3.8 (proactive audio) | unverified, per-minute suggests yes |
| cache discount | audio in $32 → $0.40 / M | none | n/a |
| context cap | `truncation.retention_ratio` | `contextWindowCompression` | undocumented |
| limits | 60 min | 10 min per connection, 15 min without compression | `max_duration` error (value unverified), 10 concurrent sessions default |
| resume | no | `sessionResumption` handle (2h) | `resumption.enabled` + `?conversation_id=` (30 min idle) |
| built-in tools | none | none | `web_search`, `x_search`, `file_search`, `mcp` |
| reasoning | n/a | `thinkingLevel` on extended-thinking model | `reasoning.effort` `high` (default) or `none` |

## 4. Cost rules applied by default

1. **Never stream silence.** On Discord this is free: Discord only sends packets while a user
   talks. Browser gets a client gate with ~300 ms pre-roll.
2. **Tell the server the turn ended** at the end of each burst, instead of streaming silence:
   Gemini `audioStreamEnd`; OpenAI and xAI append a short block of zero PCM (equal to
   `silenceMs`) so server VAD can close the turn. Silence is not billed on OpenAI with VAD.
3. **OpenAI:** keep instructions and tools static (cache), default
   `truncation: { type: 'retention_ratio', retention_ratio: 0.8 }`.
4. **Gemini:** `contextWindowCompression` on by default (also removes the 15 min limit),
   automatic reconnect on `goAway` with the resumption handle.
5. **xAI:** billed by time, so close the socket after `idleCloseMs` with nobody talking, keep
   `conversation_id`, and reopen with resumption when someone speaks again.
6. `maxOutputTokens` and transcription opt-in on all providers.
7. Normalized `usage` on every `turn.end` (tokens or seconds), plus `estimateCost()`.

## 5. Package layout

Folder `realtime/` (workspace `./*`), name to decide (`@kimaki/realtime`). ESM, `tsc`, errore,
no runtime deps. Node, Workers and browser use the same core.

```
 realtime/src/
   index.ts      createSession(), types, estimateCost()
   session.ts    socket + adapter + reducer + tool loop + reconnect   (~350 lines)
   reducer.ts    pure fold: events → { status, messages, speaking, usage } (~200)
   openai.ts     OpenAI GA adapter + clientSecret()                    (~250)
   xai.ts        reuses openai.ts codec with an xAI dialect + clientSecret() (~100)
   gemini.ts     Gemini adapter, pure decoder state, token()           (~300)
   audio.ts      PCM16 helpers: resample, stereo↔mono, mix, silence, gate (~150)
   discord.ts    joins a VoiceConnection to a session (peer deps, optional) (~200)
```

Target about 1600 lines. `discord.ts` is a subpath export (`/discord`) with optional peer deps
`@discordjs/voice` and `prism-media`; core never imports them.

### 5.1 Adapter interface (pure)

```ts
type Adapter<S> = {
  initial: S
  connect(): { url: string; headers?: Record<string, string>; protocols?: string[] }
  setup(config: SessionConfig): Wire[]
  encode(cmd: Command, state: S): Wire[]
  decode(raw: Wire, state: S): { state: S; events: RealtimeEvent[] }
  audio: { inputRate: number; outputRate: number }
}
```

Decoder state is a plain value, so recorded wire streams replay in tests.

### 5.2 Normalized events

`ready`, `speech.start`, `speech.end`, `input.transcript` (delta | final), `output.audio`
(pcm Int16Array, itemId), `output.text` (delta | final), `output.transcript` (delta | final),
`tool.call` (id, name, args), `tool.cancel`, `turn.end` (status, usage), `interrupted`,
`reconnecting`, `error`, `raw` (anything unmapped).

### 5.3 Commands and mapping

| method | OpenAI | xAI | Gemini |
| --- | --- | --- | --- |
| `appendAudio(pcm, rate)` | `input_audio_buffer.append` | same (or binary frame) | `realtimeInput.audio` |
| `endOfSpeech()` | append `silenceMs` of zeros | same | `audioStreamEnd` |
| `startTurn()` (manual mode) | `response.cancel` + truncate + `clear` | same | `activityStart` |
| `endTurn()` (manual mode) | `commit` + `response.create` | same | `activityEnd` |
| `sendText(text)` | `conversation.item.create` + `response.create` | same | `realtimeInput.text` |
| `interrupt()` | `response.cancel` + `conversation.item.truncate` | same | stop playback only |
| tool result (automatic) | `function_call_output`, one `response.create` after last | same | `toolResponse` |
| `update(config)` | `session.update` | `session.update` | reconnect with resumption handle |
| `close()` | close socket | close socket | close socket |

`appendAudio` takes any rate and channel count; the session converts to the adapter's input
rate (xAI accepts 48 kHz, so Discord audio needs only stereo → mono there).

## 6. API examples

### 6.1 Core usage (Node)

```ts
import { createSession } from '@kimaki/realtime'
import { gemini } from '@kimaki/realtime/gemini'
import { z } from 'zod'

const session = createSession({
  model: gemini({ apiKey: process.env.GEMINI_API_KEY!, model: 'gemini-3.8-live' }),
  instructions: 'You are Kimaki. Keep answers short.',
  voice: 'Kore',
  turns: { mode: 'server', silenceMs: 600, sensitivity: 'low', interrupt: true },
  transcribe: { input: true, output: true },
  maxOutputTokens: 400,
  tools: {
    runTask: {
      description: 'Send a coding task to OpenCode in the current project',
      parameters: z.object({ prompt: z.string() }),
      execute: async ({ prompt }) => {
        const sessionId = await startOpencodeSession(prompt)
        return { started: true, sessionId }
      },
    },
  },
  output: { play: (pcm) => speaker.write(pcm), stop: () => speaker.flush() },
})

session.subscribe((event, state) => {
  if (event.type === 'input.transcript' && event.final) console.log('user:', event.text)
  if (event.type === 'turn.end') console.log('usage', event.usage, estimateCost(event.usage))
})

const error = await session.connect()
if (error instanceof Error) throw error

mic.on('data', (pcm: Int16Array) => session.appendAudio(pcm, { rate: 48000, channels: 2 }))
mic.on('pause', () => session.endOfSpeech())
```

Switch provider by changing one line:

```ts
model: openai({ apiKey, model: 'gpt-realtime-2.1', noiseReduction: 'near_field' }),
model: xai({ apiKey, model: 'grok-voice-think-fast-2.0', reasoning: 'none',
             builtinTools: [{ type: 'web_search' }] }),
```

Provider-only options live on the provider factory, typed, never in a `providerOptions` bag.

### 6.2 Push-to-talk

```ts
const session = createSession({ model, turns: { mode: 'manual' }, output })
button.onPress(() => session.startTurn())
button.onRelease(() => session.endTurn())
```

### 6.3 Browser token (OpenAI, xAI, Gemini)

```ts
// server route
import { clientSecret } from '@kimaki/realtime/openai'
const secret = await clientSecret({ apiKey, model: 'gpt-realtime-2.1', ttlSeconds: 60 })
return Response.json(secret)

// browser
const session = createSession({ model: openai({ token: secret.value, model: 'gpt-realtime-2.1' }), ... })
```

### 6.4 Discord voice channel

```ts
import { joinVoiceChannel } from '@discordjs/voice'
import { createSession } from '@kimaki/realtime'
import { gemini } from '@kimaki/realtime/gemini'
import { attachVoiceConnection } from '@kimaki/realtime/discord'

const connection = joinVoiceChannel({
  channelId: voiceChannel.id,
  guildId: voiceChannel.guild.id,
  adapterCreator: voiceChannel.guild.voiceAdapterCreator,
  selfDeaf: false,
})

const session = createSession({
  model: gemini({ apiKey, model: 'gemini-3.8-live' }),
  instructions: 'You are Kimaki in a Discord voice channel.',
  turns: { mode: 'server', silenceMs: 600 },
  tools,
})

const voice = attachVoiceConnection({
  session,
  connection,
  // only these users can talk to the bot; others are ignored
  allowUser: (userId) => canUseKimaki(userId),
  // one speaker holds the floor; a second speaker waits until the first goes silent
  floor: 'first-speaker',
  // xAI only: close the socket after 60s of nobody talking, resume on next speech
  idleCloseMs: 60_000,
})

voice.on('speaker', ({ userId }) => log(`floor: ${userId}`))
// later
voice.detach()
await session.close()
connection.destroy()
```

What `attachVoiceConnection` does:

```
Discord user ──Opus 48k stereo──▶ receiver.subscribe(userId, AfterSilence 300ms)
                                  │
                                  ▼ prism Opus decoder ──▶ PCM 48k stereo
                                  │
           floor check + allowUser│
                                  ▼
                    session.appendAudio(pcm, { rate: 48000, channels: 2 })
                    (stream end) session.endOfSpeech()

model ──output.audio 24k mono──▶ upsample to 48k stereo ──▶ PassThrough
                                  ──▶ createAudioResource(StreamType.Raw) ──▶ AudioPlayer
interrupted / speech.start ──▶ player.stop(), flush stream, playedMs = resource.playbackDuration
                           ──▶ session.interrupt(playedMs) (OpenAI/xAI truncate)
```

## 7. Discord-specific decisions

- **Free VAD.** Discord sends no packets during silence. The receive stream end
  (`EndBehaviorType.AfterSilence`) is our end-of-speech signal. V1 already did this for Gemini
  (`git show v1:cli/src/voice-handler.ts`, `audioStreamEnd` on stream end).
- **Server VAD needs trailing silence.** Without packets, OpenAI and xAI server VAD never sees
  the pause. `endOfSpeech()` appends zero PCM for them. Keep server VAD as the turn authority so
  short pauses inside a sentence do not split turns.
- **Several users, one input buffer.** Providers accept one audio stream. Default
  `floor: 'first-speaker'`. Option `'mix'` sums PCM of all speakers with clipping. Speaker
  names can be sent as text context (`sendText`) only on OpenAI/xAI without triggering a reply;
  decide later.
- **Echo.** Discord does not send the bot its own audio, so no echo cancellation is needed.
- **Barge-in** uses `AudioResource.playbackDuration` for exact played ms.

## 8. Persistence and resume

Only Gemini and xAI resume on the server. None of the three providers returns history after the
socket closes. So the SDK keeps its own neutral history and uses server resume only as a fast path.

| | OpenAI | Gemini | xAI |
| --- | --- | --- | --- |
| server resume | none | `setup.sessionResumption.handle` | `?conversation_id=` + `resumption.enabled` |
| valid for | n/a | 2h after the session ends | 30 min of inactivity |
| keeps | n/a | full context, audio tokens | transcripts and tool calls only |
| blocked | n/a | during generation and tool calls (`resumable: false`) | undocumented |
| seed message | `conversation.item.create` (assistant: `output_text`, no audio) | `clientContent.turns` + `historyConfig.initialHistoryInClientContent` | `conversation.item.create` (assistant: `text`) |
| seed tool history | `function_call` + `function_call_output` | undocumented, send as text | `function_call` + `function_call_output` |

Snapshot shape, serializable, the app stores it (kimaki: SQLite row per voice channel):

```ts
type RealtimeSnapshot = {
  provider: 'openai' | 'gemini' | 'xai'
  model: string
  resume?: { handle: string; expiresAt: number }   // gemini handle or xai conversation_id
  history: HistoryItem[]                            // from transcripts and tool events
}
type HistoryItem =
  | { role: 'user' | 'assistant'; text: string }
  | { role: 'tool'; callId: string; name: string; args: unknown; result: unknown }
  | { role: 'summary'; text: string }
```

Resume order in `connect({ resume })`:

```
snapshot.resume valid, same provider and model ──▶ server resume (no re-send, fastest)
            │ fails or expired
            ▼
seed: adapter.seed(history, { maxTurns }) ──▶ summary item + last N turns as text
```

- `history` comes from `input.transcript` and `output.transcript` final events, so resume needs
  transcription on. Cost: cheap on OpenAI, text-output rate on Gemini, included on xAI.
- Seeding works across providers, because history is neutral text.
- OpenAI: seeded assistant text can make the model reply in text
  (https://github.com/openai/openai-realtime-api-beta/issues/72). Send
  `output_modalities: ['audio']` on every `response.create` after a seed.
- Same path handles limits: Gemini `goAway` reconnects with the handle; OpenAI at
  `session.expires_at` (60 min) rolls over to a new session seeded from history.
- Summaries are made by the app (any cheap text model), passed in as a `summary` item. The SDK
  does not call text models.

## 9. Tests

- `scripts/record.ts` (needs API keys) records real wire streams to `fixtures/<provider>-*.jsonl`:
  text turn, audio turn, tool call, barge-in, manual turn, Gemini `goAway`, xAI resumption.
- Replay fixtures through `decode` + `reducer`, assert with inline snapshots. No mocks.
- Unit tests only for `audio.ts` (resample, stereo↔mono, mix, gate pre-roll).
- One live e2e per provider gated on env keys: connect, text in, tool call, close.
- Discord: e2e with `discord-digital-twin` later, if it gets voice support.

## 10. Open questions

- Package name.
- xAI: VAD tuning fields, max session length, silence billing, function tool shape (flat or
  nested) are undocumented or conflicting. Record fixtures first.
- xAI opus output (24 kHz mono) straight into Discord without decode is unverified.
- Gemini 3.8: whether time with no streamed audio is billed under proactive audio.

## 11. Sources

- AI SDK realtime docs: https://ai-sdk.dev/docs/ai-sdk-core/realtime
- AI SDK source: https://github.com/vercel/ai/tree/main/packages/ai/src/realtime
- OpenAI realtime guide: https://developers.openai.com/api/docs/guides/realtime
- OpenAI conversations: https://developers.openai.com/api/docs/guides/realtime-conversations
- OpenAI VAD: https://developers.openai.com/api/docs/guides/realtime-vad
- OpenAI cost: https://developers.openai.com/api/docs/guides/voice-latency-cost
- OpenAI client events: https://developers.openai.com/api/reference/resources/realtime/client-events
- OpenAI server events: https://developers.openai.com/api/reference/resources/realtime/server-events
- OpenAI pricing: https://developers.openai.com/api/docs/pricing
- Gemini Live capabilities: https://ai.google.dev/gemini-api/docs/live-guide
- Gemini session management: https://ai.google.dev/gemini-api/docs/live-api/session-management
- Gemini best practices + billing: https://ai.google.dev/gemini-api/docs/live-api/best-practices
- Gemini ephemeral tokens: https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens
- Gemini WS reference: https://ai.google.dev/api/live
- Gemini pricing: https://ai.google.dev/gemini-api/docs/pricing
- xAI speech to speech: https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech
- xAI voice API reference: https://docs.x.ai/developers/rest-api-reference/inference/voice
- xAI WS event schema: https://docs.x.ai/voice-realtime.ws.json
- xAI ephemeral tokens: https://docs.x.ai/developers/model-capabilities/audio/ephemeral-tokens
- xAI pricing: https://docs.x.ai/developers/pricing
