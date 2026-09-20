---
'kimaki': patch
---

Fix questions that were answered after the session was aborted elsewhere. When you aborted a session in another opencode client, its run went idle, so answering the Discord dropdown had no effect and your choice was silently dropped. Kimaki now detects the idle session and resumes it by sending your answers back as a new prompt, so the session continues instead of hanging.
