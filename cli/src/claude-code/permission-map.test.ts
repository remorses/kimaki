import { describe, expect, test } from 'vitest'
import {
  buildAlwaysRules,
  describeToolPermission,
  evaluatePermission,
  wildcardMatchValue,
} from './permission-map.js'

describe('wildcardMatchValue', () => {
  test('star matches any run', () => {
    expect(wildcardMatchValue({ value: 'git push origin', pattern: 'git *' })).toBe(true)
    expect(wildcardMatchValue({ value: 'rm -rf /', pattern: 'git *' })).toBe(false)
  })

  test('trailing " *" also matches the bare prefix', () => {
    expect(wildcardMatchValue({ value: 'git', pattern: 'git *' })).toBe(true)
  })

  test('star alone matches everything', () => {
    expect(wildcardMatchValue({ value: 'anything at all', pattern: '*' })).toBe(true)
  })
})

describe('evaluatePermission', () => {
  test('defaults: bash asks, webfetch allows', () => {
    expect(evaluatePermission({ rules: [], permission: 'bash', patterns: ['ls'] })).toBe('ask')
    expect(
      evaluatePermission({
        rules: [],
        permission: 'webfetch',
        patterns: ['https://example.com'],
      }),
    ).toBe('allow')
  })

  test('last matching rule wins', () => {
    const rules = [
      { permission: 'bash', pattern: '*', action: 'allow' as const },
      { permission: 'bash', pattern: 'rm *', action: 'deny' as const },
    ]
    expect(evaluatePermission({ rules, permission: 'bash', patterns: ['ls -la'] })).toBe('allow')
    expect(evaluatePermission({ rules, permission: 'bash', patterns: ['rm -rf dist'] })).toBe(
      'deny',
    )
  })

  test('deny wins over ask across multiple patterns', () => {
    const rules = [{ permission: 'external_directory', pattern: '/etc/*', action: 'deny' as const }]
    expect(
      evaluatePermission({
        rules,
        permission: 'external_directory',
        patterns: ['/home/user/x', '/etc/passwd'],
      }),
    ).toBe('deny')
  })

  test('unknown permission defaults to allow', () => {
    expect(evaluatePermission({ rules: [], permission: 'somethingelse', patterns: ['*'] })).toBe(
      'allow',
    )
  })
})

describe('describeToolPermission', () => {
  test('Bash maps to bash permission with command pattern', () => {
    const descriptor = describeToolPermission({
      toolName: 'Bash',
      input: { command: 'git push origin main' },
      directory: '/repo',
    })
    expect(descriptor).toMatchObject({
      permission: 'bash',
      patterns: ['git push origin main'],
      always: ['git *'],
    })
  })

  test('Edit maps to edit permission with workspace-relative path', () => {
    const descriptor = describeToolPermission({
      toolName: 'Edit',
      input: { file_path: '/repo/src/index.ts' },
      directory: '/repo',
    })
    expect(descriptor).toMatchObject({
      permission: 'edit',
      patterns: ['src/index.ts'],
      always: ['*'],
    })
  })

  test('blockedPath maps to external_directory', () => {
    const descriptor = describeToolPermission({
      toolName: 'Read',
      input: { file_path: '/outside/secret.txt' },
      directory: '/repo',
      blockedPath: '/outside',
    })
    expect(descriptor).toMatchObject({
      permission: 'external_directory',
      patterns: ['/outside'],
      always: ['/outside', '/outside/*'],
    })
  })

  test('safe read-only tools inside workspace are auto-allowed', () => {
    expect(
      describeToolPermission({
        toolName: 'Read',
        input: { file_path: '/repo/a.ts' },
        directory: '/repo',
      }),
    ).toBeUndefined()
    expect(
      describeToolPermission({
        toolName: 'Grep',
        input: { pattern: 'foo' },
        directory: '/repo',
      }),
    ).toBeUndefined()
    expect(
      describeToolPermission({
        toolName: 'mcp__kimaki__kimaki_action_buttons',
        input: {},
        directory: '/repo',
      }),
    ).toBeUndefined()
  })

  test('WebFetch always pattern is host-scoped', () => {
    const descriptor = describeToolPermission({
      toolName: 'WebFetch',
      input: { url: 'https://docs.example.com/page?q=1' },
      directory: '/repo',
    })
    expect(descriptor).toMatchObject({
      permission: 'webfetch',
      always: ['https://docs.example.com*'],
    })
  })
})

describe('buildAlwaysRules', () => {
  test('builds allow rules from always patterns', () => {
    expect(buildAlwaysRules({ permission: 'bash', always: ['git *'] })).toEqual([
      { permission: 'bash', pattern: 'git *', action: 'allow' },
    ])
  })

  test('falls back to star when empty', () => {
    expect(buildAlwaysRules({ permission: 'edit', always: [] })).toEqual([
      { permission: 'edit', pattern: '*', action: 'allow' },
    ])
  })
})
