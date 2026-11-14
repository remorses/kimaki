---
'kimaki': patch
---

Retry voice transcription through short outages, and add a Retry button when it still fails.

- When every transcriber fails with a network error, 408, 409, 429 or 5xx, Kimaki tries them all again after 2s, 4s, 8s and so on (at most 30s apart) until the 2-minute transcription limit. Before, it gave up after about 1.5 seconds.
- While it waits, one subtext reply under the voice message shows `-# transcription failed, retrying in 4s (attempt 2)`. It is edited each round and deleted once the transcription works.
- When transcription fails, the error reply has a **Retry** button. A click handles the same voice message again, as if it had just arrived, so queue, btw, new session and a spoken agent work as usual.
- The free kimaki.dev Whisper transcriber now gets the same quick retries as the other providers.
- Bad keys, content filter refusals and empty transcriptions still fail at once, with the Retry button.

Refs #263
