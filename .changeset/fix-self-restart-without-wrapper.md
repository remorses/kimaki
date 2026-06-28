---
'kimaki': patch
---

Fix bot not restarting after gateway reconnect limit when running without the `bin.ts` wrapper (e.g. `tsx src/cli.ts` in local dev).

The previous fallback used a detached `spawn()` + `process.exit(0)` which was unreliable: the child could be killed before starting, there was no backoff between restarts, and spawn failures were silent.

Now `selfRestart` always exits with code 1. When running under the `bin.ts` wrapper (`tsx src/bin.ts` or `kimaki` from npm), the wrapper catches the non-zero exit and restarts with exponential backoff and crash-loop detection. When running without the wrapper, the process exits with a warning suggesting to use `bin.ts`.
