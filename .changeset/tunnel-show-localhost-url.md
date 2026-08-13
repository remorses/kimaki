---
'kimaki': patch
---

`kimaki tunnel` now prints both the **localhost** URL and the public tunnel URL after it connects.

Never use the tunnel URL for local testing. Use localhost instead; it is much faster. The CLI still prints the tunnel URL so people who are not on the same machine can open the app.

```
Connected with Traforo!

Local:  http://localhost:5173
Tunnel: https://abc123-tunnel.kimaki.dev

NEVER use the tunnel URL for local testing. Use the local URL instead; it is much faster.
Always show both URLs to the user. The local URL works when they are on the same machine.
```
