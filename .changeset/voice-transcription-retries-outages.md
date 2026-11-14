---
'kimaki': patch
---

Retry voice transcription through short outages instead of losing the voice message.

- When every transcriber fails with a network error, 408, 409, 429 or 5xx, Kimaki tries them all again after 2s, 4s, 8s and so on (at most 30s apart) until the 2-minute transcription limit. Before, it gave up after about 1.5 seconds.
- The free kimaki.dev Whisper transcriber now gets the same quick retries as the other providers.
- Bad keys, content filter refusals and empty transcriptions still fail at once.

Refs #263
