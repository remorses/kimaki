---
'kimaki': patch
---

Log the text of every prompt Kimaki receives, so a prompt can be recovered from `kimaki.log` when its session never started.

Before, the log only said who sent a message and where. When a session failed to start (for example because the OpenCode plugin failed to load), a slash command prompt was lost: Discord only kept the thread name, cut to 80 characters.

Now Discord messages, slash command prompts, voice transcriptions, edited queued messages, `/btw`, routines and `kimaki send` each log one line with the prompt text before anything can fail. Prompts over 4000 characters are cut, and newlines are escaped so each prompt stays on one line:

```
2026-11-15T13:51:31.000Z LOG   [PROMPT] steer from xmorse in new session in channel 1451285274616401931: "read ses_e33646dd8ffeRusoZagWj4XrjM. can we make the rendering of pixels embedded..."
```
