// Verifies Slack webhook team-id extraction across event and action payload shapes.

import { describe, expect, test } from 'vitest'
import { getTeamIdForWebhookEvent } from '../src/index.js'

describe('getTeamIdForWebhookEvent', () => {
  test('reads team_id from slash-command form payload', () => {
    const body = new URLSearchParams({
      team_id: 'T_SLASH',
      command: '/kimaki',
    }).toString()

    expect(getTeamIdForWebhookEvent({
      body,
      contentType: 'application/x-www-form-urlencoded',
    })).toBe('T_SLASH')
  })

  test('reads team.id from interactive payload', () => {
    const body = new URLSearchParams({
      payload: JSON.stringify({
        type: 'block_actions',
        team: { id: 'T_INTERACTIVE' },
      }),
    }).toString()

    expect(getTeamIdForWebhookEvent({
      body,
      contentType: 'application/x-www-form-urlencoded; charset=utf-8',
    })).toBe('T_INTERACTIVE')
  })

  test('reads team_id from JSON event callback payload', () => {
    const body = JSON.stringify({
      type: 'event_callback',
      team_id: 'T_EVENT',
      event: { type: 'message' },
    })

    expect(getTeamIdForWebhookEvent({
      body,
      contentType: 'application/json',
    })).toBe('T_EVENT')
  })

  test('falls back to authorizations[].team_id', () => {
    const body = JSON.stringify({
      type: 'event_callback',
      authorizations: [{ team_id: 'T_AUTHZ' }],
      event: { type: 'message' },
    })

    expect(getTeamIdForWebhookEvent({ body })).toBe('T_AUTHZ')
  })

  test('returns undefined for malformed payload', () => {
    expect(getTeamIdForWebhookEvent({
      body: '{not-json}',
      contentType: 'application/json',
    })).toBeUndefined()
  })
})
