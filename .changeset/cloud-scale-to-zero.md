---
'kimaki': minor
'website': minor
---

Add scale-to-zero for Kimaki Cloud machines.

Cloud machines now idle-exit after 10 minutes with no busy session, then Fly stops the VM. A Discord message or a due scheduled task / sleep wakes the machine again.

While the machine boots, gateway-proxy shows **kimaki is typing** in the channel or thread that sent the message.

Scheduled tasks stay in local SQLite. The cloud only stores `next_wake_at` on `gateway_clients` so the always-on gateway can start the machine ~30s early.

Enable with `KIMAKI_SCALE_TO_ZERO=1`. Cloud init sets this plus `KIMAKI_LOCK_PORT=8080` so `/kimaki/wake` is on the Fly HTTP port.
