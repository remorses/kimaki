// Vitest config for cli2. KIMAKI_VITEST=1 silences the logger unless
// KIMAKI_TEST_LOGS=1. E2E files spawn their own isolated OpenCode server, so
// files can run in parallel forks without sharing any state.

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    testTimeout: 10_000,
    hookTimeout: 60_000,
    env: {
      KIMAKI_VITEST: '1',
    },
    pool: 'forks',
  },
})
