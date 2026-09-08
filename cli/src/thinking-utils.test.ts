// Tests thinking-level variant matching used by /xxx-agent variant.

import { describe, expect, test } from 'vitest'
import {
  resolveRequestedThinkingVariant,
} from './thinking-utils.js'

describe('resolveRequestedThinkingVariant', () => {
  const providers = [
    {
      id: 'anthropic',
      models: {
        'claude-opus-4-6': {
          variants: {
            high: {},
            max: {},
          },
        },
      },
    },
  ]

  test('matches a supported thinking level case-insensitively', () => {
    expect(
      resolveRequestedThinkingVariant({
        requestedValue: 'HIGH',
        providers,
        providerId: 'anthropic',
        modelId: 'claude-opus-4-6',
      }),
    ).toBe('high')
  })

  test('returns undefined for an unsupported thinking level', () => {
    expect(
      resolveRequestedThinkingVariant({
        requestedValue: 'not-a-real-level',
        providers,
        providerId: 'anthropic',
        modelId: 'claude-opus-4-6',
      }),
    ).toBeUndefined()
  })
})
