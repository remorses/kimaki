import { describe, expect, test } from 'vitest'
import { classify, loginKey, parseModel, pick, type Block, type FailedRequest } from './fallback.ts'

const now = Date.parse('2026-10-02T12:00:00Z')
const iso = (time: number | undefined) => (time === undefined ? undefined : new Date(time).toISOString())

function block(failed: Partial<FailedRequest> & Pick<FailedRequest, 'error'>) {
  const result = classify({
    failed: { model: { providerID: 'anthropic', id: 'claude-opus-5-5' }, credentialID: 'cred_a', ...failed },
    now,
  })
  return result && { ...result, until: iso(result.until) }
}

describe('classify', () => {
  test('error kinds, scopes and reset sources', () => {
    expect({
      anthropicSubscription: block({
        error: { type: 'provider.rate-limit', status: 429, message: 'rate_limit_error' },
        headers: {
          'Anthropic-Ratelimit-Unified-Status': 'rejected',
          'anthropic-ratelimit-unified-reset': String(now / 1000 + 3 * 3600),
          'retry-after': '30',
        },
      }),
      anthropicApiTokens: block({
        error: { type: 'provider.rate-limit', status: 429, message: 'rate limited' },
        headers: {
          'anthropic-ratelimit-tokens-remaining': '0',
          'anthropic-ratelimit-tokens-reset': '2026-10-02T12:00:42Z',
          'anthropic-ratelimit-requests-remaining': '10',
          'anthropic-ratelimit-requests-reset': '2026-10-02T12:09:00Z',
        },
      }),
      codexUsageLimit: block({
        model: { providerID: 'openai', id: 'gpt-6-sol' },
        error: {
          type: 'provider.rate-limit',
          status: 429,
          message: 'usage limit',
          response: { body: JSON.stringify({ error: { type: 'usage_limit_reached', resets_in_seconds: 5400 } }) },
        },
      }),
      codexHeaders: block({
        model: { providerID: 'openai', id: 'gpt-6-sol' },
        error: { type: 'provider.quota', status: 429, message: 'quota' },
        headers: {
          'x-codex-primary-used-percent': '40',
          'x-codex-primary-reset-at': String(now / 1000 + 600),
          'x-codex-secondary-used-percent': '100',
          'x-codex-secondary-reset-at': String(now / 1000 + 86400),
        },
      }),
      // Real stream error of "Sign in with ChatGPT" (OpenCode 2.3): HTTP 200, no reset info.
      chatgptSignInLimit: block({
        model: { providerID: 'openai', id: 'gpt-6.2-astra' },
        error: {
          type: 'provider.chatgpt-limit',
          status: 200,
          message: 'ChatGPT usage limit reached. Check ChatGPT Settings → Usage for details.',
          response: {
            body: JSON.stringify({
              type: 'error',
              sequence_number: 3,
              error: { message: 'The ChatGPT user has reached their Subscription Sharing usage limit.', type: 'invalid_request_error', param: null, code: 'subscription_sharing_usage_limit_exceeded' },
            }),
          },
        },
      }),
      chatgptWorkspaceLimit: block({
        model: { providerID: 'openai', id: 'gpt-6.2-astra' },
        error: {
          type: 'provider.invalid-request',
          status: 200,
          message: 'workspace limit',
          response: { body: JSON.stringify({ error: { code: 'subscription_sharing_workplace_individual_usage_limit_exceeded' } }) },
        },
      }),
      chatgptInvalidUser: block({
        model: { providerID: 'openai', id: 'gpt-6.2-astra' },
        error: { type: 'provider.invalid-request', status: 403, message: 'This ChatGPT connection is no longer valid.', response: { body: '{"error":{"code":"subscription_sharing_invalid_user"}}' } },
      }),
      goLimitRetryAfter: block({
        model: { providerID: 'opencode-go', id: 'kimi-k3' },
        error: { type: 'provider.go-limit', status: 429, message: 'OpenCode Go weekly usage limit reached.', retryAfterMs: 2 * 3600_000 },
      }),
      modelBudgetLimit: block({
        model: { providerID: 'opencode', id: 'claude-opus-5-5' },
        error: { type: 'provider.model-budget-limit', status: 402, message: "You've reached the spend limit for this model." },
      }),
      openaiDuration: block({
        model: { providerID: 'openai', id: 'gpt-5.5' },
        error: { type: 'provider.rate-limit', status: 429, message: 'Rate limit reached' },
        headers: { 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '6m0s' },
      }),
      // Provider outages are retried by OpenCode on the same model, never switched.
      // bare503 is the real error that moved a Kimaki session from opus to gpt.
      overloaded: block({
        error: { type: 'provider.internal', status: 529, message: 'Overloaded' },
        headers: { 'retry-after-ms': '1500' },
      }),
      bare503: block({ error: { type: 'provider.internal', status: 503, message: 'Provider request failed with HTTP 503', response: { body: '' } } }),
      quotaIn500: block({ error: { type: 'provider.internal', status: 500, message: 'You have reached your spending limit' } }),
      auth: block({ error: { type: 'provider.auth', status: 401, message: 'invalid x-api-key' } }),
      plain500: block({ error: { type: 'provider.internal', status: 500, message: 'Internal server error' } }),
      invalidRequest: block({ error: { type: 'provider.invalid-request', status: 400, message: 'bad' } }),
    }).toMatchInlineSnapshot(`
      {
        "anthropicApiTokens": {
          "credentialID": "cred_a",
          "modelID": "claude-opus-5-5",
          "providerID": "anthropic",
          "reason": "rate-limit",
          "until": "2026-10-02T12:00:42.000Z",
        },
        "anthropicSubscription": {
          "credentialID": "cred_a",
          "modelID": "*",
          "providerID": "anthropic",
          "reason": "quota",
          "until": "2026-10-02T15:00:00.000Z",
        },
        "auth": {
          "credentialID": "cred_a",
          "modelID": "*",
          "providerID": "anthropic",
          "reason": "auth",
          "until": "2026-10-03T12:00:00.000Z",
        },
        "bare503": undefined,
        "chatgptInvalidUser": {
          "credentialID": "cred_a",
          "modelID": "*",
          "providerID": "openai",
          "reason": "auth",
          "until": "2026-10-03T12:00:00.000Z",
        },
        "chatgptSignInLimit": {
          "credentialID": "cred_a",
          "modelID": "*",
          "providerID": "openai",
          "reason": "quota",
          "until": "2026-10-02T12:30:00.000Z",
        },
        "chatgptWorkspaceLimit": {
          "credentialID": "cred_a",
          "modelID": "*",
          "providerID": "openai",
          "reason": "quota",
          "until": "2026-10-02T12:30:00.000Z",
        },
        "codexHeaders": {
          "credentialID": "cred_a",
          "modelID": "*",
          "providerID": "openai",
          "reason": "quota",
          "until": "2026-10-03T12:00:00.000Z",
        },
        "codexUsageLimit": {
          "credentialID": "cred_a",
          "modelID": "*",
          "providerID": "openai",
          "reason": "quota",
          "until": "2026-10-02T13:30:00.000Z",
        },
        "goLimitRetryAfter": {
          "credentialID": "cred_a",
          "modelID": "*",
          "providerID": "opencode-go",
          "reason": "quota",
          "until": "2026-10-02T14:00:00.000Z",
        },
        "invalidRequest": undefined,
        "modelBudgetLimit": {
          "credentialID": "cred_a",
          "modelID": "claude-opus-5-5",
          "providerID": "opencode",
          "reason": "quota",
          "until": "2026-10-02T12:30:00.000Z",
        },
        "openaiDuration": {
          "credentialID": "cred_a",
          "modelID": "gpt-5.5",
          "providerID": "openai",
          "reason": "rate-limit",
          "until": "2026-10-02T12:06:00.000Z",
        },
        "overloaded": undefined,
        "plain500": undefined,
        "quotaIn500": {
          "credentialID": "cred_a",
          "modelID": "*",
          "providerID": "anthropic",
          "reason": "quota",
          "until": "2026-10-02T12:30:00.000Z",
        },
      }
    `)
  })
})

test('loginKey matches two saved logins of the same user', () => {
  const jwt = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`
  const user = { iss: 'https://auth.openai.com', sub: 'user-1' }
  expect({
    first: loginKey({ type: 'oauth', access: jwt({ ...user, jti: 'a' }) }),
    second: loginKey({ type: 'oauth', access: jwt({ ...user, jti: 'b' }) }),
    other: loginKey({ type: 'oauth', access: jwt({ ...user, sub: 'user-2' }) }),
    opaque: loginKey({ type: 'oauth', access: 'not-a-jwt' }),
    apiKey: loginKey({ type: 'key' }),
  }).toMatchInlineSnapshot(`
    {
      "apiKey": undefined,
      "first": "https://auth.openai.com user-1",
      "opaque": undefined,
      "other": "https://auth.openai.com user-2",
      "second": "https://auth.openai.com user-1",
    }
  `)
})

describe('pick', () => {
  const ranking = ['anthropic/claude-opus-5-5', 'openai/gpt-6-sol#high', 'xai/grok-4.6'].map((entry) => parseModel(entry)!)
  const accounts = { anthropic: ['cred_a', 'cred_b'], openai: ['cred_o'], xai: ['env'] }
  const blocked = (partial: Omit<Block, 'until' | 'reason'>, minutes: number): Block => ({
    ...partial,
    until: now + minutes * 60_000,
    reason: 'rate-limit',
  })
  const choose = (blocks: Block[]) => {
    const choice = pick({ ranking, accounts, blocks, now })
    return choice && { ...choice, waitUntil: iso(choice.waitUntil) }
  }

  test('same model on the next account, then the next model, then wait for the first reset', () => {
    expect({
      nothingBlocked: choose([]),
      firstAccountLimited: choose([blocked({ providerID: 'anthropic', credentialID: 'cred_a', modelID: 'claude-opus-5-5' }, 5)]),
      bothAccountsLimited: choose([
        blocked({ providerID: 'anthropic', credentialID: 'cred_a', modelID: '*' }, 5),
        blocked({ providerID: 'anthropic', credentialID: 'cred_b', modelID: 'claude-opus-5-5' }, 5),
      ]),
      twoProvidersLimited: choose([
        blocked({ providerID: 'anthropic', credentialID: 'cred_a', modelID: '*' }, 1),
        blocked({ providerID: 'anthropic', credentialID: 'cred_b', modelID: '*' }, 1),
        blocked({ providerID: 'openai', credentialID: 'cred_o', modelID: '*' }, 60),
      ]),
      expiredBlockIgnored: choose([blocked({ providerID: 'anthropic', credentialID: 'cred_a', modelID: '*' }, -1)]),
      allBlocked: choose([
        blocked({ providerID: 'anthropic', credentialID: 'cred_a', modelID: '*' }, 30),
        blocked({ providerID: 'anthropic', credentialID: 'cred_b', modelID: '*' }, 30),
        blocked({ providerID: 'openai', credentialID: 'cred_o', modelID: '*' }, 10),
        blocked({ providerID: 'xai', credentialID: 'env', modelID: '*' }, 20),
      ]),
    }).toMatchInlineSnapshot(`
      {
        "allBlocked": {
          "credentialID": "cred_o",
          "model": {
            "id": "gpt-6-sol",
            "providerID": "openai",
            "variant": "high",
          },
          "waitUntil": "2026-10-02T12:10:00.000Z",
        },
        "bothAccountsLimited": {
          "credentialID": "cred_o",
          "model": {
            "id": "gpt-6-sol",
            "providerID": "openai",
            "variant": "high",
          },
          "waitUntil": undefined,
        },
        "expiredBlockIgnored": {
          "credentialID": "cred_a",
          "model": {
            "id": "claude-opus-5-5",
            "providerID": "anthropic",
          },
          "waitUntil": undefined,
        },
        "firstAccountLimited": {
          "credentialID": "cred_b",
          "model": {
            "id": "claude-opus-5-5",
            "providerID": "anthropic",
          },
          "waitUntil": undefined,
        },
        "nothingBlocked": {
          "credentialID": "cred_a",
          "model": {
            "id": "claude-opus-5-5",
            "providerID": "anthropic",
          },
          "waitUntil": undefined,
        },
        "twoProvidersLimited": {
          "credentialID": "env",
          "model": {
            "id": "grok-4.6",
            "providerID": "xai",
          },
          "waitUntil": undefined,
        },
      }
    `)
  })

  test('never waits on an account whose login failed', () => {
    // Issue #262: cred_a at its weekly limit, idle cred_b with a dead refresh token.
    // Waiting on cred_b would activate it for every session.
    const anthropicOnly = { anthropic: ['cred_a', 'cred_b'] }
    const weekly = blocked({ providerID: 'anthropic', credentialID: 'cred_a', modelID: '*' }, 7 * 24 * 60)
    const dead: Block = { providerID: 'anthropic', credentialID: 'cred_b', modelID: '*', until: now + 24 * 60 * 60_000, reason: 'auth' }
    expect({
      limitedAndDead: pick({ ranking, accounts: anthropicOnly, blocks: [weekly, dead], now }),
      onlyDead: pick({ ranking, accounts: { anthropic: ['cred_b'] }, blocks: [dead], now }),
    }).toMatchInlineSnapshot(`
      {
        "limitedAndDead": {
          "credentialID": "cred_a",
          "model": {
            "id": "claude-opus-5-5",
            "providerID": "anthropic",
          },
          "waitUntil": 1791547200000,
        },
        "onlyDead": undefined,
      }
    `)
  })
})
