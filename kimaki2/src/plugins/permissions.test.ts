import { afterEach, expect, test } from 'vitest'
import { canUseKimaki } from '../../opencode-plugins/permissions/access.ts'
import {
  parsePermissionCustomId,
  permissionContextHash,
  permissionCustomId,
} from '../../opencode-plugins/permissions/hash.ts'
import {
  getPending,
  removePendingForDirectory,
  resetPermissions,
  savePending,
  takePending,
} from '../../opencode-plugins/permissions/store.ts'

afterEach(() => {
  resetPermissions()
})

test('canUseKimaki fails closed without a member', () => {
  expect(
    canUseKimaki({
      member: null,
      user: { id: '1' },
      guild: null,
    }),
  ).toBe(false)
})

test('canUseKimaki allows the guild owner', () => {
  expect(
    canUseKimaki({
      member: { permissions: '0', roles: [] },
      user: { id: 'owner' },
      guild: {
        ownerId: 'owner',
        roles: { cache: { get() { return undefined } } },
      },
    }),
  ).toBe(true)
})

test('custom ids stay under Discord 100 char limit', () => {
  const customId = permissionCustomId({ reply: 'always', requestID: 'per_abcdefghijklmnopqrstuvwxyz' })
  expect(customId.length).toBeLessThanOrEqual(100)
  expect(parsePermissionCustomId(customId)).toEqual({
    reply: 'always',
    hash: permissionContextHash('per_abcdefghijklmnopqrstuvwxyz'),
  })
})

test('parsePermissionCustomId rejects other buttons', () => {
  expect(parsePermissionCustomId('queue_remove:abc')).toBeNull()
})

test('pending store is keyed by hash and take removes it', () => {
  const hash = permissionContextHash('per_1')
  savePending({
    requestID: 'per_1',
    sessionID: 'ses_perm',
    directory: '/tmp/perm',
    action: 'edit',
    resources: ['src/a.ts'],
    hash,
    threadId: '111',
  })
  expect(getPending(hash)?.requestID).toBe('per_1')
  expect(takePending(hash)?.sessionID).toBe('ses_perm')
  expect(getPending(hash)).toBeNull()
})

test('removePendingForDirectory keeps other locations', () => {
  savePending({
    requestID: 'per_a',
    sessionID: 'ses_a',
    directory: '/tmp/a',
    action: 'edit',
    resources: [],
    hash: 'aaaaaaaaaaaaaaaa',
    threadId: '1',
  })
  savePending({
    requestID: 'per_b',
    sessionID: 'ses_b',
    directory: '/tmp/b',
    action: 'edit',
    resources: [],
    hash: 'bbbbbbbbbbbbbbbb',
    threadId: '2',
  })
  removePendingForDirectory('/tmp/a')
  expect(getPending('aaaaaaaaaaaaaaaa')).toBeNull()
  expect(getPending('bbbbbbbbbbbbbbbb')?.requestID).toBe('per_b')
})
