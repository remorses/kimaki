// Tests for parsePermissionRules() from opencode.ts
import path from 'node:path'
import { describe, test, expect } from 'vitest'
import {
  buildSessionPermissions,
  parsePermissionRules,
  shouldIncludeExternalDirectoryAsk,
} from './opencode.js'
import { setDataDir } from './config.js'
import fs from 'node:fs'

function createProjectDirectory({ name }: { name: string }) {
  const projectDirectory = path.resolve(process.cwd(), 'tmp', name)
  fs.mkdirSync(projectDirectory, { recursive: true })
  return projectDirectory
}

describe('parsePermissionRules', () => {
  test('simple tool:action format', () => {
    expect(parsePermissionRules(['bash:deny'])).toMatchInlineSnapshot(`
      [
        {
          "action": "deny",
          "pattern": "*",
          "permission": "bash",
        },
      ]
    `)
  })

  test('multiple rules', () => {
    expect(parsePermissionRules(['bash:deny', 'edit:deny', 'read:allow'])).toMatchInlineSnapshot(`
      [
        {
          "action": "deny",
          "pattern": "*",
          "permission": "bash",
        },
        {
          "action": "deny",
          "pattern": "*",
          "permission": "edit",
        },
        {
          "action": "allow",
          "pattern": "*",
          "permission": "read",
        },
      ]
    `)
  })

  test('tool:pattern:action format', () => {
    expect(parsePermissionRules(['bash:git *:allow'])).toMatchInlineSnapshot(`
      [
        {
          "action": "allow",
          "pattern": "git *",
          "permission": "bash",
        },
      ]
    `)
  })

  test('wildcard permission', () => {
    expect(parsePermissionRules(['*:deny'])).toMatchInlineSnapshot(`
      [
        {
          "action": "deny",
          "pattern": "*",
          "permission": "*",
        },
      ]
    `)
  })

  test('case-insensitive action', () => {
    expect(parsePermissionRules(['bash:DENY', 'edit:Allow'])).toMatchInlineSnapshot(`
      [
        {
          "action": "deny",
          "pattern": "*",
          "permission": "bash",
        },
        {
          "action": "allow",
          "pattern": "*",
          "permission": "edit",
        },
      ]
    `)
  })

  test('trims whitespace', () => {
    expect(parsePermissionRules([' bash : deny '])).toMatchInlineSnapshot(`
      [
        {
          "action": "deny",
          "pattern": "*",
          "permission": "bash",
        },
      ]
    `)
  })

  test('skips invalid entries', () => {
    expect(parsePermissionRules(['', 'bash', 'bash:invalid', ':deny'])).toMatchInlineSnapshot(`[]`)
  })

  test('handles non-array input defensively', () => {
    expect(parsePermissionRules(undefined)).toMatchInlineSnapshot(`[]`)
    expect(parsePermissionRules(null)).toMatchInlineSnapshot(`[]`)
    expect(parsePermissionRules('bash:deny')).toMatchInlineSnapshot(`[]`)
    expect(parsePermissionRules(123)).toMatchInlineSnapshot(`[]`)
  })

  test('handles non-string array items', () => {
    expect(parsePermissionRules([123, null, 'bash:deny'])).toMatchInlineSnapshot(`
      [
        {
          "action": "deny",
          "pattern": "*",
          "permission": "bash",
        },
      ]
    `)
  })

  test('ask action', () => {
    expect(parsePermissionRules(['webfetch:ask'])).toMatchInlineSnapshot(`
      [
        {
          "action": "ask",
          "pattern": "*",
          "permission": "webfetch",
        },
      ]
    `)
  })
})

describe('buildSessionPermissions', () => {
  test('injects catch-all external_directory ask by default', () => {
    expect(
      buildSessionPermissions({
        directory: '/repo',
      }),
    ).toContainEqual({
      permission: 'external_directory',
      pattern: '*',
      action: 'ask',
    })
  })

  test('omits catch-all external_directory ask when permission is explicitly configured', () => {
    const projectDirectory = createProjectDirectory({ name: 'permission-project-allow' })
    fs.writeFileSync(
      path.join(projectDirectory, 'opencode.json'),
      JSON.stringify({ permission: 'allow' }, null, 2),
    )

    expect(
      buildSessionPermissions({
        directory: '/repo',
        includeExternalDirectoryAsk: shouldIncludeExternalDirectoryAsk({
          projectDirectory,
        }),
      }),
    ).not.toContainEqual({
      permission: 'external_directory',
      pattern: '*',
      action: 'ask',
    })
  })

  test('keeps catch-all external_directory ask without explicit config', () => {
    const projectDirectory = createProjectDirectory({ name: 'permission-project-default' })
    const xdgConfigHome = path.resolve(process.cwd(), 'tmp', 'permission-project-default-config-home')
    fs.mkdirSync(xdgConfigHome, { recursive: true })

    const previousXdgConfigHome = process.env['XDG_CONFIG_HOME']
    process.env['XDG_CONFIG_HOME'] = xdgConfigHome
    try {
      expect(shouldIncludeExternalDirectoryAsk({ projectDirectory })).toBe(true)
    } finally {
      if (previousXdgConfigHome) {
        process.env['XDG_CONFIG_HOME'] = previousXdgConfigHome
      } else {
        delete process.env['XDG_CONFIG_HOME']
      }
    }
  })

  test('omits catch-all external_directory ask for explicit global config', () => {
    const dataDir = path.resolve(process.cwd(), 'tmp', 'permission-global-data')
    const projectDirectory = createProjectDirectory({ name: 'permission-global-project' })
    const xdgConfigHome = path.join(dataDir, '.config-home')
    setDataDir(dataDir)
    fs.mkdirSync(path.join(xdgConfigHome, 'opencode'), {
      recursive: true,
    })
    fs.writeFileSync(
      path.join(xdgConfigHome, 'opencode', 'opencode.json'),
      JSON.stringify({ permission: 'allow' }, null, 2),
    )

    const previousXdgConfigHome = process.env['XDG_CONFIG_HOME']
    process.env['XDG_CONFIG_HOME'] = xdgConfigHome
    try {
      expect(shouldIncludeExternalDirectoryAsk({ projectDirectory })).toBe(false)
    } finally {
      if (previousXdgConfigHome) {
        process.env['XDG_CONFIG_HOME'] = previousXdgConfigHome
      } else {
        delete process.env['XDG_CONFIG_HOME']
      }
    }
  })

  test('supports explicit permission in project jsonc config', () => {
    const projectDirectory = createProjectDirectory({ name: 'permission-project-jsonc' })
    fs.writeFileSync(
      path.join(projectDirectory, 'opencode.jsonc'),
      '{\n  // user override\n  "permission": "allow"\n}\n',
    )

    expect(shouldIncludeExternalDirectoryAsk({ projectDirectory })).toBe(false)
  })

  test('allows the active kimaki data dir', () => {
    const dataDir = path.resolve(process.cwd(), 'tmp', 'kimaki-data-test')
    setDataDir(dataDir)

    expect(
      buildSessionPermissions({
        directory: '/repo',
      }),
    ).toContainEqual({
      permission: 'external_directory',
      pattern: dataDir,
      action: 'allow',
    })
  })
})
