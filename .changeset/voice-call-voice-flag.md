---
'kimaki': minor
'website': patch
---

Add `kimaki --voice <name>` to choose the voice of voice calls. Pass it once: Kimaki saves it in SQLite, so `kimaki restart`, crashes, reboots and the OpenCode autostart keep it.

```bash
kimaki --voice juniper    # case-insensitive
kimaki --voice default    # back to cove
```

- The default is `cove`; the others are `arbor`, `breeze`, `ember`, `juniper`, `maple`, `sol`, `spruce` and `vale`. The first line of a call shows the voice: `⬦ voice call started ⋅ gpt-live ⋅ cove`.
- An unknown name stops the start with the list of voices, before the running bot is stopped.
- A saved voice GPT-Live does not know falls back to `cove`, and the voice channel chat says why.
- Precedence: `--voice` flag, then the saved voice, then `cove`.
