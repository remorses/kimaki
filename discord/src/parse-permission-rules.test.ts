// Tests for parsePermissionRules() from opencode.ts
import { describe, test, expect } from 'vitest'
import { parsePermissionRules } from './opencode.js'

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
