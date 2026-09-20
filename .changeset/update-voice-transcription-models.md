---
'kimaki': patch
---

Update voice transcription to the current OpenAI and Google audio models. OpenAI transcription now uses `gpt-audio-1.5`, while Gemini uses the rolling `gemini-flash-latest` alias. Both paths continue to return structured queue, session-routing, and agent-selection results from spoken messages.
