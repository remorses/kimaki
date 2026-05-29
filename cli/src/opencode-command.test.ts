// Regression tests for Windows OpenCode command resolution and spawn args.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  ensureKimakiCommandShim,
  getSpawnCommandAndArgs,
  sanitizeShimExecArgv,
  selectResolvedCommand,
  splitCommandLookupOutput,
} from './opencode-command.js'

describe('splitCommandLookupOutput', () => {
  test('splits windows command lookup output into trimmed lines', () => {
    expect(
      splitCommandLookupOutput(
        'C:\\Program Files\\nodejs\\opencode\r\nC:\\Program Files\\nodejs\\opencode.cmd\r\n',
      ),
    ).toEqual([
      'C:\\Program Files\\nodejs\\opencode',
      'C:\\Program Files\\nodejs\\opencode.cmd',
    ])
  })
})

describe('selectResolvedCommand', () => {
  test('prefers npm cmd shims on windows', () => {
    expect(
      selectResolvedCommand({
        output: 'C:\\Program Files\\nodejs\\opencode\r\nC:\\Program Files\\nodejs\\opencode.cmd\r\n',
        isWindows: true,
      }),
    ).toBe('C:\\Program Files\\nodejs\\opencode.cmd')
  })

  test('keeps first result on non-windows platforms', () => {
    expect(
      selectResolvedCommand({
        output: '/usr/local/bin/opencode\n/opt/homebrew/bin/opencode\n',
        isWindows: false,
      }),
    ).toBe('/usr/local/bin/opencode')
  })
})

describe('getSpawnCommandAndArgs', () => {
  test('wraps windows cmd shims through cmd.exe without double-quoting by node', () => {
    expect(
      getSpawnCommandAndArgs({
        resolvedCommand: 'C:\\Program Files\\nodejs\\opencode.cmd',
        baseArgs: ['serve', '--port', '4096'],
        platform: 'win32',
      }),
    ).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', '"C:\\Program Files\\nodejs\\opencode.cmd"', 'serve', '--port', '4096'],
      windowsVerbatimArguments: true,
    })
  })

  test('leaves direct executables unchanged on windows', () => {
    expect(
      getSpawnCommandAndArgs({
        resolvedCommand: 'C:\\tools\\opencode.exe',
        baseArgs: ['serve', '--port', '4096'],
        platform: 'win32',
      }),
    ).toEqual({
      command: 'C:\\tools\\opencode.exe',
      args: ['serve', '--port', '4096'],
    })
  })
})

describe('sanitizeShimExecArgv', () => {
  test('strips --env-file=value single-arg form', () => {
    expect(
      sanitizeShimExecArgv([
        '--require',
        '/abs/tsx/preflight.cjs',
        '--env-file=.env',
        '--import',
        'file:///abs/tsx/loader.mjs',
      ]),
    ).toEqual([
      '--require',
      '/abs/tsx/preflight.cjs',
      '--import',
      'file:///abs/tsx/loader.mjs',
    ])
  })

  test('strips --env-file value two-arg form and its value', () => {
    expect(
      sanitizeShimExecArgv(['--env-file', '.env', '--require', '/abs/preflight.cjs']),
    ).toEqual(['--require', '/abs/preflight.cjs'])
  })

  test('strips --env-file-if-exists in both forms', () => {
    expect(
      sanitizeShimExecArgv([
        '--env-file-if-exists=.env',
        '--env-file-if-exists',
        '/abs/.env',
        '--enable-source-maps',
      ]),
    ).toEqual(['--enable-source-maps'])
  })

  test('leaves unrelated flags untouched', () => {
    expect(
      sanitizeShimExecArgv(['--enable-source-maps', '--max-old-space-size=4096']),
    ).toEqual(['--enable-source-maps', '--max-old-space-size=4096'])
  })
})

describe('ensureKimakiCommandShim', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-shim-test-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  test('generated posix shim does not contain a relative --env-file flag', () => {
    const result = ensureKimakiCommandShim({
      dataDir: tempDir,
      execPath: '/usr/bin/node',
      execArgv: [
        '--require',
        '/abs/tsx/preflight.cjs',
        '--env-file=.env',
        '--import',
        'file:///abs/tsx/loader.mjs',
      ],
      entryScript: '/abs/cli/src/cli',
      platform: 'linux',
    })
    expect(result).not.toBeInstanceOf(Error)
    const shimContent = fs.readFileSync(path.join(tempDir, 'bin', 'kimaki'), 'utf8')
    expect(shimContent).not.toContain('--env-file')
    expect(shimContent).toContain('/abs/tsx/preflight.cjs')
    expect(shimContent).toContain('/abs/cli/src/cli')
  })
})
