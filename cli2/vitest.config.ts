// Vitest config for cli2. KIMAKI_VITEST=1 silences the logger unless
// KIMAKI_TEST_LOGS=1. E2E files spawn their own isolated OpenCode server, so
// files can run in parallel forks without sharing any state.
//
// Each e2e file costs one OpenCode server (~400 MB, CPU-heavy cold start),
// a bot and a Discord twin. One fork per CPU starts them all at once and the
// machine thrashes: waits time out on a busy machine, not on slow code. So
// forks are capped (KIMAKI_TEST_WORKERS overrides). testTimeout stays above
// the 10s waitFor clamp so a slow wait fails with its own label.

import os from 'node:os'
import { defineConfig } from 'vitest/config'

const workers = Number(process.env['KIMAKI_TEST_WORKERS']) || Math.max(2, Math.floor(os.availableParallelism() / 3))

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      KIMAKI_VITEST: '1',
    },
    pool: 'forks',
    maxWorkers: workers,
    minWorkers: 1,
  },
})
