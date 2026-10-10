---
'kimaki': minor
---

Voice messages and voice calls now use your **ChatGPT subscription** when you signed in to OpenCode with "Sign in with ChatGPT". No API credits are used.

Voice calls connect to the OpenAI Realtime API (`gpt-realtime-2.1`) with the ChatGPT token stored by OpenCode, before any OpenAI, xAI or Gemini key. The `web_search` tool of a call still needs an OpenAI API key, because the token has no Responses API scope.

Voice messages keep using an OpenAI key first, because only the API key route detects voice instructions like "queue this" or "use the plan agent". ChatGPT dictation (the private endpoint the ChatGPT and Codex desktop apps use) comes next. A failing provider now falls through to the next one:

1. OpenAI key (saved, then `OPENAI_API_KEY`)
2. ChatGPT subscription signed in to OpenCode
3. Gemini key (saved, then `GEMINI_API_KEY`)
4. hosted Whisper on kimaki.dev (gateway mode)

Kimaki reads the ChatGPT credential from OpenCode's database read-only and never refreshes it.
