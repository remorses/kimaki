// Regression tests for Windows OpenCode command resolution and spawn args.

import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  ensureKimakiCommandShim,
  getIncompatibleOpencodeVersionError,
  getSpawnCommandAndArgs,
  INCOMPATIBLE_OPENCODE_MAJOR_VERSION,
  isIncompatibleOpencodeMajor,
  parseOpencodeVersion,
  sanitizeShimExecArgv,
  selectResolvedCommand,
  splitCommandLookupOutput,
} from './opencode-command.js'
import { OpencodeIncompatibleVersionError } from './errors.js'

describe('parseOpencodeVersion', () => {
  test('extracts major.minor.patch from opencode --version output', () => {
    expect(parseOpencodeVersion('1.2.3')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      raw: '1.2.3',
    })
    expect(parseOpencodeVersion('opencode 2.0.0\n')).toEqual({
      major: 2,
      minor: 0,
      patch: 0,
      raw: '2.0.0',
    })
    expect(parseOpencodeVersion('v2.1.0-beta.1')).toEqual({
      major: 2,
      minor: 1,
      patch: 0,
      raw: '2.1.0',
    })
  })

  test('returns null when output has no three-part version', () => {
    expect(parseOpencodeVersion('')).toBeNull()
    expect(parseOpencodeVersion('opencode')).toBeNull()
    expect(parseOpencodeVersion('2.0')).toBeNull()
  })
})

describe('isIncompatibleOpencodeMajor', () => {
  test('rejects the incompatible major and allows every other major', () => {
    expect(INCOMPATIBLE_OPENCODE_MAJOR_VERSION).toBe(2)
    expect(isIncompatibleOpencodeMajor({ major: 2 })).toBe(true)
    expect(isIncompatibleOpencodeMajor({ major: 1 })).toBe(false)
    expect(isIncompatibleOpencodeMajor({ major: 0 })).toBe(false)
    expect(isIncompatibleOpencodeMajor({ major: 3 })).toBe(false)
  })
})

describe('getIncompatibleOpencodeVersionError', () => {
  test('returns a tagged error for OpenCode 2.x', () => {
    const error = getIncompatibleOpencodeVersionError('2.0.0')
    expect(error).toBeInstanceOf(OpencodeIncompatibleVersionError)
    expect(error?.message).toMatchInlineSnapshot(
      `"Kimaki is not compatible with OpenCode version 2.0.0. Install an OpenCode 1.x release."`,
    )
  })

  test('allows 1.x and unparseable output', () => {
    expect(getIncompatibleOpencodeVersionError('1.4.0')).toBeNull()
    expect(getIncompatibleOpencodeVersionError('opencode')).toBeNull()
  })
})

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
  test('always passes --hostname so opencode.json cannot bind 0.0.0.0', async () => {
    const { buildOpencodeServeArgs } = await import('./opencode.js')
    expect(buildOpencodeServeArgs({ port: 4096 })).toEqual([
      'serve',
      '--port',
      '4096',
      '--hostname',
      '127.0.0.1',
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
    ])
  })
})

describe('published runtime artifacts', () => {
  test('lists @subrouter/opencode as a runtime dependency', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, '../package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    expect(pkg.dependencies?.['@subrouter/opencode']).toMatch(/^(workspace:\^|\^)/)
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
