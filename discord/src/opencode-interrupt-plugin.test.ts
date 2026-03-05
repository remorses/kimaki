// Runtime tests for queued-message interrupt plugin behavior.
//
// Event fixtures here come from real Kimaki sessions, trimmed to only the parts
// that affect interrupt behavior:
// 1) export session events:
//    `pnpm tsx src/cli.ts session export-events-jsonl --session <id> --out ../tmp/<id>.jsonl`
// 2) inspect timeline:
//    `jq -r '[.timestamp, .event.type, (.event.properties.status.type // .event.properties.info.role // .event.properties.error.name // ""), (.event.properties.info.id // .event.properties.sessionID // ""), (.event.properties.info.parentID // "")] | @tsv' ../tmp/<id>.jsonl`
// 3) keep only status/error/assistant-parent events relevant to timeout + resume.

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

const REAL_RATE_LIMIT_CASE = {
  sessionID: 'ses_34227488cffeO6V9KFc4QRzCr1',
  previousMessageID: 'msg_cbdd8fa01001UYKvAEc7rx3nTO',
  queuedMessageID: 'msg_cbdd923e5001ZSCxCbj9oGbdHV',
  events: [
    {
      type: 'session.status',
      properties: {
        sessionID: 'ses_34227488cffeO6V9KFc4QRzCr1',
        status: {
          type: 'retry',
          attempt: 1,
          message: 'Resource exhausted, please retry after 8.643s.',
          next: 1772711648923,
        },
      },
    },
    {
      type: 'message.updated',
      properties: {
        info: {
          role: 'assistant',
          sessionID: 'ses_34227488cffeO6V9KFc4QRzCr1',
          parentID: 'msg_cbdd8fa01001UYKvAEc7rx3nTO',
        },
      },
    },
  ] as InterruptEvent[],
}

const REAL_SLEEP_INTERRUPT_CASE = {
  sessionID: 'ses_342257e56ffeNdEEQ3lVVR3sZe',
  runningMessageID: 'msg_cbddaa49c00123dKnwvzTVjutL',
  interruptingMessageID: 'msg_cbddad73c001LZrsb4XMZt5Lls',
  assistantRunningEvent: {
    type: 'message.updated',
    properties: {
      info: {
        role: 'assistant',
        sessionID: 'ses_342257e56ffeNdEEQ3lVVR3sZe',
        parentID: 'msg_cbddaa49c00123dKnwvzTVjutL',
      },
    },
  } as InterruptEvent,
  idleEvent: {
    type: 'session.idle',
    properties: {
      sessionID: 'ses_342257e56ffeNdEEQ3lVVR3sZe',
    },
  } as InterruptEvent,
  abortErrorEvent: {
    type: 'session.error',
    properties: {
      sessionID: 'ses_342257e56ffeNdEEQ3lVVR3sZe',
      error: {
        name: 'MessageAbortedError',
        data: { message: 'The operation was aborted.' },
      },
    },
  } as InterruptEvent,
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
  test('real rate-limit trace keeps queued message unsent until timeout recovery', async () => {
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

    await chatHook(
      {
        sessionID: REAL_RATE_LIMIT_CASE.sessionID,
        messageID: REAL_RATE_LIMIT_CASE.queuedMessageID,
      } as InterruptChatInput,
      createChatOutput({
        sessionID: REAL_RATE_LIMIT_CASE.sessionID,
        messageID: REAL_RATE_LIMIT_CASE.queuedMessageID,
      }),
    )

    for (const event of REAL_RATE_LIMIT_CASE.events) {
      await eventHook({ event })
    }

    await delay({ ms: 30 })
    await eventHook({
      event: createSessionErrorEvent({ sessionID: REAL_RATE_LIMIT_CASE.sessionID }),
    })
    await eventHook({
      event: createSessionIdleEvent({ sessionID: REAL_RATE_LIMIT_CASE.sessionID }),
    })
    await delay({ ms: 20 })

    expect(abortCalls).toEqual([{ path: { id: REAL_RATE_LIMIT_CASE.sessionID } }])
    expect(promptAsyncCalls).toEqual([
      {
        path: { id: REAL_RATE_LIMIT_CASE.sessionID },
        body: { parts: [] },
      },
    ])
  })

  test('assistant parent match marks sent and skips timeout abort', async () => {
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

  test('real sleep interrupt trace still recovers queued interrupt message', async () => {
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

    await chatHook(
      {
        sessionID: REAL_SLEEP_INTERRUPT_CASE.sessionID,
        messageID: REAL_SLEEP_INTERRUPT_CASE.runningMessageID,
      } as InterruptChatInput,
      createChatOutput({
        sessionID: REAL_SLEEP_INTERRUPT_CASE.sessionID,
        messageID: REAL_SLEEP_INTERRUPT_CASE.runningMessageID,
      }),
    )
    await eventHook({ event: REAL_SLEEP_INTERRUPT_CASE.assistantRunningEvent })

    await chatHook(
      {
        sessionID: REAL_SLEEP_INTERRUPT_CASE.sessionID,
        messageID: REAL_SLEEP_INTERRUPT_CASE.interruptingMessageID,
      } as InterruptChatInput,
      createChatOutput({
        sessionID: REAL_SLEEP_INTERRUPT_CASE.sessionID,
        messageID: REAL_SLEEP_INTERRUPT_CASE.interruptingMessageID,
      }),
    )

    await delay({ ms: 30 })
    await eventHook({ event: REAL_SLEEP_INTERRUPT_CASE.idleEvent })
    await eventHook({ event: REAL_SLEEP_INTERRUPT_CASE.abortErrorEvent })
    await delay({ ms: 20 })

    expect(abortCalls).toEqual([{ path: { id: REAL_SLEEP_INTERRUPT_CASE.sessionID } }])
    expect(promptAsyncCalls).toEqual([
      {
        path: { id: REAL_SLEEP_INTERRUPT_CASE.sessionID },
        body: { parts: [] },
      },
    ])
  })
})
