// Regression tests for Windows OpenCode command resolution and spawn args.

import fs from 'node:fs'
import { createRequire } from 'node:module'
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

describe('buildOpencodeServeArgs', () => {
  test('omits hostname when unset so opencode stays on 127.0.0.1', async () => {
    const { buildOpencodeServeArgs } = await import('./opencode.js')
    expect(buildOpencodeServeArgs({ port: 4096 })).toEqual([
      'serve',
      '--port',
      '4096',
      '--print-logs',
      '--log-level',
      'WARN',
    ])
  })

  test('passes --hostname when set', async () => {
    const { buildOpencodeServeArgs } = await import('./opencode.js')
    expect(
      buildOpencodeServeArgs({ port: 4096, hostname: '0.0.0.0' }),
    ).toEqual([
      'serve',
      '--port',
      '4096',
      '--hostname',
      '0.0.0.0',
      '--print-logs',
      '--log-level',
      'WARN',
    ])
  })
})

describe('resolveSubrouterPluginSpec', () => {
  test('uses npm package identity in production for OpenCode deduplication', async () => {
    const { resolveSubrouterPluginSpec } = await import('./opencode.js')
    const require = createRequire(import.meta.url)
    const packageJsonPath = require.resolve('@subrouter/opencode/package.json')
    const version = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version
    expect(resolveSubrouterPluginSpec({ isDev: false })).toBe(
      `@subrouter/opencode@${version}`,
    )
  })

  test('loads workspace source directly in development', async () => {
    const { resolveSubrouterPluginSpec } = await import('./opencode.js')
    expect(resolveSubrouterPluginSpec({ isDev: true })).toMatch(
      /^file:.*\/subrouter\/opencode\/dist\/index\.js$/,
    )
  })
})

describe('publicOpencodeBindRequiresPassword', () => {
  test('allows loopback without a password', async () => {
    const { publicOpencodeBindRequiresPassword } = await import('./opencode.js')
    expect(publicOpencodeBindRequiresPassword({ hostname: null })).toBe(false)
    expect(publicOpencodeBindRequiresPassword({ hostname: '127.0.0.1' })).toBe(
      false,
    )
    expect(publicOpencodeBindRequiresPassword({ hostname: 'localhost' })).toBe(
      false,
    )
  })

  test('requires a password for 0.0.0.0', async () => {
    const { publicOpencodeBindRequiresPassword } = await import('./opencode.js')
    expect(publicOpencodeBindRequiresPassword({ hostname: '0.0.0.0' })).toBe(
      true,
    )
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
