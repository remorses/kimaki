// Regression tests for Windows OpenCode command resolution and spawn args.

import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  decodeWindowsBunShimTarget,
  ensureKimakiCommandShim,
  getSpawnCommandAndArgs,
  resolveWindowsBunShimTarget,
  sanitizeShimExecArgv,
  selectResolvedCommand,
  splitCommandLookupOutput,
} from './opencode-command.js'

const BUN_SHIM_VERSION = 5478

function createBunShimMetadata({
  relativeTarget,
  flags = BUN_SHIM_VERSION << 3,
}: {
  relativeTarget: string
  flags?: number
}): Buffer {
  const trailer = Buffer.alloc(6)
  trailer.writeUInt16LE(0x22, 0)
  trailer.writeUInt16LE(0, 2)
  trailer.writeUInt16LE(flags, 4)
  return Buffer.concat([Buffer.from(relativeTarget, 'utf16le'), trailer])
}

function createPeExecutableFixture(): Buffer {
  const executable = Buffer.alloc(512)
  executable.write('MZ', 0, 'ascii')
  executable.writeUInt32LE(0x80, 0x3c)
  executable.write('PE\0\0', 0x80, 'ascii')
  executable.writeUInt16LE(1, 0x80 + 6)
  executable.writeUInt16LE(0xf0, 0x80 + 20)
  executable.writeUInt16LE(0x0002, 0x80 + 22)
  executable.writeUInt16LE(0x20b, 0x80 + 24)
  return executable
}

describe('decodeWindowsBunShimTarget', () => {
  const command = 'C:\\Users\\test\\.bun\\bin\\opencode.exe'
  const expectedTarget =
    'C:\\Users\\test\\.bun\\install\\global\\node_modules\\opencode-ai\\bin\\opencode.exe'

  test('decodes a native target from current Bun shim metadata', () => {
    // Captured from Bun 1.3.14's generated opencode.bunx metadata.
    const metadata = Buffer.from(
      '69006e007300740061006c006c005c0067006c006f00620061006c005c006e006f00640065005f006d006f00640075006c00650073005c006f00700065006e0063006f00640065002d00610069005c00620069006e005c006f00700065006e0063006f00640065002e006500780065002200000030ab',
      'hex',
    )

    expect(decodeWindowsBunShimTarget({ command, metadata })).toBe(
      expectedTarget,
    )
  })

  test.each([
    ['unknown metadata version', (BUN_SHIM_VERSION + 1) << 3],
    ['interpreter-backed target', (BUN_SHIM_VERSION << 3) | 0b100],
  ])('rejects %s', (_name, flags) => {
    const metadata = createBunShimMetadata({
      relativeTarget:
        'install\\global\\node_modules\\opencode-ai\\bin\\opencode.exe',
      flags,
    })

    expect(decodeWindowsBunShimTarget({ command, metadata })).toBeNull()
  })

  test('rejects malformed metadata', () => {
    expect(
      decodeWindowsBunShimTarget({ command, metadata: Buffer.alloc(4) }),
    ).toBeNull()
    expect(
      decodeWindowsBunShimTarget({
        command,
        metadata: Buffer.alloc(65_538),
      }),
    ).toBeNull()
  })

  test('rejects targets outside the shim root', () => {
    const metadata = createBunShimMetadata({
      relativeTarget: '..\\outside.exe',
    })

    expect(decodeWindowsBunShimTarget({ command, metadata })).toBeNull()
  })

  test('rejects metadata beside executables outside Bun bin directories', () => {
    const metadata = createBunShimMetadata({
      relativeTarget: 'opencode-ai\\bin\\opencode.exe',
    })

    expect(
      decodeWindowsBunShimTarget({
        command: 'C:\\tools\\opencode.exe',
        metadata,
      }),
    ).toBeNull()
  })
})

describe.runIf(process.platform === 'win32')(
  'resolveWindowsBunShimTarget',
  () => {
    let tempDir: string
    let shimPath: string
    let metadataPath: string
    let nativeTarget: string
    let outsideDir: string | null

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimaki-bun-shim-test-'))
      const binDir = path.join(tempDir, 'bin')
      nativeTarget = path.join(
        tempDir,
        'install',
        'global',
        'node_modules',
        'opencode-ai',
        'bin',
        'opencode.exe',
      )
      shimPath = path.join(binDir, 'opencode.exe')
      metadataPath = path.join(binDir, 'opencode.bunx')
      fs.mkdirSync(path.dirname(nativeTarget), { recursive: true })
      fs.mkdirSync(binDir, { recursive: true })
      fs.writeFileSync(shimPath, createPeExecutableFixture())
      fs.writeFileSync(nativeTarget, createPeExecutableFixture())
      outsideDir = null
    })

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true })
      if (outsideDir) {
        fs.rmSync(outsideDir, { recursive: true, force: true })
      }
    })

    test('resolves a native target from current Bun shim metadata', () => {
      fs.writeFileSync(
        metadataPath,
        createBunShimMetadata({
          relativeTarget:
            'install\\global\\node_modules\\opencode-ai\\bin\\opencode.exe',
        }),
      )

      expect(
        resolveWindowsBunShimTarget({ command: shimPath, platform: 'win32' }),
      ).toBe(nativeTarget)
    })

    test('keeps the launcher when the target is missing or not native', () => {
      fs.writeFileSync(
        metadataPath,
        createBunShimMetadata({
          relativeTarget:
            'install\\global\\node_modules\\opencode-ai\\bin\\missing.exe',
        }),
      )
      expect(
        resolveWindowsBunShimTarget({ command: shimPath, platform: 'win32' }),
      ).toBe(shimPath)

      fs.writeFileSync(nativeTarget, Buffer.from('MZ but not a PE executable'))
      fs.writeFileSync(
        metadataPath,
        createBunShimMetadata({
          relativeTarget:
            'install\\global\\node_modules\\opencode-ai\\bin\\opencode.exe',
        }),
      )
      expect(
        resolveWindowsBunShimTarget({ command: shimPath, platform: 'win32' }),
      ).toBe(shimPath)

      const truncatedPe = createPeExecutableFixture().subarray(0, 0x9a)
      fs.writeFileSync(nativeTarget, truncatedPe)
      expect(
        resolveWindowsBunShimTarget({ command: shimPath, platform: 'win32' }),
      ).toBe(shimPath)
    })

    test('keeps the launcher when a junction redirects outside the shim root', () => {
      outsideDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'kimaki-bun-shim-outside-'),
      )
      fs.writeFileSync(
        path.join(outsideDir, 'opencode.exe'),
        createPeExecutableFixture(),
      )
      fs.symlinkSync(outsideDir, path.join(tempDir, 'linked'), 'junction')
      fs.writeFileSync(
        metadataPath,
        createBunShimMetadata({ relativeTarget: 'linked\\opencode.exe' }),
      )

      expect(
        resolveWindowsBunShimTarget({ command: shimPath, platform: 'win32' }),
      ).toBe(shimPath)
    })

    test('keeps the launcher when no Bun metadata file exists', () => {
      expect(
        resolveWindowsBunShimTarget({ command: shimPath, platform: 'win32' }),
      ).toBe(shimPath)
    })

    test('resolved target spawns directly without a cmd.exe wrapper', () => {
      fs.writeFileSync(
        metadataPath,
        createBunShimMetadata({
          relativeTarget:
            'install\\global\\node_modules\\opencode-ai\\bin\\opencode.exe',
        }),
      )
      const resolved = resolveWindowsBunShimTarget({
        command: shimPath,
        platform: 'win32',
      })
      expect(resolved).toBe(nativeTarget)

      // With the native target as the spawn command there is no intermediate
      // process, so the spawned ChildProcess.pid is the server Kimaki's
      // SIGTERM cleanup must terminate.
      expect(
        getSpawnCommandAndArgs({
          resolvedCommand: resolved,
          baseArgs: ['serve', '--port', '4096'],
          platform: 'win32',
        }),
      ).toEqual({
        command: nativeTarget,
        args: ['serve', '--port', '4096'],
      })
    })

    test('keeps direct executables with spaces unchanged on windows', () => {
      expect(
        getSpawnCommandAndArgs({
          resolvedCommand: 'C:\\Program Files\\opencode\\opencode.exe',
          baseArgs: ['serve', '--port', '4096'],
          platform: 'win32',
        }),
      ).toEqual({
        command: 'C:\\Program Files\\opencode\\opencode.exe',
        args: ['serve', '--port', '4096'],
      })
    })
  },
)

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
