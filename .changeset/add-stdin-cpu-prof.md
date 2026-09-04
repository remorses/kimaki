---
'kimaki': minor
---

Add a `cpuprof` stdin command to capture a CPU profile from a running Kimaki process.

In the terminal where Kimaki is running, type `cpuprof` and press Enter. Type it again to stop, or wait 20 seconds for auto-stop. The profile is written to `~/.kimaki/cpu-profiles/` (or `<data-dir>/cpu-profiles/`).

```
cpuprof
```

Open the `.cpuprofile` file in Chrome DevTools (Performance tab) or with `bunx profano`. Stdin must be a TTY. Heap snapshots still use `kill -SIGUSR1`.
