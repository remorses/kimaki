---
'kimaki': patch
---

Make voice transcription more reliable: retry on transient provider failures, and add clearer errors.

Gemini sometimes sends back a body without `candidates`, or a malformed function call. Before, the voice message failed right away with an opaque `⚠️ Transcription failed: ... Invalid JSON response`. Now Kimaki tries up to 3 times with a short backoff for:

- responses with no candidates, no tool call, or a bad finish reason like `MALFORMED_FUNCTION_CALL`
- cut-off responses (`MAX_TOKENS`, OpenAI `length`), which were never used as a partial transcription
- network errors
- HTTP 408, 409, 429 and 5xx

Client errors like an invalid API key and content filter blocks fail at once, without retries. Errors now show the HTTP status, the Gemini block or finish reason, and the start of the response body.

Voice transcription and `kimaki tts` now call the OpenAI and Gemini REST APIs directly with `fetch`. The `@ai-sdk/google`, `@ai-sdk/openai` and `@ai-sdk/provider` dependencies are removed, so the package has fewer dependencies. Gemini TTS audio now also gets the correct WAV header when Gemini returns `audio/L16;codec=pcm;rate=24000`.
