// Ticket #55 diagnostic repro — interrupt plugin vs manual compaction
// (Path A mechanism). Adapted from the shipped opencode-interrupt-plugin.test.js
// stub-server harness; targets the plugin built from this branch's source
// (the deployed npm dist is wiped by kimaki's background auto-update).
//
// Shows: a user message persisted into a session that is busy running a
// MANUAL COMPACTION is aborted+replayed after the interrupt step timeout —
// i.e. the plugin kills the in-flight /compact (it has no compaction
// awareness), reproducing "ordinary message cancels the compaction".
import http from 'node:http'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { pathToFileURL } from 'node:url'

const livePlugin = 'C:/Dev/kimaki-compact-queue/cli/dist/opencode-interrupt-plugin.js'
const { interruptOpencodeSessionOnUserMessage } = (await import(
  pathToFileURL(livePlugin).href
)) as any

function createStubServer() {
  const abortCalls: Array<{ sessionID: string }> = []
  const promptAsyncCalls: Array<Record<string, unknown>> = []
  const statuses = new Map()
  const readBody = (req: http.IncomingMessage) =>
    new Promise<string>((resolve) => {
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
      const data: Record<string, unknown> = {}
      for (const [id, status] of statuses.entries()) data[id] = status
      sendJson(data)
      return
    }
    if (req.method === 'POST' && url.pathname === '/log') {
      await readBody(req)
      sendJson(true)
      return
    }
    const abortMatch = url.pathname.match(/^\/session\/([^/]+)\/abort$/)
    if (req.method === 'POST' && abortMatch) {
      const sessionID = decodeURIComponent(abortMatch[1]!)
      abortCalls.push({ sessionID })
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
      const { port } = server.address() as { port: number }
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        abortCalls,
        promptAsyncCalls,
        setStatus: (sessionID: string, status: unknown) => {
          if (status) statuses.set(sessionID, status)
          else statuses.delete(sessionID)
        },
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done())
          }),
      })
    })
  })
}

function createContext({ baseUrl }: { baseUrl: string }) {
  return {
    client: {},
    project: { id: 'p', worktree: '/w', time: { created: Date.now() } },
    directory: '/w',
    worktree: '/w',
    experimental_workspace: { register: () => {} },
    serverUrl: new URL(baseUrl),
    $: {},
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let stub: any

beforeEach(async () => {
  // Keep the journal fence away from the production ~/.kimaki/restart-journal.
  process.env['KIMAKI_RESTART_JOURNAL_DIR'] =
    'C:/Users/Cody/AppData/Local/Temp/opencode/kimaki55/journal-vitest'
  stub = await createStubServer()
})
afterEach(async () => {
  delete process.env['KIMAKI_INTERRUPT_STEP_TIMEOUT_MS']
  delete process.env['KIMAKI_RESTART_JOURNAL_DIR']
  await stub.close()
})

describe('#55 interrupt plugin vs manual compaction (Path A mechanism)', () => {
  test('user message landing mid-compaction aborts the busy session (kills the /compact run) and replays', async () => {
    process.env['KIMAKI_INTERRUPT_STEP_TIMEOUT_MS'] = '20'
    const hooks = await interruptOpencodeSessionOnUserMessage(createContext({ baseUrl: stub.baseUrl }))
    const chatHook = hooks['chat.message']
    const eventHook = hooks.event
    const sessionID = 'ses-compact'
    const compactionUserMessageID = 'msg_cu'
    const queuedMessageID = 'msg_followup'

    // Manual /compact is running: session reports busy, the summary assistant
    // message streams updates (parentID = compaction user message).
    stub.setStatus(sessionID, { type: 'busy' })
    await eventHook({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_summary',
            role: 'assistant',
            sessionID,
            parentID: compactionUserMessageID,
            summary: true,
          },
        },
      },
    })

    // Ordinary Discord message (stock 0.27.0 routes it straight to
    // promptAsync) is persisted into the session mid-compaction.
    await chatHook(
      { sessionID, messageID: queuedMessageID },
      {
        message: {
          id: queuedMessageID,
          sessionID,
          role: 'user',
          time: { created: Date.now() },
        },
        parts: [{ type: 'text', text: 'run the next ticket' }],
      },
    )

    // Summary keeps streaming AFTER the follow-up landed — its parentID
    // (compaction user message) never matches the follow-up's id, so the
    // pending interrupt timer for the follow-up is NOT cancelled.
    await eventHook({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg_summary',
            role: 'assistant',
            sessionID,
            parentID: compactionUserMessageID,
            summary: true,
          },
        },
      },
    })

    // Abort fires at ~20ms, the idle poll adds up to 100ms, then the replay
    // lands. 400ms covers the full sequence.
    await delay(400)

    // The plugin aborted the busy session — the in-flight compaction run —
    // and replayed the follow-up prompt.
    expect(stub.abortCalls).toEqual([{ sessionID }])
    expect(stub.promptAsyncCalls).toEqual([
      {
        sessionID,
        messageID: queuedMessageID,
        parts: [{ type: 'text', text: 'run the next ticket' }],
      },
    ])
  })
})
