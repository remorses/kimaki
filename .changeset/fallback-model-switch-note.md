---
'@kimaki/plugin-fallback': minor
---

Tell the agent when fallback moves its session to another model. The new model gets a system note with the old model, the new model and the reason, starting with the retried request:

```
<model-fallback>
This session ran on google/gemini-3.8-flash. The fallback plugin moved it to anthropic/claude-opus-5-5, the model you are now, because a request to the previous model failed: its login failed (expired or invalid credentials).
Tools, input types (audio, video, images) and other abilities that google/gemini-3.8-flash had may be missing on this model. Earlier messages may assume them.
If the task needs an ability you do not have, tell the user plainly. Never claim you used a tool, heard audio or saw content that you cannot access.
</model-fallback>
```

Before, the agent did not know about the switch. A Gemini agent used for audio input was moved to Claude, which then claimed it had heard the audio.

The switch is stored in the session metadata (`fallback` key), so the note survives restarts and compaction. It goes away when the session is switched to another model by hand.
