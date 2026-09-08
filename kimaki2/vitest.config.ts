import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.e2e.test.ts'],
    testTimeout: 30_000,
  },
})
