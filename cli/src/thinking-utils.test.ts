// Tests thinking-level variant matching used by /xxx-agent variant.

import { describe, expect, test } from 'vitest'
import {
  getThinkingValuesForModel,
  matchThinkingValue,
} from './thinking-utils.js'

describe('matchThinkingValue', () => {
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
  const availableValues = getThinkingValuesForModel({
    providers,
    providerId: 'anthropic',
    modelId: 'claude-opus-4-6',
  })

  test('matches a supported thinking level case-insensitively', () => {
    expect(
      matchThinkingValue({
        requestedValue: 'HIGH',
        availableValues,
      }),
    ).toBe('high')
  })

  test('returns undefined for an unsupported thinking level', () => {
    expect(
      matchThinkingValue({
        requestedValue: 'not-a-real-level',
        availableValues,
      }),
    ).toBeUndefined()
  })
})
