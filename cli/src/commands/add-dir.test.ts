// Tests for /add-dir permission helpers.

import { describe, expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  appendSessionPermissionRules,
  buildAddDirPermissionRules,
  resolveDirectoryPermissionPattern,
} from './add-dir.js'

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
})

describe('appendSessionPermissionRules', () => {
  test('appends missing external_directory allow rules', () => {
    expect(
      appendSessionPermissionRules({
        existingPermissions: [
          { permission: 'bash', pattern: '*', action: 'deny' },
        ],
        addedRules: buildAddDirPermissionRules({
          resolvedPattern: '/repo/extra',
        }),
      }),
    ).toMatchInlineSnapshot(`
      [
        {
          "action": "deny",
          "pattern": "*",
          "permission": "bash",
        },
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

  test('keeps permissions unchanged when the path is already covered', () => {
    expect(
      appendSessionPermissionRules({
        existingPermissions: [
          { permission: 'external_directory', pattern: '*', action: 'allow' },
        ],
        addedRules: buildAddDirPermissionRules({
          resolvedPattern: '/repo/extra',
        }),
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
})
