---
'kimaki': patch
---

Transcribe uploaded audio files that Discord labels with unusual media types.

- MP3 files reported as `audio/mpeg3` (or `audio/x-mpeg-3`, `audio/mpg`) are now sent to OpenAI as mp3 instead of failing with "unsupported audio type".
- Audio-only `.m4a` files reported as `video/mp4` are now detected as audio and transcribed, instead of being skipped.
- Every provider (OpenAI, Gemini, hosted kimaki.dev Whisper) now gets one canonical media type, taken from the Discord type or the file extension.

Fixes #235
