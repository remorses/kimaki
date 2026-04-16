// Tests the subagent-only rate-limit model switching plugin.

import { describe, expect, test } from 'vitest'
import { subagentRateLimitPlugin } from './subagent-rate-limit-plugin.js'

type PluginHooks = Awaited<ReturnType<typeof subagentRateLimitPlugin>>
type EventHook = NonNullable<PluginHooks['event']>
type PluginEvent = Parameters<EventHook>[0]['event']
type PluginContext = Parameters<typeof subagentRateLimitPlugin>[0]

type MockProviderData = {
  all: Array<{
    id: string
    models: Record<string, { id: string; name: string; release_date: string }>
  }>
  default: Record<string, string>
  connected: string[]
}

type MockClient = {
  provider: {
    list: (input: { query?: { directory?: string } }) => Promise<{
      data?: MockProviderData
    }>
  }
  session: {
    promptAsync: (input: {
      path: { id: string }
      body: {
        parts: unknown[]
        model?: {
          providerID: string
          modelID: string
        }
      }
    }) => Promise<void>
  }
  tui: {
    showToast: (input: {
      body: {
        message: string
        variant: 'info' | 'success' | 'warning' | 'error'
      }
    }) => Promise<void>
  }
}

function createContext({ client }: { client: MockClient }): PluginContext {
  return {
    client: client as unknown as PluginContext['client'],
    project: {
      id: 'project-id',
      worktree: '/Users/morse/Documents/GitHub/kimakivoice',
      time: { created: Date.now() },
    },
    directory: '/Users/morse/Documents/GitHub/kimakivoice',
    worktree: '/Users/morse/Documents/GitHub/kimakivoice',
    experimental_workspace: {
      register: () => {
        return
      },
    },
    serverUrl: new URL('http://127.0.0.1:4096'),
    $: {} as PluginContext['$'],
  }
}

async function requireEventHook({ client }: { client: MockClient }): Promise<EventHook> {
  const hooks = await subagentRateLimitPlugin(createContext({ client }))
  if (!hooks.event) {
    throw new Error('Expected event hook')
  }
  return hooks.event
}

function createTaskChildEvent({
  childSessionId,
  subagentType = 'general',
}: {
  childSessionId: string
  subagentType?: string
}): PluginEvent {
  return {
    type: 'message.part.updated',
    properties: {
      part: {
        id: 'part-task',
        sessionID: 'ses-main',
        messageID: 'msg-main-assistant',
        type: 'tool',
        callID: 'call-task',
        tool: 'task',
        state: {
          status: 'running',
          input: { subagent_type: subagentType },
          metadata: { sessionId: childSessionId },
          time: { start: Date.now() },
        },
      },
    },
  } as PluginEvent
}

function createAssistantMessageEvent({
  sessionID,
  providerID,
  modelID,
}: {
  sessionID: string
  providerID: string
  modelID: string
}): PluginEvent {
  return {
    type: 'message.updated',
    properties: {
      info: {
        id: 'msg-assistant',
        sessionID,
        role: 'assistant',
        parentID: 'msg-user',
        providerID,
        modelID,
        mode: 'chat',
        path: {
          cwd: '/Users/morse/Documents/GitHub/kimakivoice',
          root: '/Users/morse/Documents/GitHub/kimakivoice',
        },
        time: { created: Date.now() },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    },
  } as PluginEvent
}

function createRetryStatusEvent({
  sessionID,
  message,
}: {
  sessionID: string
  message: string
}): PluginEvent {
  return {
    type: 'session.status',
    properties: {
      sessionID,
      status: {
        type: 'retry',
        attempt: 1,
        message,
        next: Date.now() + 5_000,
      },
    },
  } as PluginEvent
}

function createApiErrorEvent({
  sessionID,
  statusCode,
  responseBody,
}: {
  sessionID: string
  statusCode?: number
  responseBody?: string
}): PluginEvent {
  return {
    type: 'session.error',
    properties: {
      sessionID,
      error: {
        name: 'APIError',
        data: {
          message: 'provider error',
          statusCode,
          isRetryable: true,
          responseBody,
        },
      },
    },
  } as PluginEvent
}

function createMockClient() {
  const promptAsyncCalls: Array<{
    path: { id: string }
    body: {
      parts: unknown[]
      model?: {
        providerID: string
        modelID: string
      }
    }
  }> = []
  const toastCalls: Array<string> = []

  const providerData: MockProviderData = {
    connected: ['anthropic', 'openai'],
    default: {
      anthropic: 'claude-sonnet-4-5',
      openai: 'gpt-5',
    },
    all: [
      {
        id: 'anthropic',
        models: {
          'claude-sonnet-4-5': {
            id: 'claude-sonnet-4-5',
            name: 'Claude Sonnet 4.5',
            release_date: '2026-01-01',
          },
        },
      },
      {
        id: 'openai',
        models: {
          'gpt-5': {
            id: 'gpt-5',
            name: 'GPT-5',
            release_date: '2026-01-01',
          },
        },
      },
    ],
  }

  const client: MockClient = {
    provider: {
      list: async () => {
        return {
          data: providerData,
        }
      },
    },
    session: {
      promptAsync: async (input) => {
        promptAsyncCalls.push(input)
      },
    },
    tui: {
      showToast: async (input) => {
        toastCalls.push(input.body.message)
      },
    },
  }

  return { client, promptAsyncCalls, toastCalls }
}

describe('subagentRateLimitPlugin', () => {
  test('switches only task child sessions after retry rate limit events', async () => {
    const { client, promptAsyncCalls, toastCalls } = createMockClient()
    const eventHook = await requireEventHook({ client })

    await eventHook({ event: createTaskChildEvent({ childSessionId: 'ses-child' }) })
    await eventHook({
      event: createAssistantMessageEvent({
        sessionID: 'ses-child',
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4-5',
      }),
    })
    await eventHook({
      event: createRetryStatusEvent({
        sessionID: 'ses-child',
        message: 'Resource exhausted, please retry after 8.643s.',
      }),
    })

    expect(promptAsyncCalls).toMatchInlineSnapshot(`
      [
        {
          "body": {
            "model": {
              "modelID": "gpt-5",
              "providerID": "openai",
            },
            "parts": [],
          },
          "path": {
            "id": "ses-child",
          },
        },
      ]
    `)
    expect(toastCalls[0]).toContain('Switching general to openai/gpt-5 after rate limit')
  })

  test('detects API 429 errors for registered subagents too', async () => {
    const { client, promptAsyncCalls } = createMockClient()
    const eventHook = await requireEventHook({ client })

    await eventHook({ event: createTaskChildEvent({ childSessionId: 'ses-child' }) })
    await eventHook({
      event: createAssistantMessageEvent({
        sessionID: 'ses-child',
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4-5',
      }),
    })
    await eventHook({
      event: createApiErrorEvent({
        sessionID: 'ses-child',
        statusCode: 429,
        responseBody: 'rate_limit exceeded',
      }),
    })

    expect(promptAsyncCalls[0]?.body.model).toEqual({
      providerID: 'openai',
      modelID: 'gpt-5',
    })
  })
})
