---
'kimaki': minor
'website': patch
---

Add `kimaki --voice <name>` to choose the voice of voice calls. Pass it once: Kimaki saves it in SQLite, so `kimaki restart`, crashes, reboots and the OpenCode autostart keep it.

```bash
kimaki --voice cedar      # OpenAI voice
kimaki --voice Kore       # Gemini voice, case-insensitive
kimaki --voice default    # back to the provider default
```

- Defaults: `marin` (OpenAI), `eve` (xAI), `Puck` (Gemini). The first line of a call shows the voice: `⬦ voice call started ⋅ gpt-realtime-2.1 ⋅ marin`.
- An unknown name stops the start with the list of voices, before the running bot is stopped.
- The voice picks its provider when that key is set: `--voice Kore` uses Gemini even if an OpenAI key exists. Without that key, the call uses the usual key order with the provider default and says so in the voice channel chat.
- Precedence: `--voice` flag, then the saved voice, then the provider default.
