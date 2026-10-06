// OpenCode binary lookup: PATH names first, then the bundled @opencode/cli binary.

import { expect, test } from 'vitest'

import { bundledOpencodeBinary, resolveOpencodeBinary } from './opencode-server.ts'

test('falls back to the bundled binary, and fails with a hint when nothing is found', async () => {
  const bundled = bundledOpencodeBinary()
  expect(bundled).toMatch(/@opencode\/cli\/bin\/opencode\.exe$/)
  expect(await resolveOpencodeBinary({ candidates: ['kimaki-missing-opencode2', null, bundled] })).toBe(bundled)
  const missing = await resolveOpencodeBinary({ candidates: ['kimaki-missing-opencode2', null] })
  expect(missing instanceof Error ? missing.message : missing).toMatchInlineSnapshot(`"OpenCode service not reachable (no OpenCode >= 2.0.19: no opencode binary on PATH or in the kimaki install). Reinstall kimaki, or install OpenCode 2 with: npm i -g @opencode/cli"`)
})
