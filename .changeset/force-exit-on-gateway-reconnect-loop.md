---
'kimaki': patch
---

Force-exit the process after 50 consecutive failed Discord gateway reconnect attempts instead of retrying forever. The `bin.ts` auto-restart wrapper then starts a fresh process, which is more likely to recover than a zombie bot stuck in an infinite reconnection loop.
