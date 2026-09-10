import { describe, test, expect } from 'vitest'
import {
  computeSkillPermission,
  isSkillAllowed,
  skillPermissionRules,
} from './skill-filter.js'

describe('computeSkillPermission', () => {
  test('empty inputs returns undefined (no filtering)', () => {
    expect(
      computeSkillPermission({ enabledSkills: [], disabledSkills: [] }),
    ).toMatchInlineSnapshot(`undefined`)
  })

  test('whitelist single skill', () => {
    expect(
      computeSkillPermission({
        enabledSkills: ['npm-package'],
        disabledSkills: [],
      }),
    ).toMatchInlineSnapshot(`
      {
        "*": "deny",
        "npm-package": "allow",
      }
    `)
  })

  test('whitelist multiple skills', () => {
    expect(
      computeSkillPermission({
        enabledSkills: ['npm-package', 'playwriter', 'errore'],
        disabledSkills: [],
      }),
    ).toMatchInlineSnapshot(`
      {
        "*": "deny",
        "errore": "allow",
        "npm-package": "allow",
        "playwriter": "allow",
      }
    `)
  })

  test('blacklist single skill', () => {
    expect(
      computeSkillPermission({
        enabledSkills: [],
        disabledSkills: ['jitter'],
      }),
    ).toMatchInlineSnapshot(`
      {
        "jitter": "deny",
      }
    `)
  })

  test('blacklist multiple skills', () => {
    expect(
      computeSkillPermission({
        enabledSkills: [],
        disabledSkills: ['jitter', 'termcast'],
      }),
    ).toMatchInlineSnapshot(`
      {
        "jitter": "deny",
        "termcast": "deny",
      }
    `)
  })

  test('whitelist takes precedence when both are set (cli.ts is expected to reject this upstream)', () => {
    // cli.ts validates mutual exclusion before reaching this helper. This
    // test documents the defensive behavior if both arrays ever leak through.
    expect(
      computeSkillPermission({
        enabledSkills: ['npm-package'],
        disabledSkills: ['jitter'],
      }),
    ).toMatchInlineSnapshot(`
      {
        "*": "deny",
        "npm-package": "allow",
      }
    `)
  })
})

describe('skillPermissionRules', () => {
  test('empty inputs returns no v2 rules', () => {
    expect(
      skillPermissionRules({ enabledSkills: [], disabledSkills: [] }),
    ).toMatchInlineSnapshot(`[]`)
  })

  test('whitelist becomes deny-all then allow named skills', () => {
    expect(
      skillPermissionRules({
        enabledSkills: ['npm-package', 'errore'],
        disabledSkills: [],
      }),
    ).toMatchInlineSnapshot(`
      [
        {
          "action": "skill",
          "effect": "deny",
          "resource": "*",
        },
        {
          "action": "skill",
          "effect": "allow",
          "resource": "npm-package",
        },
        {
          "action": "skill",
          "effect": "allow",
          "resource": "errore",
        },
      ]
    `)
  })
})

describe('isSkillAllowed', () => {
  test('no filters - all skills allowed', () => {
    expect(isSkillAllowed({ name: 'anything', enabledSkills: [], disabledSkills: [] })).toBe(true)
  })

  test('whitelist mode - listed skill is allowed', () => {
    expect(isSkillAllowed({ name: 'npm-package', enabledSkills: ['npm-package', 'errore'], disabledSkills: [] })).toBe(true)
  })

  test('whitelist mode - unlisted skill is denied', () => {
    expect(isSkillAllowed({ name: 'jitter', enabledSkills: ['npm-package', 'errore'], disabledSkills: [] })).toBe(false)
  })

  test('blacklist mode - listed skill is denied', () => {
    expect(isSkillAllowed({ name: 'jitter', enabledSkills: [], disabledSkills: ['jitter', 'termcast'] })).toBe(false)
  })

  test('blacklist mode - unlisted skill is allowed', () => {
    expect(isSkillAllowed({ name: 'npm-package', enabledSkills: [], disabledSkills: ['jitter', 'termcast'] })).toBe(true)
  })

  test('whitelist takes precedence when both are set', () => {
    expect(isSkillAllowed({ name: 'npm-package', enabledSkills: ['npm-package'], disabledSkills: ['npm-package'] })).toBe(true)
    expect(isSkillAllowed({ name: 'jitter', enabledSkills: ['npm-package'], disabledSkills: ['jitter'] })).toBe(false)
  })
})
