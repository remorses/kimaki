// Unit tests for queued-message interrupt plugin behavior.
// Verifies timeout-triggered abort/resume and sent-message bypass logic.

import { afterEach, describe, expect, test } from 'vitest'
import { interruptOpencodeSessionOnUserMessage } from './opencode-interrupt-plugin.js'

type InterruptHooks = Awaited<ReturnType<typeof interruptOpencodeSessionOnUserMessage>>
type InterruptEventHook = NonNullable<InterruptHooks['event']>
type InterruptChatHook = NonNullable<InterruptHooks['chat.message']>
type InterruptEvent = Parameters<InterruptEventHook>[0]['event']
type InterruptChatInput = Parameters<InterruptChatHook>[0]
type InterruptChatOutput = Parameters<InterruptChatHook>[1]
type InterruptContext = Parameters<typeof interruptOpencodeSessionOnUserMessage>[0]

type MockClient = {
  session: {
    abort: (input: { path: { id: string } }) => Promise<void>
    promptAsync: (input: {
      path: { id: string }
      body: { parts: [] }
    }) => Promise<void>
  }
}

function createContext({ client }: { client: MockClient }): InterruptContext {
  return {
    client: client as unknown as InterruptContext['client'],
    project: {
      id: 'project-id',
      worktree: '/Users/morse/Documents/GitHub/kimakivoice',
      time: { created: Date.now() },
    },
    directory: '/Users/morse/Documents/GitHub/kimakivoice',
    worktree: '/Users/morse/Documents/GitHub/kimakivoice',
    serverUrl: new URL('http://127.0.0.1:4096'),
    $: {} as InterruptContext['$'],
  }
}

function createChatOutput({
  sessionID,
  messageID,
}: {
  sessionID: string
  messageID: string
}): InterruptChatOutput {
  return {
    message: {
      id: messageID,
      sessionID,
      role: 'user',
      time: { created: Date.now() },
      agent: 'build',
      model: {
        providerID: 'deterministic-provider',
        modelID: 'deterministic-v2',
      },
    },
    parts: [],
  } as InterruptChatOutput
}

function createSessionErrorEvent({ sessionID }: { sessionID: string }): InterruptEvent {
  return {
    type: 'session.error',
    properties: {
      sessionID,
      error: {
        name: 'MessageAbortedError',
        data: { message: 'The operation was aborted.' },
      },
    },
  } as InterruptEvent
}

function createSessionIdleEvent({ sessionID }: { sessionID: string }): InterruptEvent {
  return {
    type: 'session.idle',
    properties: { sessionID },
  } as InterruptEvent
}

function createAssistantStartedEvent({
  sessionID,
  messageID,
}: {
  sessionID: string
  messageID: string
}): InterruptEvent {
  return {
    type: 'message.updated',
    properties: {
      info: {
        role: 'assistant',
        sessionID,
        parentID: messageID,
      },
    },
  } as InterruptEvent
}

function delay({ ms }: { ms: number }): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve()
    }, ms)
  })
}

async function requireHooks({
  client,
}: {
  client: MockClient
}): Promise<{ eventHook: InterruptEventHook; chatHook: InterruptChatHook }> {
  const hooks = await interruptOpencodeSessionOnUserMessage(
    createContext({ client }),
  )

  const eventHook = hooks.event
  if (!eventHook) {
    throw new Error('Expected event hook')
  }
  const chatHook = hooks['chat.message']
  if (!chatHook) {
    throw new Error('Expected chat.message hook')
  }

  return { eventHook, chatHook }
}

afterEach(() => {
  delete process.env['KIMAKI_INTERRUPT_STEP_TIMEOUT_MS']
})

describe('interruptOpencodeSessionOnUserMessage', () => {
  test('aborts and resumes when queued user message is still unsent after timeout', async () => {
    process.env['KIMAKI_INTERRUPT_STEP_TIMEOUT_MS'] = '20'

    const abortCalls: Array<{ path: { id: string } }> = []
    const promptAsyncCalls: Array<{
      path: { id: string }
      body: { parts: [] }
    }> = []
    const client: MockClient = {
      session: {
        abort: async (input) => {
          abortCalls.push(input)
        },
        promptAsync: async (input) => {
          promptAsyncCalls.push(input)
        },
      },
    }

    const { eventHook, chatHook } = await requireHooks({ client })
    const sessionID = 'ses-timeout'
    const messageID = 'msg-timeout'

    await chatHook(
      { sessionID, messageID } as InterruptChatInput,
      createChatOutput({ sessionID, messageID }),
    )

    await delay({ ms: 30 })
    await eventHook({ event: createSessionErrorEvent({ sessionID }) })
    await eventHook({ event: createSessionIdleEvent({ sessionID }) })
    await delay({ ms: 20 })

    expect(abortCalls).toEqual([{ path: { id: sessionID } }])
    expect(promptAsyncCalls).toEqual([
      { path: { id: sessionID }, body: { parts: [] } },
    ])
  })

  test('does nothing when message is marked sent before timeout', async () => {
    process.env['KIMAKI_INTERRUPT_STEP_TIMEOUT_MS'] = '40'

    const abortCalls: Array<{ path: { id: string } }> = []
    const promptAsyncCalls: Array<{
      path: { id: string }
      body: { parts: [] }
    }> = []
    const client: MockClient = {
      session: {
        abort: async (input) => {
          abortCalls.push(input)
        },
        promptAsync: async (input) => {
          promptAsyncCalls.push(input)
        },
      },
    }

    const { eventHook, chatHook } = await requireHooks({ client })
    const sessionID = 'ses-sent'
    const messageID = 'msg-sent'

    await chatHook(
      { sessionID, messageID } as InterruptChatInput,
      createChatOutput({ sessionID, messageID }),
    )
    await eventHook({
      event: createAssistantStartedEvent({ sessionID, messageID }),
    })
    await delay({ ms: 70 })

    expect(abortCalls).toEqual([])
    expect(promptAsyncCalls).toEqual([])
  })
})
