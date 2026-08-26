---
'kimaki': patch
---

Stop transcribing iOS and Discord video uploads as voice notes.

Videos from iOS (`.mov` screen recordings, camera clips) include `duration`, so Kimaki treated them as audio and replaced the user's text with a transcription. Video attachments now stay as files. Voice notes and uploaded audio (`.ogg`, `.m4a`, `.mp3`, `.wav`) still transcribe as before.
