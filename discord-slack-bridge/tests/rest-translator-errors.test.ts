// Unit tests for Slack-to-Discord REST error mapping behavior.

import { describe, expect, test } from 'vitest'
import { ErrorCode } from '@slack/web-api'
import { mapSlackErrorToDiscordError } from '../src/rest-translator.js'

describe('mapSlackErrorToDiscordError', () => {
  test('maps Slack auth failures to Discord invalid token', () => {
    const mapped = mapSlackErrorToDiscordError(
      buildSlackApiError({ code: 'invalid_auth' }),
    )
    expect(mapped.httpStatus).toBe(401)
    expect(mapped.discordCode).toBe(50014)
    expect(mapped.message).toBe('Invalid authentication token')
  })

  test('maps thread_not_found to unknown message', () => {
    const mapped = mapSlackErrorToDiscordError(
      buildSlackApiError({ code: 'thread_not_found' }),
    )
    expect(mapped.httpStatus).toBe(404)
    expect(mapped.discordCode).toBe(10008)
  })

  test('maps permission failures to missing permissions', () => {
    const mapped = mapSlackErrorToDiscordError(
      buildSlackApiError({ code: 'cant_delete_message' }),
    )
    expect(mapped.httpStatus).toBe(403)
    expect(mapped.discordCode).toBe(50013)
    expect(mapped.message).toBe('Missing Permissions')
  })

  test('maps missing_scope with actionable scope hint', () => {
    const mapped = mapSlackErrorToDiscordError(
      buildSlackApiError({
        code: 'missing_scope',
        needed: 'files:write',
      }),
    )
    expect(mapped.httpStatus).toBe(403)
    expect(mapped.discordCode).toBe(50013)
    expect(mapped.message).toBe(
      'Missing Permissions (Slack missing scope: files:write)',
    )
  })

  test('maps message-parsed Slack errors from error.message', () => {
    const mapped = mapSlackErrorToDiscordError(
      new Error('An API error occurred: token_revoked'),
    )
    expect(mapped.httpStatus).toBe(401)
    expect(mapped.discordCode).toBe(50014)
  })
})

function buildSlackApiError({
  code,
  needed,
}: {
  code: string
  needed?: string
}): Error {
  const err = new Error(`An API error occurred: ${code}`)
  return Object.assign(err, {
    code: ErrorCode.PlatformError,
    data: {
      ok: false,
      error: code,
      needed,
    },
  })
}
