---
'kimaki': minor
'@kimaki/realtime': minor
'website': minor
---

Add voice calls. Kimaki creates one **Kimaki voice** channel per computer (in the `Kimaki <machine>` category). Join it and talk: a realtime voice model answers and controls your coding agents with the `kimaki` CLI.

```
you ──voice──▶ Kimaki voice ──▶ realtime model ──shell──▶ kimaki send / session list / read / wait
```

- The model runs commands in the Kimaki data folder. For coding work it starts sessions with `kimaki send` and adds everyone in the call to the new thread.
- Slow commands like `kimaki session wait` run in the background; the model tells you the result when they end.
- The text chat of the voice channel shows transcripts, tool lines and links. Type there to talk to the model without speaking.
- The call ends when the last user leaves, or when you ask the model to hang up (`end_call` tool).
- Keys: the same as voice transcription (`/transcription-key`, `kimaki bot keys set`). OpenAI `gpt-realtime-2.1` first, then xAI (built-in `web_search` and `x_search`), then Gemini (built-in Google Search). `/transcription-key` and `kimaki bot keys set --xai` now accept xAI keys.

Other changes:

- `kimaki send --user` is repeatable. Every user joins the thread; the first is the author. Scheduled tasks still take one user.
- `kimaki upload-to-discord --channel <voice channel>` posts into the voice channel chat. Inside a voice call it is the default.
- `@kimaki/realtime`: `gemini({ builtinTools: [{ googleSearch: {} }] })` enables Gemini Live server-side tools.

```bash
kimaki send --channel 123 --prompt 'Fix the signup link' --user 111 --user 222
```
