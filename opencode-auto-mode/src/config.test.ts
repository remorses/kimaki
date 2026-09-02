import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { loadConfig, parseModelId } from './config.ts'

const originalEnv = process.env.OPENCODE_AUTO_MODE

afterEach(() => {
  if (originalEnv === undefined) delete process.env.OPENCODE_AUTO_MODE
  else process.env.OPENCODE_AUTO_MODE = originalEnv
})

describe('parseModelId', () => {
  test('parses provider/model', () => {
    expect(parseModelId('anthropic/claude-haiku-4-5')).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-haiku-4-5',
    })
  })
})

describe('loadConfig', () => {
  test('returns null without file or env', () => {
    expect(loadConfig({ projectDir: '/nonexistent' })).toBe(null)
  })

  test('loads find-up auto-mode.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-mode-config-'))
    fs.mkdirSync(path.join(dir, '.opencode'))
    fs.writeFileSync(
      path.join(dir, '.opencode', 'auto-mode.json'),
      JSON.stringify({ model: 'anthropic/claude-haiku-4-5' }),
    )
    expect(loadConfig({ projectDir: dir })?.model).toBe('anthropic/claude-haiku-4-5')
  })
})
