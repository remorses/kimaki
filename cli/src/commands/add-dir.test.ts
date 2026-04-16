// Tests for /add-dir permission helpers.

import { describe, expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  buildAddDirPermissionRules,
  resolveDirectoryPermissionPattern,
} from './add-dir.js'
import {
  buildExternalDirectoryPermissionRules,
  buildSessionPermissions,
} from '../opencode.js'

describe('resolveDirectoryPermissionPattern', () => {
  test('resolves relative directories against the working directory', () => {
    const root = path.resolve(process.cwd(), 'tmp', 'add-dir-test')
    const nested = path.join(root, 'nested')
    fs.mkdirSync(nested, { recursive: true })

    const result = resolveDirectoryPermissionPattern({
      input: './nested',
      workingDirectory: root,
    })

    expect(result).toBe(nested.replaceAll('\\', '/'))
  })

  test('supports allowing every directory with *', () => {
    expect(
      buildAddDirPermissionRules({
        resolvedPattern: '*',
      }),
    ).toMatchInlineSnapshot(`
      [
        {
          "action": "allow",
          "pattern": "*",
          "permission": "external_directory",
        },
      ]
    `)
  })

  test('builds allow rules for a specific directory', () => {
    expect(
      buildAddDirPermissionRules({
        resolvedPattern: '/repo/extra',
      }),
    ).toMatchInlineSnapshot(`
      [
        {
          "action": "allow",
          "pattern": "/repo/extra",
          "permission": "external_directory",
        },
        {
          "action": "allow",
          "pattern": "/repo/extra/*",
          "permission": "external_directory",
        },
      ]
    `)
  })

  test('builds deny rules for a specific directory', () => {
    expect(
      buildExternalDirectoryPermissionRules({
        resolvedPattern: '/repo',
        action: 'deny',
      }),
    ).toMatchInlineSnapshot(`
      [
        {
          "action": "deny",
          "pattern": "/repo",
          "permission": "external_directory",
        },
        {
          "action": "deny",
          "pattern": "/repo/*",
          "permission": "external_directory",
        },
      ]
    `)
  })

  test('worktree sessions deny the original checkout last', () => {
    expect(
      buildSessionPermissions({
        directory: '/Users/me/.kimaki/worktrees/hash/feature',
        originalRepoDirectory: '/Users/me/project',
      }).slice(-2),
    ).toMatchInlineSnapshot(`
      [
        {
          "action": "deny",
          "pattern": "/Users/me/project",
          "permission": "external_directory",
        },
        {
          "action": "deny",
          "pattern": "/Users/me/project/*",
          "permission": "external_directory",
        },
      ]
    `)
  })
})
