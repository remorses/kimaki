---
'kimaki': minor
---

Voice messages now use your **ChatGPT subscription** when you signed in to OpenCode with "Sign in with ChatGPT". No API credits are used.

Voice messages keep using an OpenAI key first, because only the API key route detects voice instructions like "queue this" or "use the plan agent". ChatGPT dictation (the private endpoint the ChatGPT and Codex desktop apps use) comes next. A failing provider now falls through to the next one:

1. OpenAI key (saved, then `OPENAI_API_KEY`)
2. ChatGPT subscription signed in to OpenCode
3. Gemini key (saved, then `GEMINI_API_KEY`)
4. hosted Whisper on kimaki.dev (gateway mode)

Kimaki reads the ChatGPT credential from OpenCode's database read-only and never refreshes it.
