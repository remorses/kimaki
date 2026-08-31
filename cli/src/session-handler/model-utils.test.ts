// Tests for model ID parsing, cached provider.list wrapping, and validation.

import { afterEach, describe, expect, test } from 'vitest'
import { InvalidModelError } from '../errors.js'
import {
  clearModelListCache,
  formatDisplayedModelId,
  getProviderModelName,
  listModels,
  parseModelId,
  resolveDisplayedModelId,
  validateCliModelOption,
  validateModelId,
  validateModelIdAgainstList,
  type ListedModel,
} from './model-utils.js'

const listed: ListedModel[] = [
  {
    providerID: 'anthropic',
    modelID: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    connected: true,
  },
  {
    providerID: 'anthropic',
    modelID: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    connected: true,
  },
  {
    providerID: 'openai',
    modelID: 'gpt-5.4',
    name: 'GPT-5.4',
    connected: false,
  },
]

afterEach(() => {
  clearModelListCache()
})

describe('getProviderModelName', () => {
  const providers = [
    {
      id: 'subrouter',
      models: {
        build: { name: 'build (claude-opus-4-6)' },
        default: { name: 'default' },
      },
    },
    {
      id: 'deterministic-provider',
      models: {
        'deterministic-v2': { name: 'deterministic-v2' },
      },
    },
  ]

  test('uses the sdk display name when subrouter adds the live model', () => {
    expect(
      getProviderModelName({
        providers,
        providerID: 'subrouter',
        modelID: 'build',
      }),
    ).toMatchInlineSnapshot(`"build (claude-opus-4-6)"`)
  })

  test('falls back to the model id when name is missing', () => {
    expect(
      getProviderModelName({
        providers: [{ id: 'subrouter', models: { build: {} } }],
        providerID: 'subrouter',
        modelID: 'build',
      }),
    ).toMatchInlineSnapshot(`"build"`)
  })

  test('returns undefined when provider or model is missing', () => {
    expect(
      getProviderModelName({
        providers,
        providerID: 'subrouter',
        modelID: 'missing',
      }),
    ).toBeUndefined()
    expect(
      getProviderModelName({
        providers,
        providerID: 'openai',
        modelID: 'gpt-5.4',
      }),
    ).toBeUndefined()
    expect(
      getProviderModelName({
        providers,
      }),
    ).toBeUndefined()
  })
})

describe('formatDisplayedModelId', () => {
  test('keeps provider/id when the sdk name matches the model id', () => {
    expect(
      formatDisplayedModelId({
        providerID: 'deterministic-provider',
        modelID: 'deterministic-v2',
        name: 'deterministic-v2',
      }),
    ).toMatchInlineSnapshot(`"deterministic-provider/deterministic-v2"`)
  })

  test('uses the sdk name so subrouter live model shows in parentheses', () => {
    expect(
      formatDisplayedModelId({
        providerID: 'subrouter',
        modelID: 'build',
        name: 'build (claude-opus-4-6)',
      }),
    ).toMatchInlineSnapshot(`"subrouter/build (claude-opus-4-6)"`)
  })

  test('falls back to provider/id when name is missing', () => {
    expect(
      formatDisplayedModelId({
        providerID: 'subrouter',
        modelID: 'build',
      }),
    ).toMatchInlineSnapshot(`"subrouter/build"`)
  })

  test('keeps provider/id when sdk name is a pretty label', () => {
    expect(
      formatDisplayedModelId({
        providerID: 'anthropic',
        modelID: 'claude-opus-4-6',
        name: 'Claude Opus 4.6',
      }),
    ).toMatchInlineSnapshot(`"anthropic/claude-opus-4-6"`)
  })
})

describe('resolveDisplayedModelId', () => {
  test('uses subrouter sdk name with parentheses', () => {
    expect(
      resolveDisplayedModelId({
        providers: [
          {
            id: 'subrouter',
            models: { build: { name: 'build (claude-opus-4-6)' } },
          },
        ],
        providerID: 'subrouter',
        modelID: 'build',
      }),
    ).toMatchInlineSnapshot(`"subrouter/build (claude-opus-4-6)"`)
  })
})

describe('parseModelId', () => {
  test('splits provider/model', () => {
    expect(parseModelId('anthropic/claude-opus-4-6')).toMatchInlineSnapshot(`
      {
        "modelID": "claude-opus-4-6",
        "providerID": "anthropic",
      }
    `)
  })

  test('keeps slashes inside the model id', () => {
    expect(parseModelId('opencode/glm-5/free')).toMatchInlineSnapshot(`
      {
        "modelID": "glm-5/free",
        "providerID": "opencode",
      }
    `)
  })

  test('rejects missing slash, empty provider, and empty model', () => {
    expect(parseModelId('claude-opus-4-6')).toBeUndefined()
    expect(parseModelId('/claude-opus-4-6')).toBeUndefined()
    expect(parseModelId('anthropic/')).toBeUndefined()
    expect(parseModelId('')).toBeUndefined()
  })
})

describe('validateModelIdAgainstList', () => {
  test('accepts a connected listed model', () => {
    expect(
      validateModelIdAgainstList({
        model: 'anthropic/claude-opus-4-6',
        models: listed,
      }),
    ).toMatchInlineSnapshot(`
      {
        "modelID": "claude-opus-4-6",
        "providerID": "anthropic",
      }
    `)
  })

  test('rejects bad format', () => {
    const result = validateModelIdAgainstList({
      model: 'claude-opus-4-6',
      models: listed,
    })
    expect(result).toBeInstanceOf(InvalidModelError)
    if (result instanceof InvalidModelError) {
      expect(result.model).toBe('claude-opus-4-6')
      expect(result.reason).toContain('provider/model')
    }
  })

  test('rejects unknown model and lists siblings', () => {
    const result = validateModelIdAgainstList({
      model: 'anthropic/does-not-exist',
      models: listed,
    })
    expect(result).toBeInstanceOf(InvalidModelError)
    if (result instanceof InvalidModelError) {
      expect(result.message).toContain('anthropic/does-not-exist')
      expect(result.message).toContain('anthropic/claude-opus-4-6')
      expect(result.message).toContain('anthropic/claude-sonnet-4-6')
    }
  })

  test('rejects disconnected provider', () => {
    const result = validateModelIdAgainstList({
      model: 'openai/gpt-5.4',
      models: listed,
    })
    expect(result).toBeInstanceOf(InvalidModelError)
    if (result instanceof InvalidModelError) {
      expect(result.message).toContain('not connected')
      expect(result.message).toContain('openai')
    }
  })
})

function fakeGetClient(options?: {
  calls?: { count: number }
  failOnce?: boolean
}) {
  let failed = false
  return () => ({
    provider: {
      list: async () => {
        if (options?.calls) options.calls.count += 1
        if (options?.failOnce && !failed) {
          failed = true
          throw new Error('provider.list failed')
        }
        return {
          data: {
            all: [
              {
                id: 'anthropic',
                models: {
                  'claude-opus-4-6': { name: 'Claude Opus 4.6' },
                },
              },
            ],
            connected: ['anthropic'],
            default: {},
          },
        }
      },
    },
  })
}

describe('listModels', () => {
  test('returns listed models from provider.list', async () => {
    const models = await listModels({
      getClient: fakeGetClient() as never,
      directory: '/tmp/project-a',
    })
    expect(models).not.toBeInstanceOf(Error)
    if (models instanceof Error) throw models
    expect(models).toMatchInlineSnapshot(`
      [
        {
          "connected": true,
          "modelID": "claude-opus-4-6",
          "name": "Claude Opus 4.6",
          "providerID": "anthropic",
        },
      ]
    `)
  })

  test('memoizes provider.list per directory', async () => {
    const calls = { count: 0 }
    const getClient = fakeGetClient({ calls }) as never
    const first = await listModels({ getClient, directory: '/tmp/project-a' })
    const second = await listModels({ getClient, directory: '/tmp/project-a' })
    expect(first).not.toBeInstanceOf(Error)
    expect(second).not.toBeInstanceOf(Error)
    expect(calls.count).toBe(1)
  })

  test('does not share cache across directories', async () => {
    const calls = { count: 0 }
    const getClient = fakeGetClient({ calls }) as never
    const first = await listModels({ getClient, directory: '/tmp/project-a' })
    const second = await listModels({ getClient, directory: '/tmp/project-b' })
    expect(first).not.toBeInstanceOf(Error)
    expect(second).not.toBeInstanceOf(Error)
    expect(calls.count).toBe(2)
  })

  test('does not cache failed fetches', async () => {
    const calls = { count: 0 }
    const getClient = fakeGetClient({ calls, failOnce: true }) as never
    const first = await listModels({ getClient, directory: '/tmp/project-a' })
    expect(first).toBeInstanceOf(Error)
    const second = await listModels({ getClient, directory: '/tmp/project-a' })
    expect(second).not.toBeInstanceOf(Error)
    expect(calls.count).toBe(2)
  })

  test('does not restore a pending result after the cache is cleared', async () => {
    const calls = { count: 0 }
    const firstResponse = Promise.withResolvers<{
      data: {
        all: Array<{ id: string; models: Record<string, { name: string }> }>
        connected: string[]
        default: Record<string, string>
      }
    }>()
    const getClient = (() => ({
      provider: {
        list: () => {
          calls.count += 1
          if (calls.count === 1) return firstResponse.promise
          return Promise.resolve({
            data: {
              all: [{ id: 'openai', models: { 'gpt-5.5': { name: 'GPT-5.5' } } }],
              connected: ['openai'],
              default: {},
            },
          })
        },
      },
    })) as never

    const pending = listModels({ getClient, directory: '/tmp/project-a' })
    clearModelListCache()
    firstResponse.resolve({
      data: {
        all: [
          {
            id: 'anthropic',
            models: { 'claude-opus-4-6': { name: 'Claude Opus 4.6' } },
          },
        ],
        connected: ['anthropic'],
        default: {},
      },
    })
    await pending

    const refreshed = await listModels({ getClient, directory: '/tmp/project-a' })
    expect({ calls: calls.count, refreshed }).toMatchInlineSnapshot(`
      {
        "calls": 2,
        "refreshed": [
          {
            "connected": true,
            "modelID": "gpt-5.5",
            "name": "GPT-5.5",
            "providerID": "openai",
          },
        ],
      }
    `)
  })
})

describe('validateCliModelOption', () => {
  test('skips empty model', async () => {
    expect(await validateCliModelOption({ model: undefined })).toBeUndefined()
    expect(await validateCliModelOption({ model: '' })).toBeUndefined()
  })

  test('rejects bad format without starting opencode', async () => {
    const result = await validateCliModelOption({ model: 'claude-opus-4-6' })
    expect(result).toBeInstanceOf(InvalidModelError)
  })
})

describe('validateModelId', () => {
  test('validates against the cached list', async () => {
    const getClient = fakeGetClient() as never
    const ok = await validateModelId({
      model: 'anthropic/claude-opus-4-6',
      getClient,
      directory: '/tmp/project-a',
    })
    expect(ok).toMatchInlineSnapshot(`
      {
        "modelID": "claude-opus-4-6",
        "providerID": "anthropic",
      }
    `)

    const bad = await validateModelId({
      model: 'anthropic/missing',
      getClient,
      directory: '/tmp/project-a',
    })
    expect(bad).toBeInstanceOf(InvalidModelError)
  })
})
