import type {
  Event as OpenCodeEvent,
  Message as OpenCodeMessage,
  Part,
} from '@opencode-ai/sdk/v2'
import { describe, expect, test } from 'vitest'
import type { EventBufferEntry, EventBufferEvent } from './event-stream-state.js'
import { ThreadSessionRuntime } from './thread-session-runtime.js'

type RuntimeInternals = {
  state?: { sessionId: string }
  eventBuffer: EventBufferEntry[]
  partBuffer: Map<string, Map<string, Part>>
  compactEventForEventBuffer: (event: EventBufferEvent) => EventBufferEvent | undefined
  flushBufferedParts: () => Promise<void>
  handleMessageUpdated: (message: OpenCodeMessage) => Promise<void>
  handlePartUpdated: (part: Part) => Promise<void>
  handleNaturalAssistantCompletion: () => Promise<void>
}

function summaryMessageEvent({
  sessionId,
  messageId,
}: {
  sessionId: string
  messageId: string
}): OpenCodeEvent {
  return {
    id: `evt_${messageId}`,
    type: 'message.updated',
    properties: {
      sessionID: sessionId,
      info: {
        id: messageId,
        sessionID: sessionId,
        role: 'assistant',
        parentID: 'msg_user',
        time: { created: 2, completed: 3 },
        modelID: 'compaction-model',
        providerID: 'test-provider',
        mode: 'compaction',
        agent: 'compaction',
        path: { cwd: '/test', root: '/test' },
        cost: 1,
        tokens: {
          input: 10,
          output: 1,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        finish: 'stop',
        summary: true,
      },
    },
  }
}

function summaryTextPart({
  sessionId,
  messageId,
}: {
  sessionId: string
  messageId: string
}): Part {
  return {
    id: `prt_${messageId}`,
    sessionID: sessionId,
    messageID: messageId,
    type: 'text',
    text: 'internal compaction summary must not reach Discord',
    time: { start: 2, end: 3 },
  }
}

describe('ThreadSessionRuntime compaction summary routing', () => {
  test('drops summary message parts before fallback buffering or completion', async () => {
    const sessionId = 'ses_main'
    const messageId = 'msg_summary_embedded_parts'
    const event = summaryMessageEvent({ sessionId, messageId })
    if (event.type !== 'message.updated') {
      throw new Error('Expected summary message event')
    }
    const message = {
      ...event.properties.info,
      parts: [summaryTextPart({ sessionId, messageId })],
    } as unknown as OpenCodeMessage
    const runtime = Object.create(ThreadSessionRuntime.prototype) as RuntimeInternals
    Object.defineProperty(runtime, 'state', {
      value: { sessionId },
      configurable: true,
    })
    runtime.eventBuffer = [{ event, timestamp: 1 }]
    runtime.partBuffer = new Map()
    runtime.flushBufferedParts = async () => {
      throw new Error('Summary message must not flush parts')
    }
    runtime.handleNaturalAssistantCompletion = async () => {
      throw new Error('Summary message must not complete the Discord turn')
    }

    await runtime.handleMessageUpdated(message)

    expect(runtime.partBuffer.size).toBe(0)
  })

  test.each([
    ['main session', 'ses_main'],
    ['subagent session', 'ses_child'],
  ])('preserves summary identity and drops %s parts before buffering', async (_, sessionId) => {
    const messageId = `msg_summary_${sessionId}`
    const runtime = Object.create(ThreadSessionRuntime.prototype) as RuntimeInternals
    const compacted = runtime.compactEventForEventBuffer(
      summaryMessageEvent({ sessionId, messageId }),
    )

    expect(compacted?.type).toBe('message.updated')
    if (!compacted || compacted.type !== 'message.updated') {
      throw new Error('Expected compacted summary message event')
    }
    expect(compacted.properties.info.summary).toBe(true)

    runtime.eventBuffer = [{ event: compacted, timestamp: 1 }]
    runtime.partBuffer = new Map()

    await runtime.handlePartUpdated(summaryTextPart({ sessionId, messageId }))

    expect(runtime.partBuffer.size).toBe(0)
  })
})
