import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import {
  countSystemPromptDiffLines,
  formatSystemPromptPatch,
  writeSystemPromptPatch,
} from './cache-rewrite.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('counts added and removed system prompt lines', () => {
  expect(countSystemPromptDiffLines({
    beforeText: 'keep\nold line\n',
    afterText: 'keep\nnew line\nextra\n',
  })).toEqual({ additions: 2, deletions: 1 })
})

test('writes a unified patch only for the caller', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-cache-rewrite-'))
  tempDirs.push(dataDir)
  const filePath = await writeSystemPromptPatch({
    dataDir,
    sessionId: 'ses_test',
    beforeText: 'alpha\n',
    afterText: 'beta\n',
    model: 'openai/gpt-5',
    agent: 'build',
    now: 1_700_000_000_000,
  })
  expect(path.basename(filePath)).toBe('1700000000000-ses_test.patch')
  const text = fs.readFileSync(filePath, 'utf8')
  expect(text).toContain('session: ses_test')
  expect(text).toContain('system +1 -1')
  expect(text).toContain('-alpha')
  expect(text).toContain('+beta')
  expect(formatSystemPromptPatch({
    beforeText: 'alpha\n',
    afterText: 'beta\n',
    sessionId: 'ses_test',
  })).toContain('--- system-before.txt')
})
