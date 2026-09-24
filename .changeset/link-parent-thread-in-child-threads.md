---
'kimaki': patch
---

Show a link to the parent Discord thread in threads started with `kimaki send --parent-session`.

The starter message embed now includes `Parent thread: #thread-name` as a clickable link above the marker footer, so you can jump back to the thread that spawned the session. Works for direct sends and scheduled `--send-at` tasks. The link appears only when the parent session is bound to a thread on the same machine.
