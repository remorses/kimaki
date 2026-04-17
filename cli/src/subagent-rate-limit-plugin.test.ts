// Tests the fallback model ranking for subagent rate-limit recovery.

import { describe, expect, test } from 'vitest'
import { listCandidateModels } from './subagent-rate-limit-plugin.js'

function createProviderData(): Parameters<typeof listCandidateModels>[0]['providerData'] {
  return {
    connected: ['anthropic', 'openai'],
    default: {
      anthropic: 'claude-sonnet-4-5',
      openai: 'gpt-5',
    },
    all: [
      {
        id: 'anthropic',
        api: 'https://api.anthropic.com',
        name: 'Anthropic',
        env: ['ANTHROPIC_API_KEY'],
        models: {
          'claude-sonnet-4-5': {
            id: 'claude-sonnet-4-5',
            name: 'Claude Sonnet 4.5',
            release_date: '2026-01-01',
            attachment: true,
            reasoning: true,
            temperature: true,
            tool_call: true,
            limit: { context: 200_000, output: 16_000 },
            options: {},
            cost: { input: 3, output: 15 },
            modalities: { input: ['text'], output: ['text'] },
          },
          'claude-haiku-4-5': {
            id: 'claude-haiku-4-5',
            name: 'Claude Haiku 4.5',
            release_date: '2026-01-01',
            attachment: true,
            reasoning: false,
            temperature: true,
            tool_call: true,
            limit: { context: 200_000, output: 16_000 },
            options: {},
            cost: { input: 1, output: 5 },
            modalities: { input: ['text'], output: ['text'] },
          },
        },
      },
      {
        id: 'openai',
        api: 'https://api.openai.com/v1',
        name: 'OpenAI',
        env: ['OPENAI_API_KEY'],
        models: {
          'gpt-5': {
            id: 'gpt-5',
            name: 'GPT-5',
            release_date: '2026-01-01',
            attachment: true,
            reasoning: true,
            temperature: true,
            tool_call: true,
            limit: { context: 200_000, output: 16_000 },
            options: {},
            cost: { input: 1.25, output: 10 },
            modalities: { input: ['text'], output: ['text'] },
          },
          'gpt-4o-mini': {
            id: 'gpt-4o-mini',
            name: 'GPT-4o mini',
            release_date: '2026-01-01',
            attachment: true,
            reasoning: false,
            temperature: true,
            tool_call: true,
            limit: { context: 200_000, output: 16_000 },
            options: {},
            cost: { input: 0.15, output: 0.6 },
            modalities: { input: ['text'], output: ['text'] },
          },
        },
      },
    ],
  }
}

describe('listCandidateModels', () => {
  test('prefers the cheapest model from other connected providers', () => {
    const result = listCandidateModels({
      providerData: createProviderData(),
      currentModel: {
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4-5',
      },
    })

    expect(result).toMatchInlineSnapshot(`
      [
        {
          "modelID": "gpt-4o-mini",
          "providerID": "openai",
        },
        {
          "modelID": "gpt-5",
          "providerID": "openai",
        },
      ]
    `)
  })

  test('never falls back to models from the same provider', () => {
    const providerData = createProviderData()
    providerData.connected = ['anthropic']
    providerData.all = providerData.all.filter((provider) => {
      return provider.id === 'anthropic'
    })

    const result = listCandidateModels({
      providerData,
      currentModel: {
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4-5',
      },
    })

    expect(result).toEqual([])
  })
})
