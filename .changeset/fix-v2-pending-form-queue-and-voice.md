---
'kimaki': patch
---

Keep queued Discord messages parked while a question form is pending, and cancel the form when a new message or voice note dismisses it.

v2 can go idle while a question dropdown is still on screen. Kimaki no longer drains `/queue` items in that window. Voice notes now cancel the form first, then send the transcription as a normal prompt instead of leaving the old question marker as the latest user text.
