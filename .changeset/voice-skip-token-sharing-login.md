---
'kimaki': patch
---

Voice calls and ChatGPT voice transcription use only a Codex login of OpenCode (`chatgpt-browser` or `chatgpt-headless`). The new "ChatGPT token sharing" login is skipped: OpenAI rejects it with `401 rejected_by_access_enforcement` on GPT-Live and dictation. An expired Codex login no longer hides a valid one, and the voice call error says which login to add:

```
kimaki login openai --method chatgpt-browser
```
