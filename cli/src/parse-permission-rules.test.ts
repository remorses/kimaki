// Tests for parsePermissionRules() from opencode.ts
import { describe, test, expect } from 'vitest'
import path from 'node:path'
import { buildSessionPermissions, parsePermissionRules } from './opencode.js'

describe('parsePermissionRules', () => {
  test('returns native rules and preserves colons in resources', () => {
    expect(parsePermissionRules(['shell:git *:ALLOW', 'edit:C:/repo/*:deny'])).toEqual([
      { action: 'shell', resource: 'git *', effect: 'allow' },
      { action: 'edit', resource: 'C:/repo/*', effect: 'deny' },
    ])
  })
  test('simple tool:action format', () => {
    expect(parsePermissionRules(['bash:deny'])).toMatchInlineSnapshot(`
      [
        {
          "action": "bash",
          "effect": "deny",
          "resource": "*",
        },
      ]
    `)
  })

  test('multiple rules', () => {
    expect(parsePermissionRules(['bash:deny', 'edit:deny', 'read:allow'])).toMatchInlineSnapshot(`
      [
        {
          "action": "bash",
          "effect": "deny",
          "resource": "*",
        },
        {
          "action": "edit",
          "effect": "deny",
          "resource": "*",
        },
        {
          "action": "read",
          "effect": "allow",
          "resource": "*",
        },
      ]
    `)
  })

  test('tool:pattern:action format', () => {
    expect(parsePermissionRules(['bash:git *:allow'])).toMatchInlineSnapshot(`
      [
        {
          "action": "bash",
          "effect": "allow",
          "resource": "git *",
        },
      ]
    `)
  })

  test('wildcard permission', () => {
    expect(parsePermissionRules(['*:deny'])).toMatchInlineSnapshot(`
      [
        {
          "action": "*",
          "effect": "deny",
          "resource": "*",
        },
      ]
    `)
  })

  test('case-insensitive action', () => {
    expect(parsePermissionRules(['bash:DENY', 'edit:Allow'])).toMatchInlineSnapshot(`
      [
        {
          "action": "bash",
          "effect": "deny",
          "resource": "*",
        },
        {
          "action": "edit",
          "effect": "allow",
          "resource": "*",
        },
      ]
    `)
  })

  test('trims whitespace', () => {
    expect(parsePermissionRules([' bash : deny '])).toMatchInlineSnapshot(`
      [
        {
          "action": "bash",
          "effect": "deny",
          "resource": "*",
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
          "action": "bash",
          "effect": "deny",
          "resource": "*",
        },
      ]
    `)
  })

  test('ask action', () => {
    expect(parsePermissionRules(['webfetch:ask'])).toMatchInlineSnapshot(`
      [
        {
          "action": "webfetch",
          "effect": "ask",
          "resource": "*",
        },
      ]
    `)
  })
})

describe('buildSessionPermissions', () => {
  test('leaves ordinary sessions under agent and project policy', () => {
    expect(buildSessionPermissions({ directory: '/repo' })).toEqual([])
    expect(buildSessionPermissions({ directory: '/repo', originalRepoDirectory: '/repo/' })).toEqual([])
  })

  test('denies both absolute and relative original-checkout file resources', () => {
    const permissions = buildSessionPermissions({
      directory: '/worktrees/task',
      originalRepoDirectory: '/repo',
    })
    expect(permissions).toEqual([
      { action: 'external_directory', resource: '/repo/*', effect: 'deny' },
      ...['read', 'edit'].flatMap((action) => {
        return ['/repo', '/repo/*', '../../repo', '../../repo/*'].map((resource) => {
          return { action, resource, effect: 'deny' }
        })
      }),
    ])
  })

  test('covers siblings when the worktree is inside the original checkout', () => {
    const permissions = buildSessionPermissions({
      directory: '/repo/.worktrees/task',
      originalRepoDirectory: '/repo',
    })
    expect(permissions).toContainEqual({ action: 'edit', resource: '../*', effect: 'deny' })
    expect(permissions.every((rule) => rule.effect === 'deny')).toBe(true)
    expect(permissions.some((rule) => rule.resource === '*')).toBe(false)
  })

  test('normalizes Windows paths before creating native rules', () => {
    const permissions = buildSessionPermissions({
      directory: 'C:\\worktrees\\task',
      originalRepoDirectory: 'C:\\repo\\',
    })
    expect(permissions).toContainEqual({ action: 'edit', resource: '../../repo/*', effect: 'deny' })
    expect(permissions).toContainEqual({ action: 'external_directory', resource: 'C:/repo/*', effect: 'deny' })
    expect(permissions.some((rule) => rule.resource.includes('\\'))).toBe(false)
    expect(buildSessionPermissions({
      directory: path.resolve('/repo'),
      originalRepoDirectory: path.resolve('/repo'),
    })).toEqual([])
  })
})
