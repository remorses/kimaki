---
'kimaki': patch
---

Skip joining Discord voice channels when no Gemini API key is configured. Previously the bot would join and then fail when trying to start the live audio session. Now it logs a message telling the user to set an API key via `/audio-api-key`.
