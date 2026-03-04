// Vitest configuration for the kimaki discord package.
// Injects KIMAKI_VITEST=1 so config.ts and db.ts auto-isolate from the real
// ~/.kimaki/ database and the running bot's Hrana server.

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    env: {
      KIMAKI_VITEST: '1',
    },
    // Use forked workers so e2e suites that mutate process.env (KIMAKI_DB_URL,
    // KIMAKI_LOCK_PORT, etc.) do not race across files. Thread workers share
    // process-wide env state and caused flaky cross-suite failures.
    // Cap workers to avoid CPU contention during TypeScript compilation.
    pool: 'forks',
    poolOptions: {
      forks: {
        maxForks: 4,
      },
    },
  },
})
