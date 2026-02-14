import { describe, expect, test } from 'vitest'
import {
  getThinkingValuesForModel,
  matchThinkingValue,
} from './thinking-utils.js'

describe('thinking-utils', () => {
  test('returns thinking values for the selected model', () => {
    const values = getThinkingValuesForModel({
      providers: [
        {
          id: 'anthropic',
          models: {
            'claude-sonnet': {
              variants: {
                low: {},
                high: {},
                max: {},
              },
            },
          },
        },
        {
          id: 'openai',
          models: {
            'gpt-5': {
              variants: {
                minimal: {},
              },
            },
          },
        },
      ],
      providerId: 'anthropic',
      modelId: 'claude-sonnet',
    })

    expect(values).toMatchInlineSnapshot(`
      [
        "low",
        "high",
        "max",
      ]
    `)
  })

  test('matches thinking values case-insensitively', () => {
    const matched = matchThinkingValue({
      requestedValue: 'MAX',
      availableValues: ['low', 'high', 'max'],
    })

    expect(matched).toMatchInlineSnapshot(`"max"`)
  })
})
