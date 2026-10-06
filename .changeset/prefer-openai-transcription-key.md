---
'kimaki': patch
---

Voice transcription and `kimaki tts` now prefer any OpenAI key over any Gemini key. Before, a Gemini key saved with `/transcription-key` won over an `OPENAI_API_KEY` env var. Now the order is:

1. saved OpenAI key
2. `OPENAI_API_KEY`
3. saved Gemini key
4. `GEMINI_API_KEY`

Gemini's content filter sometimes blocks harmless voice messages, so OpenAI is used whenever one is available.
