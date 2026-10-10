---
'kimaki': minor
'website': minor
---

Add scale-to-zero for Kimaki Cloud machines.

With `KIMAKI_SCALE_TO_ZERO=1`, the bot exits after 10 minutes with no running session, queued message, background shell or scheduler tick (`KIMAKI_SCALE_TO_ZERO_IDLE_MS` changes the window). Fly then stops the VM. A Discord message, or a scheduled task or `kimaki sleep` that is due, starts it again:

```
idle 10 min ─▶ POST kimaki.dev/api/cloud/next-wake (soonest task or sleep) ─▶ exit 0 ─▶ VM stops
Discord message, or next_wake_at - 30s ─▶ gateway-proxy ─▶ POST <machine>/kimaki/wake ─▶ VM starts
```

- Tasks and sleeps stay in local SQLite. The cloud only stores `next_wake_at`. If that write fails, the bot stays up, so a stopped VM never misses a task.
- While the VM boots, gateway-proxy shows **typing** in the channel that sent the message.
- Slash commands and button clicks do not wake a stopped VM: Discord needs an answer within 3 seconds. Send a message first.
- `KIMAKI_INTERNET_REACHABLE_URL` binds the lock server on `0.0.0.0`, so gateway-proxy reaches `POST /kimaki/wake`. The route answers after Discord and OpenCode are ready and checks the bot's `clientId:secret`. Other lock routes still need the local lock token.
- `kimaki --gateway` now uses a gateway `KIMAKI_BOT_TOKEN` from the env instead of starting a new install.
- The bot removes `KIMAKI_BOT_TOKEN` from its env after it saves the credentials, so the OpenCode service and agent shells do not inherit it.
