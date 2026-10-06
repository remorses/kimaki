---
'kimaki': patch
---

`kimaki send` works without a local bot again, for example in CI.

```bash
KIMAKI_BOT_TOKEN=... kimaki send --channel 123456789012345678 --prompt 'Run the nightly checks'
```

When no Kimaki bot runs on the machine, `send` posts the prompt to the channel with the bot token, and the Kimaki bot that owns the channel starts the session and replies with the thread and session IDs. It needs `--channel` or `--thread`; `--wait` and `--send-at` still need a local bot.

`KIMAKI_BOT_TOKEN` now also works for `kimaki user list` and `kimaki upload-to-discord`, without a `kimaki.db`.
