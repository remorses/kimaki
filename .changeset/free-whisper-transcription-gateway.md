---
'kimaki': minor
---

Voice message transcription now works out of the box for gateway-mode installs, even with no OpenAI or Gemini API key configured.

When a gateway-mode bot has no transcription key set, the CLI falls back to a free Whisper transcription endpoint on `kimaki.dev`, backed by Cloudflare Workers AI (`@cf/openai/whisper-large-v3-turbo`). This is authenticated with the same `clientId:clientSecret` credentials already used for gateway-proxy calls, so no extra setup is needed.

```
gateway-mode bot, no API key
        │
        ▼
kimaki.dev /api/transcribe  ──►  Cloudflare Workers AI (Whisper)  ──►  transcription text
```

If this free fallback is rate-limited or unavailable, the CLI still falls back to the existing "add API key" button so you can bring your own OpenAI/Gemini key for full context-aware transcription (which supports detecting `/queue` and agent hints spoken in the voice message — the free fallback does not).

Self-hosted bot installs are unaffected; this only applies to gateway mode, since it requires a registered `client_id`.
