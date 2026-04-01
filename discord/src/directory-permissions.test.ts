// Tests for one-shot directory permission path normalization helpers.

import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  buildAllowedDirectoryPatterns,
  normalizeAllowedDirectoryPath,
} from './directory-permissions.js'

describe('normalizeAllowedDirectoryPath', () => {
  test('resolves relative paths from the working directory', () => {
    const result = normalizeAllowedDirectoryPath({
      input: '../shared/',
      workingDirectory: '/repo/worktree/app',
    })
    expect(result).toBe('/repo/worktree/shared')
  })

  test('expands home directories and strips implicit trailing glob', () => {
    const result = normalizeAllowedDirectoryPath({
      input: '~/projects/*',
      workingDirectory: '/repo/worktree/app',
    })
    expect(result).toBe(`${os.homedir().replaceAll('\\', '/')}/projects`)
  })

  test('rejects glob patterns in the middle of the path', () => {
    const result = normalizeAllowedDirectoryPath({
      input: 'src/*/nested',
      workingDirectory: '/repo/worktree/app',
    })
    expect(result instanceof Error ? result.message : result).toBe(
      'Path must be a directory, not a glob pattern',
    )
  })
})

describe('buildAllowedDirectoryPatterns', () => {
  test('adds exact and child wildcard patterns for a directory', () => {
    const directory = path.join('/repo', 'shared').replaceAll('\\', '/')
    expect(buildAllowedDirectoryPatterns({ directory })).toEqual([
      '/repo/shared',
      '/repo/shared/*',
    ])
  })
})
