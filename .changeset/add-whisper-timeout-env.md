---
'kimaki': patch
---

Add `KIMAKI_WHISPER_TIMEOUT` (seconds) to raise the 2 minute transcription limit for a slow local Whisper server, for example on CPU-only hardware with long voice messages. It applies only when `KIMAKI_WHISPER_URL` is set; the default is unchanged.

```bash
KIMAKI_WHISPER_URL=http://127.0.0.1:8000/v1 KIMAKI_WHISPER_TIMEOUT=600 kimaki
```

Fixes #257
