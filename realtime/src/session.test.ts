// Session lifecycle against a local WebSocket server. No provider API calls.

import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { expect, test } from 'vitest'
import { WebSocketServer } from 'ws'
import { xai } from './openai.ts'
import { RealtimeSession } from './session.ts'

test('close() during a server resume attempt does not open a seeded second socket', async () => {
  const server = new WebSocketServer({ port: 0 })
  await once(server, 'listening')
  const urls: string[] = []
  server.on('connection', (_socket, request) => urls.push(request.url ?? ''))
  const { port } = server.address() as AddressInfo

  const session = new RealtimeSession({ model: xai({ apiKey: 'test', baseUrl: `ws://127.0.0.1:${port}` }) })
  const connecting = session.connect({
    resume: {
      version: 1,
      events: [
        { type: 'session.started', provider: 'xai', model: 'grok-voice-think-fast-2.0', sessionId: null },
        { type: 'resume.handle', handle: 'conv_1' },
        { type: 'session.closed', code: 1000, reason: '' },
      ],
    },
  })
  await once(server, 'connection')
  await session.close()
  const result = await connecting

  expect(result instanceof Error).toBe(true)
  expect(urls).toMatchInlineSnapshot(`
    [
      "/?model=grok-voice-think-fast-2.0&conversation_id=conv_1",
    ]
  `)
  expect(session.view().connected).toBe(false)
  server.close()
})
