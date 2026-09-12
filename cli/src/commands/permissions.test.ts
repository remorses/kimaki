// Native permission grouping preserves session ownership and saved-approval scope.
import type { PermissionRequest } from '@opencode/client'
import { describe, expect, test } from 'vitest'
import {
  arePatternsCoveredBy,
  canGroupPermissionRequests,
  compactPermissionPatterns,
} from './permissions.js'

const existing: PermissionRequest = {
  id: 'per_existing',
  sessionID: 'ses_parent',
  action: 'read',
  resources: ['/repo/*'],
  save: ['/repo/*'],
  source: { type: 'tool', messageID: 'msg_parent', id: 'call_parent' },
}

describe('native permission grouping', () => {
  test('groups covered requests within one session', () => {
    expect(canGroupPermissionRequests({
      existing,
      permission: {
        ...existing,
        id: 'per_next',
        resources: ['/repo/file.ts'],
        source: { type: 'tool', messageID: 'msg_next', id: 'call_next' },
      },
    })).toBe(true)
  })

  test('does not group parent and subagent requests', () => {
    expect(canGroupPermissionRequests({
      existing,
      permission: { ...existing, id: 'per_child', sessionID: 'ses_child' },
    })).toBe(false)
  })

  test('does not reuse a button with different saved scope', () => {
    expect(canGroupPermissionRequests({
      existing,
      permission: { ...existing, save: ['*'] },
    })).toBe(false)
    expect(canGroupPermissionRequests({
      existing,
      permission: { ...existing, save: undefined },
    })).toBe(false)
  })

  test('saved scope comparison ignores order and duplicates', () => {
    expect(canGroupPermissionRequests({
      existing: { ...existing, save: ['/a/*', '/b/*'] },
      permission: { ...existing, save: ['/b/*', '/a/*', '/a/*'] },
    })).toBe(true)
  })

  test('requests without saved scope can share accept-once buttons', () => {
    expect(canGroupPermissionRequests({
      existing: { ...existing, save: undefined },
      permission: { ...existing, save: [] },
    })).toBe(true)
  })

  test('does not group different actions or uncovered resources', () => {
    expect(canGroupPermissionRequests({
      existing,
      permission: { ...existing, action: 'edit' },
    })).toBe(false)
    expect(canGroupPermissionRequests({
      existing,
      permission: { ...existing, resources: ['/elsewhere/file.ts'] },
    })).toBe(false)
    expect(canGroupPermissionRequests({
      existing,
      permission: { ...existing, resources: ['/repo/file.ts', '/elsewhere/file.ts'] },
    })).toBe(false)
  })
})

describe('permission resource display', () => {
  test('compacts covered resources without widening scope', () => {
    expect(compactPermissionPatterns(['/repo/*', '/repo/file.ts', '/other/file.ts', '/repo/*']))
      .toEqual(['/repo/*', '/other/file.ts'])
  })

  test('keeps literal regex characters in resource matching', () => {
    expect(arePatternsCoveredBy({ patterns: ['/repo/a.ts'], coveringPatterns: ['/repo/a.ts'] })).toBe(true)
    expect(arePatternsCoveredBy({ patterns: ['/repo/aXts'], coveringPatterns: ['/repo/a.ts'] })).toBe(false)
  })

  test('supports shell command resource wildcards', () => {
    expect(arePatternsCoveredBy({ patterns: ['git', 'git status'], coveringPatterns: ['git *'] })).toBe(true)
    expect(arePatternsCoveredBy({ patterns: ['gitx status'], coveringPatterns: ['git *'] })).toBe(false)
  })
})
