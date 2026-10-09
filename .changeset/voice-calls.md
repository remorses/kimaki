---
'kimaki': minor
'@kimaki/realtime': minor
'website': minor
---

Add voice calls. Kimaki creates one **Kimaki voice &lt;machine&gt;** channel per computer, outside any category (drag it where you want). Join it and talk: a realtime voice model answers and controls your coding agents with the `kimaki` CLI.

```
you ──voice──▶ Kimaki voice ──▶ realtime model ──shell──▶ kimaki send / session list / read / wait
```

- The model runs commands in the Kimaki data folder. For coding work it starts threads with `kimaki send --wait` as a background command and adds everyone in the call to the new thread. When the thread finishes, the same command returns its transcript, so the model is notified and gets the result together, and tells you what the thread did.
- When a thread of any project finishes or fails during a call, the text chat shows `⬦ thread finished: <title> ⋅ <thread URL> ⋅ <session ID>` and the model gets the same notice, so it never polls. It answers out loud only for threads it started in the call.
- In a call, "thread" and "session" mean the same thing (one OpenCode session per Discord thread). The model says "thread", never "task".
- Slow commands like `kimaki send --wait` and `kimaki session wait` run in the background; the model tells you the result when they end.
- The text chat of the voice channel shows transcripts, links and a line for every tool call, formatted like in session threads. Status lines show new threads (`⬦ session started in #thread`), finished background commands, failed tools and model reconnects. Type there to talk to the model without speaking.
- The model knows your global OpenCode `AGENTS.md` and your global skills (with the path of each `SKILL.md`, which it reads before using a skill). Both load once when the call starts.
- The call ends when the last user leaves, or when you ask the model to hang up (`end_call` tool).
- Keys: the same as voice transcription (`/transcription-key`, `kimaki bot keys set`). OpenAI `gpt-realtime-2.1` first (web search through a `web_search` tool that calls the Responses API with the same key), then xAI (built-in `web_search` and `x_search`), then Gemini (built-in Google Search). `/transcription-key` and `kimaki bot keys set --xai` now accept xAI keys.

Other changes:

- `kimaki send --user` is repeatable. Every user joins the thread; the first is the author. Scheduled tasks still take one user.
- `kimaki upload-to-discord --channel <voice channel>` posts into the voice channel chat. Inside a voice call it is the default.
- `@kimaki/realtime`: `gemini({ builtinTools: [{ googleSearch: {} }] })` enables Gemini Live server-side tools. Google Search queries arrive as `tool.builtin` events.

```bash
kimaki send --channel 123 --prompt 'Fix the signup link' --user 111 --user 222
```
