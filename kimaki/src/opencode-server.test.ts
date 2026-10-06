// OpenCode binary lookup: the first binary that answers --version decides.
// OpenCode 1 is an error with install instructions, never replaced.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'

import { findOpencodeBinary } from './opencode-server.ts'
import { opencodeBinary } from './test/harness.ts'

test('opencode2 wins, OpenCode 1 is an error, nothing found is null', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-opencode-bin-'))
  const v1 = path.join(dir, 'opencode')
  fs.writeFileSync(v1, '#!/bin/sh\necho 1.15.5\n', { mode: 0o755 })
  const v2 = opencodeBinary()
  const message = (value: Error | string | null) => (value instanceof Error ? value.message.replace(dir, '<dir>') : value)

  expect(await findOpencodeBinary({ candidates: ['kimaki-missing-opencode2', v2, v1] })).toBe(v2)
  expect(message(await findOpencodeBinary({ candidates: ['kimaki-missing-opencode2', v1, v2] }))).toMatchInlineSnapshot(`"Kimaki now requires OpenCode 2, but <dir>/opencode is OpenCode 1.15.5. Install OpenCode 2 with: curl -fsSL https://opencode.ai/v2/install | bash (or: npm i -g @opencode/cli). Then run kimaki again"`)
  expect(await findOpencodeBinary({ candidates: ['kimaki-missing-opencode2'] })).toBe(null)
  fs.rmSync(dir, { recursive: true, force: true })
})
