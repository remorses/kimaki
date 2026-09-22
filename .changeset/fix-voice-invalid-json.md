---
'kimaki': patch
---

Fix Discord voice transcription failing with `Invalid JSON response`.

OpenAI voice notes now call the Chat Completions API directly. `gpt-audio-1.5` can return the transcript in `message.audio`, and the installed AI SDK rejects that field. The parser reads `tool_calls` and `message.audio.transcript` from the documented response.
