---
'kimaki': patch
---

Self-restart the process after 50 consecutive failed Discord gateway reconnect attempts instead of retrying forever. Uses the same spawn-and-exit pattern as SIGUSR2, so it works whether or not the `bin.ts` auto-restart wrapper is the parent process (e.g. when started directly via `tsx src/cli`).
