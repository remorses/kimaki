// Tests Anthropic OAuth account identity parsing and normalization.

import { describe, expect, test } from 'vitest'
import {
  extractAnthropicAccountIdentity,
  normalizeAnthropicAccountIdentity,
} from './anthropic-account-identity.js'

describe('normalizeAnthropicAccountIdentity', () => {
  test('normalizes email casing and drops empty values', () => {
    expect(
      normalizeAnthropicAccountIdentity({
        email: '  User@Example.com ',
        accountId: '  user_123  ',
      }),
    ).toEqual({
      email: 'user@example.com',
      accountId: 'user_123',
    })

    expect(normalizeAnthropicAccountIdentity({ email: '   ' })).toBeUndefined()
  })
})

describe('extractAnthropicAccountIdentity', () => {
  test('prefers nested user profile identity from client_data responses', () => {
    expect(
      extractAnthropicAccountIdentity({
        organizations: [{ id: 'org_123', name: 'Workspace' }],
        user: {
          id: 'usr_123',
          email: 'User@Example.com',
        },
      }),
    ).toEqual({
      accountId: 'usr_123',
      email: 'user@example.com',
    })
  })

  test('falls back to profile-style payloads without email', () => {
    expect(
      extractAnthropicAccountIdentity({
        profile: {
          user_id: 'usr_456',
        },
      }),
    ).toEqual({
      accountId: 'usr_456',
    })
  })
})
