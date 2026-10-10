---
'website': minor
---

Add the Kimaki Cloud dashboard at `/dashboard`: create, pause, resume and delete managed Kimaki machines on Fly.io.

An **active** machine sleeps when idle and wakes on the next Discord message or scheduled task. A **paused** machine never wakes until you resume it.

```
/dashboard/create ─▶ Fly app + secrets + volume + machine (not launched)
                  ─▶ /dashboard/machines/:id ─▶ Authorize on Discord
                  ─▶ OAuth callback writes gateway_clients with the Fly URL ─▶ machine starts
```

- Sign in with Discord (identify and email scopes only).
- Creating machines is limited to `CLOUD_PROVISION_ALLOWLIST`, a comma-separated list of Discord user ids or emails. An empty list provisions nobody.
- Each machine gets its own Fly app (`kimaki-cloud-{user}-{random}`) on its own private network, with a shared IPv4 and an IPv6. Its volume keeps daily snapshots for 14 days (Fly default is 5). The `clientId:secret` token is a Fly secret, not machine env.
- Delete force-removes the Fly app (also while the machine runs) and every `gateway_clients` row of the machine. If Fly cannot delete the app, the machine row stays with the error so the VM is not lost while it still bills.
- Cost copy shows storage plus compute **if always on**.
