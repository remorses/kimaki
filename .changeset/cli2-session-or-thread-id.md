---
'kimaki-cli2': patch
---

Every command that targets a session now accepts a session ID, a Discord thread ID, or a Discord thread URL. Kimaki detects the kind from the format.

```bash
kimaki session title 'New title' --session 1556973287077060629
kimaki session read https://discord.com/channels/<guild>/<thread>
kimaki sleep --duration 2h --session ses_abc123
```

- `--session` on `session title|queue|command|shell|btw|diff|cwd`, `buttons`, `upload-request`, `upload-to-discord`, `sleep` and `send` takes all three formats.
- Positional IDs of `session read|events|url|wait|abort|archive|fork` take all three formats.
- `kimaki send --thread` also takes a thread URL.
- Removed `session cwd --thread` and `session archive --session`. Pass the thread to `--session` or as the positional ID.
- The system prompt asks agents to end commit messages with `Discord: https://discord.com/channels/<guild>/<thread>` instead of a bare session ID.
