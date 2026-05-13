---
'kimaki': minor
---

Add text-to-speech audio generation via `kimaki tts` CLI command.

Generate speech audio from text using OpenAI (`gpt-4o-mini-tts`) or Google Gemini (`gemini-2.5-flash-preview-tts`). Provider is auto-detected from the API key prefix (`sk-*` = OpenAI, otherwise Gemini).

```bash
# Generate audio file
kimaki tts "Hello world" --voice alloy --output greeting.mp3

# Generate and upload directly to a Discord thread
kimaki tts "Build summary" --session ses_xxx
```

The command resolves API keys from the database (same keys set via `/transcription-key`), then falls back to `OPENAI_API_KEY` / `GEMINI_API_KEY` env vars.

Also refactors the API key dialog into a reusable `showApiKeyRequiredButton()` so both transcription and TTS share the same "Set API Key" button flow.
