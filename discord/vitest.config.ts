// Vitest configuration for the kimaki discord package.
// Injects KIMAKI_VITEST=1 so config.ts and db.ts auto-isolate from the real
// ~/.kimaki/ database and the running bot's Hrana server.
//
// CPU profiling: set VITEST_CPU_PROF=1 to generate .cpuprofile files in
// ./tmp/cpu-profiles/. Analyze with: node ../profano/dist/cli.js tmp/cpu-profiles/CPU.*.cpuprofile
// Run only one test file at a time to avoid overloading the machine:
//   VITEST_CPU_PROF=1 pnpm test --run src/some-file.test.ts

import { defineConfig } from 'vitest/config'

const cpuProf = process.env.VITEST_CPU_PROF === '1'

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
        // Single fork when profiling to keep output manageable and not hang CPU
        maxForks: cpuProf ? 1 : 4,
        execArgv: cpuProf
          ? ['--cpu-prof', '--cpu-prof-dir=tmp/cpu-profiles']
          : [],
      },
    },
  },
})
