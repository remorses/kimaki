// Tests native OpenCode v2 authentication method preservation.

import { describe, expect, test } from 'vitest'
import type { IntegrationMethod } from '@opencode/client/promise'
import {
  getAuthenticationAttemptResult,
  normalizeAuthMethods,
} from './login.js'

describe('login authentication methods', () => {
  test('preserves oauth, key, command, and env methods', () => {
    const methods: IntegrationMethod[] = [
      { id: 'browser', type: 'oauth', label: 'Browser' },
      { type: 'key', label: 'API key' },
      {
        id: 'cli-login',
        type: 'command',
        label: 'Provider CLI',
        command: ['provider', 'login'],
      },
      { type: 'env', names: ['PROVIDER_API_KEY'] },
    ]

    expect(normalizeAuthMethods(methods)).toMatchInlineSnapshot(`
      [
        {
          "id": "browser",
          "label": "Browser",
          "prompts": [],
          "type": "oauth",
        },
        {
          "label": "API key",
          "prompts": [],
          "type": "key",
        },
        {
          "id": "cli-login",
          "label": "Provider CLI",
          "type": "command",
        },
        {
          "label": "Environment: PROVIDER_API_KEY",
          "names": [
            "PROVIDER_API_KEY",
          ],
          "type": "env",
        },
      ]
    `)
  })

  test('uses native attempt completion status', () => {
    const time = { created: 1, expires: 2 }
    const values = [
      getAuthenticationAttemptResult({ status: 'pending', time }),
      getAuthenticationAttemptResult({ status: 'complete', time }),
      getAuthenticationAttemptResult({ status: 'failed', message: 'denied', time }),
      getAuthenticationAttemptResult({ status: 'expired', time }),
    ].map((value) => value instanceof Error ? value.message : value ?? 'complete')

    expect(values).toMatchInlineSnapshot(`
      [
        "pending",
        "complete",
        "denied",
        "Authentication attempt expired",
      ]
    `)
  })
})
