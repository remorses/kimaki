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

function createAssistantAbortedEvent({
  sessionID,
  assistantMessageID,
  parentID,
}: {
  sessionID: string
  assistantMessageID: string
  parentID: string
}): InterruptEvent {
  return {
    type: 'message.updated',
    properties: {
      info: {
        id: assistantMessageID,
        role: 'assistant',
        sessionID,
        parentID,
        error: {
          name: 'MessageAbortedError',
          data: { message: 'The operation was aborted.' },
        },
      },
    },
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
    await eventHook({
      event: createAssistantAbortedEvent({
        sessionID: REAL_RATE_LIMIT_CASE.sessionID,
        assistantMessageID: 'msg-rate-limit-aborted',
        parentID: REAL_RATE_LIMIT_CASE.previousMessageID,
      }),
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

  // Reproduces production bug from ses_33bb324aaffeQuvMZeixQ9x11N:
  //
  // Timeline:
  //   1. Session is busy streaming response to firstMsg
  //   2. User sends userMsg (queued via promptAsync in opencode)
  //   3. 3s timeout fires - no assistant started on userMsg
  //   4. Plugin aborts session → session goes idle
  //   5. Plugin sends promptAsync({parts:[]}) → opencode creates NEW empty
  //      user message and processes THAT instead of userMsg
  //   6. userMsg is silently lost — no assistant ever responds to it
  //
  // Root cause: session.abort() clears opencode's internal prompt queue.
  // The empty promptAsync({parts:[]}) is supposed to "resume" but instead
  // creates a separate message. The user's actual message is gone.
  //
  // This is a unit-level repro — it proves the plugin clears the user
  // message from tracking without any assistant acknowledgement. A full
  // e2e test is needed to prove the message is lost in Discord.
  test.todo('BUG REPRO: user message dropped after abort because promptAsync({parts:[]}) replaces it', async () => {
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
    const sessionID = 'ses-33bb-repro'
    const firstMsgID = 'msg-first-streaming'
    const userMsgID = 'msg-user-queued'

    // 1. First message is running (assistant already started on it)
    await chatHook(
      { sessionID, messageID: firstMsgID } as InterruptChatInput,
      createChatOutput({ sessionID, messageID: firstMsgID }),
    )
    await eventHook({
      event: createAssistantStartedEvent({ sessionID, messageID: firstMsgID }),
    })

    // 2. User sends second message while session is busy streaming
    await chatHook(
      { sessionID, messageID: userMsgID } as InterruptChatInput,
      createChatOutput({ sessionID, messageID: userMsgID }),
    )

    // 3. Timeout fires (20ms), plugin runs handleUnsentTimeout
    await delay({ ms: 30 })

    // 4. Simulate abort completing (error + idle from opencode)
    await eventHook({ event: createSessionErrorEvent({ sessionID }) })
    await eventHook({ event: createSessionIdleEvent({ sessionID }) })
    await eventHook({
      event: createAssistantAbortedEvent({
        sessionID,
        assistantMessageID: 'msg-aborted-after-timeout',
        parentID: firstMsgID,
      }),
    })
    await delay({ ms: 20 })

    // 5. Verify plugin aborted the session
    expect(abortCalls).toEqual([{ path: { id: sessionID } }])

    // 6. BUG: plugin sent promptAsync({parts:[]}) which creates a NEW empty
    //    user message in opencode. The user's actual message (userMsgID) was
    //    cleared from the prompt queue by abort() and is never processed.
    expect(promptAsyncCalls).toEqual([
      { path: { id: sessionID }, body: { parts: [] } },
    ])

    // 7. Verify the plugin cleared userMsgID from pending tracking.
    //    Re-registering it via chatHook succeeds (doesn't hit the dedup guard
    //    at line 225), proving the plugin considers it "handled" even though
    //    no assistant message.updated with parentID=userMsgID was ever received.
    //
    //    In production this means the user's message is silently lost:
    //    - opencode processed the empty prompt instead
    //    - the bot thinks the message was dispatched (promptAsync returned OK)
    //    - nobody re-sends the user's actual message
    let reRegisteredWithoutDedup = false
    await chatHook(
      { sessionID, messageID: userMsgID } as InterruptChatInput,
      createChatOutput({ sessionID, messageID: userMsgID }),
    )
    reRegisteredWithoutDedup = true
    expect(reRegisteredWithoutDedup).toBe(true)
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
    await eventHook({
      event: createAssistantAbortedEvent({
        sessionID: REAL_SLEEP_INTERRUPT_CASE.sessionID,
        assistantMessageID: 'msg-sleep-aborted',
        parentID: REAL_SLEEP_INTERRUPT_CASE.runningMessageID,
      }),
    })
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
