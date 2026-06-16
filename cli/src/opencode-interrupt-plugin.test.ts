// Runtime tests for the queued-message interrupt plugin.
//
// The plugin builds its OWN v2 OpenCode client from ctx.serverUrl and talks to
// the real server over HTTP. To test without a real opencode/LLM, we spin up a
// tiny local HTTP server that implements the three endpoints the plugin uses:
//   GET  /session/status         → { [sessionID]: SessionStatus }
//   POST /session/{id}/abort     → records abort, flips status to idle
//   POST /session/{id}/prompt_async → records the replay
// No module mocking: the plugin runs against a genuine HTTP endpoint.

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { SessionStatus } from '@opencode-ai/sdk/v2'
import { interruptOpencodeSessionOnUserMessage } from './opencode-interrupt-plugin.js'

type InterruptHooks = Awaited<ReturnType<typeof interruptOpencodeSessionOnUserMessage>>
type InterruptEventHook = NonNullable<InterruptHooks['event']>
type InterruptChatHook = NonNullable<InterruptHooks['chat.message']>
type InterruptEvent = Parameters<InterruptEventHook>[0]['event']
type InterruptChatInput = Parameters<InterruptChatHook>[0]
type InterruptChatOutput = Parameters<InterruptChatHook>[1]
type InterruptContext = Parameters<typeof interruptOpencodeSessionOnUserMessage>[0]

type AbortCall = { sessionID: string }
type PromptAsyncCall = {
  sessionID: string
  messageID?: string
  parts?: unknown
  agent?: string
  model?: { providerID: string; modelID: string }
}

// A tiny stand-in opencode server. Records abort/prompt_async calls and serves
// a configurable per-session status. abort flips the session to idle, mirroring
// OpenCode's synchronous cancel().
function createStubServer(): Promise<{
  baseUrl: string
  abortCalls: AbortCall[]
  promptAsyncCalls: PromptAsyncCall[]
  setStatus: (sessionID: string, status: SessionStatus | undefined) => void
  close: () => Promise<void>
}> {
  const abortCalls: AbortCall[] = []
  const promptAsyncCalls: PromptAsyncCall[] = []
  const statuses = new Map<string, SessionStatus>()

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
      })
      req.on('end', () => resolve(raw))
    })

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const sendJson = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    if (req.method === 'GET' && url.pathname === '/session/status') {
      const data: Record<string, SessionStatus> = {}
      for (const [id, status] of statuses.entries()) data[id] = status
      sendJson(data)
      return
    }

    // The plugin logs through client.app.log (POST /log); accept and ignore.
    if (req.method === 'POST' && url.pathname === '/log') {
      await readBody(req)
      sendJson(true)
      return
    }

    const abortMatch = url.pathname.match(/^\/session\/([^/]+)\/abort$/)
    if (req.method === 'POST' && abortMatch) {
      const sessionID = decodeURIComponent(abortMatch[1]!)
      abortCalls.push({ sessionID })
      // Mirror OpenCode: cancel() sets status idle synchronously on abort.
      statuses.delete(sessionID)
      sendJson(true)
      return
    }

    const promptMatch = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/)
    if (req.method === 'POST' && promptMatch) {
      const sessionID = decodeURIComponent(promptMatch[1]!)
      const raw = await readBody(req)
      const parsed = raw ? JSON.parse(raw) : {}
      promptAsyncCalls.push({ sessionID, ...parsed })
      sendJson({})
      return
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found', path: url.pathname }))
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        abortCalls,
        promptAsyncCalls,
        setStatus: (sessionID, status) => {
          if (status) statuses.set(sessionID, status)
          else statuses.delete(sessionID)
        },
        close: () =>
          new Promise((done) => {
            server.close(() => done())
          }),
      })
    })
  })
}

function createContext({ baseUrl }: { baseUrl: string }): InterruptContext {
  return {
    client: {} as InterruptContext['client'],
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
    serverUrl: new URL(baseUrl),
    $: {} as InterruptContext['$'],
  }
}

function createChatOutput({
  sessionID,
  messageID,
  parts,
}: {
  sessionID: string
  messageID: string
  parts?: InterruptChatOutput['parts']
}): InterruptChatOutput {
  return {
    message: {
      id: messageID,
      sessionID,
      role: 'user',
      time: { created: Date.now() },
    },
    parts: parts || [{ type: 'text', text: 'user message' }],
  } as InterruptChatOutput
}

function createAssistantStartedEvent({
  sessionID,
  messageID,
  assistantMessageID,
}: {
  sessionID: string
  messageID: string
  assistantMessageID: string
}): InterruptEvent {
  return {
    type: 'message.updated',
    properties: {
      info: {
        id: assistantMessageID,
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

let stub: Awaited<ReturnType<typeof createStubServer>>

async function requireHooks(): Promise<{
  eventHook: InterruptEventHook
  chatHook: InterruptChatHook
}> {
  const hooks = await interruptOpencodeSessionOnUserMessage(
    createContext({ baseUrl: stub.baseUrl }),
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

beforeEach(async () => {
  stub = await createStubServer()
})

afterEach(async () => {
  delete process.env['KIMAKI_INTERRUPT_STEP_TIMEOUT_MS']
  await stub.close()
})

describe('interruptOpencodeSessionOnUserMessage', () => {
  test('aborts a busy session after timeout and replays the queued message', async () => {
    process.env['KIMAKI_INTERRUPT_STEP_TIMEOUT_MS'] = '20'

    const { chatHook } = await requireHooks()
    const sessionID = 'ses-busy'
    const messageID = 'msg-queued'

    // Session is busy with a long-running turn.
    stub.setStatus(sessionID, { type: 'busy' })

    await chatHook(
      { sessionID, messageID } as InterruptChatInput,
      createChatOutput({ sessionID, messageID }),
    )

    // Timer fires (20ms), abort is called, status poll sees idle (abort cleared
    // it), replay runs.
    await delay({ ms: 120 })

    expect(stub.abortCalls).toEqual([{ sessionID }])
    expect(stub.promptAsyncCalls).toEqual([
      {
        sessionID,
        messageID,
        parts: [{ type: 'text', text: 'user message' }],
      },
    ])
  })

  test('assistant parent match cancels timer and skips abort/replay', async () => {
    process.env['KIMAKI_INTERRUPT_STEP_TIMEOUT_MS'] = '40'

    const { eventHook, chatHook } = await requireHooks()
    const sessionID = 'ses-sent'
    const messageID = 'msg-sent'

    await chatHook(
      { sessionID, messageID } as InterruptChatInput,
      createChatOutput({ sessionID, messageID }),
    )
    // Assistant starts processing this exact message before the timer fires.
    await eventHook({
      event: createAssistantStartedEvent({
        sessionID,
        messageID,
        assistantMessageID: 'msg-sent-assistant',
      }),
    })
    await delay({ ms: 90 })

    expect(stub.abortCalls).toEqual([])
    expect(stub.promptAsyncCalls).toEqual([])
  })

  test('empty resume messages do not schedule interruption tracking', async () => {
    process.env['KIMAKI_INTERRUPT_STEP_TIMEOUT_MS'] = '20'

    const { chatHook } = await requireHooks()

    await chatHook(
      { sessionID: 'ses-empty-resume', messageID: 'msg-empty-resume' } as InterruptChatInput,
      createChatOutput({
        sessionID: 'ses-empty-resume',
        messageID: 'msg-empty-resume',
        parts: [],
      }),
    )
    await delay({ ms: 60 })

    expect(stub.abortCalls).toEqual([])
    expect(stub.promptAsyncCalls).toEqual([])
  })

  test('replayed message does not schedule another interrupt (no abort loop)', async () => {
    process.env['KIMAKI_INTERRUPT_STEP_TIMEOUT_MS'] = '20'

    const { chatHook } = await requireHooks()
    const sessionID = 'ses-loop'
    const messageID = 'msg-loop'

    stub.setStatus(sessionID, { type: 'busy' })

    await chatHook(
      { sessionID, messageID } as InterruptChatInput,
      createChatOutput({ sessionID, messageID }),
    )
    await delay({ ms: 120 })

    // After replay, OpenCode emits chat.message again for the same messageID.
    // The plugin must skip scheduling a new interrupt timer.
    await chatHook(
      { sessionID, messageID } as InterruptChatInput,
      createChatOutput({ sessionID, messageID }),
    )
    await delay({ ms: 80 })

    expect(stub.abortCalls).toEqual([{ sessionID }])
    expect(stub.promptAsyncCalls).toEqual([
      {
        sessionID,
        messageID,
        parts: [{ type: 'text', text: 'user message' }],
      },
    ])
  })

  test('drains multiple queued messages in order', async () => {
    process.env['KIMAKI_INTERRUPT_STEP_TIMEOUT_MS'] = '20'

    const { chatHook } = await requireHooks()
    const sessionID = 'ses-drain'
    const firstMessageID = 'msg-first'
    const secondMessageID = 'msg-second'

    stub.setStatus(sessionID, { type: 'busy' })

    // Two messages queued while session is busy.
    await chatHook(
      { sessionID, messageID: firstMessageID } as InterruptChatInput,
      createChatOutput({ sessionID, messageID: firstMessageID }),
    )
    await chatHook(
      { sessionID, messageID: secondMessageID } as InterruptChatInput,
      createChatOutput({ sessionID, messageID: secondMessageID }),
    )

    // First timer fires, aborts + replays first message, then schedules the
    // second. Wait long enough for both to drain.
    await delay({ ms: 300 })

    expect(stub.abortCalls).toEqual([{ sessionID }, { sessionID }])
    expect(stub.promptAsyncCalls.map((c) => c.messageID)).toEqual([
      firstMessageID,
      secondMessageID,
    ])
  })

  test('preserves agent and model overrides on replay', async () => {
    process.env['KIMAKI_INTERRUPT_STEP_TIMEOUT_MS'] = '20'

    const { chatHook } = await requireHooks()
    const sessionID = 'ses-overrides'
    const messageID = 'msg-overrides'

    stub.setStatus(sessionID, { type: 'busy' })

    const output = createChatOutput({ sessionID, messageID })
    output.message.agent = 'plan'
    output.message.model = { providerID: 'anthropic', modelID: 'claude' }

    await chatHook({ sessionID, messageID } as InterruptChatInput, output)
    await delay({ ms: 120 })

    expect(stub.promptAsyncCalls).toEqual([
      {
        sessionID,
        messageID,
        parts: [{ type: 'text', text: 'user message' }],
        agent: 'plan',
        model: { providerID: 'anthropic', modelID: 'claude' },
      },
    ])
  })
})
