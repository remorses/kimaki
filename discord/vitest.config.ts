// Vitest configuration for the kimaki discord package.
// Injects KIMAKI_VITEST=1 so config.ts and db.ts auto-isolate from the real
// ~/.kimaki/ database and the running bot's Hrana server.

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    env: {
      KIMAKI_VITEST: '1',
    },
    // Cap worker count to avoid CPU contention during TypeScript compilation.
    // With 10 CPUs and default maxThreads=cpus, all workers compile the same
    // heavy module graph (discord.js, prisma, opencode SDK) in parallel,
    // thrashing the CPU and inflating collect time from ~8s to ~90s.
    // 4 workers keeps collect at ~8s with 360% CPU utilization — the sweet spot.
    pool: 'threads',
    poolOptions: {
      threads: {
        maxThreads: 4,
      },
    },
  },
})
