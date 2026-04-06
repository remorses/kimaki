// Regression tests for Windows OpenCode command resolution and spawn args.

import { describe, expect, test } from 'vitest'
import {
  getSpawnCommandAndArgs,
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
