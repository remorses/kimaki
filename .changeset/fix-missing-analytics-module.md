---
'kimaki': patch
---

Fix source builds failing because `cli/src/analytics.ts` was missing from the repository.

`session-handler/thread-session-runtime.ts` imports `../analytics.js`, but the module itself was never committed, so building or running from a fresh clone failed immediately:

```
src/session-handler/thread-session-runtime.ts(106,8): error TS2307:
  Cannot find module '../analytics.js' or its corresponding type declarations.
```

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../cli/dist/analytics.js'
    imported from .../cli/dist/session-handler/thread-session-runtime.js
```

Published npm builds were unaffected because they ship a prebuilt `dist/`. Only contributors, forks, and anyone running a patched build from source hit this. `pnpm --filter kimaki build` and `pnpm tsc` now succeed on a clean checkout.

Fixes #182
Fixes #183
