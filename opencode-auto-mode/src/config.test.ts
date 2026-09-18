import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { JEV_MODEL, loadConfig } from './config.ts'

const originalEnv = process.env.OPENCODE_AUTO_MODE

afterEach(() => {
  if (originalEnv === undefined) delete process.env.OPENCODE_AUTO_MODE
  else process.env.OPENCODE_AUTO_MODE = originalEnv
})

describe('loadConfig', () => {
  test('returns disabled without file or env', () => {
    expect(loadConfig({ projectDir: '/nonexistent' })).toEqual({ kind: 'disabled' })
  })

  test('loads find-up auto-mode.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-mode-config-'))
    fs.mkdirSync(path.join(dir, '.opencode'))
    fs.writeFileSync(
      path.join(dir, '.opencode', 'auto-mode.json'),
      JSON.stringify({ model: 'main' }),
    )
    const loaded = loadConfig({ projectDir: dir })
    expect(loaded.kind).toBe('enabled')
    if (loaded.kind === 'enabled') {
      expect(loaded.config.model).toBe('main')
    }
  })

  test('invalid json fails closed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-mode-bad-json-'))
    fs.mkdirSync(path.join(dir, '.opencode'))
    fs.writeFileSync(path.join(dir, '.opencode', 'auto-mode.json'), '{')
    expect(loadConfig({ projectDir: dir })).toMatchObject({ kind: 'invalid' })
  })

  test('invalid env json fails closed', () => {
    process.env.OPENCODE_AUTO_MODE = '{'
    expect(loadConfig({ projectDir: '/nonexistent' })).toMatchObject({ kind: 'invalid' })
  })

  test('unknown keys fail closed', () => {
    process.env.OPENCODE_AUTO_MODE = JSON.stringify({ extra: true })
    expect(loadConfig({ projectDir: '/nonexistent' })).toMatchObject({ kind: 'invalid' })
  })

  test('non-object json fails closed', () => {
    process.env.OPENCODE_AUTO_MODE = '[]'
    expect(loadConfig({ projectDir: '/nonexistent' })).toMatchObject({ kind: 'invalid' })
    process.env.OPENCODE_AUTO_MODE = 'null'
    expect(loadConfig({ projectDir: '/nonexistent' })).toMatchObject({ kind: 'invalid' })
  })

  test('env timeout does not overwrite file model', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-mode-merge-'))
    fs.mkdirSync(path.join(dir, '.opencode'))
    fs.writeFileSync(
      path.join(dir, '.opencode', 'auto-mode.json'),
      JSON.stringify({ model: 'main' }),
    )
    process.env.OPENCODE_AUTO_MODE = JSON.stringify({ timeoutMs: 500 })
    const loaded = loadConfig({ projectDir: dir })
    expect(loaded).toMatchObject({
      kind: 'enabled',
      config: { model: 'main', timeoutMs: 500 },
    })
  })

  test('defaults to Jev with a conservative allow threshold', () => {
    process.env.OPENCODE_AUTO_MODE = '{}'
    expect(loadConfig({ projectDir: '/nonexistent' })).toMatchObject({
      kind: 'enabled',
      config: { model: JEV_MODEL, allowProbability: 0.9 },
    })
  })

  test('accepts main and Jev only', () => {
    process.env.OPENCODE_AUTO_MODE = JSON.stringify({ model: 'main' })
    expect(loadConfig({ projectDir: '/nonexistent' })).toMatchObject({
      kind: 'enabled',
      config: { model: 'main' },
    })
    process.env.OPENCODE_AUTO_MODE = JSON.stringify({ model: JEV_MODEL })
    expect(loadConfig({ projectDir: '/nonexistent' })).toMatchObject({
      kind: 'enabled',
      config: { model: JEV_MODEL },
    })
    process.env.OPENCODE_AUTO_MODE = JSON.stringify({ model: 'anthropic/claude-haiku-4-5' })
    expect(loadConfig({ projectDir: '/nonexistent' })).toMatchObject({ kind: 'invalid' })
  })

  test('validates allow probability', () => {
    process.env.OPENCODE_AUTO_MODE = JSON.stringify({ allowProbability: 0.8 })
    expect(loadConfig({ projectDir: '/nonexistent' })).toMatchObject({
      kind: 'enabled',
      config: { allowProbability: 0.8 },
    })
    process.env.OPENCODE_AUTO_MODE = JSON.stringify({ allowProbability: 2 })
    expect(loadConfig({ projectDir: '/nonexistent' })).toMatchObject({ kind: 'invalid' })
  })
})
